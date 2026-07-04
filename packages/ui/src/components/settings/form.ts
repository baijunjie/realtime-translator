import type {
  UiLang,
  FontSize,
  ThemePref,
  AsrSettings,
  CloudTranslationConfig,
  LocalEngine,
} from '@rt/core';

/**
 * 翻译方式的三态选择（UI 概念，不进持久化）：
 *  · 'none'  → 关闭翻译（取代旧的独立翻译开关）
 *  · 'local' → 用本地模型翻译（具体哪款由 translationModel 指定）
 *  · 'cloud' → 用云端模型翻译
 * 与持久化的 { enabled, engine } 的映射在各调用页完成（enabled = 方式 !== 'none'；
 * engine = 云端为 'cloud'、本地为 translationModel）。
 */
export type TranslationMode = 'none' | 'local' | 'cloud';

/** 设置表单的数据形状（设置页与首次引导向导共用） */
export interface SettingsFormData {
  nativeLang: UiLang;
  fontSize: FontSize;
  theme: ThemePref;
  /** 识别语言 + 选用的 ASR 模型 */
  asr: AsrSettings;
  /** 翻译方式（三态）。 */
  translationMode: TranslationMode;
  /** 选用的本地翻译模型 id（仅 translationMode==='local' 时有意义）。 */
  translationModel: LocalEngine;
  cloud: CloudTranslationConfig;
}

/** 通用设置子集（母语/字体/主题）：首次引导向导仅编辑这几项。 */
export type GeneralFormData = Pick<SettingsFormData, 'nativeLang' | 'fontSize' | 'theme'>;

/** 各界面语言的自称（下拉 label 用），与 UI_LANGS 的 key 一一对应。 */
export const LANG_LABELS: Record<UiLang, string> = {
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  zh: '中文',
};
