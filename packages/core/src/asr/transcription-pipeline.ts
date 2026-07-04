// 平台无关的实时转写管线：16kHz 单声道 PCM 输入，输出文本段。
//
// 流程: 音频 -> Silero VAD 切出语音段 -> 滑动窗口解码 + 按模型分流的文本提交
//
// 行内文本提交按模型解码特性分两种策略（AsrModelSpec.commitStrategy，构造时注入）：
// - agreement（一致前缀提交，LocalAgreement-2）：适用解码前缀对增长窗口单调稳定的
//   非自回归模型（SenseVoice/paraformer）。对随提交前移的窗口反复解码，只把「连续
//   两次解码一致的前缀」当作已提交文本单调落定；已提交音频随窗口滑出解码输入，
//   交叠语音污染的窗口前缀由此被逐出，不再随窗口增长而放大坍缩。
// - chunk（定长分块提交）：适用增长窗口下输出非单调、会震荡坍缩的自回归 transducer
//   （zipformer/NeMo TDT）。行内 tick 解码只用于展示、不做前缀落定；窗口积累到定长
//   就把当次解码整块提交，切点选在块尾 token 间隙最大处（近似词边界），窗口前移。
//
// 两种策略共用同一骨架：VAD 切段、历史缓冲、解码调度、断行定稿（只对未提交尾部补解
// 一次，不再整段重解码下注）、长行强切（切点即提交边界）、文本清理与全部调参常量。
// 三端只需实现 AsrInferenceEngine（macOS = sherpa-onnx-node，web = sherpa-onnx WASM），
// 调参改一处即三端生效。本文件不得引入 Node/DOM 依赖（跑在 utilityProcess 与 Web Worker 里）。
//
// 引擎需透传 token 级时间戳（tokens/timestamps）以支持窗口滑动与块切点定位；接不通的端
// 返回空即可，管线自动退化为「尾部截断窗口、无行中提交推进」的 fallback，行为不比整窗解码差。
import type { SegmentPayload, PartialPayload, AsrCommitStrategy } from '../types';

export const SAMPLE_RATE = 16000;
export const VAD_WINDOW_SIZE = 512;

// 断句主依据：连续静音达到该时长就断句。isSpeechDetected() 是逐帧瞬时状态，词间/换气
// 会瞬间转 false，用它去抖：值偏小 = 断句更勤、定稿/翻译更快；过小会把一句切碎。
// 各端构造 VAD 时的 minSilenceDuration 也用它，保持探测与去抖一致。
export const MIN_SILENCE_SECONDS = 0.35;

// 历史缓冲上限（秒），用于段前回补与滑动窗口的历史音频取用。
const MAX_HISTORY_SECONDS = 60;

// 长行强切上限：一直无自然停顿（极快语速）时行会无限增长、迟迟不断句。行时长达到该值
// 且已有滑出窗口的已提交文本时，就在「已提交/窗口」的边界处直接断行——切点即提交边界，
// 天然落在已确定的词之间，无边界词损失。
const MAX_SEGMENT_SECONDS = 7;

// 说话过程中每隔这么久解码一次，让文字实时出现（最小间隔）
const PARTIAL_INTERVAL_SECONDS = 0.6;
// 检测到语音时，起点向前回看的时长（弥补 VAD 确认偏晚导致的句首截字）
const PARTIAL_LOOKBACK_SECONDS = 0.6;
// 解码窗口的尾部上限（秒）：fallback（引擎无时间戳、无法滑动）时用它截断窗口，
// 防止长句/连续说话时解码窗口无限增长拖垮宿主线程。有时间戳时靠滑动与停滞保护控窗。
const PARTIAL_MAX_WINDOW_SECONDS = 8;

