// 统一模型清单（平台无关、**纯可序列化数据**）：ASR 与翻译两类模型合并为一份 MODELS 注册表，
// 以 kind 判别。所有可用模型、下载地址（按端分源的有序 URL 列表）、可用端与能力门槛都在这里声明，
// 一处增删即可扩展；各端消费从这里派生（ASR 视图见 ./models，翻译视图见 ./translation/local-spec）。
//
// 红线：本模块**不得含任何函数值/运行时行为**（如简繁转换 normalizeZh）。翻译母语字形后处理降为
// 字符串标签（LangEntrySpec.script），由 ./translation/local-spec 在派生视图时挂回具体函数——否则
// 会把 chinese-conv 拖进以 ./models 为入口的 iOS esbuild 子图（见 apps/ios .../gen-asr-models-swift.mjs）。
import { hfResolveUrls, selfHostedAsset } from './model-sources';
import type { AsrCommitStrategy, AsrLang, LocalEngine, Platform } from './types';

/**
 * 单个待下载文件的平台无关基础描述（纯数据）。每端一个有序 URL 列表，下载器按序尝试、每个只试一次、
 * 全部失败才判失败（见各端下载器）。翻译文件即此形态（不逐文件记字节/角色）；ASR 见 AsrFileSpec。
 */
export interface ModelFileSpec {
  /** 落地文件名。 */
  filename: string;
  /**
   * 目标子目录（相对模型/缓存根）。空串表示直接放根目录下。
   * ASR：相对 models 目录；翻译：Transformers.js 缓存布局内相对 `<cacheDir>/<modelId>/` 的子目录。
   */
  dir: string;
  /** native 端（macOS/iOS）下载源，有序：自托管 GitHub Release 优先，可含 HF 上游做兜底。 */
  nativeUrls: string[];
  /**
   * web 端下载源，有序：HF 主源 + 镜像（见 model-sources 的 HF_MIRRORS）。浏览器 fetch 受 CORS
   * 约束，故只用发 CORS 头的上游源。无 web 端源者（如仅 macOS 的模型、或 web 靠同源覆盖的 VAD）为空数组。
   */
  webUrls: string[];
}

/** ASR 文件（含公共依赖 VAD）：在基础描述上额外登记近似字节与识别器角色。 */
export interface AsrFileSpec extends ModelFileSpec {
  /** 近似大小（字节），用于下载进度/一致性校验。 */
  approxBytes: number;
  /** 该文件在识别器配置中的角色，供各端按角色装配 sherpa-onnx 识别器。VAD 省略（非模型角色）。 */
  role?: 'model' | 'tokens' | 'encoder' | 'decoder' | 'joiner';
}

/** 模型的平台可用性 + 细分端能力门槛（纯数据；宿主自行决定如何消费门槛）。 */
export interface ModelAvailability {
  /** 支持该模型的平台。 */
  platforms: Platform[];
  /**
   * true=该模型内存占用大。内存受限的运行环境（iOS/iPadOS WebKit 单标签页，本地翻译大模型与 ASR
   * 共存会 OOM）会据此排除之——见 ./translation/local-spec 的 availableTranslationModels。
   * 这里只声明「模型很吃内存」这一事实，不写死具体端，宿主报告自身是否受限来决定。
   */
  memoryHeavy?: boolean;
}

/**
 * 翻译模型某 app 语言的处理描述（纯数据版：脚本后处理降为标签，函数由派生视图挂回）。
 * 语义见 ./translation/local-spec 的 LangEntry。
 */
export interface LangEntrySpec {
  /** 模型自己的语言码（M2M100: zh/en…）。 */
  code: string;
  /** 语言身份（区分共用同一模型码却实为不同语言者，如 yue vs zh）；缺省回退到该项的 app 语言键。 */
  lang?: string;
  /** 作为目标语言时对译文的脚本后处理标签；目前仅 'zh-hans'（简体归一化）。 */
  script?: 'zh-hans';
}

interface CommonModelFields {
  /** UI 端 i18n 显示名 key（形如 models.senseVoice）。 */
  nameKey: string;
  availability: ModelAvailability;
  /** 全部文件近似合计字节，用作下载进度分母。 */
  approxBytes: number;
}

