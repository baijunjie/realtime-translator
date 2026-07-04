// 平台无关的实时转写管线：16kHz 单声道 PCM 输入，输出文本段。
//
// 流程: 音频 -> Silero VAD 切出语音段 -> SenseVoice 识别文本
//
// 切段策略、历史缓冲、部分识别调度、文本清理与全部调参常量都收敛在这里，
// 三端只需实现 AsrInferenceEngine（macOS = sherpa-onnx-node，web = sherpa-onnx WASM），
// 调参改一处即三端生效。本文件不得引入 Node/DOM 依赖（跑在 utilityProcess 与 Web Worker 里）。
//
// 为了让文字实时出现，说话过程中会周期性地对“尚未结束”的语音做部分识别
// （onPartial），语音段结束后再吐出最终结果（onSegment）。
import type { SegmentPayload, PartialPayload } from '../types';

export const SAMPLE_RATE = 16000;
export const VAD_WINDOW_SIZE = 512;

// 断句主依据：连续静音达到该时长就断句。isSpeechDetected() 是逐帧瞬时状态，词间/换气
// 会瞬间转 false，用它去抖：值偏小 = 断句更勤、定稿/翻译更快；过小会把一句切碎。
// 各端构造 VAD 时的 minSilenceDuration 也用它，保持探测与去抖一致。
export const MIN_SILENCE_SECONDS = 0.35;

// 历史缓冲上限（秒），用于段前回补、实时部分识别、兜底断句的能量搜索。
const MAX_HISTORY_SECONDS = 60;

// 兜底断句：连续说话一直没有自然停顿（如极快语速）时，段会无限增长、迟迟不定稿。
// 不在固定时刻硬切，而是在最近一段音频里找“能量最低点”（词间微停顿）作为切点，
// 尽量不切在半词上。SOFT 上限触发搜索；搜索只看最近 SEARCH 秒；切点前至少保留 MIN 秒。
const MAX_SEGMENT_SECONDS = 7;
const SPLIT_SEARCH_SECONDS = 2;
const MIN_SEGMENT_SECONDS = 4;

// 说话过程中每隔这么久就对当前未结束的语音做一次部分识别，让文字实时出现（最小间隔）
const PARTIAL_INTERVAL_SECONDS = 0.6;
// 检测到语音时，部分识别向前回看的时长（弥补 VAD 确认偏晚）
const PARTIAL_LOOKBACK_SECONDS = 0.6;
// 部分识别单次最多回看的音频时长：防止长句/连续说话时重复解码的窗口无限增长，
// 否则单次解码会超过实时、拖垮宿主线程，导致 VAD 段迟迟无法闭合（不出定稿、不翻译）
const PARTIAL_MAX_WINDOW_SECONDS = 8;

// 定稿抢救的最短段长：段长达到该值仍解码不出实文时，用最近一次 partial 文本抢救定稿
// （见 finalizeSegment）；更短的段按噪音丢弃。
const SALVAGE_MIN_SECONDS = 2;

// 连续重复达到这个次数才视为退化（复读机幻觉），折叠
const REPEAT_MIN = 4;
// 折叠后保留的份数（保留少量，既不刷屏又能看出原文带重复）
const REPEAT_KEEP = 2;
// 重复检测的最大单元长度（覆盖单字到短词的复读，如「快快…」「公公…」「ABAB…」）
const REPEAT_MAX_UNIT = 4;

// CJK 字符集合：平假名/片假名、CJK 扩展A+统一表意、兼容表意、半角片假名
const CJK = '\\u3040-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff\\uff66-\\uff9f';
// SenseVoice 对中日韩会逐 token 输出并夹空格，去掉 CJK 之间的空格
const CJK_SPACE_RE = new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'g');

function stripCjkSpaces(text: string): string {
  return text.replace(CJK_SPACE_RE, '$1');
}

function gramEqual(chars: string[], a: number, b: number, unit: number): boolean {
  for (let k = 0; k < unit; k++) {
    if (chars[a + k] !== chars[b + k]) return false;
  }
  return true;
}

/**
 * 折叠 ASR 退化产生的连续重复：同一段 1~REPEAT_MAX_UNIT 字的单元连续重复
 * 达到 REPEAT_MIN 次时，收敛为 REPEAT_KEEP 份。阈值偏保守，避免误伤
 * 「そうそう」「いいい」这类正常的少量重叠。
 */
