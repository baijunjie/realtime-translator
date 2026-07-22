import { describe, it, expect } from 'vitest';
import {
  TranscriptionPipeline,
  cleanAsrText,
  SAMPLE_RATE,
  type AsrInferenceEngine,
} from './transcription-pipeline';
import type { SegmentPayload, AsrCommitStrategy } from '../types';

// ============================================================================
// 简单假引擎：VAD 探测由测试逐步设置，识别结果固定返回（不带 tokens/timestamps
// → core 判定为无时间戳，走 fallback：不滑动、尾部截断窗口）。用于切段/一致提交/
// 定稿逻辑等不依赖窗口滑动的用例。
// ============================================================================
class FakeEngine implements AsrInferenceEngine {
  detected = false;
  result: { text: string; lang: string } = { text: '你好世界', lang: '<|zh|>' };
  acceptVadWindow(): void {}
  isSpeechDetected(): boolean {
    return this.detected;
  }
  drainVad(): void {}
  flushVad(): void {}
  transcribe(): { text: string; lang: string } {
    return this.result;
  }
}

const CHUNK = SAMPLE_RATE / 10; // 0.1s，模拟真实的流式喂入粒度

interface Harness {
  engine: FakeEngine;
  pipeline: TranscriptionPipeline;
  segments: SegmentPayload[];
  partials: string[];
  /** 以 detected 状态喂入 seconds 秒音频（可指定每个采样的振幅） */
  feed(seconds: number, detected: boolean, amplitude?: number): void;
}

function makeHarness(): Harness {
  const engine = new FakeEngine();
  const segments: SegmentPayload[] = [];
  const partials: string[] = [];
  const pipeline = new TranscriptionPipeline(engine, {
    onSegment: (seg) => segments.push(seg),
    onPartial: (p) => partials.push(p.text),
  });
  return {
    engine,
    pipeline,
    segments,
    partials,
    feed(seconds, detected, amplitude = 0.5) {
      engine.detected = detected;
      const chunks = Math.round((seconds * SAMPLE_RATE) / CHUNK);
      for (let i = 0; i < chunks; i++) {
        const samples = new Float32Array(CHUNK).fill(amplitude);
        pipeline.acceptWaveform(samples);
      }
    },
  };
}

// ============================================================================
// 可编程假引擎：透传 tokens/timestamps（→ core 启用窗口滑动）。喂入的音频用「样本值 =
// 绝对采样序号 + 1」编码（补零在尾部为 0，可区分），引擎据 samples[0] 反解出本次解码
// 窗口的起点，交给 respond 按 [起点秒, 终点秒] 返回结果，从而精确断言引擎收到的音频区间。
// ============================================================================
interface DecodeResult {
  text: string;
  lang?: string;
  tokens?: string[];
  timestamps?: number[];
  durations?: number[];
}
class RampEngine implements AsrInferenceEngine {
  detected = false;
  respond: (startSec: number, endSec: number) => DecodeResult = () => ({ text: '' });
  calls: { startSec: number; endSec: number; text: string }[] = [];
  acceptVadWindow(): void {}
  isSpeechDetected(): boolean {
    return this.detected;
  }
  drainVad(): void {}
  flushVad(): void {}
  transcribe(samples: Float32Array): DecodeResult & { lang: string } {
    let n = samples.length;
    while (n > 0 && samples[n - 1] === 0) n--; // 去掉尾部补零
    if (n === 0) return { text: '', lang: '' }; // 纯补零输入（空窗口定稿），无内容
    const startSec = (samples[0] - 1) / SAMPLE_RATE; // 值 = 绝对序号 + 1
    const endSec = startSec + n / SAMPLE_RATE;
    const r = this.respond(startSec, endSec);
    this.calls.push({ startSec, endSec, text: r.text });
    return { text: r.text, lang: r.lang ?? '<|ja|>', tokens: r.tokens, timestamps: r.timestamps, durations: r.durations };
  }
}