/** ASR 识别模型条目。 */
export interface AsrModelEntry extends CommonModelFields {
  kind: 'asr';
  /** 该模型全部需下载文件（不含公共依赖 Silero VAD；每文件登记字节与角色）。 */
  files: AsrFileSpec[];
  /** 注册表 id（设置 asr.model 存的就是它）。 */
  id: string;
  /** 支持的识别语言（auto 仅多语种模型具备）。 */
  languages: AsrLang[];
  /** 识别引擎类型，供各端选择对应的 sherpa-onnx 识别器构造路径。 */
  engine: 'senseVoice' | 'paraformer' | 'transducer';
  /** transducer 的具体子类型（NeMo transducer 需标记 'nemo_transducer'）。 */
  modelType?: string;
  /** 行内文本提交策略（见各端转写管线；取值语义见 types 的 AsrCommitStrategy）。 */
  commitStrategy: AsrCommitStrategy;
  /** 模型文件所在子目录（相对 models 目录）。 */
  dir: string;
}

/** 本地翻译模型条目。 */
export interface TranslationModelEntry extends CommonModelFields {
  kind: 'translation';
  /** 该模型全部需下载文件（权重 + tokenizer/config；不逐文件记字节）。 */
  files: ModelFileSpec[];
  id: LocalEngine;
  /** HuggingFace 仓库标识：Transformers.js 的模型 id + 缓存布局根目录名。 */
  modelId: string;
  /** 量化档位。 */
  dtype: 'q8';
  /** 未知语言的回退（通常英语）。 */
  fallbackLang: string;
  /** app 语言（含 ASR 源码 yue）→ 处理方式；未列出的语言回退到 fallbackLang。 */
  langs: Record<string, LangEntrySpec>;
}

export type ModelEntry = AsrModelEntry | TranslationModelEntry;

// —— ASR 模型文件子目录常量 ——
const SENSE_VOICE_DIR = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
const PARAFORMER_ZH_DIR = 'sherpa-onnx-paraformer-zh-2024-03-09';
const REAZONSPEECH_JA_DIR = 'sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01';
const PARAKEET_EN_DIR = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8';

/**
 * Silero VAD：所有 ASR 模型共用的语音端点检测依赖。native 走自托管 GitHub Release（无前缀）；
 * web 由同源静态资源覆盖（见 web asr model-store），故 webUrls 为空。不进模型选择列表，随任一模型一并下载。
 */
export const SILERO_VAD_FILE: AsrFileSpec = {
  filename: 'silero_vad.onnx',
  dir: '',
  nativeUrls: [selfHostedAsset('silero_vad.onnx')],
  webUrls: [],
  approxBytes: 643_854,
};

/**
 * 构造一份 ASR 模型文件描述：native = [自托管资产（扁平命名 `<modelId>-<原文件名>`）, ...HF 上游兜底]；
 * web = [HF 上游(+镜像)]。多数模型的 HF 源仓名与本地子目录同名（dir 默认取 hfRepoDir）；个别模型的
 * 权重个体文件来自另一命名的源仓（如 reazonspeech），此时显式传 dir。
 */
function asrFile(
  modelId: string,
  hfRepoDir: string,
  filename: string,
  approxBytes: number,
  role: NonNullable<AsrFileSpec['role']>,
  dir: string = hfRepoDir,
): AsrFileSpec {
  const upstream = hfResolveUrls(`csukuangfj/${hfRepoDir}`, filename);
  return {
    filename,
    dir,
    nativeUrls: [selfHostedAsset(`${modelId}-${filename}`), ...upstream],
    webUrls: upstream,
    approxBytes,
    role,
  };
}

// M2M100 系（418M / 1.2B）共用同一分词器与语言码映射。yue（粤语）虽被 M2M100 归到 'zh' 码，但与
// 中文是不同语言（lang 回退到键 'yue'）；中文母语产出/原文统一归一化为简体（script:'zh-hans'）。
const M2M100_LANGS: Record<string, LangEntrySpec> = {
  zh: { code: 'zh', lang: 'zh', script: 'zh-hans' },
  en: { code: 'en' },
  ja: { code: 'ja' },
  ko: { code: 'ko' },
  yue: { code: 'zh' },
};

