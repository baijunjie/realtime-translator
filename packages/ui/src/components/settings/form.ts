import type {
  UiLang,
  FontSize,
  ThemePref,
  AsrSettings,
  CloudTranslationConfig,
  TranslationEngine,
} from '@rt/core';

/**
 * 翻译方式的三态选择（UI 概念，不进持久化）：
 *  · 'none'          → 关闭翻译（取代旧的独立翻译开关）
 *  · 'm2m100'/'cloud' → 选中即开启翻译并用对应引擎
 * 与持久化的 { enabled, engine } 的映射在各调用页完成（enabled = 选择 !== 'none'）。
 */
export type TranslationChoice = 'none' | TranslationEngine;

/** 设置表单的数据形状（设置页与首次引导向导共用） */
export interface SettingsFormData {
  nativeLang: UiLang;
  fontSize: FontSize;
  theme: ThemePref;
  /** 识别语言 + 选用的 ASR 模型 */
  asr: AsrSettings;
  engine: TranslationChoice;
  cloud: CloudTranslationConfig;
}

/** 通用设置子集（母语/字体/主题）：首次引导向导仅编辑这几项。 */
export type GeneralFormData = Pick<SettingsFormData, 'nativeLang' | 'fontSize' | 'theme'>;