// 窗口滑动阈值：已提交前缀覆盖的音频时长达到该值就把窗口前移，将已定稿音频逐出解码输入。
const WINDOW_COMMIT_SLIDE_SECONDS = 3;
// 压力滑动：交叠语音下解码震荡会拖慢提交，窗口迟迟攒不满常规滑动阈值、污染前缀随窗口
// 一路增长。窗口长度达到 PRESSURE 时滑动阈值降为 MIN——已确认多少就先逐出多少，
// 遏制窗口继续膨胀（正常语速下提交很快达到常规阈值，走不到这档）。
const WINDOW_PRESSURE_SECONDS = 6;
const WINDOW_COMMIT_SLIDE_MIN_SECONDS = 1;
// 滑动切点取已提交末尾 token 的结束时刻（= 下一 token 起点）：已提交音频已保存进
// committedDone，不再需要留在窗口里，切净以免其尾音被重新解码、重复提交（下一个未提交
// token 的起音正好保留在新窗口内）。故不留回退余量。
const SLIDE_SAFETY_SECONDS = 0;

// 停滞保护：窗口超过该时长且连续多个 tick 无提交进展（音频确实解不出）时，强制把窗口
// 前移到 now-STALL_KEEP，放弃解不出的音频段，防止窗口无界增长。
const STALL_WINDOW_SECONDS = 8;
const STALL_KEEP_SECONDS = 4;
const STALL_MIN_TICKS = 3;

// chunk 提交（自回归 transducer 专用，见 AsrCommitStrategy）：窗口积累到该时长就把当次
// tick 的解码整块提交。取 3s：reazonspeech 对 3s 定长窗解码连贯，窗口再长（4s+）就开始
// 整块坍缩（自回归解码对长窗不稳），A/B 实测 3s 块能保住 4s 块丢掉的句首整句；
// 过小则块间边界密、拼接毛刺多。
const CHUNK_SECONDS = 3;
// chunk 切点搜索区：在块尾这么长的范围内找相邻 token 间隙最大处作为切点（近似词边界，
// 避免裸切块尾把正在说的词拦腰截断）。
const CHUNK_CUT_SEARCH_SECONDS = 1.5;
// token 时长的缺省估计（秒）：部分模型不回传 durations（reazon 返回空数组），
// 间隙计算与块尾切点用该值近似 token 终点。
const EST_TOKEN_DUR_SECONDS = 0.2;
// 切点相对下一 token 起点的回退（秒）：transducer 的 token 时间戳是发射时刻、相对声学
// 起点偏晚，略往前切让下一 token 的起音完整落入新窗口（已提交侧不受影响——其 token
// 文本已整体落定）。
const CHUNK_CUT_BACKOFF_SECONDS = 0.1;
// 只有间隙达到该值才算可信停顿、可作块内切点：transducer 发射时刻抖动会造出零散的
// 假间隙，在假间隙处切会把下一个词切伤；无可信停顿时退回块尾切点（切在末 token 终点，
// 语流紧凑处不冒进）。
const CHUNK_MIN_PAUSE_SECONDS = 0.25;

// 单次解码的最短输入时长：transducer 类模型（zipformer/NeMo）的卷积下采样对过短输入
// 会在原生层抛异常——JS 无法捕获，识别子进程直接终止（实测 reazonspeech zipformer 的
// 崩溃边界为 0.1s，取 0.5s 留裕量）。不足时补零凑齐再解码，对识别结果无影响。
const MIN_DECODE_SECONDS = 0.5;

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
// sherpa BPE token 的词边界标记（U+2581），重建文本时还原为空格
const WORD_BOUNDARY = /▁/g;

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

/** ASR 原始文本后处理：去 CJK 空格 + 折叠复读机幻觉。仅用于展示与定稿，导出供单元测试。 */
export function cleanAsrText(text: string): string {
  return collapseRepeats(stripCjkSpaces(text.trim()));
}

/** 剥离 SenseVoice 的 <|zh|> 语言标记，得到裸语言码。 */
function cleanLang(lang: string | null): string {
  return (lang || '').replace(/[<|>]/g, '');
}