interface RampHarness {
  engine: RampEngine;
  pipeline: TranscriptionPipeline;
  segments: SegmentPayload[];
  partials: string[];
  /** 喂入 seconds 秒「斜坡编码」音频（样本值=绝对序号+1，供引擎反解窗口） */
  feed(seconds: number, detected: boolean): void;
}

function makeRampHarness(strategy: AsrCommitStrategy = 'agreement'): RampHarness {
  const engine = new RampEngine();
  const segments: SegmentPayload[] = [];
  const partials: string[] = [];
  const pipeline = new TranscriptionPipeline(
    engine,
    {
      onSegment: (seg) => segments.push(seg),
      onPartial: (p) => partials.push(p.text),
    },
    strategy,
  );
  let fed = 0; // 已喂入采样总数（与管线 totalSamples 同步，用作绝对序号）
  return {
    engine,
    pipeline,
    segments,
    partials,
    feed(seconds, detected) {
      engine.detected = detected;
      const chunks = Math.round((seconds * SAMPLE_RATE) / CHUNK);
      for (let i = 0; i < chunks; i++) {
        const samples = new Float32Array(CHUNK);
        for (let k = 0; k < CHUNK; k++) samples[k] = fed++ + 1;
        pipeline.acceptWaveform(samples);
      }
    },
  };
}

// 按「绝对时间 → 字」的 token 时间表构造稳定解码器：同一绝对时间总解出同一字（模型稳定），
// 返回窗口 [startSec, endSec) 内的字及其相对本窗起点的时间戳。
function scheduleDecode(schedule: { t: number; ch: string }[], dur = 0.4) {
  return (startSec: number, endSec: number): DecodeResult => {
    const tokens: string[] = [];
    const timestamps: number[] = [];
    const durations: number[] = [];
    let text = '';
    for (const { t, ch } of schedule) {
      if (t >= startSec - 1e-6 && t < endSec - 1e-6) {
        tokens.push(ch);
        timestamps.push(Math.round((t - startSec) * 1000) / 1000);
        durations.push(dur);
        text += ch;
      }
    }
    return { text, tokens, timestamps, durations, lang: '<|ja|>' };
  };
}

// 虚拟均匀转写：第 i 个字在绝对时间 i*DT 说出。
const DT = 0.4;
const VCHARS = Array.from('あいうえおかきくけこさしすせそたちつてとなにぬねの'); // 25 字 = 0..9.6s
const virtualDecode = scheduleDecode(
  VCHARS.map((ch, i) => ({ t: i * DT, ch })),
  DT,
);
/** 虚拟转写在 [0, endSec) 的完整文本（用作无丢失断言的期望值）。 */
function virtualUpTo(endSec: number): string {
  let s = '';
  for (let i = 0; i < VCHARS.length; i++) if (i * DT < endSec - 1e-6) s += VCHARS[i];
  return s;
}

