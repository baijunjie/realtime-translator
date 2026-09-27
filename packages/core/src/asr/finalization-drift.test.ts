import { describe, expect, it } from 'vitest';
import { FinalizationDriftTracker } from './finalization-drift';

const tracker = (): FinalizationDriftTracker => new FinalizationDriftTracker((text) => text);

describe('FinalizationDriftTracker', () => {
  it('普通定稿配对本段最长实时文本与 final', () => {
    const t = tracker();
    t.onPartial('短句');
    t.onPartial('较长的实时句子');
    t.onSegment('最终句子');
    t.onPartial('');
    expect(t.pairs).toEqual([{ partial: '较长的实时句子', final: '最终句子' }]);
  });

  it('实时文本被清空且没有 segment 时记录整段丢失', () => {
    const t = tracker();
    t.onPartial('整段实时文本');
    t.onPartial('');
    expect(t.pairs).toEqual([{ partial: '整段实时文本', final: '' }]);
  });

  it('长行强切只比较已确认前缀，并把实时尾巴带到下一段', () => {
    const t = tracker();
    t.onPartial('已确认前缀仍在继续');
    t.onSegment('已确认前缀');
    t.onPartial('仍在继续并完成');
    t.onSegment('仍在继续并完成');
    t.onPartial('');
    expect(t.pairs).toEqual([
      { partial: '已确认前缀', final: '已确认前缀' },
      { partial: '仍在继续并完成', final: '仍在继续并完成' },
    ]);
  });
});
