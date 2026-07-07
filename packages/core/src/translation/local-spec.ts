// 本地翻译模型的平台无关视图：从统一注册表 ../model-registry 的 MODELS 过滤 kind==='translation' 派生。
// 保持既有导出形状（LOCAL_TRANSLATION_MODELS / M2M100_SPEC / helpers / planTranslation），各端消费不变。
//
// 本模块是**唯一**把注册表里纯数据的字形后处理标签（LangEntrySpec.script='zh-hans'）挂回具体函数
// （normalizeZh，依赖 chinese-conv）的地方——注册表本身保持纯数据，避免 chinese-conv 被拖进以 ../models
// 为入口的 iOS esbuild 子图（见 ../model-registry 顶部说明）。具体跑模型的 LocalTranslator 留在各端。
import { sify } from 'chinese-conv';
import { MODELS, type LangEntrySpec, type ModelFileSpec, type TranslationModelEntry } from '../model-registry';
import type { LocalEngine, Platform } from '../types';

/** 中文简体归一化：模型输出偶带繁体字形，统一转简体（成本极低，值得保留）。 */
export function normalizeZh(text: string): string {
  return sify(text);
}

/** 某个 app 语言在该模型下如何处理：用哪个模型语言码 + 目标产出的脚本后处理（视图，含函数）。 */
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

/**
 * 本地翻译模型的单个待下载文件（自研下载链路：按 URL 下载，落入 Transformers.js 的缓存布局后
 * 以 allowRemoteModels=false 离线加载）。与 ASR 共用同一份文件描述——按端分源的有序 URL 列表
 * （nativeUrls / webUrls，见 ../model-sources），下载器按序 fallback。
 */
export type LocalModelFile = ModelFileSpec;

export interface LocalModelSpec {
  id: LocalEngine;
  /** UI 端 i18n 显示名 key（形如 models.m2m100）。 */
  nameKey: string;
  /** HuggingFace 仓库标识：既是 Transformers.js 的模型 id，也是缓存布局的根目录名。 */
  modelId: string;
  /** 量化档位 */
  dtype: 'q8';
  /**
   * 该模型全部需下载文件（权重 + tokenizer/config）。自研下载器按此逐个下载，落入
   * Transformers.js 缓存布局后离线加载。清单以本机真实缓存为准枚举，缺任一文件都会导致离线加载失败。
   */
  files: LocalModelFile[];
  /**
   * 全部需下载文件的近似总字节（非精确值），用作下载进度分母：各文件不必单独记大小，
   * loaded 跨文件累计即可。分母从第一个进度事件起即为全量，总进度不因文件陆续下载而回落。
   */
  approxDownloadBytes: number;
  /** app 语言（含 ASR 源码 yue）→ 处理方式；未列出的语言回退到 fallbackLang */
  langs: Record<string, LangEntry>;
  /** 未知语言的回退（通常英语） */
  fallbackLang: string;
  /** 支持该模型的平台（如 iOS 走系统翻译、不消费本地权重，故不列入）。 */
  platforms: Platform[];
  /** true=内存占用大：内存受限运行环境（iOS/iPadOS WebKit）会排除之，见 availableTranslationModels。 */
  memoryHeavy?: boolean;
}

/** 把注册表纯数据的语言项挂回视图（script 标签 → 具体后处理函数）。 */
function reifyLangEntry(v: LangEntrySpec): LangEntry {
  const entry: LangEntry = { code: v.code };
  if (v.lang !== undefined) entry.lang = v.lang;
  if (v.script === 'zh-hans') entry.toScript = normalizeZh;
  return entry;
}

function reifyLangs(langs: Record<string, LangEntrySpec>): Record<string, LangEntry> {
  const out: Record<string, LangEntry> = {};
  for (const [k, v] of Object.entries(langs)) out[k] = reifyLangEntry(v);
  return out;
}

/**
 * 可选用的本地翻译模型注册表（从统一清单派生的视图，默认项在首）。
 * 入册硬门槛：非英语直连方向（本项目核心场景是 ja↔zh）实测可用。英语中心的
 * many-to-many 模型（如 mBART-50）ja→zh 接近零样本、会输出英语或幻觉，不满足门槛。
 */
export const LOCAL_TRANSLATION_MODELS: readonly LocalModelSpec[] = MODELS.filter(
  (m): m is TranslationModelEntry => m.kind === 'translation',
).map((m) => ({
  id: m.id,
  nameKey: m.nameKey,
  modelId: m.modelId,
  dtype: m.dtype,
  files: m.files,
  approxDownloadBytes: m.approxBytes,
  langs: reifyLangs(m.langs),
  fallbackLang: m.fallbackLang,
  platforms: m.availability.platforms,
  memoryHeavy: m.availability.memoryHeavy,
}));