/** 两字符串按码点计的最长公共前缀（CJK 无分词问题，代理对不被拆坏）。 */
function commonCodePointPrefix(a: string, b: string): string {
  const aa = Array.from(a);
  const bb = Array.from(b);
  const n = Math.min(aa.length, bb.length);
  let i = 0;
  while (i < n && aa[i] === bb[i]) i++;
  return aa.slice(0, i).join('');
}

// 提交前剥离尾部的标点与空白：句末标点会随窗口增长被模型改写（如 SenseVoice 把
// 「こんにちは。」修订为「こんにちは、証券…」，。→、），一旦把它当已提交前缀落定，后续
// 解码就不再以该前缀开头，提交与展示都会永久卡死。故只提交到最后一个实义字符，标点由断行
// 时的尾部解码补齐（内部标点仍会随后续实义字符一并提交，不受影响）。
const TRAILING_UNSTABLE_RE = /[\s\p{P}\p{S}]+$/u;
function trimTrailingUnstable(text: string): string {
  return text.replace(TRAILING_UNSTABLE_RE, '');
}

/**
 * 用 tokens/timestamps 定位「已提交前缀 committed」覆盖到的最后一个完整 token：
 * 逐 token 累加重建文本（BPE 词边界 ▁ 还原为空格），找到累计码点数不超过 committed
 * 码点数的最后一个 token，返回 { cutLen, endSec }：
 *   cutLen —— 该 token 结束处的码点数（<= committed 码点数）；
 *   endSec —— 该 token 结束时间（秒，相对本次解码输入起点，取下一 token 起点为其末尾）。
 * tokens/timestamps 缺失或长度不匹配时返回 null（调用方走 fallback，不滑动）。
 */
function alignCommitted(
  committed: string,
  tokens?: string[],
  timestamps?: number[],
  durations?: number[],
): { cutLen: number; endSec: number } | null {
  if (!tokens || !timestamps || tokens.length === 0 || timestamps.length !== tokens.length) {
    return null;
  }
  const target = Array.from(committed).length;
  let acc = 0;
  let lastIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    let surf = tokens[i].replace(WORD_BOUNDARY, ' ');
    // sherpa 的 text 字段会 trim 首个词边界产生的前导空格，重建时同样去掉，避免拉丁文本错位 1 位
    if (i === 0) surf = surf.replace(/^ /, '');
    const len = Array.from(surf).length;
    if (acc + len <= target) {
      acc += len;
      lastIdx = i;
    } else {
      break;
    }
  }
  if (lastIdx < 0) return null;
  const endSec =
    lastIdx + 1 < timestamps.length
      ? timestamps[lastIdx + 1]
      : timestamps[lastIdx] + (durations?.[lastIdx] ?? 0.2);
  return { cutLen: acc, endSec };
}

/**
 * chunk 提交的切点选择：在块尾搜索区（最后 CHUNK_CUT_SEARCH_SECONDS）内找相邻 token
 * 间隙最大处（gap = 下一 token 起点 − 当前 token 终点，终点缺 durations 时按
 * EST_TOKEN_DUR_SECONDS 估计），近似词边界；「最后一个 token 之后到块尾」也作为候选
 * （覆盖块尾静音，并保证 token 存在时必有切点）。间隙相同取最靠后者（多提交）。
 * 切点位置取下一 token 起点（减去发射滞后回退）而非间隙中点——保证切点不落在已提交
 * token 的音频内部，新窗口从下一 token 的起音开始，块边界既不重复也不丢字。
 * 返回 { text, cutSec }：text 为切点前全部 token 重建的提交文本（BPE 词边界 ▁ 还原为
 * 空格，首块的前导空格由展示/定稿的 clean 吸收）；cutSec 为窗口前移量（秒，相对本次
 * 解码输入起点）。tokens/timestamps 不可用时返回 null（本 tick 不提交，停滞保护兜底）。
 */
