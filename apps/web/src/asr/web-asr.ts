// Web ASR 执行层。
//
// 这是桥接 (../bridge.ts) 调用的统一接口：start() 起一条「采麦 → 16kHz 单声道 PCM → sherpa-onnx
// WASM（Silero VAD + 按 modelId 选定的离线识别器）」的实时识别管线，stop() 拆除音频通路。
//
// 架构：
//  - 采麦：getUserMedia + AudioContext(16k) + AudioWorklet（见 ./pcm-worklet.js），每 100ms 一帧。
//  - 识别：放在 module Web Worker（./sherpa-worker.ts）里跑，切段策略在 @rt/core、
//    WASM 引擎适配在 worker 内；主线程只负责把帧 postMessage 过去，避免 WASM 解码阻塞 UI。
//  - 模型：首次 start 前确保 @rt/core ASR_MODELS 已下载并缓存（Cache Storage），把字节传给
//    Worker 写入 WASM FS（见 ./model-store.ts）。
//  - 复用：worker 跨录音会话常驻（stop 只 flush、不 terminate），模型留在 WASM FS 里，
//    再次 start 只发 reset 重置计时基线——省去重读 ~230MB 模型字节与重新构图预热。
//    worker 报过错则下次 start 前丢弃重建，避免带病复用。
//  - 回吐：Worker 的 partial/segment 消息转成 @rt/core 的 PartialPayload/SegmentPayload，
//    经 onPartial/onSegment 回调上抛。

import type {
  SegmentPayload,
  PartialPayload,
  StatusPayload,
  PipelineErrorCode,
  AsrLang,
} from '@rt/core';
import { DEFAULT_ASR_MODEL_ID } from '@rt/core';
import { areModelsCached, ensureModelsCached, readCachedModels } from './model-store';
import type { ToWorker, FromWorker } from './worker-protocol';

// sherpa-onnx 离线识别期望的采样率（与 @rt/core 各模型一致）。
const SAMPLE_RATE = 16000;

export interface WebAsrCallbacks {
  onSegment?: (s: SegmentPayload) => void;
  onPartial?: (p: PartialPayload) => void;
  onStatus?: (s: StatusPayload) => void;
}

/** 桥接层按当前设置注入的识别配置（模型 id + 识别语言）。 */
export interface WebAsrConfig {
  modelId: string;
  language: AsrLang;
}

export interface WebAsrStartResult {
  ok: boolean;
  error?: string;
  /** 错误码（ok 为 false 时可选携带），与 @rt/core StartResult.code 同义 */
  code?: PipelineErrorCode;
}

/**
 * 浏览器端实时 ASR 管线：真采麦 + sherpa-onnx WASM 识别。
 * 平台特定的接缝（音频通路、WASM Worker、模型加载、回调）都收敛在这里，桥接只调 start/stop。
 */
export class WebAsr {
  private cbs: WebAsrCallbacks;
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private worker: Worker | null = null;
  private workerReady = false;
  // worker 报过错（init 失败 / 解码异常）：不再复用，下次 start 前 terminate 重建
  private workerFailed = false;
  private running = false;

  // 当前生效的识别配置（modelId 指向 @rt/core 注册表条目，language 为识别语言）。
  // 桥接层在 start/prewarm 前按最新设置注入。
  private config: WebAsrConfig = { modelId: DEFAULT_ASR_MODEL_ID, language: 'auto' };
  // 常驻 worker 内 recognizer 当前所用的识别语言；与 config.language 不一致时（同模型）走轻量重建。
  private workerLanguage: AsrLang | null = null;
  // 常驻 worker 已装载的模型 id；与 config.modelId 不一致时须冷启动重建（模型字节不同，原地重建不适用）。
  private workerModelId: string | null = null;

  // start/stop/prewarm 单飞串行：三类操作一律入队到同一条链尾逐次执行——调用顺序即生效顺序，
  // 「最后一次意图」必然最后生效。internal 各自幂等（start 遇 running 短路、worker 复用、stop 幂等），
  // 逐次执行代价极低。避免并发 start 泄漏双 Worker/双麦克风流、或 stop 在 start 的 await 间隙插入
  // 拆到一半的通路；预热在途时 start 排其后、自然复用其建好的 worker。
  private opChain: Promise<unknown> = Promise.resolve();

  constructor(cbs: WebAsrCallbacks = {}) {
    this.cbs = cbs;
  }

  setCallbacks(cbs: WebAsrCallbacks): void {
    this.cbs = cbs;
  }