/** 按 id 取本地翻译模型规格（缺失即注册表配置错误，早失败）。 */
function requireModel(id: LocalEngine): LocalModelSpec {
  const spec = LOCAL_TRANSLATION_MODELS.find((m) => m.id === id);
  if (!spec) throw new Error(`翻译模型注册表缺少 ${id}`);
  return spec;
}

// M2M100-418M（MIT，轻量，默认）。产出中文统一归一化为简体字形。
export const M2M100_SPEC: LocalModelSpec = requireModel('m2m100');
// M2M100-1.2B（MIT，质量档，仅 macOS，自托管唯一源）。
export const M2M100_1_2B_SPEC: LocalModelSpec = requireModel('m2m100-1.2b');

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
 * 某平台上**实际可用**的本地翻译模型：platforms 含该平台，且当宿主内存受限（memoryConstrained）时
 * 排除吃内存的模型（memoryHeavy）。iOS/iPadOS WebKit（移动 Safari）传 memoryConstrained=true——本地翻译
 * 大模型与 ASR 共存会 OOM，故这些端只走云端；macOS/native 传 false。宿主约束与模型属性分离、由此收口，
 * 三处消费（模型列表过滤 / 本地翻译是否可用 / 引擎回落）共用同一判定，避免漂移。
 */
export function availableTranslationModels(
  platform: Platform,
  opts: { memoryConstrained: boolean },
): LocalModelSpec[] {
  return LOCAL_TRANSLATION_MODELS.filter(
    (m) => m.platforms.includes(platform) && !(opts.memoryConstrained && m.memoryHeavy),
  );
}

/** 某平台上是否支持本地（离线）翻译（在该端内存约束下至少有一个可用本地模型）。 */
export function localTranslationSupported(
  platform: Platform,
  opts: { memoryConstrained: boolean },
): boolean {
  return availableTranslationModels(platform, opts).length > 0;
}

/**
 * 某语言在该模型下的「语言身份」（判断「是否同一种语言」时用；忽略简繁字形）。
 * 缺省回退到该项的 app 语言键，故 yue（粤语）归 'yue' 而非其模型码 'zh'——与中文不视作同语言。
 */
export function langIdentity(spec: LocalModelSpec, lang: string): string {
  return spec.langs[lang]?.lang ?? lang;
}

/**
 * 一条定稿段「要不要翻、怎么翻」的决策（平台无关，三端共用同一判定）。目标语言由调用方给定
 * （通常是母语；反向翻译时是「上一次的外语」，见 segment-translation）。
 * - `skip`：源与目标是同一种语言且字形一致，无需任何处理（不显示译文、不触发等待动画）。
 * - `script`：源与目标是同一种语言、仅简繁字形不同——直接对原文做脚本转换，不经模型/云。
 * - `translate`：源与目标是不同语言，需走翻译引擎；产出后按 toScript 归一化目标字形。
 */
export type TranslationPlan =
  | { readonly kind: 'skip' }
  | { readonly kind: 'script'; readonly text: string }
  | {
      readonly kind: 'translate';
      /** 传给翻译引擎的目标模型短码（M2M100: zh/en/…）。 */
      readonly targetCode: string;
      /** 目标 app 语言键（zh/ja/en/ko/yue）：能感知语言的引擎（如云端提示词）用它。 */
      readonly targetLang: string;
      /** 译文的字形后处理（中文目标归一化为简体）；无则不处理。 */
      readonly toScript?: (text: string) => string;
    };

/**
 * 决定源语言为 sourceLang 的一段文本翻成 targetLang 时该如何处理。
 * 中文目标只做轻量简体归一化、绝不经模型；源已是简体则等价于跳过。
 * @param sourceLang ASR 源语言短码（zh/en/ja/ko/yue）
 * @param targetLang 目标 app 语言键（zh/ja/en/ko；反向翻译时可为其它 ASR 源码如 yue）
 * @param text 源文本（用于判断字形转换后是否与原文一致）
 */
export function planTranslation(
  spec: LocalModelSpec,
  sourceLang: string,
  targetLang: string,
  text: string,
): TranslationPlan {
  const targetEntry = spec.langs[targetLang];
  const targetCode = targetEntry?.code ?? spec.fallbackLang;
  const toScript = targetEntry?.toScript;

  // 不同语言：必须走翻译引擎（产出后按目标字形归一化）。
  if (langIdentity(spec, sourceLang) !== langIdentity(spec, targetLang)) {
    return { kind: 'translate', targetCode, targetLang, toScript };
  }

  // 同一语言，且目标无字形后处理（en/ja/ko 等）：源即目标，跳过。
  if (!toScript) {
    return { kind: 'skip' };
  }

  // 同一语言但目标要求简体字形：对原文做简体归一化即可。
  // 转换后与原文一致（源已是简体）时等价于跳过。
  const converted = toScript(text);
  return converted === text ? { kind: 'skip' } : { kind: 'script', text: converted };
}