function findChunkCut(
  winLen: number,
  tokens?: string[],
  timestamps?: number[],
  durations?: number[],
): { text: string; cutSec: number } | null {
  if (!tokens || !timestamps || tokens.length === 0 || timestamps.length !== tokens.length) {
    return null;
  }
  const n = tokens.length;
  // token 终点：起点 + 时长（缺省估计），钳在 [自身起点, 下一 token 起点/块尾] 内
  const tokenEnd = (i: number): number => {
    const cap = i + 1 < n ? timestamps[i + 1] : winLen;
    const dur = durations?.[i] ?? EST_TOKEN_DUR_SECONDS;
    return Math.min(Math.max(timestamps[i] + dur, timestamps[i]), cap);
  };
  const searchFrom = winLen - CHUNK_CUT_SEARCH_SECONDS;
  let best: { count: number; cutSec: number; gap: number } | null = null;
  for (let i = 0; i < n - 1; i++) {
    if (timestamps[i + 1] < searchFrom) continue; // 间隙落在搜索区之前
    const end = tokenEnd(i);
    const gap = timestamps[i + 1] - end;
    if (gap < CHUNK_MIN_PAUSE_SECONDS) continue; // 非可信停顿（发射抖动的假间隙），不切
    const cutSec = Math.max(end, timestamps[i + 1] - CHUNK_CUT_BACKOFF_SECONDS);
    if (!best || gap >= best.gap) {
      best = { count: i + 1, cutSec, gap };
    }
  }
  if (best) return finishCut(tokens, best.count, best.cutSec);
  // 无可信停顿：退回块尾切点——提交全部 token，切在末 token 终点（估计），末 token 之后
  // 尚未发射成词的音频留在新窗口。
  return finishCut(tokens, n, tokenEnd(n - 1));
}

/** 组装 chunk 提交结果：切点前 count 个 token 重建文本（BPE 词边界 ▁ 还原为空格）。 */
function finishCut(
  tokens: string[],
  count: number,
  cutSec: number,
): { text: string; cutSec: number } {
  return { text: tokens.slice(0, count).join('').replace(WORD_BOUNDARY, ' '), cutSec };
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
  /**
   * 对一段音频做整段离线识别，返回原始文本与语言标记（如 "<|zh|>"，不做清理）。
   * tokens/timestamps 为 token 级文本与其起始时间（秒，相对本次输入音频起点），供窗口滑动
   * 定位已提交前缀覆盖的音频边界；引擎不产出时可省略，管线走 fallback（不滑动）。
   * durations 为各 token 时长（秒），可选，用于估算末尾 token 的结束时间。
   */
  transcribe(samples: Float32Array): {
    text: string;
    lang: string;
    tokens?: string[];
    timestamps?: number[];
    durations?: number[];
  };
}

export interface PipelineCallbacks {
  onSegment: (segment: SegmentPayload) => void;
  onPartial?: (partial: PartialPayload) => void;
}

interface HistoryChunk {
  start: number;
  samples: Float32Array;
}

interface RawDecode {
  text: string;
  lang: string;
  tokens?: string[];
  timestamps?: number[];
  durations?: number[];
}

export class TranscriptionPipeline {
  private readonly engine: AsrInferenceEngine;
  private readonly onSegment: (segment: SegmentPayload) => void;
  private readonly onPartial: (partial: PartialPayload) => void;
  // 行内文本提交策略（按模型解码特性选择，见文件头与 AsrModelSpec.commitStrategy）
  private readonly commitStrategy: AsrCommitStrategy;

  // VAD 要求按固定窗口大小喂数据，这里做积攒
  private pending = new Float32Array(0);
  // 最近音频的历史缓冲
  private historyChunks: HistoryChunk[] = [];
  private totalSamples = 0;

  // 定稿段序号（引擎宿主内自增；宿主下发前可改写为跨会话单调的行 id）
  private segmentId = 0;

  // 本次录音会话的起始采样位置：segment.start 以此为基线换算成会话内相对秒数。
  private sessionBase = 0;

