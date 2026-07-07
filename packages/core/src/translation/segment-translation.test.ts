// translateFinalizedSegment 的反向翻译编排测试：识别语言为 auto 时，听到母语的段翻成上一次的外语。
import { describe, expect, it, vi } from 'vitest';
import { M2M100_SPEC } from './local-spec';
import {
  createReverseTranslationContext,
  resetReverseTranslationContext,
  translateFinalizedSegment,
  type SegmentTranslateRequest,
  type TranslateFinalizedSegmentOptions,
} from './segment-translation';
import type { TranslationPayload } from '../types';

/** 跑一条段：记录引擎收到的翻译请求与派发的译文事件，返回可断言的桩数据。 */
async function run(
  opts: Pick<TranslateFinalizedSegmentOptions, 'segment' | 'nativeLang' | 'asrLanguage' | 'reverse'> &
    Partial<TranslateFinalizedSegmentOptions>,
) {
  const requests: SegmentTranslateRequest[] = [];
  const emitted: TranslationPayload[] = [];
  const translate = vi.fn(async (req: SegmentTranslateRequest) => {
    requests.push(req);
    return `TR(${req.source}->${req.targetLang})`;
  });
  await translateFinalizedSegment({
    spec: M2M100_SPEC,
    enabled: true,
    translate,
    emitTranslation: (p) => emitted.push(p),
    ...opts,
  } as TranslateFinalizedSegmentOptions);
  return { requests, emitted, translate };
}

const seg = (lang: string, text = 'x', id = 1) => ({ id, text, lang });

describe('反向翻译编排（translateFinalizedSegment）', () => {
  it('auto 模式：外语段正向翻成母语，并记录为 lastForeignLang', async () => {
    const reverse = createReverseTranslationContext();
    const { requests } = await run({
      segment: seg('ja', 'こんにちは'),
      nativeLang: 'zh',
      asrLanguage: 'auto',
      reverse,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ source: 'ja', targetLang: 'zh', targetCode: 'zh' });
    expect(reverse.lastForeignLang).toBe('ja');
  });

  it('auto 模式：母语段在有外语历史时反向翻成上一次的外语', async () => {
    const reverse = createReverseTranslationContext();
    // 先听到日语，记录外语
    await run({ segment: seg('ja'), nativeLang: 'zh', asrLanguage: 'auto', reverse });
    // 再听到母语（中文）→ 反向翻成日语
    const { requests, emitted } = await run({
      segment: seg('zh', '你好', 2),
      nativeLang: 'zh',
      asrLanguage: 'auto',
      reverse,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ source: 'zh', targetLang: 'ja', targetCode: 'ja' });
    // 反向翻译走 translate 分支：先发 pending，再回填译文（无 zh 简体归一化）。
    expect(emitted[0]).toMatchObject({ id: 2, pending: true });
    expect(emitted[1]).toMatchObject({ id: 2, text: 'TR(zh->ja)' });
  });

  it('auto 模式：尚无外语历史时，母语段仍按现有逻辑跳过（不翻、不发事件）', async () => {
    const reverse = createReverseTranslationContext();
    const { requests, emitted } = await run({
      segment: seg('zh', '你好'),
      nativeLang: 'zh',
      asrLanguage: 'auto',
      reverse,
    });
    expect(requests).toHaveLength(0);
    expect(emitted).toHaveLength(0);
    expect(reverse.lastForeignLang).toBeNull();
  });

  it('指定识别语言（非 auto）：即便有外语历史，母语段也不反向翻译（保持跳过）', async () => {
    const reverse = createReverseTranslationContext();
    reverse.lastForeignLang = 'ja'; // 假设此前有过外语
    const { requests, emitted } = await run({
      segment: seg('zh', '你好'),
      nativeLang: 'zh',
      asrLanguage: 'ja',
      reverse,
    });
    expect(requests).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it('未传 reverse 状态：关闭反向翻译，母语段一律跳过（向后兼容）', async () => {
    const { requests, emitted } = await run({
      segment: seg('zh', '你好'),
      nativeLang: 'zh',
      asrLanguage: 'auto',
    });
    expect(requests).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it('lastForeignLang 随最新外语滚动更新', async () => {
    const reverse = createReverseTranslationContext();
    await run({ segment: seg('ja'), nativeLang: 'zh', asrLanguage: 'auto', reverse });
    expect(reverse.lastForeignLang).toBe('ja');
    await run({ segment: seg('en'), nativeLang: 'zh', asrLanguage: 'auto', reverse });
    expect(reverse.lastForeignLang).toBe('en');
    // 母语段反向翻到最新的外语（en），不影响历史
    const { requests } = await run({
      segment: seg('zh', '你好'),
      nativeLang: 'zh',
      asrLanguage: 'auto',
      reverse,
    });
    expect(requests[0]).toMatchObject({ source: 'zh', targetLang: 'en' });
  });

  it('外语历史只在本次会话内有效：reset 后母语段无可翻的外语、直接跳过', async () => {
    const reverse = createReverseTranslationContext();
    // 上一次会话听到过日语
    await run({ segment: seg('ja'), nativeLang: 'zh', asrLanguage: 'auto', reverse });
    expect(reverse.lastForeignLang).toBe('ja');
    // 新会话开始：清空外语历史
    resetReverseTranslationContext(reverse);
    expect(reverse.lastForeignLang).toBeNull();
    // 新会话第一句就是母语 → 无可翻的外语，不翻、不发事件
    const { requests, emitted } = await run({
      segment: seg('zh', '你好', 2),
      nativeLang: 'zh',
      asrLanguage: 'auto',
      reverse,
    });
    expect(requests).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it('中文母语反向翻译到粤语历史（yue）：走翻译分支，不误判为同语言跳过', async () => {
    const reverse = createReverseTranslationContext();
    // 粤语与中文视作不同语言 → 记录 yue 为外语
    await run({ segment: seg('yue', '早晨'), nativeLang: 'zh', asrLanguage: 'auto', reverse });
    expect(reverse.lastForeignLang).toBe('yue');
    const { requests } = await run({
      segment: seg('zh', '你好'),
      nativeLang: 'zh',
      asrLanguage: 'auto',
      reverse,
    });
    // 目标 yue 的模型码为 zh，但 targetLang 仍是 'yue'（云端提示词按之产出粤语）。
    expect(requests[0]).toMatchObject({ source: 'zh', targetLang: 'yue', targetCode: 'zh' });
  });
});
