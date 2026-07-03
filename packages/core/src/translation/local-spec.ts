// 本地翻译模型的平台无关数据：模型规格（LocalModelSpec）、M2M100 规格与语言码映射，
// 以及中文简体归一化（normalizeZh，基于 chinese-conv）。
// 具体跑模型的 LocalTranslator 实现（依赖 onnxruntime-node）留在各端。
import { sify } from 'chinese-conv';
import { ghModelAsset } from '../model-assets';
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

/**
 * 本地翻译模型的单个待下载文件（自研下载链路：按 URL 下载，落入 Transformers.js 的缓存布局后
 * 以 allowRemoteModels=false 离线加载）。与 ASR 的 AsrModelFile 同理——注册表声明 URL，各端自行下载。
 */
export interface LocalModelFile {
  /** 下载源（自托管 GitHub Release 扁平直链，与缓存键解耦）：macOS 用。 */
  url: string;
  /**
   * web 端专用下载源（上游 HF resolve 直链）：浏览器 fetch 受 CORS 约束，而自托管 GitHub
   * Release 资产不发 CORS 头，故 web 改走发 CORS 头的上游源。仅 platforms 含 web 的模型需要；
   * macOS 专属模型（如 1.2B）不设。
   */
  webUrl?: string;
  /** 落地文件名（如 encoder_model_quantized.onnx）。 */
  filename: string;
  /**
   * Transformers.js 缓存布局内、相对 `<cacheDir>/<modelId>/` 的子目录（'' 或 'onnx'）。
   * macOS 据此拼本地路径 `<cacheDir>/<modelId>/<dir>/<filename>`；Web 据此构造 Transformers.js
   * 将要请求的缓存键（HF resolve URL），从而与下载源 URL 解耦。
   */
  dir: string;
}

export interface LocalModelSpec {
  id: LocalEngine;
  /** UI 端 i18n 显示名 key（形如 models.m2m100）。 */
  nameKey: string;
  /** HuggingFace 仓库标识：既是 Transformers.js 的模型 id，也是缓存布局的根目录名。 */
  modelId: string;
  /** 量化档位 */
  dtype: 'q8';
  /**
   * 缓存完整性判据：每个特征串须命中至少一个已缓存的 .onnx 权重文件（见 hasAllWeightFiles）。
   * 缓存按文件粒度写入/逐出，只查目录或任一文件存在会把部分缺失误判为已就绪。
   */
  weightFiles: string[];
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
}

/** 已缓存文件名/URL 列表是否覆盖 spec 的全部权重文件（每个特征串命中至少一个 .onnx） */
export function hasAllWeightFiles(spec: LocalModelSpec, cached: string[]): boolean {
  return spec.weightFiles.every((w) => cached.some((f) => f.includes(w) && f.includes('.onnx')));
}

// M2M100-418M（MIT，轻量）。产出中文统一归一化为简体字形。
const M2M100_REPO = 'Xenova/m2m100_418M';
/**
 * 构造 M2M100-418M 的一个待下载文件：url 为自托管 GitHub Release 资产（扁平命名
 * `m2m100_418M-<原文件名>`，与 1.2B 前缀风格一致，macOS 用）；webUrl 为上游 Xenova HF
 * resolve 直链（web 用，发 CORS 头）。dir 仅为缓存布局子目录（'' 或 'onnx'），与下载源 URL 解耦。
 */
function m2m100File(dir: string, filename: string): LocalModelFile {
  const rel = dir ? `${dir}/${filename}` : filename;
  return {
    url: ghModelAsset(`m2m100_418M-${filename}`),
    webUrl: `https://huggingface.co/${M2M100_REPO}/resolve/main/${rel}`,
    filename,
    dir,
  };
}