describe('TranscriptionPipeline 切段', () => {
  it('静音→语音→静音：按去抖阈值定稿，start 含句首回看、段尾不含尾随静音', () => {
    const h = makeHarness();
    h.feed(1.0, false); // 1s 静音
    h.feed(2.0, true); // 2s 语音（探测从 1.1s 的块起生效）
    h.feed(0.5, false); // 静音 >0.35s 触发定稿

    expect(h.segments).toHaveLength(1);
    const seg = h.segments[0];
    expect(seg.id).toBe(0);
    expect(seg.text).toBe('你好世界');
    expect(seg.lang).toBe('zh'); // <|zh|> 标记已剥离
    // 语音在 1.1s 处首次被探测到，句首回看 0.6s → start=0.5s
    expect(seg.start).toBeCloseTo(0.5, 5);
    // 段尾取最后有语音的位置（3.0s），不含尾随静音 → duration=2.5s
    expect(seg.duration).toBeCloseTo(2.5, 5);
    // 定稿后识别区被清空
    expect(h.partials[h.partials.length - 1]).toBe('');
    // 语音过程中出过实时部分识别
    expect(h.partials).toContain('你好世界');
  });

  it('词间小停顿（< 去抖阈值）不断句', () => {
    const h = makeHarness();
    h.feed(1.0, true);
    h.feed(0.2, false); // 0.2s < 0.35s，不应触发定稿
    h.feed(1.0, true);
    expect(h.segments).toHaveLength(0);
    h.feed(0.5, false);
    expect(h.segments).toHaveLength(1); // 两段语音并成一段
  });

  it('reset 后新会话的 start 从会话起点重新计，id 保持单调', () => {
    const h = makeHarness();
    h.feed(1.0, false);
    h.feed(2.0, true);
    h.feed(0.5, false);
    h.pipeline.flush();
    expect(h.segments).toHaveLength(1);

    h.pipeline.reset();
    h.feed(0.5, false);
    h.feed(1.5, true);
    h.feed(0.5, false);

    expect(h.segments).toHaveLength(2);
    const seg2 = h.segments[1];
    // 会话基线生效：不叠加第一会话的 ~3.5s 音频时长
    expect(seg2.start).toBeGreaterThanOrEqual(0);
    expect(seg2.start).toBeLessThan(1.0);
    expect(seg2.duration).toBeGreaterThan(1.0);
    expect(seg2.id).toBe(1);
  });

  it('说话中途未 flush 直接 reset：丢弃未闭合段，新会话段 start ≥ 0 且不跨会话', () => {
    const h = makeHarness();
    h.feed(1.0, false); // 静音
    h.feed(2.0, true); // 说话中，尚未静音断句，段仍未闭合
    expect(h.segments).toHaveLength(0);

    // stop/start 交错时 reset 可能先于 flush 到达：未 flush 直接 reset
    h.pipeline.reset();

    // 继续喂新会话音频并正常断句
    h.feed(0.5, false);
    h.feed(1.5, true);
    h.feed(0.5, false);

    // 只产出新会话的一段，旧的未闭合段被丢弃（未定稿成跨会话段）
    expect(h.segments).toHaveLength(1);
    const seg = h.segments[0];
    // 新会话段从会话起点计，start 不为负、不叠加上一会话音频时长
    expect(seg.start).toBeGreaterThanOrEqual(0);
    expect(seg.start).toBeLessThan(1.0);
    expect(seg.id).toBe(0);
  });

  it('空段与纯标点段被丢弃且清空识别区', () => {
    for (const text of ['', '。', '！？…']) {
      const h = makeHarness();
      h.engine.result = { text, lang: '<|zh|>' };
      h.feed(1.0, true);
      h.feed(0.5, false);
      expect(h.segments).toHaveLength(0);
      expect(h.partials[h.partials.length - 1]).toBe('');
    }
  });

  it('flush 把未闭合的语音段定稿到末尾', () => {
    const h = makeHarness();
    h.feed(1.5, true);
    expect(h.segments).toHaveLength(0); // 尚未静音，段未闭合
    h.pipeline.flush();
    expect(h.segments).toHaveLength(1);
    expect(h.segments[0].start + h.segments[0].duration).toBeCloseTo(1.5, 5);
    expect(h.partials[h.partials.length - 1]).toBe('');
  });
});

describe('cleanAsrText', () => {
  it('去掉 CJK 字符之间的空格，保留拉丁词间空格', () => {
    expect(cleanAsrText('你 好 世 界')).toBe('你好世界');
    expect(cleanAsrText('こん にちは')).toBe('こんにちは');
    expect(cleanAsrText('hello world')).toBe('hello world');
    expect(cleanAsrText('中文 mixed words 中文')).toBe('中文 mixed words 中文');
  });

  it('折叠达到阈值的连续重复，保留少量重复痕迹', () => {
    expect(cleanAsrText('快快快快快')).toBe('快快'); // 5 连 ≥4 → 保留 2 份
    expect(cleanAsrText('ABABABABAB')).toBe('ABAB'); // 双字单元 5 连 → 保留 2 份
    expect(cleanAsrText('公司公司公司公司去了')).toBe('公司公司去了');
  });

  it('少量正常重叠不被误伤', () => {
    expect(cleanAsrText('そうそう')).toBe('そうそう');
    expect(cleanAsrText('いいい')).toBe('いいい'); // 3 连 < 阈值 4
    expect(cleanAsrText('快快快')).toBe('快快快');
  });

  it('按码点处理，代理对（emoji）不被拆坏', () => {
    expect(cleanAsrText('😀😀😀😀😀')).toBe('😀😀');
  });
});

