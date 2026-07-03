// planTranslation / normalizeZh / hasAllWeightFiles 的单元测试：三端共用的判定逻辑。
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRANSLATION_MODEL_ID,
  LOCAL_TRANSLATION_MODELS,
  M2M100_SPEC,
  MBART50_SPEC,
  getTranslationModel,
  hasAllWeightFiles,
  normalizeZh,
  planTranslation,
  translationModelsFor,
} from './local-spec';

describe('hasAllWeightFiles 缓存完整性判据', () => {
  it('encoder + decoder 权重齐全（q8 带 _quantized 后缀）→ 完整', () => {
    const cached = [
      'https://huggingface.co/Xenova/m2m100_418M/resolve/main/onnx/encoder_model_quantized.onnx',
      'https://huggingface.co/Xenova/m2m100_418M/resolve/main/onnx/decoder_model_merged_quantized.onnx',
      'https://huggingface.co/Xenova/m2m100_418M/resolve/main/tokenizer.json',
    ];
    expect(hasAllWeightFiles(M2M100_SPEC, cached)).toBe(true);
  });

  it('只剩 encoder（decoder 被逐出）→ 不完整', () => {
    expect(hasAllWeightFiles(M2M100_SPEC, ['encoder_model_quantized.onnx'])).toBe(false);
  });

  it('只有非权重文件（tokenizer/config）→ 不完整', () => {
    expect(hasAllWeightFiles(M2M100_SPEC, ['tokenizer.json', 'config.json'])).toBe(false);
  });

  it('空列表 → 不完整', () => {
    expect(hasAllWeightFiles(M2M100_SPEC, [])).toBe(false);
  });
});

describe('本地翻译模型注册表', () => {
  it('默认模型存在于注册表且为本地全平台可用（macos + web）', () => {
    const m = getTranslationModel(DEFAULT_TRANSLATION_MODEL_ID);
    expect(m).toBe(M2M100_SPEC);
    expect(m?.platforms).toEqual(expect.arrayContaining(['macos', 'web']));
  });

  it('getTranslationModel 未知 id 返回 undefined', () => {
    expect(getTranslationModel('nllb')).toBeUndefined();
    expect(getTranslationModel('cloud')).toBeUndefined();
  });

  it('每个模型都声明 nameKey、平台与权重文件', () => {
    for (const m of LOCAL_TRANSLATION_MODELS) {
      expect(m.nameKey).toMatch(/^models\./);
      expect(m.platforms.length).toBeGreaterThan(0);
      expect(m.weightFiles).toEqual(['encoder_model', 'decoder_model']);
    }
  });

  it('translationModelsFor 按平台过滤：macos/web 含两款、ios 无本地模型', () => {
    expect(translationModelsFor('macos').map((m) => m.id)).toEqual(['m2m100', 'mbart50']);
    expect(translationModelsFor('web').map((m) => m.id)).toEqual(['m2m100', 'mbart50']);
    expect(translationModelsFor('ios')).toEqual([]);
  });
});

describe('mBART-50 语言码映射', () => {
  const plan = (source: string, native: string, text: string) =>
    planTranslation(MBART50_SPEC, source, native, text);

  it('不同语言：携带 mBART-50 locale 风格目标码', () => {
    expect((plan('en', 'ja', 'hello') as { targetCode: string }).targetCode).toBe('ja_XX');
    expect((plan('ja', 'ko', 'こんにちは') as { targetCode: string }).targetCode).toBe('ko_KR');
    const toZh = plan('ja', 'zh', 'こんにちは');
    expect(toZh.kind).toBe('translate');
    if (toZh.kind === 'translate') {
      expect(toZh.targetCode).toBe('zh_CN');
      expect(toZh.toScript?.('發現')).toBe('发现');
    }
  });

  it('yue 与 zh 共用 zh_CN 但仍作不同语言 → translate（不 skip）', () => {
    const p = plan('yue', 'zh', '早晨');
    expect(p.kind).toBe('translate');
    if (p.kind === 'translate') expect(p.targetCode).toBe('zh_CN');
  });

  it('未知目标语言：targetCode 回退 fallbackLang（en_XX）', () => {
    const p = plan('ja', 'xx', 'こんにちは');
    expect(p.kind).toBe('translate');
    if (p.kind === 'translate') expect(p.targetCode).toBe('en_XX');
  });
});

describe('normalizeZh 简体归一化', () => {
  it('繁体字形 → 简体', () => {
    expect(normalizeZh('發現問題')).toBe('发现问题');
  });

  it('已是简体 → 原样', () => {
    expect(normalizeZh('发现问题')).toBe('发现问题');
  });
});

describe('planTranslation 判定矩阵（M2M100）', () => {
  const plan = (source: string, native: string, text: string) =>
    planTranslation(M2M100_SPEC, source, native, text);

  it('同语言同字形：skip（zh→zh / en→en / ja→ja / ko→ko）', () => {
    expect(plan('zh', 'zh', '你好')).toEqual({ kind: 'skip' });
    expect(plan('en', 'en', 'hello')).toEqual({ kind: 'skip' });
    expect(plan('ja', 'ja', 'こんにちは')).toEqual({ kind: 'skip' });
    expect(plan('ko', 'ko', '안녕하세요')).toEqual({ kind: 'skip' });
  });

  it('中文母语但源带繁体字形：script，直接产出简体、不经模型', () => {
    expect(plan('zh', 'zh', '發現問題')).toEqual({ kind: 'script', text: '发现问题' });
  });

  it('中文母语源已是简体：等价于 skip', () => {
    expect(plan('zh', 'zh', '谢谢')).toEqual({ kind: 'skip' });
  });

  it('不同语言：translate，携带模型码与母语键；中文母语带简体归一化', () => {
    const p = plan('ja', 'zh', 'こんにちは');
    expect(p.kind).toBe('translate');
    if (p.kind === 'translate') {
      expect(p.targetCode).toBe('zh');
      expect(p.targetLang).toBe('zh');
      expect(p.toScript?.('發現')).toBe('发现');
    }
  });

  it('无字形后处理的母语（ja/en/ko）：translate 不带 toScript', () => {
    const p = plan('zh', 'ja', '你好');
    expect(p.kind).toBe('translate');
    if (p.kind === 'translate') {
      expect(p.targetCode).toBe('ja');
      expect(p.toScript).toBeUndefined();
    }
  });

  it('yue 与 zh 是不同语言：即便共用模型码 zh 也必须 translate、不得 skip', () => {
    const p = plan('yue', 'zh', '早晨');
    expect(p.kind).toBe('translate');
    if (p.kind === 'translate') {
      expect(p.targetCode).toBe('zh');
      // 母语中文：译文按简体归一化
      expect(p.toScript?.('發現')).toBe('发现');
    }
  });

  it('yue → 非中文母语：普通 translate', () => {
    const p = plan('yue', 'en', '早晨');
    expect(p.kind).toBe('translate');
    if (p.kind === 'translate') {
      expect(p.targetCode).toBe('en');
    }
  });

  it('未知源语言：按不同语言处理（translate）', () => {
    expect(plan('fr', 'zh', 'bonjour').kind).toBe('translate');
  });

  it('spec 未收录的目标语言：targetCode 回退 fallbackLang', () => {
    const p = plan('ja', 'xx', 'こんにちは');
    expect(p.kind).toBe('translate');
    if (p.kind === 'translate') {
      expect(p.targetCode).toBe(M2M100_SPEC.fallbackLang);
    }
  });
});
