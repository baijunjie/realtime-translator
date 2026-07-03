// settings 纯逻辑的单元测试：默认值的母语推断、字段补齐与语言/模型校验。
import { describe, expect, it } from 'vitest';
import { UI_LANGS, makeDefaults, withDefaults } from './settings';

describe('UI_LANGS', () => {
  it('按 key 字母序渲染', () => {
    expect(UI_LANGS).toEqual(['en', 'ja', 'ko', 'zh']);
  });
});

describe('makeDefaults 母语推断', () => {
  it('任意中文变体（含 TW/HK/MO/Hant）一律推断为简体 zh', () => {
    expect(makeDefaults(['zh-CN']).nativeLang).toBe('zh');
    expect(makeDefaults(['zh']).nativeLang).toBe('zh');
    expect(makeDefaults(['zh-TW']).nativeLang).toBe('zh');
    expect(makeDefaults(['zh-HK']).nativeLang).toBe('zh');
    expect(makeDefaults(['zh-Hant-TW']).nativeLang).toBe('zh');
  });

  it('ja / ko / en 按前缀命中', () => {
    expect(makeDefaults(['ja-JP']).nativeLang).toBe('ja');
    expect(makeDefaults(['ko-KR']).nativeLang).toBe('ko');
    expect(makeDefaults(['en-US']).nativeLang).toBe('en');
  });

  it('首个可识别语言优先', () => {
    expect(makeDefaults(['fr-FR', 'ja-JP', 'zh-CN']).nativeLang).toBe('ja');
  });

  it('未知语言或空列表回退英语', () => {
    expect(makeDefaults(['fr-FR']).nativeLang).toBe('en');
    expect(makeDefaults([]).nativeLang).toBe('en');
  });

  it('识别默认 auto + sense-voice，音源默认麦克风', () => {
    const d = makeDefaults([]);
    expect(d.asr).toEqual({ language: 'auto', model: 'sense-voice' });
    expect(d.audioSource).toBe('mic');
  });

  it('默认关闭翻译、引擎为本地 m2m100、云端三项留空', () => {
    const d = makeDefaults([]);
    expect(d.onboarded).toBe(false);
    expect(d.fontSize).toBe('medium');
    expect(d.theme).toBe('system');
    expect(d.translation.enabled).toBe(false);
    expect(d.translation.engine).toBe('m2m100');
    expect(d.translation.cloud).toEqual({ baseURL: '', apiKey: '', model: '' });
  });
});

describe('withDefaults 字段补齐与校验', () => {
  const d = makeDefaults(['en-US']);

  it('空对象/null 全部落默认', () => {
    expect(withDefaults(null, d)).toEqual(d);
    expect(withDefaults({}, d)).toEqual(d);
  });

  it('非法 nativeLang / fontSize / theme / audioSource 回退默认', () => {
    const s = withDefaults(
      { nativeLang: 'fr', fontSize: 'huge', theme: 'blue', audioSource: 'bluetooth' },
      d,
    );
    expect(s.nativeLang).toBe(d.nativeLang);
    expect(s.fontSize).toBe('medium');
    expect(s.theme).toBe('system');
    expect(s.audioSource).toBe('mic');
  });

  it('合法字段原样保留', () => {
    const s = withDefaults(
      {
        onboarded: true,
        nativeLang: 'ja',
        fontSize: 'large',
        theme: 'dark',
        audioSource: 'mic',
        asr: { language: 'ja', model: 'zipformer-ja-reazonspeech' },
        translation: {
          enabled: true,
          engine: 'cloud',
          cloud: { baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'm' },
        },
      },
      d,
    );
    expect(s.onboarded).toBe(true);
    expect(s.nativeLang).toBe('ja');
    expect(s.fontSize).toBe('large');
    expect(s.theme).toBe('dark');
    expect(s.audioSource).toBe('mic');
    expect(s.asr).toEqual({ language: 'ja', model: 'zipformer-ja-reazonspeech' });
    expect(s.translation).toEqual({
      enabled: true,
      engine: 'cloud',
      cloud: { baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'm' },
    });
  });

  it('cloud 字段缺省补齐为空串', () => {
    const s = withDefaults({ translation: { engine: 'cloud' } }, d);
    expect(s.translation.cloud).toEqual({ baseURL: '', apiKey: '', model: '' });
  });

  it('引擎校验：cloud 与注册表本地模型 id 保留，未知值回落默认本地模型', () => {
    // 注册表内的本地模型 id 原样保留。
    expect(withDefaults({ translation: { engine: 'm2m100' } }, d).translation.engine).toBe('m2m100');
    expect(withDefaults({ translation: { engine: 'm2m100-1.2b' } }, d).translation.engine).toBe('m2m100-1.2b');
    expect(withDefaults({ translation: { engine: 'cloud' } }, d).translation.engine).toBe('cloud');
    // 未在注册表中的旧值/非法值/已下架 id 回落默认本地模型。
    expect(withDefaults({ translation: { engine: 'local' } }, d).translation.engine).toBe('m2m100');
    expect(withDefaults({ translation: { engine: 'nllb' } }, d).translation.engine).toBe('m2m100');
    expect(withDefaults({ translation: { engine: 'mbart50' } }, d).translation.engine).toBe('m2m100');
  });

  describe('asr 语言与模型校验', () => {
    it('非法识别语言回落 auto', () => {
      const s = withDefaults({ asr: { language: 'fr', model: 'sense-voice' } }, d);
      expect(s.asr.language).toBe('auto');
    });

    it('模型不在注册表：回落 sense-voice', () => {
      const s = withDefaults({ asr: { language: 'auto', model: 'ghost-model' } }, d);
      expect(s.asr.model).toBe('sense-voice');
    });

    it('模型存在但不支持当前识别语言：回落 sense-voice', () => {
      // paraformer-zh 只支持 zh，识别语言却设 ja → 不匹配，回落默认模型
      const s = withDefaults({ asr: { language: 'ja', model: 'paraformer-zh' } }, d);
      expect(s.asr.language).toBe('ja');
      expect(s.asr.model).toBe('sense-voice');
    });

    it('模型存在且支持当前识别语言：保留', () => {
      const s = withDefaults({ asr: { language: 'zh', model: 'paraformer-zh' } }, d);
      expect(s.asr).toEqual({ language: 'zh', model: 'paraformer-zh' });
    });
  });
});
