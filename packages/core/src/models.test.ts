// ASR 模型注册表的单元测试：查表、按语言/平台过滤、齐全性文件清单。
import { describe, expect, it } from 'vitest';
import {
  ASR_MODELS,
  DEFAULT_ASR_MODEL_ID,
  SILERO_VAD,
  asrModelsFor,
  getAsrModel,
  requiredAsrFiles,
} from './models';

describe('ASR 模型注册表', () => {
  it('默认模型存在、多语种且全平台可用', () => {
    const m = getAsrModel(DEFAULT_ASR_MODEL_ID);
    expect(m).toBeDefined();
    expect(m?.languages).toContain('auto');
    expect(m?.platforms).toEqual(expect.arrayContaining(['macos', 'web', 'ios']));
  });

  it('每个模型 approxBytes 等于其文件字节之和', () => {
    for (const m of ASR_MODELS) {
      const sum = m.files.reduce((acc, f) => acc + f.approxBytes, 0);
      expect(m.approxBytes).toBe(sum);
    }
  });

  it('getAsrModel 未知 id 返回 undefined', () => {
    expect(getAsrModel('nope')).toBeUndefined();
  });
});

describe('asrModelsFor', () => {
  it('auto 仅命中多语种模型', () => {
    expect(asrModelsFor('auto', 'macos').map((m) => m.id)).toEqual(['sense-voice']);
  });

  it('按语言+平台过滤（ja 在 macOS）', () => {
    const ids = asrModelsFor('ja', 'macos').map((m) => m.id);
    expect(ids).toContain('sense-voice');
    expect(ids).toContain('zipformer-ja-reazonspeech');
  });

  it('web / ios 平台仅 sense-voice', () => {
    expect(asrModelsFor('zh', 'web').map((m) => m.id)).toEqual(['sense-voice']);
    expect(asrModelsFor('ja', 'web').map((m) => m.id)).toEqual(['sense-voice']);
    expect(asrModelsFor('zh', 'ios').map((m) => m.id)).toEqual(['sense-voice']);
  });
});

describe('requiredAsrFiles', () => {
  it('含公共依赖 VAD + 该模型全部文件（POSIX 相对路径）', () => {
    const files = requiredAsrFiles('sense-voice');
    expect(files[0]).toBe('silero_vad.onnx');
    expect(files).toContain(
      'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/model.int8.onnx',
    );
    expect(files).toContain('sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/tokens.txt');
  });

  it('未知 id 仅返回 VAD', () => {
    expect(requiredAsrFiles('nope')).toEqual([SILERO_VAD.filename]);
  });
});