// M2M100 系（418M / 1.2B）共用同一分词器与语言码映射。
const M2M100_LANGS: Record<string, LangEntry> = {
  // 中文母语：产出/原文一律归一化为简体（模型输出偶带繁体字形）。
  zh: { code: 'zh', lang: 'zh', toScript: normalizeZh },
  en: { code: 'en' },
  ja: { code: 'ja' },
  ko: { code: 'ko' },
  // yue（粤语）虽被 M2M100 归到 'zh' 码，但与中文是不同语言（lang 回退到键 'yue'）：
  // 云端可真正翻译粤→中；本地模型做不到时由翻译器内部回退到字形转换。
  yue: { code: 'zh' },
};

export const M2M100_SPEC: LocalModelSpec = {
  id: 'm2m100',
  nameKey: 'models.m2m100',
  modelId: M2M100_REPO,
  dtype: 'q8',
  // seq2seq 双权重：encoder + merged decoder（q8 档文件名带 _quantized 后缀，用特征串匹配）
  weightFiles: ['encoder_model', 'decoder_model'],
  // 文件清单以本机真实缓存为准枚举（Transformers.js q8 档实际拉取的完整集合）：4 个 tokenizer/config
  // 小文件 + onnx/ 下的量化 encoder/decoder。按体积升序排列（小文件先下，早暴露连接问题）。
  files: [
    m2m100File('', 'config.json'),
    m2m100File('', 'generation_config.json'),
    m2m100File('', 'tokenizer_config.json'),
    m2m100File('', 'tokenizer.json'),
    m2m100File('onnx', 'encoder_model_quantized.onnx'),
    m2m100File('onnx', 'decoder_model_merged_quantized.onnx'),
  ],
  approxDownloadBytes: 640_000_000, // 上列文件合计约 640MB（q8 encoder ~288MB + decoder ~344MB + tokenizer 等）
  fallbackLang: 'en',
  langs: M2M100_LANGS,
  platforms: ['macos', 'web'],
};

// M2M100-1.2B（MIT，质量档）。官方无 ONNX 发布，权重经 optimum 导出 + 合并 decoder + q8 量化后
// 自托管于本仓库 GitHub Release（models-v1，资产名带 m2m100_1.2B- 前缀的扁平文件）；仅 macOS 支持、
// 无上游镜像，故不设 webUrl（唯一源）。modelId 仅作 Transformers.js 缓存布局键，不对应 HuggingFace 仓库。
function m2m1002bFile(dir: string, filename: string): LocalModelFile {
  return { url: ghModelAsset(`m2m100_1.2B-${filename}`), filename, dir };
}

export const M2M100_1_2B_SPEC: LocalModelSpec = {
  id: 'm2m100-1.2b',
  nameKey: 'models.m2m100_1_2b',
  modelId: 'realtime-translator/m2m100_1.2B',
  dtype: 'q8',
  weightFiles: ['encoder_model', 'decoder_model'],
  files: [
    m2m1002bFile('', 'config.json'),
    m2m1002bFile('', 'generation_config.json'),
    m2m1002bFile('', 'tokenizer_config.json'),
    m2m1002bFile('', 'tokenizer.json'),
    m2m1002bFile('onnx', 'encoder_model_quantized.onnx'),
    m2m1002bFile('onnx', 'decoder_model_merged_quantized.onnx'),
  ],
  approxDownloadBytes: 1_531_751_193, // 上列文件精确合计（q8 encoder 642MB + decoder 881MB + tokenizer 等）
  fallbackLang: 'en',
  langs: M2M100_LANGS,
  // 体积超出浏览器 WASM 内存的稳妥范围，web 暂不放开；iOS 走系统翻译不消费本地权重。
  platforms: ['macos'],
};

/**
 * 可选用的本地翻译模型注册表（默认项在首）。
 * 入册硬门槛：非英语直连方向（本项目核心场景是 ja↔zh）实测可用。英语中心的
 * many-to-many 模型（如 mBART-50）ja→zh 接近零样本、会输出英语或幻觉，不满足门槛。
 */
export const LOCAL_TRANSLATION_MODELS: readonly LocalModelSpec[] = [M2M100_SPEC, M2M100_1_2B_SPEC];

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
