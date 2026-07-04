// 浏览器端本地翻译：把 Transformers.js seq2seq 翻译模型的推理放到 Web Worker（见 ./translate-worker），
// 主线程不被模型推理阻塞。本类是瘦代理：做语言码映射 + 同语言短路 + 简繁 toScript 后处理（都很轻），
// 实际推理通过消息发给 worker、按 id 对应结果。模型差异全部收敛到传入的 LocalModelSpec（见 @rt/core 注册表）。
import { type LocalModelSpec } from '@rt/core';
import type { ToTranslateWorker, FromTranslateWorker } from './translate-worker-protocol';

export class WebLocalTranslator {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>();
  // 预热（翻译开启时：开关打开 / 启动时已开）：init→ready 的等待句柄，幂等复用。
  private warming: Promise<void> | null = null;
  private warmResolve: (() => void) | null = null;
  private warmReject: ((e: Error) => void) | null = null;

  constructor(private readonly spec: LocalModelSpec) {}

  /** 取某 app 语言在本模型下的处理项，未知语言回退。 */
  private entry(lang?: string): LocalModelSpec['langs'][string] {
    return this.spec.langs[lang ?? ''] ?? this.spec.langs[this.spec.fallbackLang];
  }

  /**
   * worker 脚本加载失败 / 推理崩溃（如 OOM）：worker 已无法再回执任何消息，兜底 settle
   * 所有等待方——拒绝在途 pending 与预热、复位状态，并丢弃这个 worker 以便下次冷启动重建。
   */
  private failWorker(error: Error): void {
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    this.warmReject?.(error);
    this.warmResolve = null;
    this.warmReject = null;
    this.warming = null;
    this.worker?.terminate();
    this.worker = null;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./translate-worker.ts', import.meta.url), { type: 'module' });
    // worker 级致命错误无法经协议消息上报（脚本加载失败 / 运行时崩溃），单独兜底。
    w.onerror = (e: ErrorEvent) => this.failWorker(new Error(e.message || '翻译 worker 崩溃'));
    w.onmessageerror = () => this.failWorker(new Error('翻译 worker 消息反序列化失败'));
    w.onmessage = (ev: MessageEvent<FromTranslateWorker>) => {
      const m = ev.data;
      switch (m.type) {
        case 'ready':
          // 预热完成（响应 init）。
          this.warmResolve?.();
          this.warmResolve = null;
          this.warmReject = null;
          break;
        case 'result': {
          const p = this.pending.get(m.id);
          if (p) {
            this.pending.delete(m.id);
            p.resolve(m.text);
          }
          break;
        }
        case 'error': {
          if (m.id === -1) {
            // 初始化/加载失败：结束预热等待，允许下次重试。
            this.warmReject?.(new Error(m.error));
            this.warmResolve = null;
            this.warmReject = null;
            this.warming = null;
            break;
          }
          const p = this.pending.get(m.id);
          if (p) {
            this.pending.delete(m.id);
            p.reject(new Error(m.error));
          }
          break;
        }
      }
    };
    this.worker = w;
    return w;
  }

  /** 预热：把已下载的模型装载入内存但不翻译（翻译开启时调用，第一句不再等装载）。幂等。 */
  warmUp(): Promise<void> {
    if (this.warming) return this.warming;
    const w = this.ensureWorker();
    this.warming = new Promise<void>((resolve, reject) => {
      this.warmResolve = resolve;
      this.warmReject = reject;
    });
    w.postMessage({
      type: 'init',
      modelId: this.spec.modelId,
      dtype: this.spec.dtype,
    } satisfies ToTranslateWorker);
    return this.warming;
  }

  /**
   * 把 text 翻成 target（app 语言键 zh/en/ja/ko），经 spec.langs 映射到模型语言码。
   * 目标若需脚本后处理（中文母语归一化为简体）则套 toScript。
   * 模型须已由下载链路落盘（Worker 内 allowRemoteModels=false）；未缓存时 worker 装载即报错。
   */
  async translate(text: string, opts: { source?: string; target: string }): Promise<string> {
    if (!text.trim()) return text;
    const src = this.entry(opts.source);
    const tgt = this.entry(opts.target);

    // 模型层面同语言：无需经模型，仅按需做脚本归一化（不动 worker）。
    if (src.code === tgt.code) {
      return tgt.toScript ? tgt.toScript(text) : text;
    }

    const w = this.ensureWorker();
    const id = this.nextId++;
    const result = await new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({
        type: 'translate',
        id,
        text,
        srcLang: src.code,
        tgtLang: tgt.code,
        modelId: this.spec.modelId,
        dtype: this.spec.dtype,
      } satisfies ToTranslateWorker);
    });
    return tgt.toScript ? tgt.toScript(result) : result;
  }
}