  /** 注入当前识别配置（模型 id + 识别语言）。桥接层在每次 start/prewarm 前按最新设置调用。 */
  setConfig(config: WebAsrConfig): void {
    this.config = config;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** sherpa 静态资源（胶水 + .wasm + 包装器）所在的基址（public/sherpa/，受 Vite base 影响）。 */
  private sherpaBaseUrl(): string {
    // import.meta.env.BASE_URL 形如 '/' 或 '/realtime-translator/'。
    const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
    return new URL(`${base}sherpa/`, self.location.origin).toString();
  }

  /** 丢弃当前 worker（异常路径 / 带病状态），下次 start 走冷启动重建。 */
  private discardWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    this.workerReady = false;
    this.workerFailed = false;
    this.workerLanguage = null;
    this.workerModelId = null;
  }

  /** 冷启动识别 Worker：等模型缓存就绪 → 取字节 → 建 Worker → init（写 FS + 建 VAD/recognizer）。 */
  private async startWorker(): Promise<void> {
    const modelId = this.config.modelId;
    // 确保模型已缓存（正常路径下 SetupScreen 已先下过；这里兜底，命中即秒回）。
    if (!(await areModelsCached(modelId))) {
      await ensureModelsCached(modelId);
    }
    const models = await readCachedModels(modelId);

    // module worker：worker 内 import @rt/core（Vite dev 原生 ESM / build 打包）；
    // sherpa 胶水是 classic 全局脚本，由 worker 内部 fetch+eval 加载（见 sherpa-worker 头注）。
    this.worker = new Worker(new URL('./sherpa-worker.ts', import.meta.url), {
      type: 'module',
    });

    // 快照本次 init 的模型 id 与识别语言：ready 回执到达时据此登记（避免期间 config 改动串味）。
    const initModelId = modelId;
    const initLanguage = this.config.language;

    const ready = new Promise<void>((resolve, reject) => {
      const w = this.worker!;
      w.onmessage = (ev: MessageEvent<FromWorker>) => {
        const msg = ev.data;
        switch (msg.type) {
          case 'ready':
            this.workerReady = true;
            // 记录 worker 内 recognizer 实际生效的模型与识别语言（init 时用的 config）。
            this.workerModelId = initModelId;
            this.workerLanguage = initLanguage;
            resolve();
            break;
          case 'partial':
            this.cbs.onPartial?.({ text: msg.text });
            break;
          case 'segment':
            this.cbs.onSegment?.({
              id: msg.id,
              text: msg.text,
              lang: msg.lang,
              start: msg.start,
              duration: msg.duration,
            });
            break;
          case 'error':
            this.workerFailed = true;
            if (!this.workerReady) reject(new Error(msg.error));
            this.cbs.onStatus?.({
              state: 'error',
              error: msg.error,
              // 就绪前失败 = 引擎初始化问题；就绪后失败 = 运行中异常
              code: this.workerReady ? 'asr-crashed' : 'asr-init-failed',
            });
            break;
          // 'flushed' / 'stopped' 由 stop() 里的临时监听消费，这里无需处理。
          default:
            break;
        }
      };
      w.onerror = (e) => {
        this.workerFailed = true;
        if (!this.workerReady) reject(new Error(e.message || 'sherpa worker 加载失败'));
      };
    });

    // init：传模型字节（转移底层 buffer，避免拷贝）+ sherpa 资源基址 + 模型 id + 识别语言。
    const initMsg: ToWorker = {
      type: 'init',
      models: Array.from(models, ([name, bytes]) => ({ name, bytes })),
      sherpaBaseUrl: this.sherpaBaseUrl(),
      modelId: initModelId,
      language: initLanguage,
    };
    const transfer = initMsg.models.map((m) => m.bytes.buffer);
    this.worker.postMessage(initMsg, transfer);

    await ready;
  }