function collapseRepeats(text: string): string {
  let chars = Array.from(text); // 按码点切分，避免破坏代理对
  for (let unit = 1; unit <= REPEAT_MAX_UNIT; unit++) {
    if (chars.length < unit * REPEAT_MIN) continue;
    const out: string[] = [];
    let i = 0;
    while (i < chars.length) {
      if (i + unit > chars.length) {
        out.push(chars[i]);
        i++;
        continue;
      }
      let count = 1;
      let j = i + unit;
      while (j + unit <= chars.length && gramEqual(chars, i, j, unit)) {
        count++;
        j += unit;
      }
      if (count >= REPEAT_MIN) {
        for (let k = 0; k < REPEAT_KEEP * unit; k++) out.push(chars[i + k]);
        i = j;
      } else {
        out.push(chars[i]);
        i++;
      }
    }
    chars = out;
  }
  return chars.join('');
}

/** ASR 原始文本后处理：去 CJK 空格 + 折叠复读机幻觉。导出供单元测试。 */
export function cleanAsrText(text: string): string {
  return collapseRepeats(stripCjkSpaces(text.trim()));
}

/**
 * 管线对推理引擎的最小依赖（由各端实现）：
 * macOS = sherpa-onnx-node（N-API），web = sherpa-onnx 单线程 WASM。
 * 管线只用 VAD 的瞬时探测结果自行切段，不消费 VAD 内部的段队列。
 */
export interface AsrInferenceEngine {
  /** 喂入一个 VAD_WINDOW_SIZE 采样的窗口 */
  acceptVadWindow(samples: Float32Array): void;
  /** VAD 当前是否探测到语音（逐帧瞬时状态） */
  isSpeechDetected(): boolean;
  /** 排空 VAD 内部段队列（管线不消费，排空防止其环形缓冲无限增长） */
  drainVad(): void;
  /** 冲刷 VAD 内部状态（录音结束时） */
  flushVad(): void;
  /** 对一段音频做整段离线识别，返回原始文本与语言标记（如 "<|zh|>"，不做清理） */
  transcribe(samples: Float32Array): { text: string; lang: string };
}

export interface PipelineCallbacks {
  onSegment: (segment: SegmentPayload) => void;
  onPartial?: (partial: PartialPayload) => void;
}

interface HistoryChunk {
  start: number;
  samples: Float32Array;
}

export class TranscriptionPipeline {
  private readonly engine: AsrInferenceEngine;
  private readonly onSegment: (segment: SegmentPayload) => void;
  private readonly onPartial: (partial: PartialPayload) => void;

  // VAD 要求按固定窗口大小喂数据，这里做积攒
  private pending = new Float32Array(0);
  // 最近音频的历史缓冲
  private historyChunks: HistoryChunk[] = [];
  private totalSamples = 0;

  // 定稿段序号（引擎宿主内自增；宿主下发前可改写为跨会话单调的行 id）
  private segmentId = 0;

  // 本次录音会话的起始采样位置：segment.start 以此为基线换算成会话内相对秒数。
  // 引擎宿主跨会话复用时 totalSamples 只增不减，靠基线而非清零来对齐会话起点。
  private sessionBase = 0;

  // 切段 / 部分识别状态
  private speechActive = false; // 当前是否处于一段语音中
  private segStart = 0; // 当前未闭合语音段的起始采样（含句首回看）
  private speechEnd = 0; // 最近一次检测到语音的采样位置（用于静音去抖与段尾）
  private partialFloor = 0; // 已最终确定的音频边界，部分识别不回看到此之前
  private lastPartialAt = 0; // 上次做部分识别时的 totalSamples
  // 最近一次有实文的 partial 结果：定稿解码无实文时用于抢救长段（见 finalizeSegment）
  private lastPartial: { text: string; lang: string } | null = null;
  private partialGap = Math.round(PARTIAL_INTERVAL_SECONDS * SAMPLE_RATE); // 自适应间隔（采样）

  constructor(engine: AsrInferenceEngine, callbacks: PipelineCallbacks) {
    this.engine = engine;
    this.onSegment = callbacks.onSegment;
    this.onPartial = callbacks.onPartial ?? (() => {});
  }

  private rememberHistory(samples: Float32Array): void {
    this.historyChunks.push({ start: this.totalSamples, samples: samples.slice() });
    this.totalSamples += samples.length;
    const cutoff = this.totalSamples - MAX_HISTORY_SECONDS * SAMPLE_RATE;
    while (
      this.historyChunks.length > 0 &&
      this.historyChunks[0].start + this.historyChunks[0].samples.length < cutoff
    ) {
      this.historyChunks.shift();
    }
  }

