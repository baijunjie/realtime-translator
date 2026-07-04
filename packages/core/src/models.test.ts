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

  it('每个模型 approxBytes 等于其文件字节之和（ASR 每文件登记字节）', () => {
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

  it('web 平台含专用模型（sense-voice + 各语言专用）', () => {
    expect(asrModelsFor('zh', 'web').map((m) => m.id)).toEqual(['sense-voice', 'paraformer-zh']);
    expect(asrModelsFor('ja', 'web').map((m) => m.id)).toEqual([
      'sense-voice',
      'zipformer-ja-reazonspeech',
    ]);
    expect(asrModelsFor('en', 'web').map((m) => m.id)).toEqual([
      'sense-voice',
      'parakeet-tdt-0.6b-v2-en',
    ]);
  });

  it('ios 平台仅 sense-voice', () => {
    expect(asrModelsFor('zh', 'ios').map((m) => m.id)).toEqual(['sense-voice']);
    expect(asrModelsFor('ja', 'ios').map((m) => m.id)).toEqual(['sense-voice']);
    expect(asrModelsFor('en', 'ios').map((m) => m.id)).toEqual(['sense-voice']);
  });
});

describe('ASR 按端分源 URL（native 自托管优先 + HF 兜底；web HF 上游）', () => {
  const GH_BASE = 'https://github.com/baijunjie/realtime-translator/releases/download/models-v1/';

  it('公共依赖 VAD：nativeUrls 为自托管无前缀资产；web 用同源静态资源覆盖，故 webUrls 为空', () => {
    expect(SILERO_VAD.nativeUrls).toEqual([`${GH_BASE}silero_vad.onnx`]);
    expect(SILERO_VAD.webUrls).toEqual([]);
  });

  it('各模型文件：nativeUrls[0] 为自托管资产（modelId- 前缀 + 原文件名），native 兜底 = web 上游；web 平台模型带上游 HF csukuangfj webUrls', () => {
    for (const m of ASR_MODELS) {
      for (const f of m.files) {
        // native 首选自托管，扁平命名 `<modelId>-<原文件名>`。
        expect(f.nativeUrls[0]).toBe(`${GH_BASE}${m.id}-${f.filename}`);
        // 全部 ASR 模型 platforms 均含 web，故都带上游 webUrls（HF csukuangfj resolve 直链，以原文件名结尾）。
        expect(m.platforms).toContain('web');
        expect(f.webUrls.length).toBeGreaterThan(0);
        for (const u of f.webUrls) {
          expect(u).toMatch(/^https:\/\/[^/]+\/csukuangfj\/.+\/resolve\/main\//);
          expect(u.endsWith(f.filename)).toBe(true);
        }
        // native 兜底段（自托管之后）与 web 上游同款。
        expect(f.nativeUrls.slice(1)).toEqual(f.webUrls);
      }
    }
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