describe('一致前缀提交（LocalAgreement-2）', () => {
  it('解码震荡（长句→はい→长句）：已提交前缀不回退，定稿不输出坍缩结果', () => {
    const h = makeHarness();
    // 提交「こんにちは」
    h.engine.result = { text: 'こんにちは', lang: '<|ja|>' };
    h.feed(1.4, true);
    // 解码坍缩为「はい」：与已提交前缀不一致，不得回退、不得展示坍缩文本
    h.engine.result = { text: 'はい', lang: '<|ja|>' };
    h.feed(0.7, true);
    expect(h.partials).not.toContain('はい');
    // 解码恢复并延伸到「こんにちは世界」：提交前缀延长
    h.engine.result = { text: 'こんにちは世界', lang: '<|ja|>' };
    h.feed(1.4, true);
    // 定稿时再次坍缩为「はい」：以已提交前缀为准，不采纳坍缩定稿
    h.engine.result = { text: 'はい', lang: '<|ja|>' };
    h.feed(0.5, false);

    expect(h.segments).toHaveLength(1);
    expect(h.segments[0].text).toBe('こんにちは世界');
  });

  it('定稿 tail 以已提交前缀为前缀（正常延伸）→ 取 tail', () => {
    const h = makeHarness();
    h.engine.result = { text: '前半部分', lang: '<|ja|>' };
    h.feed(2, true); // 提交「前半部分」
    h.engine.result = { text: '前半部分の続きです', lang: '<|ja|>' };
    h.feed(0.5, false); // 定稿尾部解码延伸
    expect(h.segments).toHaveLength(1);
    expect(h.segments[0].text).toBe('前半部分の続きです');
  });

  it('定稿 tail 与已提交前缀不一致且更短（坍缩）→ 保底取已提交前缀', () => {
    const h = makeHarness();
    h.engine.result = { text: '完全な文章です', lang: '<|ja|>' };
    h.feed(2, true); // 提交「完全な文章です」
    h.engine.result = { text: 'はい', lang: '<|ja|>' };
    h.feed(0.5, false); // 定稿坍缩，弃 tail 保底
    expect(h.segments).toHaveLength(1);
    expect(h.segments[0].text).toBe('完全な文章です');
  });

  it('定稿 tail 与已提交前缀不一致但更长（表记改写）→ 取 tail，整句不丢', () => {
    const h = makeHarness();
    h.engine.result = { text: 'みなさんこんにちは', lang: '<|ja|>' };
    h.feed(2, true); // 提交「みなさんこんにちは」
    // 定稿解码把前缀改写（み→皆）并覆盖后续整句：是对同一段音频更完整的一次性解码
    h.engine.result = { text: '皆さんこんにちは、本日はよろしく', lang: '<|ja|>' };
    h.feed(0.5, false);
    expect(h.segments).toHaveLength(1);
    expect(h.segments[0].text).toBe('皆さんこんにちは、本日はよろしく');
  });

  it('句末标点随窗口增长被改写（。→、）不卡死提交', () => {
    const h = makeHarness();
    h.engine.result = { text: 'こんにちは。', lang: '<|ja|>' };
    h.feed(1.4, true); // 提交「こんにちは」（尾部句号不落定）
    h.engine.result = { text: 'こんにちは、証券投資部です', lang: '<|ja|>' };
    h.feed(1.4, true); // 。改写为、并延伸，提交前缀应能继续延长
    h.feed(0.5, false);
    expect(h.segments).toHaveLength(1);
    expect(h.segments[0].text).toBe('こんにちは、証券投資部です');
  });

  it('CJK 逐 token 空格漂移不卡死提交', () => {
    const h = makeHarness();
    h.engine.result = { text: '本日 は', lang: '<|ja|>' };
    h.feed(1.4, true); // 提交「本日は」（CJK 间空格归一）
    h.engine.result = { text: '本日 はよろしく', lang: '<|ja|>' }; // 空格位置漂移 + 延伸
    h.feed(1.4, true);
    h.feed(0.5, false);
    expect(h.segments).toHaveLength(1);
    expect(h.segments[0].text).toBe('本日はよろしく');
  });
});

