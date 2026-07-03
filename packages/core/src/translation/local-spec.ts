// 本地翻译模型的平台无关数据：模型规格（LocalModelSpec）、M2M100 规格与语言码映射，
// 以及中文简体归一化（normalizeZh，基于 chinese-conv）。
// 具体跑模型的 LocalTranslator 实现（依赖 onnxruntime-node）留在各端。
import { sify } from 'chinese-conv';
import type { LocalEngine, Platform } from '../types';

/** 中文简体归一化：模型输出偶带繁体字形，统一转简体（成本极低，值得保留）。 */
export function normalizeZh(text: string): string {
  return sify(text);
}

/** 某个 app 语言在该模型下如何处理：用哪个模型语言码 + 目标产出的脚本后处理 */
export interface LangEntry {
  /** 模型自己的语言码（M2M100: zh/en…；NLLB: zho_Hans/eng_Latn…） */
  code: string;
  /**
   * 语言身份：判断「是否同一种语言」时用。用于区分共用同一模型码却实为不同语言者——
   * yue（粤语）与 zh 都被 M2M100 归到码 'zh'，但不是同一语言，不能相互「同语言跳过」。
   * 缺省时回退到该项的 app 语言键（见 planTranslation）。
   */
  lang?: string;
  /**
   * 作为目标语言时对译文的后处理：中文母语统一归一化为简体字形。
   * 仅当母语需要该处理时才设（en/ja/ko 无需）。
   */
  toScript?: (text: string) => string;
}

export interface LocalModelSpec {
  id: LocalEngine;
  /** UI 端 i18n 显示名 key（形如 models.m2m100）。 */
  nameKey: string;
  /** HuggingFace 仓库标识（首次联网下载后离线复用） */
  modelId: string;
  /** 量化档位 */
  dtype: 'q8';
  /**
   * 缓存完整性判据：每个特征串须命中至少一个已缓存的 .onnx 权重文件（见 hasAllWeightFiles）。
   * 缓存按文件粒度写入/逐出，只查目录或任一文件存在会把部分缺失误判为已就绪。
   */
  weightFiles: string[];
  /**
   * 全部需下载文件的近似总字节（非精确值），用于预置下载进度聚合器的分母：
   * 从第一个进度事件起分母即为全量，总进度不因文件陆续注册而回落。
   */
  approxDownloadBytes: number;
  /** app 语言（含 ASR 源码 yue）→ 处理方式；未列出的语言回退到 fallbackLang */
  langs: Record<string, LangEntry>;
  /** 未知语言的回退（通常英语） */
  fallbackLang: string;
  /** 支持该模型的平台（如 iOS 走系统翻译、不消费本地权重，故不列入）。 */
  platforms: Platform[];
}

/** 已缓存文件名/URL 列表是否覆盖 spec 的全部权重文件（每个特征串命中至少一个 .onnx） */
export function hasAllWeightFiles(spec: LocalModelSpec, cached: string[]): boolean {
  return spec.weightFiles.every((w) => cached.some((f) => f.includes(w) && f.includes('.onnx')));
}

// M2M100-418M（MIT，轻量）。产出中文统一归一化为简体字形。
export const M2M100_SPEC: LocalModelSpec = {
  id: 'm2m100',
  nameKey: 'models.m2m100',
  modelId: 'Xenova/m2m100_418M',
  dtype: 'q8',
  // seq2seq 双权重：encoder + merged decoder（q8 档文件名带 _quantized 后缀，用特征串匹配）
  weightFiles: ['encoder_model', 'decoder_model'],
  approxDownloadBytes: 630_000_000, // q8 encoder+decoder+tokenizer 等合计约 630MB
  fallbackLang: 'en',
  langs: {
    // 中文母语：产出/原文一律归一化为简体（模型输出偶带繁体字形）。
    zh: { code: 'zh', lang: 'zh', toScript: normalizeZh },
    en: { code: 'en' },
    ja: { code: 'ja' },
    ko: { code: 'ko' },
    // yue（粤语）虽被 M2M100 归到 'zh' 码，但与中文是不同语言（lang 回退到键 'yue'）：
    // 云端可真正翻译粤→中；本地模型做不到时由翻译器内部回退到字形转换。
    yue: { code: 'zh' },
  },
  platforms: ['macos', 'web'],
};