  // 引擎是否透传可用的 token 时间戳：首次出现非空解码时判定；null=未定，false=走 fallback。
  private engineHasTimestamps: boolean | null = null;

  // ===== VAD / 静音跟踪 =====
  private speechActive = false; // 当前是否处于一段语音中
  private speechEnd = 0; // 最近一次检测到语音的采样位置（用于静音去抖与段尾）
  private partialFloor = 0; // 已最终确定的音频边界，句首回看不越过此点
  private lastPartialAt = 0; // 上次解码时的 totalSamples
  private partialGap = Math.round(PARTIAL_INTERVAL_SECONDS * SAMPLE_RATE); // 自适应间隔（采样）

  // ===== 行（line）状态 =====
  private lineStart = 0; // 本行起始采样（segment.start 基线，滑动不改它）
  private windowStart = 0; // 当前解码窗口起点（随提交前移）
  private committedDone = ''; // 已滑出窗口的已提交文本（原始，本行内单调只增）
  private committedInWindow = ''; // 当前窗口内已提交的前缀（原始）
  private prevDecode: string | null = null; // 上一次解码文本（同一 windowStart 下才可比）
  private lineLang: string | null = null; // 本行语言（取首个非空解码的 lang）
  private noProgressTicks = 0; // 连续无提交进展的 tick 数（停滞保护用）