describe('窗口滑动（污染逐出）', () => {
  it('提交足够后 windowStart 前移，旧音频不再进入后续解码输入，且全程无丢失', () => {
    const h = makeRampHarness();
    h.engine.respond = virtualDecode;
    h.feed(6, true); // 6s 连续语音（<7s 强切阈值，隔离窗口滑动逻辑）
    h.feed(0.6, false); // 静音定稿

    // 至少滑动过一次：出现过起点显著大于 0 的解码窗口
    expect(h.engine.calls.some((c) => c.startSec >= 2.5)).toBe(true);
    // 窗口不无界增长：任一次解码窗口时长受滑动约束（远低于 fallback 的 8s 截断）
    expect(h.engine.calls.every((c) => c.endSec - c.startSec <= 4.5)).toBe(true);
    // 污染逐出：进入语音后段（endSec≥5s）的解码窗口起点已越过早期音频
    expect(h.engine.calls.filter((c) => c.endSec >= 5).every((c) => c.startSec >= 2.5)).toBe(true);
    // 无丢失：定稿文本 = 截至段尾的完整虚拟转写
    expect(h.segments).toHaveLength(1);
    expect(h.segments[0].text).toBe(virtualUpTo(6.0));
  });
});

describe('停滞保护', () => {
  it('持续不一致（音频解不出）时窗口不无界增长', () => {
    const h = makeRampHarness();
    let n = 0;
    // 每次解码返回不同文本（首字符即不同）→ 一致前缀恒为空、永不提交
    h.engine.respond = () => {
      n++;
      return { text: `${n}号目です`, tokens: ['x', 'y', 'z'], timestamps: [0, 0.1, 0.2], durations: [0.1, 0.1, 0.1] };
    };
    h.feed(25, true); // 25s 连续说话；无停滞保护会让窗口长到 ~25s
    // 窗口被停滞保护钳制在 ~8s 量级（触发滑动的那一 tick 略超 8s，之后回落）
    expect(h.engine.calls.every((c) => c.endSec - c.startSec <= 9)).toBe(true);
    // 确实增长过（不是每次都很短）——证明是「增长到上限再回落」而非从不增长
    expect(h.engine.calls.some((c) => c.endSec - c.startSec >= 7)).toBe(true);
  });
});

describe('长行强切', () => {
  it('切在提交边界：两行拼接无重复无丢失，时间轴相接不重叠', () => {
    const h = makeRampHarness();
    h.engine.respond = virtualDecode;
    h.feed(9, true); // 9s 连续说话，7s 处触发强切
    h.feed(0.6, false); // 静音定稿第二行

    expect(h.segments).toHaveLength(2);
    const [a, b] = h.segments;
    // 拼接无重复无丢失 = 截至段尾的完整虚拟转写
    expect(a.text + b.text).toBe(virtualUpTo(9.0));
    // 切点即提交边界：第二行紧接第一行，无重叠回看
    expect(b.start).toBeCloseTo(a.start + a.duration, 1);
    expect(a.start).toBeCloseTo(0, 5);
  });
});

