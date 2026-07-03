// 应用设置的纯逻辑：默认值生成、字段补齐与语言/模型校验。
// 不依赖任何平台 API——系统语言由调用方传入，持久化（fs 等）留在各端实现。
import type { AppSettings, AsrLang, UiLang } from './types';
import { DEFAULT_ASR_MODEL_ID, getAsrModel } from './models';
import { DEFAULT_TRANSLATION_MODEL_ID, getTranslationModel } from './translation/local-spec';

/** UI 语言下拉的渲染顺序（按 key 字母序）。 */
export const UI_LANGS: UiLang[] = ['en', 'ja', 'ko', 'zh'];

const ASR_LANGS: AsrLang[] = ['auto', 'en', 'ja', 'ko', 'zh'];

/**
 * 按系统语言猜母语，落到支持的语言之一，否则英语。
 * @param systemLangs 系统偏好语言列表（由各端提供，如 Electron 的 app.getPreferredSystemLanguages()）
 */
function defaultNativeLang(systemLangs: string[]): UiLang {
  const candidates = systemLangs.map((l) => (l || '').toLowerCase());
  for (const c of candidates) {
    // 繁体并入简体：任意中文变体（含台/港/澳、Hant）一律落简体 zh。
    if (c.startsWith('zh')) return 'zh';
    const hit = (['ja', 'en', 'ko'] as UiLang[]).find((l) => c.startsWith(l));
    if (hit) return hit;
  }
  return 'en';
}

/** 生成默认设置；母语按传入的系统语言推断 */
export function makeDefaults(systemLangs: string[]): AppSettings {
  return {
    onboarded: false,
    nativeLang: defaultNativeLang(systemLangs),
    fontSize: 'medium',
    theme: 'system',
    asr: { language: 'auto', model: DEFAULT_ASR_MODEL_ID },
    // 默认麦克风（全平台可用）；系统音频由支持的端（macOS 14.2+）作为可选项提供。
    audioSource: 'mic',
    translation: {
      enabled: false,
      engine: DEFAULT_TRANSLATION_MODEL_ID,
      // 云端三项默认留空：主页设置里由预设选择或手动输入填入（占位符仅作示例提示）
      cloud: {
        baseURL: '',
        apiKey: '',
        model: '',
      },
    },
  };
}

export function asUiLang(v: unknown): UiLang | null {
  return typeof v === 'string' && (UI_LANGS as string[]).includes(v) ? (v as UiLang) : null;
}

export function asAsrLang(v: unknown): AsrLang | null {
  return typeof v === 'string' && (ASR_LANGS as string[]).includes(v) ? (v as AsrLang) : null;
}

/**
 * 补齐缺省字段并校验：无效值一律回落默认，不迁移旧版本数据。
 * @param raw 反序列化得到的原始对象
 * @param defaults 由调用方按系统语言生成的默认值
 */
export function withDefaults(raw: unknown, defaults: AppSettings): AppSettings {
  const d = defaults;
  const s = (raw ?? {}) as Record<string, unknown>;
  const t = (s.translation ?? {}) as Record<string, unknown>;
  const cloud = (t.cloud ?? {}) as Record<string, unknown>;
  const asr = (s.asr ?? {}) as Record<string, unknown>;

  // 识别语言非法则回落 auto。
  const asrLang = asAsrLang(asr.language) ?? d.asr.language;
  // 识别模型须存在于注册表且其 languages 含当前识别语言，否则回落默认模型。
  const asrModelId = typeof asr.model === 'string' ? asr.model : '';
  const asrModel = getAsrModel(asrModelId);
  const model = asrModel?.languages.includes(asrLang) ? asrModelId : DEFAULT_ASR_MODEL_ID;

  return {
    onboarded: typeof s.onboarded === 'boolean' ? s.onboarded : d.onboarded,
    nativeLang: asUiLang(s.nativeLang) ?? d.nativeLang,
    fontSize: s.fontSize === 'small' || s.fontSize === 'large' ? s.fontSize : d.fontSize,
    theme: s.theme === 'light' || s.theme === 'dark' ? s.theme : d.theme,
    asr: { language: asrLang, model },
    audioSource:
      s.audioSource === 'mic' || s.audioSource === 'system' ? s.audioSource : d.audioSource,
    translation: {
      enabled: typeof t.enabled === 'boolean' ? t.enabled : d.translation.enabled,
      // 引擎：'cloud' 或注册表中的本地模型 id 原样保留，其余（未知/旧值）回落默认本地模型。
      engine:
        t.engine === 'cloud'
          ? 'cloud'
          : typeof t.engine === 'string' && getTranslationModel(t.engine)
            ? getTranslationModel(t.engine)!.id
            : DEFAULT_TRANSLATION_MODEL_ID,
      cloud: {
        baseURL: (cloud.baseURL as string) || d.translation.cloud.baseURL,
        apiKey: (cloud.apiKey as string) ?? '',
        model: (cloud.model as string) || d.translation.cloud.model,
      },
    },
  };
}