  /** 从历史缓冲取出 [from, to) 区间的采样，越界部分忽略 */
  private historySlice(from: number, to: number): Float32Array {
    const out = new Float32Array(Math.max(0, to - from));
    for (const chunk of this.historyChunks) {
      const begin = Math.max(from, chunk.start);
      const end = Math.min(to, chunk.start + chunk.samples.length);
      if (begin < end) {
        out.set(chunk.samples.subarray(begin - chunk.start, end - chunk.start), begin - from);
      }
    }
    return out;
  }

  /** @param samples 16kHz 单声道 */
  acceptWaveform(samples: Float32Array): void {
    this.rememberHistory(samples);
    const merged = new Float32Array(this.pending.length + samples.length);
    merged.set(this.pending);
    merged.set(samples, this.pending.length);

    let offset = 0;
    while (offset + VAD_WINDOW_SIZE <= merged.length) {
      this.engine.acceptVadWindow(merged.subarray(offset, offset + VAD_WINDOW_SIZE));
      offset += VAD_WINDOW_SIZE;
    }
    this.pending = merged.slice(offset);
    // 我们只用 VAD 的瞬时探测判定语音/静音，自己按历史缓冲切段；
    // VAD 内部完成的段不再使用，排空以释放其环形缓冲
    this.engine.drainVad();
    this.updateSpeech();
  }

  /** 录音结束时调用，把未闭合的语音段定稿 */
  flush(): void {
    this.engine.flushVad();
    this.engine.drainVad();
    if (this.speechActive) {
      this.finalizeSegment(this.segStart, this.totalSamples);
      this.speechActive = false;
    }
    this.onPartial({ text: '' });
  }

  /**
   * 开始新一次录音会话：计时基线重置为当前采样位置，segment.start 自此从 0 计。
   * 会丢弃上一会话未闭合的语音段状态，确保 reset 后不再定稿出跨会话或负时间戳的段。
   */
  reset(): void {
    this.sessionBase = this.totalSamples;
    // 上一会话的音频全部视为已定稿：句首回看与部分识别都不会跨进上一会话的尾音
    this.partialFloor = this.totalSamples;
    // 丢弃上一会话残留的不足一个 VAD 窗口的样本，避免跨会话串音
    this.pending = new Float32Array(0);
    // 丢弃上一会话未闭合的语音段：切段状态对齐到当前位置。否则旧段随后定稿时
    // segStart < sessionBase 会算出负的 start，且音频跨越两次会话。
    this.speechActive = false;
    this.segStart = this.totalSamples;
    this.speechEnd = this.totalSamples;
  }

  /**
   * 基于 VAD 瞬时探测自行切段：
   * - 静音→语音：开一段（起点向前回看，弥补 VAD 确认偏晚导致的句首截字）
   * - 语音→静音并持续 MIN_SILENCE_SECONDS：定稿当前段（段尾取最后有语音处）
   * - 一直无自然停顿且段超过 MAX_SEGMENT_SECONDS：在最近音频的能量最低点兜底断句
   * 段内周期性做部分识别，文字实时出现。
   */
  private updateSpeech(): void {
    const detected = this.engine.isSpeechDetected();

    if (detected) {
      if (!this.speechActive) {
        this.speechActive = true;
        const lookback = Math.round(PARTIAL_LOOKBACK_SECONDS * SAMPLE_RATE);
        this.segStart = Math.max(this.partialFloor, this.totalSamples - lookback);
        this.lastPartialAt = 0;
        this.partialGap = Math.round(PARTIAL_INTERVAL_SECONDS * SAMPLE_RATE);
      }
      this.speechEnd = this.totalSamples;

      // 兜底：无自然停顿导致段过长时，在最近一段里找能量最低点切，尽量切在词间而非半词
      if (this.totalSamples - this.segStart >= MAX_SEGMENT_SECONDS * SAMPLE_RATE) {
        const earliest = this.segStart + Math.round(MIN_SEGMENT_SECONDS * SAMPLE_RATE);
        const from = Math.max(earliest, this.totalSamples - Math.round(SPLIT_SEARCH_SECONDS * SAMPLE_RATE));
        const cut = this.quietestPoint(from, this.totalSamples);
        this.finalizeSegment(this.segStart, cut);
        this.segStart = cut;
      }
      this.maybePartial();
    } else if (this.speechActive) {
      // 静音去抖：连续静音达到 MIN_SILENCE_SECONDS 才断句（段尾取最后有语音处，
      // 不含尾随静音）。词间/换气的瞬时 false 不会触发，避免一句被切成碎片。
      if (this.totalSamples - this.speechEnd >= MIN_SILENCE_SECONDS * SAMPLE_RATE) {
        this.speechActive = false;
        this.finalizeSegment(this.segStart, this.speechEnd);
        this.onPartial({ text: '' });
      }
    }
  }