describe('翻供重基（模型改写窗口内已提交前缀）', () => {
  it('新读法连续两次一致且更长：重基前缀恢复提交与滑动，定稿采用新读法无丢失', () => {
    const h = makeRampHarness();
    const oldReading = scheduleDecode(Array.from('あいう').map((ch, i) => ({ t: i * 0.4, ch })));
    const newReading = scheduleDecode(
      Array.from('かきくけこさしすせそ').map((ch, i) => ({ t: i * 0.4, ch })),
    );
    // 前 2s 解出旧读法并提交；之后模型对同一段音频整体翻供为更长的新读法且保持稳定
    // （对应实测的 み→皆 表记改写：拒绝重基会永久卡死提交，最终停滞丢弃整句）
    h.engine.respond = (s, e) => (e <= 2.0 ? oldReading(s, e) : newReading(s, e));
    h.feed(6, true);
    h.feed(0.6, false);

    expect(h.segments).toHaveLength(1);
    // 旧读法被新读法整体取代，行内容完整（无卡死 → 无停滞丢弃）
    expect(h.segments[0].text).toBe('かきくけこさしすせそ');
    // 重基后提交恢复流动，窗口继续滑动（未卡死在行首）
    expect(h.engine.calls.some((c) => c.startSec >= 3)).toBe(true);
  });

  it('坍缩型翻供（输出变短）：不重基不滑动，定稿保底已提交前缀', () => {
    const h = makeRampHarness();
    const fullReading = scheduleDecode(
      Array.from('あいうえおかき').map((ch, i) => ({ t: i * 0.2, ch })),
      0.2,
    );
    // 前 2.5s 稳定解出完整读法并提交；之后解码坍缩为固定短文本（污染窗口的典型退化）
    h.engine.respond = (s, e) =>
      e <= 2.5
        ? fullReading(s, e)
        : { text: 'はい', tokens: ['は', 'い'], timestamps: [0, 0.4], durations: [0.4, 0.4] };
    h.feed(4.5, true);
    // 坍缩文本从不推进滑动：所有解码窗口都自行首
    expect(h.engine.calls.every((c) => c.startSec === 0)).toBe(true);
    h.feed(0.6, false);
    expect(h.segments).toHaveLength(1);
    expect(h.segments[0].text).toBe('あいうえおかき');
  });
});