  /** 把一次操作排到链尾逐次执行；链上吞掉 reject 只做定序，结果由本次 promise 自身反映。 */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(op);
    this.opChain = run.catch(() => undefined);
    return run;
  }

  /** 起管线：排到操作链尾（调用顺序即生效顺序），等在途操作先完成。 */
  start(): Promise<WebAsrStartResult> {
    return this.enqueue(() => this.startInternal());
  }

  /** 停止会话：排到操作链尾，晚于 stop 调用的 start 不会被它拆掉。 */
  stop(): Promise<{ ok: boolean }> {
    return this.enqueue(() => this.stopInternal());
  }

  /** 预热：进主界面即后台装模型、不触麦克风；随后的 start 排其后、自然复用建好的 worker。 */
  prewarm(): Promise<void> {
    return this.enqueue(() => this.prewarmInternal());
  }

  /**
   * 丢弃空闲的常驻 worker（删除 ASR 模型后调用）：会话进行中不动（删除已在桥接层拒绝，此处兜底）。
   * 排到操作链尾，避免与在途 start/prewarm 竞争。丢弃后下次 start 会重查缓存、必要时重下载。
   */
  dropIdleWorker(): Promise<void> {
    return this.enqueue(() => {
      if (!this.running) this.discardWorker();
      return Promise.resolve();
    });
  }

  /**
   * 识别语言变化时重建常驻 worker 的 recognizer（模型字节仍在 WASM FS，无需重下）。
   * 等 'reconfigured' 回执（或超时兜底）：成功登记新语言；失败置 workerFailed，交调用方冷启动重建。
   * 与 stopInternal 的 flush 等待同构（临时监听 + 超时），不干扰常驻 onmessage。
   */
  private reconfigureWorker(language: AsrLang): Promise<void> {
    const w = this.worker;
    if (!w) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        w.removeEventListener('message', onMsg);
        clearTimeout(timer);
        resolve();
      };
      const onMsg = (ev: MessageEvent): void => {
        const msg = ev.data as FromWorker | undefined;
        if (msg?.type !== 'reconfigured') return;
        if (msg.error) {
          this.workerFailed = true; // 重建失败：标记带病，由调用方冷启动重建
        } else {
          this.workerLanguage = language;
        }
        finish();
      };
      w.addEventListener('message', onMsg);
      // 超时兜底：按重建失败处理（标记带病，调用方冷启动重建）。若仅 resolve 不标记，
      // 慢机上超过 5s 的重建会被当作已就绪，随后以旧语言的识别器带病开始录音。
      const timer = setTimeout(() => {
        this.workerFailed = true;
        finish();
      }, 5000);
      w.postMessage({ type: 'reconfigure', language } satisfies ToWorker);
    });
  }

  /**
   * 预热识别 Worker：仅把模型装入内存，绝不请求麦克风/权限。
   * UI 在调用前先行禁用录音按钮，故除录音会话进行中外，任何路径（含模型未缓存的跳过、
   * worker 已就绪、失败）都必须以 stopped 状态收尾解禁；失败仅记录，
   * 留待用户点录音时由 start 的既有错误路径如实上报。
   */
  private async prewarmInternal(): Promise<void> {
    if (this.running) {
      // 会话进行中：重申 running（解除 UI 先行禁用），不发 stopped 打回录音态
      this.cbs.onStatus?.({ state: 'running' });
      return;
    }
    if (!(await areModelsCached(this.config.modelId))) {
      this.cbs.onStatus?.({ state: 'stopped' }); // 未下载不预热（不触发下载），仅解禁按钮
      return;
    }
    if (this.worker && this.workerFailed) this.discardWorker(); // 带病 worker 先丢弃，避免被当作已就绪
    // 识别模型变更：字节不同，原地重建不适用，丢弃后走下面冷启动重建。
    if (this.worker && this.workerReady && this.workerModelId !== this.config.modelId) {
      this.discardWorker();
    }
    if (this.worker && this.workerReady) {
      // 识别语言变了则重建 recognizer（模型仍在内存），保持预热与当前设置一致。
      if (this.workerLanguage !== this.config.language) {
        await this.reconfigureWorker(this.config.language);
      }
      if (this.workerFailed) {
        this.discardWorker(); // 重建失败：丢弃，走下面冷启动重建
      } else {
        this.cbs.onStatus?.({ state: 'stopped' });
        return;
      }
    }
    this.cbs.onStatus?.({ state: 'loading' });
    try {
      await this.startWorker();
      this.cbs.onStatus?.({ state: 'stopped' });
    } catch (e) {
      console.error('[asr:prewarm]', e);
      this.discardWorker();
      this.cbs.onStatus?.({ state: 'stopped' });
    }
  }

  /** 起管线：请求麦克风 → 16kHz AudioContext → AudioWorklet → sherpa Worker（复用或冷启动）。 */
  private async startInternal(): Promise<WebAsrStartResult> {
    if (this.running) return { ok: true };
    if (this.worker && this.workerFailed) {
      this.discardWorker();
    }
    // 识别模型变更：常驻 worker 装的是旧模型字节，reconfigure 原地重建不适用，冷启动重建。
    if (this.worker && this.workerReady && this.workerModelId !== this.config.modelId) {
      this.discardWorker();
    }
    // 仅真冷启动（要装模型）才报 loading：预热后的复用路径只剩拿麦克风/搭音频图（亚秒级），
    // 报 loading 会让每次开始录音都闪一次「识别模型加载中」的误导提示。
    if (!(this.worker && this.workerReady)) {
      this.cbs.onStatus?.({ state: 'loading' });
    }
    try {
      if (this.worker && this.workerReady) {
        // 复用常驻 worker：模型仍在 WASM FS。识别语言变了则先重建 recognizer（免重下），
        // 否则只需重置会话计时基线，秒级恢复。
        if (this.workerLanguage !== this.config.language) {
          await this.reconfigureWorker(this.config.language);
        }
        if (this.workerFailed) {
          // 重建识别器失败：丢弃冷启动重建。
          this.discardWorker();
          await this.startWorker();
        } else {
          this.worker.postMessage({ type: 'reset' } satisfies ToWorker);
        }
      } else {
        // 冷启动（含模型加载）。任何一步失败都不进入 running。
        await this.startWorker();
      }

      // 真请求麦克风（触发浏览器权限弹窗）。仅音频。
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // 16kHz 上下文：浏览器会按需重采样到该采样率，省去自己做重采样。
      this.audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
      // 标签页因自动播放策略可能挂起，恢复一下。
      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }

      // 加载 AudioWorklet 处理器。必须引用 .js：生产构建会把它内联成 data URL，
      // 扩展名决定 MIME —— .ts 会得到 video/mp2t 被 worklet 加载器拒收（见 pcm-worklet.js 头注）。
      const url = new URL('./pcm-worklet.js', import.meta.url);
      await this.audioCtx.audioWorklet.addModule(url);

      this.source = this.audioCtx.createMediaStreamSource(this.stream);
      this.worklet = new AudioWorkletNode(this.audioCtx, 'pcm-worklet');
      // worklet 把每帧 Float32 PCM（16kHz 单声道）通过 port 回吐到主线程。
      this.worklet.port.onmessage = (ev: MessageEvent) => {
        this.handleFrame(ev.data as Float32Array);
      };
      this.source.connect(this.worklet);
      // 不连到 destination：避免把麦克风原声播回扬声器（回授）。worklet 自身会驱动 process。

      this.running = true;
      this.cbs.onStatus?.({ state: 'running' });
      return { ok: true };
    } catch (e) {
      // 失败路径清理已建的部分资源（worker terminate / stream stop / audioCtx close）。
      // 直接调 stopInternal 而非公有 stop：已在操作链内，再走单飞会自等造成死锁。
      await this.stopInternal();
      const msg = e instanceof Error ? e.message : String(e);
      // 按异常来源分类错误码：getUserMedia 的权限拒绝 / 设备不可用有标准 DOMException 名，
      // 其余（模型读取、worker 构建）归为引擎初始化失败。
      const name = e instanceof DOMException ? e.name : '';
      const code =
        name === 'NotAllowedError' || name === 'PermissionDeniedError'
          ? ('mic-permission' as const)
          : name === 'NotFoundError' || name === 'NotReadableError' || name === 'OverconstrainedError'
            ? ('audio-capture-failed' as const)
            : ('asr-init-failed' as const);
      this.cbs.onStatus?.({ state: 'error', error: msg, code });
      return { ok: false, error: msg, code };
    }
  }

  /** 停止会话：拆音频通路 + flush 定稿最后一段；worker 保留供下次复用。 */
  private async stopInternal(): Promise<{ ok: boolean }> {
    this.running = false;
    try {
      if (this.worklet) {
        this.worklet.port.onmessage = null;
        this.worklet.disconnect();
        this.worklet = null;
      }
      if (this.source) {
        this.source.disconnect();
        this.source = null;
      }
      if (this.audioCtx) {
        await this.audioCtx.close().catch(() => undefined);
        this.audioCtx = null;
      }
      if (this.stream) {
        for (const track of this.stream.getTracks()) track.stop();
        this.stream = null;
      }

      const w = this.worker;
      if (w) {
        if (this.workerReady && !this.workerFailed) {
          // flush 把未闭合段定稿并回吐最后一段 segment（先于 'flushed' 回执到达），
          // 等回执（或超时兜底）后保留 worker——模型常驻，下次 start 秒级恢复。
          await new Promise<void>((resolve) => {
            let done = false;
            const finish = (): void => {
              if (done) return;
              done = true;
              w.removeEventListener('message', onMsg);
              clearTimeout(timer);
              resolve();
            };
            const onMsg = (ev: MessageEvent): void => {
              if ((ev.data as FromWorker | undefined)?.type === 'flushed') finish();
            };
            w.addEventListener('message', onMsg);
            const timer = setTimeout(finish, 3000); // 兜底：worker 异常时也不挂起
            w.postMessage({ type: 'flush' } satisfies ToWorker);
          });
        } else {
          // 初始化未完成 / 报过错：不值得保留，直接丢弃，下次冷启动重建。
          this.discardWorker();
        }
      }
    } finally {
      this.cbs.onStatus?.({ state: 'stopped' });
    }
    return { ok: true };
  }

  /**
   * 单帧 16kHz 单声道 PCM 到达：转发给 sherpa Worker（转移底层 buffer，零拷贝）。
   * Worker 内做 VAD 切段 + 选定模型识别，结果经 partial/segment 消息回吐。
   */
  private handleFrame(frame: Float32Array): void {
    if (!this.worker) return;
    const msg: ToWorker = { type: 'frame', samples: frame };
    this.worker.postMessage(msg, [frame.buffer]);
  }
}