/**
 * 构造 M2M100-418M 的一个待下载文件：native = [自托管资产（`m2m100_418M-<原文件名>`）, ...Xenova 上游兜底]；
 * web = [Xenova 上游(+镜像)]。dir 仅为缓存布局子目录（'' 或 'onnx'），与下载源 URL 解耦。
 */
function m2m100File(dir: string, filename: string): ModelFileSpec {
  const rel = dir ? `${dir}/${filename}` : filename;
  const upstream = hfResolveUrls('Xenova/m2m100_418M', rel);
  return {
    filename,
    dir,
    nativeUrls: [selfHostedAsset(`m2m100_418M-${filename}`), ...upstream],
    webUrls: upstream,
  };
}

// M2M100-1.2B（MIT，质量档）：官方无 ONNX 发布，权重经 optimum 导出 + 合并 decoder + q8 量化后自托管于
// 本仓库 GitHub Release（扁平资产名带 m2m100_1.2B- 前缀）；仅 macOS 支持、无上游镜像，故 webUrls 为空（唯一源）。
function m2m1002bFile(dir: string, filename: string): ModelFileSpec {
  return {
    filename,
    dir,
    nativeUrls: [selfHostedAsset(`m2m100_1.2B-${filename}`)],
    webUrls: [],
  };
}

/**
 * 全项目模型的单一事实源。增删/迁移模型、换镜像、调平台或能力门槛，只改这里（下载源基址在 ./model-sources）。
 * 翻译入册硬门槛：非英语直连方向（本项目核心场景 ja↔zh）实测可用。
 */
