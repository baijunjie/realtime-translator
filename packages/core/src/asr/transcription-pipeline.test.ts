import { describe, it, expect } from 'vitest';
import {
  TranscriptionPipeline,
  cleanAsrText,
  SAMPLE_RATE,
  type AsrInferenceEngine,
} from './transcription-pipeline';
import type { SegmentPayload } from '../types';

// 可编程假引擎：VAD 探测结果由测试逐步设置，识别结果固定返回。
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

  it('连续语音超过上限时在能量最低点兜底断句', () => {
    const h = makeHarness();
    h.engine.result = { text: 'test speech', lang: '<|en|>' };
    // 8s 连续语音，其中 [5.5s, 5.7s) 是低能量窗口（词间微停顿）
    h.engine.detected = true;
    const total = 8 * SAMPLE_RATE;
    const quietFrom = 5.5 * SAMPLE_RATE;
    const quietTo = 5.7 * SAMPLE_RATE;
    for (let at = 0; at < total; at += CHUNK) {
      const samples = new Float32Array(CHUNK);
      for (let k = 0; k < CHUNK; k++) {
        const pos = at + k;
        samples[k] = pos >= quietFrom && pos < quietTo ? 0 : 0.5;
      }
      h.pipeline.acceptWaveform(samples);
    }
    h.pipeline.flush();

    expect(h.segments).toHaveLength(2);
    // 第一段在 7s 上限触发时于最低能量处（~5.6s）切开，而非硬切在 7s
    expect(h.segments[0].start).toBeCloseTo(0, 5);
    expect(h.segments[0].duration).toBeGreaterThan(5.3);
    expect(h.segments[0].duration).toBeLessThan(5.9);
    // 第二段起点带 0.4s 重叠回看（跨切点的词完整落入下一段），随后直到 flush
    const cut = h.segments[0].duration;
    expect(h.segments[1].start).toBeCloseTo(cut - 0.4, 1);
    expect(h.segments[1].start + h.segments[1].duration).toBeCloseTo(8, 1);
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

describe('定稿抢救（定稿解码无实文时用最近 partial 顶替）', () => {
  it('长段定稿为空：用最近一次有实文的 partial 抢救，不丢段', () => {
    const h = makeHarness();
    // 说话 3s：期间 partial 正常出实文
    h.engine.result = { text: '这是前半句', lang: '<|zh|>' };
    h.feed(3, true);
    // 静音断句前把引擎切到「定稿解码为空」：模拟整段重解码偶发失败
    h.engine.result = { text: '', lang: '' };
    h.feed(0.5, false);
    expect(h.segments).toHaveLength(1);
    expect(h.segments[0].text).toBe('这是前半句');
    expect(h.segments[0].lang).toBe('zh');
  });

  it('长段定稿为纯标点：同样走抢救', () => {
    const h = makeHarness();
    h.engine.result = { text: '前半句内容', lang: '<|ja|>' };
    h.feed(3, true);
    h.engine.result = { text: '。', lang: '<|ja|>' };
    h.feed(0.5, false);
    expect(h.segments).toHaveLength(1);
    expect(h.segments[0].text).toBe('前半句内容');
  });

  it('短段（低于抢救阈值）定稿为空：维持丢弃（短噪音过滤语义不变）', () => {
    const h = makeHarness();
    h.engine.result = { text: '嗯', lang: '<|zh|>' };
    h.feed(1, true);
    h.engine.result = { text: '。', lang: '<|zh|>' };
    h.feed(0.5, false);
    expect(h.segments).toHaveLength(0);
  });

  it('抢救文本不跨段复用：上一段的 partial 不会救下一段', () => {
    const h = makeHarness();
    // 第一段正常定稿（消费掉 lastPartial）
    h.engine.result = { text: '第一段', lang: '<|zh|>' };
    h.feed(3, true);
    h.feed(0.5, false);
    // 第二段：partial 与定稿都无实文 → 丢弃，且不得借用第一段的文本
    h.engine.result = { text: '', lang: '' };
    h.feed(3, true);
    h.feed(0.5, false);
    expect(h.segments).toHaveLength(1);
    expect(h.segments[0].text).toBe('第一段');
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
    // 场景：上一段定稿后新语音立即开始（首个 partial 窗口极短）+ 极短语音段定稿
    h.engine.result = { text: '第一段', lang: '<|ja|>' };
    h.feed(3, true);
    h.feed(0.5, false); // 定稿第一段
    h.feed(0.1, true); // 新段仅 0.1s 即静音（超短 partial/定稿窗口）
    h.feed(0.5, false);
    h.pipeline.flush();
    expect(received.length).toBeGreaterThan(0);
    for (const n of received) {
      expect(n).toBeGreaterThanOrEqual(0.5 * SAMPLE_RATE);
    }
  });
});

describe('强切重叠回看', () => {
  it('强切后下一段起点相对切点向前重叠约 0.4s（相邻段时间轴重叠）', () => {
    const h = makeHarness();
    h.engine.result = { text: '连续快语速内容', lang: '<|ja|>' };
    // 连续说话 9s：7s 处触发强切出第一段，随后静音定稿第二段
    h.feed(9, true);
    h.feed(0.5, false);
    expect(h.segments).toHaveLength(2);
    const [a, b] = h.segments;
    const gap = b.start - (a.start + a.duration); // 第二段起点相对第一段终点
    expect(gap).toBeCloseTo(-0.4, 1); // 负值 = 重叠回看
  });
});

describe('坍缩定稿抢救（定稿远短于本段最佳 partial）', () => {
  it('交叠语音式坍缩：定稿只剩「はい」→ 最佳 partial 顶替 + 未覆盖尾部补解拼接', () => {
    const h = makeHarness();
    // partial 阶段给出完整长文（覆盖到 ~3s）
    h.engine.result = { text: 'こんにちは証券投資調査部の島田です', lang: '<|ja|>' };
    h.feed(3, true);
    // 后续 partial 与定稿都坍缩为短语
    h.engine.result = { text: 'はい', lang: '<|ja|>' };
    h.feed(3.5, true);
    h.feed(0.5, false);
    expect(h.segments).toHaveLength(1);
    // 定稿 = 最佳 partial + 尾部（[~3s, 段尾] 单独补解，此处引擎对该窗口返回「はい」）
    expect(h.segments[0].text).toBe('こんにちは証券投資調査部の島田ですはい');
  });

  it('尾部补解能救回最佳 partial 未覆盖的内容（如日期句）', () => {
    const h = makeHarness();
    // 前 3s：partial 解出自我介绍
    h.engine.result = { text: '岩井コスモ証券の島田です', lang: '<|ja|>' };
    h.feed(3, true);
    // 之后 partial 全部坍缩
    h.engine.result = { text: 'はい', lang: '<|ja|>' };
    h.feed(3.5, true);
    // 定稿阶段：整窗仍坍缩，但「尾部单独补解」（窗口 < 4s）返回日期句
    h.engine.transcribe = (samples: Float32Array) => {
      const secs = samples.length / SAMPLE_RATE;
      return secs < 4.5
        ? { text: '七月三日金曜日ですね', lang: '<|ja|>' }
        : { text: 'はい', lang: '<|ja|>' };
    };
    h.feed(0.5, false);
    expect(h.segments).toHaveLength(1);
    expect(h.segments[0].text).toBe('岩井コスモ証券の島田です七月三日金曜日ですね');
  });

  it('正常情形：定稿与最佳 partial 相当 → 保留定稿', () => {
    const h = makeHarness();
    h.engine.result = { text: 'まず指数から振り返っていきたいと思います', lang: '<|ja|>' };
    h.feed(5, true);
    h.feed(0.5, false);
    expect(h.segments).toHaveLength(1);
    expect(h.segments[0].text).toBe('まず指数から振り返っていきたいと思います');
  });

  it('最佳 partial 本身很短（低于最少码点）→ 不触发坍缩抢救', () => {
    const h = makeHarness();
    h.engine.result = { text: 'はい', lang: '<|ja|>' };
    h.feed(3, true);
    h.engine.result = { text: 'ええ', lang: '<|ja|>' };
    h.feed(0.5, false);
    expect(h.segments).toHaveLength(1);
    expect(h.segments[0].text).toBe('ええ');
  });
});
