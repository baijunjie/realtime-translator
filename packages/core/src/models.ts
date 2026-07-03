// 平台无关的 ASR 模型注册表：每个模型由若干需下载的文件组成，附远程 URL、本地
// 文件名/子目录、角色（供各端按角色装配识别器配置）与近似大小。纯数据/类型，
// **不含** Node 的 fs/fetch——各端（macOS Electron 主进程、iOS 原生下载器等）
// 共用这里的常量，自行实现下载/校验逻辑。
//
// iOS 注意：iOS 的原生模型下载器应消费同一份 @rt/core 注册表（ASR_MODELS /
// requiredAsrFiles），不要再各端硬编码 URL/文件名/目录，避免与 macOS 漂移。
//
// 翻译模型（Xenova/m2m100_418M）的规格见 ./translation/local-spec.ts。
import type { AsrLang, Platform } from './types';

/** HuggingFace 上 csukuangfj 账号某仓的 resolve 基址（文件按 `${base}/<file>` 取）。 */
function hfBase(repo: string): string {
  return `https://huggingface.co/csukuangfj/${repo}/resolve/main`;
}

/** 单个需下载的 ASR 模型文件的平台无关描述。 */
export interface AsrModelFile {
  /** 远程下载地址（自动跟随 GitHub/HF 重定向）。 */
  url: string;
  /** 落地文件名。 */
  filename: string;
  /**
   * 目标子目录（相对 models 目录）。空串表示直接放在 models 目录下。
   * 拼接本地路径：`<modelsDir>/<dir>/<filename>`（dir 为空时省略中间段）。
   */
  dir: string;
  /** 近似大小（字节），用于进度/预估，非精确值。 */
  approxBytes: number;
  /**
   * 该文件在识别器配置中的角色，供各端按角色装配 sherpa-onnx 识别器。
   * 公共依赖（Silero VAD）不属于任何模型角色，故省略。
   */
  role?: 'model' | 'tokens' | 'encoder' | 'decoder' | 'joiner';
}

/**
 * Silero VAD：所有 ASR 模型共用的语音端点检测依赖，GitHub release 直链。
 * 不进模型选择列表，随任一模型一并下载（见 requiredAsrFiles）。
 */
export const SILERO_VAD: AsrModelFile = {
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
  filename: 'silero_vad.onnx',
  dir: '',
  approxBytes: 643_854,
};

/** 一个可选用的 ASR 模型规格（平台无关）。 */
export interface AsrModelSpec {
  /** 注册表 id（设置 asr.model 存的就是它）。 */
  id: string;
  /** UI 端 i18n 显示名 key（形如 models.senseVoice）。 */
  nameKey: string;
  /** 支持的识别语言（auto 仅多语种模型具备）。 */
  languages: AsrLang[];
  /** 识别引擎类型，供各端选择对应的 sherpa-onnx 识别器构造路径。 */
  engine: 'senseVoice' | 'paraformer' | 'transducer';
  /** transducer 的具体子类型（NeMo transducer 需标记 'nemo_transducer'）。 */
  modelType?: string;
  /** 模型文件所在子目录（相对 models 目录）。 */
  dir: string;
  /** 该模型的全部需下载文件（不含公共依赖 Silero VAD）。 */
  files: AsrModelFile[];
  /** 该模型全部文件合计近似字节。 */
  approxBytes: number;
  /** 支持该模型的平台。 */
  platforms: Platform[];
}

const SENSE_VOICE_DIR = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
const PARAFORMER_ZH_DIR = 'sherpa-onnx-paraformer-zh-2024-03-09';
const REAZONSPEECH_JA_DIR = 'sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01';
const PARAKEET_EN_DIR = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8';

/**
 * 构造一份模型文件描述。多数模型的 HF 仓名与本地子目录同名（dir 默认取 repo）；
 * 个别模型的权重个体文件来自另一命名的源仓（如 reazonspeech），此时显式传 dir。
 */
function hfFile(
  repo: string,
  filename: string,
  approxBytes: number,
  role: NonNullable<AsrModelFile['role']>,
  dir: string = repo,
): AsrModelFile {
  return { url: `${hfBase(repo)}/${filename}`, filename, dir, approxBytes, role };
}