describe('chunk 提交（自回归 transducer 定长分块）', () => {
  it('窗口积累到块长即整块提交并前移窗口，切点选在块内可信停顿的下一 token 起点前', () => {
    const h = makeRampHarness('chunk');
    // token 时间表：0~1.2s 每 0.4s 一字，之后停顿（1.6~2.4 无 token），2.4s 起继续每 0.4s
    // 一字。首块在窗口达块长（3s）的 tick 触发：块内停顿间隙 0.8s ≥ 可信停顿阈值 →
    // 切点 = 下一 token 起点 2.4 − 发射滞后回退 0.1 = 2.3s
    const head = Array.from('あいうえ').map((ch, i) => ({ t: i * 0.4, ch }));
    const rest = Array.from('おかきくけこさし').map((ch, i) => ({ t: 2.4 + i * 0.4, ch }));
    h.engine.respond = scheduleDecode([...head, ...rest]);
    h.feed(6.0, true);
    h.feed(0.6, false);

    // 块提交后窗口前移到停顿处（2.3s 附近），后续解码不再包含已提交音频
    expect(h.engine.calls.some((c) => Math.abs(c.startSec - 2.3) < 0.1)).toBe(true);
    // 定稿无重复无丢失
    expect(h.segments).toHaveLength(1);
    expect(h.segments[0].text).toBe('あいうえおかきくけこさし');
  });

  it('空块（解不出文本）也前移窗口，防无界增长', () => {
    const h = makeRampHarness('chunk');
    // 首个 tick 有实文（确立引擎有时间戳），之后全部解空
    h.engine.respond = (s, e) =>
      e <= 0.7 ? { text: 'あ', tokens: ['あ'], timestamps: [0.1], durations: [0.3] } : { text: '' };
    h.feed(20, true);
    // 空块每次在窗口达块长时前移：解码窗口有界（不随 20s 语音无限增长）
    expect(h.engine.calls.every((c) => c.endSec - c.startSec <= 5)).toBe(true);
    h.feed(0.6, false);
    expect(h.segments).toHaveLength(0); // 全程无实文 → 行被 blip 过滤丢弃
  });

  it('fallback（无 timestamps）：不做块提交，定稿走尾部解码，文本完整', () => {
    const h = makeRampHarness('chunk');
    h.engine.respond = (s, e) => ({ text: virtualDecode(s, e).text }); // 去掉 tokens/timestamps
    h.feed(5, true);
    h.feed(0.6, false);
    // 从不前移窗口：所有解码都自行首
    expect(h.engine.calls.every((c) => c.startSec === 0)).toBe(true);
    expect(h.segments).toHaveLength(1);
    expect(h.segments[0].text).toBe(virtualUpTo(5.0));
  });

  it('长行强切：切在块提交边界，两行拼接无重复无丢失', () => {
    const h = makeRampHarness('chunk');
    h.engine.respond = virtualDecode;
    h.feed(9, true); // 9s 连续说话：~4s 处块提交，7s 处强切
    h.feed(0.6, false);

    expect(h.segments).toHaveLength(2);
    const [a, b] = h.segments;
    expect(a.text + b.text).toBe(virtualUpTo(9.0));
    // 切点即块提交边界：两行时间轴相接，无重叠回看
    expect(b.start).toBeCloseTo(a.start + a.duration, 1);
  });

  it('短窗解码震荡只影响展示，不进已提交文本与定稿', () => {
    const h = makeRampHarness('chunk');
    // 行首增长窗（起点 0）未达块长（3s）时解码震荡；达块长的提交解码与行中解码稳定
    let flip = false;
    h.engine.respond = (s, e) => {
      if (s === 0 && e - s < 2.9) {
        flip = !flip;
        return {
          text: flip ? 'はい' : 'ええと',
          tokens: ['は', 'い'],
          timestamps: [0, 0.2],
          durations: [0.2, 0.2],
        };
      }
      return virtualDecode(s, e);
    };
    h.feed(6, true);
    h.feed(0.6, false);

    // 震荡文本出现在过程展示里（正常），但不落进定稿
    expect(h.partials.some((p) => p.includes('はい') || p.includes('ええと'))).toBe(true);
    expect(h.segments).toHaveLength(1);
    expect(h.segments[0].text).toBe(virtualUpTo(6.0));
    expect(h.segments[0].text).not.toContain('はい');
  });
});

describe('fallback（引擎无 timestamps）', () => {
  it('不滑动窗口，仍能一致提交并定稿出完整文本', () => {
    const h = makeRampHarness();
    // 稳定转写但不带 tokens/timestamps → core 判定无时间戳，走 fallback
    h.engine.respond = (s, e) => {
      const v = virtualDecode(s, e);
      return { text: v.text }; // 去掉 tokens/timestamps
    };
    h.feed(5, true);
    h.feed(0.6, false);

    // 从不滑动：所有解码窗口都自行首（起点恒为 0）
    expect(h.engine.calls.every((c) => c.startSec === 0)).toBe(true);
    expect(h.segments).toHaveLength(1);
    expect(h.segments[0].text).toBe(virtualUpTo(5.0));
  });
});

describe('最短解码时长（过短输入补零，防原生层崩溃）', () => {
  it('任何一次送引擎解码的音频都不短于 0.5s', () => {
    const h = makeHarness();
    const received: number[] = [];
    const orig = h.engine.transcribe.bind(h.engine);
    h.engine.transcribe = (samples: Float32Array) => {
      received.push(samples.length);
      return orig(samples);
    };
    // 场景：上一段定稿后新语音立即开始（首个窗口极短）+ 极短语音段定稿
    h.engine.result = { text: '第一段', lang: '<|ja|>' };
    h.feed(3, true);
    h.feed(0.5, false); // 定稿第一段
    h.feed(0.1, true); // 新段仅 0.1s 即静音（超短解码窗口）
    h.feed(0.5, false);
    h.pipeline.flush();
    expect(received.length).toBeGreaterThan(0);
    for (const n of received) {
      expect(n).toBeGreaterThanOrEqual(0.5 * SAMPLE_RATE);
    }
  });
});