export const MODELS: readonly ModelEntry[] = [
  {
    kind: 'asr',
    id: 'sense-voice',
    nameKey: 'models.senseVoice',
    languages: ['auto', 'en', 'ja', 'ko', 'zh'],
    engine: 'senseVoice',
    commitStrategy: 'agreement',
    dir: SENSE_VOICE_DIR,
    files: [
      asrFile('sense-voice', SENSE_VOICE_DIR, 'model.int8.onnx', 239_233_841, 'model'),
      asrFile('sense-voice', SENSE_VOICE_DIR, 'tokens.txt', 315_894, 'tokens'),
    ],
    approxBytes: 239_549_735,
    availability: { platforms: ['macos', 'web', 'ios'] },
  },
  {
    kind: 'asr',
    id: 'paraformer-zh',
    nameKey: 'models.paraformerZh',
    languages: ['zh'],
    engine: 'paraformer',
    commitStrategy: 'agreement',
    dir: PARAFORMER_ZH_DIR,
    files: [
      asrFile('paraformer-zh', PARAFORMER_ZH_DIR, 'model.int8.onnx', 227_330_205, 'model'),
      asrFile('paraformer-zh', PARAFORMER_ZH_DIR, 'tokens.txt', 75_354, 'tokens'),
    ],
    approxBytes: 227_405_559,
    availability: { platforms: ['macos', 'web'] },
  },
  {
    kind: 'asr',
    id: 'zipformer-ja-reazonspeech',
    nameKey: 'models.reazonspeechJa',
    languages: ['ja'],
    engine: 'transducer',
    commitStrategy: 'chunk',
    dir: REAZONSPEECH_JA_DIR,
    // web/上游权重个体文件取自源仓 reazonspeech-k2-v2（HF 仓名 != 落地目录）：预置包
    // sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01 仅以 GitHub release tar 包整体分发，无逐文件 HF 直链。
    // 落地目录沿用预置包命名，encoder/joiner 用 int8、decoder 用 fp32（该包约定）。
    files: [
      asrFile('zipformer-ja-reazonspeech', 'reazonspeech-k2-v2', 'encoder-epoch-99-avg-1.int8.onnx', 154_670_139, 'encoder', REAZONSPEECH_JA_DIR),
      asrFile('zipformer-ja-reazonspeech', 'reazonspeech-k2-v2', 'decoder-epoch-99-avg-1.onnx', 11_767_836, 'decoder', REAZONSPEECH_JA_DIR),
      asrFile('zipformer-ja-reazonspeech', 'reazonspeech-k2-v2', 'joiner-epoch-99-avg-1.int8.onnx', 2_696_970, 'joiner', REAZONSPEECH_JA_DIR),
      asrFile('zipformer-ja-reazonspeech', 'reazonspeech-k2-v2', 'tokens.txt', 45_754, 'tokens', REAZONSPEECH_JA_DIR),
    ],
    approxBytes: 169_180_699,
    availability: { platforms: ['macos', 'web'] },
  },
  {
    kind: 'asr',
    id: 'parakeet-tdt-0.6b-v2-en',
    nameKey: 'models.parakeetEn',
    languages: ['en'],
    engine: 'transducer',
    modelType: 'nemo_transducer',
    commitStrategy: 'chunk',
    dir: PARAKEET_EN_DIR,
    files: [
      asrFile('parakeet-tdt-0.6b-v2-en', PARAKEET_EN_DIR, 'encoder.int8.onnx', 652_184_296, 'encoder'),
      asrFile('parakeet-tdt-0.6b-v2-en', PARAKEET_EN_DIR, 'decoder.int8.onnx', 7_257_753, 'decoder'),
      asrFile('parakeet-tdt-0.6b-v2-en', PARAKEET_EN_DIR, 'joiner.int8.onnx', 1_739_080, 'joiner'),
      asrFile('parakeet-tdt-0.6b-v2-en', PARAKEET_EN_DIR, 'tokens.txt', 9_384, 'tokens'),
    ],
    approxBytes: 661_190_513,
    availability: { platforms: ['macos', 'web'] },
  },
  {
    kind: 'translation',
    id: 'm2m100',
    nameKey: 'models.m2m100',
    modelId: 'Xenova/m2m100_418M',
    dtype: 'q8',
    // 文件清单以本机真实缓存为准枚举（Transformers.js q8 档实际拉取的完整集合）：4 个 tokenizer/config
    // 小文件 + onnx/ 下的量化 encoder/decoder。按体积升序（小文件先下，早暴露连接问题）。
    files: [
      m2m100File('', 'config.json'),
      m2m100File('', 'generation_config.json'),
      m2m100File('', 'tokenizer_config.json'),
      m2m100File('', 'tokenizer.json'),
      m2m100File('onnx', 'encoder_model_quantized.onnx'),
      m2m100File('onnx', 'decoder_model_merged_quantized.onnx'),
    ],
    approxBytes: 640_000_000, // 上列文件合计约 640MB（q8 encoder ~288MB + decoder ~344MB + tokenizer 等）
    fallbackLang: 'en',
    langs: M2M100_LANGS,
    // 内存偏大：内存受限运行环境（iOS/iPadOS WebKit）排除本地翻译，只走云端。
    availability: { platforms: ['macos', 'web'], memoryHeavy: true },
  },
  {
    kind: 'translation',
    id: 'm2m100-1.2b',
    nameKey: 'models.m2m100_1_2b',
    modelId: 'realtime-translator/m2m100_1.2B',
    dtype: 'q8',
    files: [
      m2m1002bFile('', 'config.json'),
      m2m1002bFile('', 'generation_config.json'),
      m2m1002bFile('', 'tokenizer_config.json'),
      m2m1002bFile('', 'tokenizer.json'),
      m2m1002bFile('onnx', 'encoder_model_quantized.onnx'),
      m2m1002bFile('onnx', 'decoder_model_merged_quantized.onnx'),
    ],
    approxBytes: 1_531_751_193, // 上列文件精确合计（q8 encoder 642MB + decoder 881MB + tokenizer 等）
    fallbackLang: 'en',
    langs: M2M100_LANGS,
    // 体积超出浏览器 WASM 内存的稳妥范围，web 暂不放开；iOS 走系统翻译不消费本地权重。
    availability: { platforms: ['macos'], memoryHeavy: true },
  },
];