/** 可选用的 ASR 模型注册表。 */
export const ASR_MODELS: readonly AsrModelSpec[] = [
  {
    id: 'sense-voice',
    nameKey: 'models.senseVoice',
    languages: ['auto', 'en', 'ja', 'ko', 'zh'],
    engine: 'senseVoice',
    dir: SENSE_VOICE_DIR,
    files: [
      hfFile(SENSE_VOICE_DIR, 'model.int8.onnx', 239_233_841, 'model'),
      hfFile(SENSE_VOICE_DIR, 'tokens.txt', 315_894, 'tokens'),
    ],
    approxBytes: 239_549_735,
    platforms: ['macos', 'web', 'ios'],
  },
  {
    id: 'paraformer-zh',
    nameKey: 'models.paraformerZh',
    languages: ['zh'],
    engine: 'paraformer',
    dir: PARAFORMER_ZH_DIR,
    files: [
      hfFile(PARAFORMER_ZH_DIR, 'model.int8.onnx', 227_330_205, 'model'),
      hfFile(PARAFORMER_ZH_DIR, 'tokens.txt', 75_354, 'tokens'),
    ],
    approxBytes: 227_405_559,
    platforms: ['macos', 'web'],
  },
  {
    id: 'zipformer-ja-reazonspeech',
    nameKey: 'models.reazonspeechJa',
    languages: ['ja'],
    engine: 'transducer',
    dir: REAZONSPEECH_JA_DIR,
    // 权重个体文件取自源仓 reazonspeech-k2-v2：预置包 sherpa-onnx-zipformer-ja-
    // reazonspeech-2024-08-01 仅以 GitHub release tar 包整体分发，无逐文件 HF 直链。
    // 落地目录沿用预置包命名，encoder/joiner 用 int8、decoder 用 fp32（该包约定）。
    files: [
      hfFile('reazonspeech-k2-v2', 'encoder-epoch-99-avg-1.int8.onnx', 154_670_139, 'encoder', REAZONSPEECH_JA_DIR),
      hfFile('reazonspeech-k2-v2', 'decoder-epoch-99-avg-1.onnx', 11_767_836, 'decoder', REAZONSPEECH_JA_DIR),
      hfFile('reazonspeech-k2-v2', 'joiner-epoch-99-avg-1.int8.onnx', 2_696_970, 'joiner', REAZONSPEECH_JA_DIR),
      hfFile('reazonspeech-k2-v2', 'tokens.txt', 45_754, 'tokens', REAZONSPEECH_JA_DIR),
    ],
    approxBytes: 169_180_699,
    platforms: ['macos', 'web'],
  },
  {
    id: 'parakeet-tdt-0.6b-v2-en',
    nameKey: 'models.parakeetEn',
    languages: ['en'],
    engine: 'transducer',
    modelType: 'nemo_transducer',
    dir: PARAKEET_EN_DIR,
    files: [
      hfFile(PARAKEET_EN_DIR, 'encoder.int8.onnx', 652_184_296, 'encoder'),
      hfFile(PARAKEET_EN_DIR, 'decoder.int8.onnx', 7_257_753, 'decoder'),
      hfFile(PARAKEET_EN_DIR, 'joiner.int8.onnx', 1_739_080, 'joiner'),
      hfFile(PARAKEET_EN_DIR, 'tokens.txt', 9_384, 'tokens'),
    ],
    approxBytes: 661_190_513,
    platforms: ['macos', 'web'],
  },
];

/** 默认 ASR 模型 id（多语种、全平台可用）。 */
export const DEFAULT_ASR_MODEL_ID = 'sense-voice';

/** 按 id 取模型规格。 */
export function getAsrModel(id: string): AsrModelSpec | undefined {
  return ASR_MODELS.find((m) => m.id === id);
}

/** 在某平台上支持指定识别语言的模型（languages 含该语言且 platforms 含该平台）。 */
export function asrModelsFor(language: AsrLang, platform: Platform): AsrModelSpec[] {
  return ASR_MODELS.filter(
    (m) => m.languages.includes(language) && m.platforms.includes(platform),
  );
}

/**
 * "模型是否齐全" 检查所用的相对路径清单（相对 models 目录，POSIX 分隔符）：
 * 公共依赖 Silero VAD + 指定模型的全部文件；未知 id 仅返回 VAD。
 * 各端据此 `existsSync(join(modelsDir, rel))` 判断。
 */
export function requiredAsrFiles(modelId: string): string[] {
  const files: AsrModelFile[] = [SILERO_VAD, ...(getAsrModel(modelId)?.files ?? [])];
  return files.map((f) => (f.dir ? `${f.dir}/${f.filename}` : f.filename));
}