// mBART-50 many-to-many（基座 facebook/mbart-large-50 为 MIT）。参数量大于 M2M100，翻译质量更高、体积更大。
// 语言码用 mBART-50 的 locale 风格串（en_XX / ja_XX / ko_KR / zh_CN）；简繁字形处理与 M2M100 同构：
// 中文母语归一化为简体，yue 与 zh 共用模型码 zh_CN 但作不同语言处理（lang 回退到键 'yue'）。
export const MBART50_SPEC: LocalModelSpec = {
  id: 'mbart50',
  nameKey: 'models.mbart50',
  modelId: 'Xenova/mbart-large-50-many-to-many-mmt',
  dtype: 'q8',
  weightFiles: ['encoder_model', 'decoder_model'],
  // q8 encoder(409.7MB) + decoder_merged(462.9MB) + tokenizer.json(17.1MB) + 根目录 config 等小文件之和。
  approxDownloadBytes: 889_657_579,
  fallbackLang: 'en_XX',
  langs: {
    zh: { code: 'zh_CN', lang: 'zh', toScript: normalizeZh },
    en: { code: 'en_XX' },
    ja: { code: 'ja_XX' },
    ko: { code: 'ko_KR' },
    // yue 无独立 mBART-50 语言码，落 zh_CN；与 zh 作不同语言处理（lang 回退到键 'yue'）。
    yue: { code: 'zh_CN' },
  },
  platforms: ['macos', 'web'],
};

/** 可选用的本地翻译模型注册表（默认项在首）。 */
export const LOCAL_TRANSLATION_MODELS: readonly LocalModelSpec[] = [M2M100_SPEC, MBART50_SPEC];

/** 默认本地翻译模型 id（轻量、全本地平台可用）。 */
export const DEFAULT_TRANSLATION_MODEL_ID: LocalEngine = 'm2m100';

/** 按 id 取本地翻译模型规格；未知 id 返回 undefined。 */
export function getTranslationModel(id: string): LocalModelSpec | undefined {
  return LOCAL_TRANSLATION_MODELS.find((m) => m.id === id);
}

/** 某平台上可用的本地翻译模型（platforms 含该平台）。 */
export function translationModelsFor(platform: Platform): LocalModelSpec[] {
  return LOCAL_TRANSLATION_MODELS.filter((m) => m.platforms.includes(platform));
}

/**
 * 一条定稿段「要不要翻、怎么翻」的决策（平台无关）。目标恒为母语 nativeLang，三端共用同一判定。
 * - `skip`：源已是母语且字形一致，无需任何处理（不显示译文、不触发等待动画）。
 * - `script`：源与母语是同一种语言、仅简繁字形不同——直接对原文做脚本转换，不经模型/云。
 * - `translate`：源与母语是不同语言，需走翻译引擎；产出后按 toScript 归一化母语字形。
 */
export type TranslationPlan =
  | { readonly kind: 'skip' }
  | { readonly kind: 'script'; readonly text: string }
  | {
      readonly kind: 'translate';
      /** 传给翻译引擎的目标模型短码（M2M100: zh/en/…）。 */
      readonly targetCode: string;
      /** 母语 app 语言键（zh/ja/en/ko）：能感知语言的引擎（如云端提示词）用它。 */
      readonly targetLang: string;
      /** 译文的字形后处理（中文归一化为简体）；无则不处理。 */
      readonly toScript?: (text: string) => string;
    };

/**
 * 决定源语言为 sourceLang 的一段文本翻成母语 nativeLang 时该如何处理。
 * 中文母语只做轻量简体归一化、绝不经模型；源已是简体则等价于跳过。
 * @param sourceLang ASR 源语言短码（zh/en/ja/ko/yue）
 * @param nativeLang 母语 app 语言键（zh/ja/en/ko）
 * @param text 源文本（用于判断字形转换后是否与原文一致）
 */
export function planTranslation(
  spec: LocalModelSpec,
  sourceLang: string,
  nativeLang: string,
  text: string,
): TranslationPlan {
  const sourceEntry = spec.langs[sourceLang];
  const targetEntry = spec.langs[nativeLang];
  const targetCode = targetEntry?.code ?? spec.fallbackLang;
  const toScript = targetEntry?.toScript;

  // 语言身份（忽略简繁字形）：缺省回退到 app 语言键，故 yue 归 'yue' 而非其模型码 'zh'。
  const sourceLangId = sourceEntry?.lang ?? sourceLang;
  const targetLangId = targetEntry?.lang ?? nativeLang;

  // 不同语言：必须走翻译引擎（产出后按母语字形归一化）。
  if (sourceLangId !== targetLangId) {
    return { kind: 'translate', targetCode, targetLang: nativeLang, toScript };
  }

  // 同一语言，且母语无字形后处理（en/ja/ko 等）：源即目标，跳过。
  if (!toScript) {
    return { kind: 'skip' };
  }

  // 同一语言但母语要求简体字形：对原文做简体归一化即可。
  // 转换后与原文一致（源已是简体）时等价于跳过。
  const converted = toScript(text);
  return converted === text ? { kind: 'skip' } : { kind: 'script', text: converted };
}