  /** 在历史缓冲 [from, to) 内找能量最低的 100ms 窗口，返回其中心采样位置（作为切点） */
  private quietestPoint(from: number, to: number): number {
    const win = Math.round(0.1 * SAMPLE_RATE);
    if (to - from <= win) return to;
    const audio = this.historySlice(from, to);
    const hop = Math.round(win / 2);
    let bestOffset = 0;
    let bestEnergy = Infinity;
    for (let i = 0; i + win <= audio.length; i += hop) {
      let e = 0;
      for (let k = 0; k < win; k++) e += audio[i + k] * audio[i + k];
      if (e < bestEnergy) {
        bestEnergy = e;
        bestOffset = i;
      }
    }
    return from + bestOffset + Math.floor(win / 2);
  }

  /** 段内周期性部分识别（自适应降频 + 回看窗口封顶） */
  private maybePartial(): void {
    if (this.totalSamples - this.lastPartialAt < this.partialGap) return;
    const maxWindow = PARTIAL_MAX_WINDOW_SECONDS * SAMPLE_RATE;
    const from = Math.max(this.segStart, this.totalSamples - maxWindow);
    const audio = this.historySlice(from, this.totalSamples);
    const t0 = Date.now();
    const result = this.transcribe(audio);
    const decodeSamples = ((Date.now() - t0) / 1000) * SAMPLE_RATE;
    // 自适应降频：部分识别约只占用 2/3 时间，给 VAD/音频处理留余量（慢机自动降频）
    this.partialGap = Math.max(
      Math.round(PARTIAL_INTERVAL_SECONDS * SAMPLE_RATE),
      Math.round(decodeSamples * 1.5)
    );
    if (result.text) {
      this.onPartial({ text: result.text });
      // 留作定稿失败时的抢救文本（见 finalizeSegment）：记录本次 partial 及其语言
      this.lastPartial = result;
    }
    this.lastPartialAt = this.totalSamples;
  }

  /** 把历史缓冲 [from, to) 这段音频定稿为一个最终段 */
  private finalizeSegment(from: number, to: number): void {
    if (to <= from) return;
    // 该段已最终确定，部分识别不应再回看到它之前
    this.partialFloor = to;

    const audio = this.historySlice(from, to);
    let result = this.transcribe(audio);
    if (!result.text || !/[\p{L}\p{N}]/u.test(result.text)) {
      // 定稿解码无实文（整段重解码与逐次 partial 是独立两遍，结果可能不同）。
      // 长段（说明确实在说话，且识别区已给用户看过 partial 文本）用最近一次 partial 抢救定稿，
      // 避免整段无声丢失——用户看到的文字消失且历史里不留痕迹；
      // 短段维持丢弃（短噪音常被识别成「。」，本过滤即为此而设）。
      const salvageable =
        to - from >= SALVAGE_MIN_SECONDS * SAMPLE_RATE &&
        this.lastPartial &&
        /[\p{L}\p{N}]/u.test(this.lastPartial.text);
      if (!salvageable) {
        this.lastPartial = null;
        this.onPartial({ text: '' }); // 无确定文本被丢弃：清空识别区，回到「聆听中」
        return;
      }
      result = this.lastPartial!;
    }
    this.lastPartial = null;

    // 有结果时不在此处清 partial：整段最终解码是独立的一遍、比逐次 partial 慢，
    // 若解码前就清空识别区，会先空、解码完才上屏，造成"识别区文字消失→确定句延迟出现"的断档。
    // 改由 onSegment 到达时清（UI 收到 segment 即清 partial），让识别文字向下淡出与确定句落入同刻发生。
    this.onSegment({
      id: this.segmentId++,
      text: result.text,
      lang: result.lang,
      start: (from - this.sessionBase) / SAMPLE_RATE, // 相对本次录音会话起点（秒）
      duration: (to - from) / SAMPLE_RATE,
    });
  }

  /** 引擎原始输出的统一清理：文本去噪 + 剥离 SenseVoice 的 <|zh|> 语言标记 */
  private transcribe(samples: Float32Array): { text: string; lang: string } {
    const raw = this.engine.transcribe(samples);
    return {
      text: cleanAsrText(raw.text || ''),
      lang: (raw.lang || '').replace(/[<|>]/g, ''),
    };
  }
}