  constructor(
    engine: AsrInferenceEngine,
    callbacks: PipelineCallbacks,
    commitStrategy: AsrCommitStrategy = 'agreement',
  ) {
    this.engine = engine;
    this.onSegment = callbacks.onSegment;
    this.onPartial = callbacks.onPartial ?? (() => {});
    this.commitStrategy = commitStrategy;
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
      this.finalizeLine(this.totalSamples);
      this.speechActive = false;
    }
    this.onPartial({ text: '' });
  }

  /**
   * 开始新一次录音会话：计时基线重置为当前采样位置，segment.start 自此从 0 计。
   * 会丢弃上一会话未闭合的行状态，确保 reset 后不再定稿出跨会话或负时间戳的段。
   */
  reset(): void {
    this.sessionBase = this.totalSamples;
    // 上一会话的音频全部视为已定稿：句首回看不会跨进上一会话的尾音
    this.partialFloor = this.totalSamples;
    // 丢弃上一会话残留的不足一个 VAD 窗口的样本，避免跨会话串音
    this.pending = new Float32Array(0);
    this.speechActive = false;
    this.speechEnd = this.totalSamples;
    this.lineStart = this.totalSamples;
    this.windowStart = this.totalSamples;
    this.resetLine();
  }

  /** 清空行内提交/解码状态（定稿或强切后调用）。 */
  private resetLine(): void {
    this.committedDone = '';
    this.committedInWindow = '';
    this.prevDecode = null;
    this.lineLang = null;
    this.noProgressTicks = 0;
  }

  /**
   * 基于 VAD 瞬时探测自行切段：
   * - 静音→语音：开一行（起点向前回看，弥补 VAD 确认偏晚导致的句首截字）
   * - 语音→静音并持续 MIN_SILENCE_SECONDS：定稿当前行（段尾取最后有语音处）
   * - 一直无自然停顿且行超过 MAX_SEGMENT_SECONDS：在已提交边界强切
   * 行内周期性解码并按提交策略落定文本，文字实时出现。
   */
  private updateSpeech(): void {
    const detected = this.engine.isSpeechDetected();

    if (detected) {
      if (!this.speechActive) {
        this.speechActive = true;
        const lookback = Math.round(PARTIAL_LOOKBACK_SECONDS * SAMPLE_RATE);
        this.lineStart = Math.max(this.partialFloor, this.totalSamples - lookback);
        this.windowStart = this.lineStart;
        this.lastPartialAt = 0;
        this.partialGap = Math.round(PARTIAL_INTERVAL_SECONDS * SAMPLE_RATE);
        this.resetLine();
      }
      this.speechEnd = this.totalSamples;

      // 长行强切：无自然停顿导致行过长时，在已提交/窗口边界处直接断行（切点即提交边界）。
      if (
        this.totalSamples - this.lineStart >= MAX_SEGMENT_SECONDS * SAMPLE_RATE &&
        /[\p{L}\p{N}]/u.test(cleanAsrText(this.committedDone))
      ) {
        this.forceSplit();
      }
      this.maybeDecode();
    } else if (this.speechActive) {
      // 静音去抖：连续静音达到 MIN_SILENCE_SECONDS 才断句（段尾取最后有语音处，
      // 不含尾随静音）。词间/换气的瞬时 false 不会触发，避免一句被切成碎片。
      if (this.totalSamples - this.speechEnd >= MIN_SILENCE_SECONDS * SAMPLE_RATE) {
        this.speechActive = false;
        this.finalizeLine(this.speechEnd);
        this.onPartial({ text: '' });
      }
    }
  }

  /**
   * 行内一次解码 tick：解码当前窗口，按提交策略落定文本并推进窗口。
   * 沿用自适应节奏：解码耗时越长间隔越大，给 VAD/音频处理留余量（慢机自动降频）。
   */
  private maybeDecode(): void {
    if (this.totalSamples - this.lastPartialAt < this.partialGap) return;

    const now = this.totalSamples;
    // fallback（无时间戳、无法推进提交边界）用尾部窗口截断控窗；有时间戳时靠提交推进 +
    // 停滞保护控窗。
    const from =
      this.engineHasTimestamps === false
        ? Math.max(this.windowStart, now - PARTIAL_MAX_WINDOW_SECONDS * SAMPLE_RATE)
        : this.windowStart;
    const audio = this.historySlice(from, now);

    const t0 = Date.now();
    const cur = this.decodeRaw(audio);
    const decodeSamples = ((Date.now() - t0) / 1000) * SAMPLE_RATE;
    this.partialGap = Math.max(
      Math.round(PARTIAL_INTERVAL_SECONDS * SAMPLE_RATE),
      Math.round(decodeSamples * 1.5),
    );
    this.lastPartialAt = now;

    // 首次出现非空解码时判定引擎是否透传可用时间戳
    if (this.engineHasTimestamps === null && cur.text) {
      this.engineHasTimestamps = Array.isArray(cur.timestamps) && cur.timestamps.length > 0;
    }
    if (!this.lineLang && cur.text) this.lineLang = cleanLang(cur.lang);

    if (this.commitStrategy === 'chunk') {
      const progressed = this.chunkTick(cur, now);
      // chunk 的 fallback（确认无时间戳）不做停滞前移：窗口解码已被尾部截断限界，前移
      // 反而会丢弃 finalize 时本可整体补解的音频（agreement 的停滞不丢已提交文本，不受此限）。
      if (this.engineHasTimestamps !== false) this.maybeStall(now, false, progressed);
      return;
    }

    // 一致前缀单调提交：agreed 以 committedInWindow 为前缀且更长才落定；模型翻供则保持不动。
    // 提交前剥离尾部标点/空白，避免句末标点被改写后卡死提交（见 trimTrailingUnstable）。
    const agreed = trimTrailingUnstable(commonCodePointPrefix(this.prevDecode ?? '', cur.text));
    let progressed = false;
    if (agreed.length > this.committedInWindow.length && agreed.startsWith(this.committedInWindow)) {
      this.committedInWindow = agreed;
      progressed = true;
    }

    // 展示（滑动前，用当前状态）：已提交前缀保持稳定，只让未提交尾巴闪动。
    const shown = cur.text.startsWith(this.committedInWindow) ? cur.text : this.committedInWindow;
    this.onPartial({ text: cleanAsrText(this.committedDone + shown) });

    this.prevDecode = cur.text;

    const slid = this.trySlide(cur, now);
    this.maybeStall(now, slid, progressed);
  }

  /**
   * chunk 模式的一个解码 tick：解码结果只用于展示（短窗震荡只影响未提交尾巴的显示），
   * 窗口积累到 CHUNK_SECONDS 时把当次解码整块提交进 committedDone 并前移窗口。
   * 返回本 tick 是否推进了提交边界（供停滞保护判定）。
   */
  private chunkTick(cur: RawDecode, now: number): boolean {
    this.onPartial({ text: cleanAsrText(this.committedDone + cur.text) });
    if (this.engineHasTimestamps !== true) return false; // fallback：无块提交
    const winLen = (now - this.windowStart) / SAMPLE_RATE;
    if (winLen < CHUNK_SECONDS) return false;

    if (!cur.text) {
      // 空块：这段音频解不出文本（VAD 误开/纯噪声）。窗口照样前移防无界增长，只保留
      // 搜索区长度的尾巴（可能含刚起口、尚未成词的语音）。
      this.windowStart = Math.max(
        this.windowStart,
        now - Math.round(CHUNK_CUT_SEARCH_SECONDS * SAMPLE_RATE),
      );
      return true;
    }
    const cut = findChunkCut(winLen, cur.tokens, cur.timestamps, cur.durations);
    if (!cut) return false; // 本次解码缺 token 对齐信息：等下一 tick（停滞保护兜底）
    this.committedDone += cut.text;
    this.windowStart += Math.round(cut.cutSec * SAMPLE_RATE);
    return true;
  }

  /**
   * 窗口滑动（agreement 模式）：已提交前缀覆盖音频达到滑动阈值（常规 3s；窗口已偏长时
   * 降为压力档，见 WINDOW_PRESSURE_SECONDS）时，把 windowStart 前移到已提交末尾 token
   * 的结束时刻，已提交文本转入 committedDone，被污染的旧前缀随之滑出后续解码输入。
   * 返回是否发生滑动。
   */
  private trySlide(cur: RawDecode, now: number): boolean {
    if (this.engineHasTimestamps !== true || this.committedInWindow === '') return false;
    // 翻供 tick 不滑动：cur 不以已提交前缀开头时，其 token 序列与已提交文本并不对应，
    // 按码点数对齐会用错时间戳、把尚未提交的音频误切出窗口。
    if (!cur.text.startsWith(this.committedInWindow)) return false;
    const aligned = alignCommitted(this.committedInWindow, cur.tokens, cur.timestamps, cur.durations);
    const winLen = (now - this.windowStart) / SAMPLE_RATE;
    const threshold =
      winLen >= WINDOW_PRESSURE_SECONDS
        ? WINDOW_COMMIT_SLIDE_MIN_SECONDS
        : WINDOW_COMMIT_SLIDE_SECONDS;
    if (!aligned || aligned.endSec < threshold) return false;

    const cps = Array.from(this.committedInWindow);
    this.committedDone += cps.slice(0, aligned.cutLen).join('');
    this.committedInWindow = cps.slice(aligned.cutLen).join('');
    const advance = Math.max(0, Math.round((aligned.endSec - SLIDE_SAFETY_SECONDS) * SAMPLE_RATE));
    this.windowStart += advance;
    // 窗口变了，旧解码不可比
    this.prevDecode = null;
    return true;
  }

  /**
   * 停滞保护：窗口超 STALL_WINDOW 且连续多个 tick 无提交进展（音频确实解不出）时，强制把
   * windowStart 前移到 now-STALL_KEEP，放弃解不出的音频段，防止窗口无界增长。
   */
  private maybeStall(now: number, slid: boolean, progressed: boolean): void {
    if (slid || progressed) {
      this.noProgressTicks = 0;
      return;
    }
    this.noProgressTicks++;
    if (now - this.windowStart <= STALL_WINDOW_SECONDS * SAMPLE_RATE) return;
    if (this.noProgressTicks < STALL_MIN_TICKS) return;

    // 已提交文本不丢（转入 committedDone），仅放弃 committed 之后确实解不出的音频。
    this.committedDone += this.committedInWindow;
    this.committedInWindow = '';
    this.windowStart = Math.max(this.lineStart, now - Math.round(STALL_KEEP_SECONDS * SAMPLE_RATE));
    this.prevDecode = null;
    this.noProgressTicks = 0;
  }

  /**
   * 长行强切：把已滑出窗口的已提交文本 committedDone 定稿为一行（音频 [lineStart, windowStart]，
   * windowStart 即历次滑动累积到的提交边界）；committedInWindow 与未提交窗口原样延续为新行内容。
   * 切点落在已确定的提交边界上，无边界词损失。调用前已确认 committedDone 有实文。
   */
  private forceSplit(): void {
    const boundary = this.windowStart;
    this.onSegment({
      id: this.segmentId++,
      text: cleanAsrText(this.committedDone),
      lang: cleanLang(this.lineLang),
      start: (this.lineStart - this.sessionBase) / SAMPLE_RATE,
      duration: (boundary - this.lineStart) / SAMPLE_RATE,
    });
    this.partialFloor = boundary;
    // 新行从提交边界继续：committedInWindow / prevDecode / windowStart 原样保留，仅重置已滑出部分。
    this.lineStart = boundary;
    this.committedDone = '';
    this.noProgressTicks = 0;
  }

  /**
   * 断行定稿：对未提交区 [windowStart, to] 做一次尾部解码。tail 以 committedInWindow 为前缀
   * （正常延伸）则取 tail；否则取 committedInWindow（tail 坍缩，弃之保底）；committedInWindow
   * 为空（含 chunk 模式——它没有窗口内前缀概念）时直接取 tail。行文本 =
   * clean(committedDone + 上述结果)；无字母/数字则丢弃（噪声 blip 过滤）。
   */
  private finalizeLine(to: number): void {
    if (to <= this.lineStart) {
      this.resetLine();
      return;
    }
    this.partialFloor = to;

    const tail = this.decodeRaw(this.historySlice(this.windowStart, to));
    let finalUncommitted: string;
    if (this.committedInWindow === '') finalUncommitted = tail.text;
    else if (tail.text.startsWith(this.committedInWindow)) finalUncommitted = tail.text;
    else finalUncommitted = this.committedInWindow;

    const lineText = cleanAsrText(this.committedDone + finalUncommitted);
    const lang = cleanLang(this.lineLang ?? tail.lang);
    if (!/[\p{L}\p{N}]/u.test(lineText)) {
      this.resetLine();
      return;
    }
    this.onSegment({
      id: this.segmentId++,
      text: lineText,
      lang,
      start: (this.lineStart - this.sessionBase) / SAMPLE_RATE,
      duration: (to - this.lineStart) / SAMPLE_RATE,
    });
    this.resetLine();
  }

  /** 送引擎解码（含最短时长补零），返回原始文本/语言/token 时间戳（不做清理）。 */
  private decodeRaw(samples: Float32Array): RawDecode {
    // 过短输入补零到最短解码时长（见 MIN_DECODE_SECONDS：原生层对超短输入会崩掉子进程）
    const minSamples = Math.round(MIN_DECODE_SECONDS * SAMPLE_RATE);
    if (samples.length < minSamples) {
      const padded = new Float32Array(minSamples);
      padded.set(samples);
      samples = padded;
    }
    const raw = this.engine.transcribe(samples);
    return {
      // 先归一化 CJK 之间的空格：SenseVoice 逐 token 夹的空格会随窗口增长漂移，若用于一致
      // 前缀比较会导致「本日 は」与「本日 はよろし」不互为前缀而卡死提交。tokens 本身不含
      // 这些空格，归一化后与 token 重建的文本对齐一致；拉丁词间空格（稳定、有意义）保留。
      text: stripCjkSpaces(raw.text || ''),
      lang: raw.lang || '',
      tokens: raw.tokens,
      timestamps: raw.timestamps,
      durations: raw.durations,
    };
  }
}
