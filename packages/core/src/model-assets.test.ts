// 模型资产源治理的单元测试：自托管 GitHub Release 源的 URL 构造。
import { describe, expect, it } from 'vitest';
import { ghModelAsset } from './model-assets';

describe('ghModelAsset', () => {
  it('拼接自托管 GitHub Release（models-v1）的扁平资产直链', () => {
    expect(ghModelAsset('silero_vad.onnx')).toBe(
      'https://github.com/baijunjie/realtime-translator/releases/download/models-v1/silero_vad.onnx',
    );
    expect(ghModelAsset('sense-voice-model.int8.onnx')).toBe(
      'https://github.com/baijunjie/realtime-translator/releases/download/models-v1/sense-voice-model.int8.onnx',
    );
  });
});
