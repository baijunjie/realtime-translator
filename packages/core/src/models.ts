// 平台无关的 ASR 模型视图：从统一注册表 ./model-registry 的 MODELS 过滤 kind==='asr' 派生，
// 保持既有导出形状（ASR_MODELS / SILERO_VAD / helpers），各端消费不变。每个文件的下载源为按端分源的
// 有序 URL 列表（AsrModelFile.nativeUrls / webUrls，源治理见 ./model-sources），下载器按序 fallback。
//
// 增删/迁移模型请改 ./model-registry（单一事实源），不要在这里或各端硬编码 URL/文件名/目录。
//
// iOS 注意：iOS 原生下载器消费同一份注册表——apps/ios/native-plugin/scripts/gen-asr-models-swift.mjs
// 从本模块的 ASR_MODELS / SILERO_VAD / DEFAULT_ASR_MODEL_ID 代码生成 Swift。故本模块**不得** import
// ./translation/local-spec 或 chinese-conv，否则会把翻译行为拖进以本模块为入口的 iOS esbuild 子图。
//
// 翻译模型（M2M100）的视图见 ./translation/local-spec。
import { MODELS, SILERO_VAD_FILE, type AsrFileSpec, type AsrModelEntry } from './model-registry';
import type { AsrCommitStrategy, AsrLang, Platform } from './types';

/** 单个需下载的 ASR 模型文件（含公共依赖 VAD）：按端分源的有序 URL 列表 + 落地信息 + 近似字节 + 角色。 */
export type AsrModelFile = AsrFileSpec;

/** 一个可选用的 ASR 模型规格（平台无关视图；platforms 从注册表 availability 摊平到顶层）。 */
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
  /** 行内文本提交策略（转写管线据此选择落定方式；取值语义见 types 的 AsrCommitStrategy）。 */
  commitStrategy: AsrCommitStrategy;
  /** 模型文件所在子目录（相对 models 目录）。 */
  dir: string;
  /** 该模型的全部需下载文件（不含公共依赖 Silero VAD）。 */
  files: AsrModelFile[];
  /** 该模型全部文件合计近似字节。 */
  approxBytes: number;
  /** 支持该模型的平台。 */
  platforms: Platform[];
}

/**
 * Silero VAD：所有 ASR 模型共用的语音端点检测依赖。不进模型选择列表，随任一模型一并下载
 * （见 requiredAsrFiles）。下载源见 ./model-registry 的 SILERO_VAD_FILE。
 */
export const SILERO_VAD: AsrModelFile = SILERO_VAD_FILE;

/** 可选用的 ASR 模型注册表（从统一清单派生的视图）。 */
export const ASR_MODELS: readonly AsrModelSpec[] = MODELS.filter(
  (m): m is AsrModelEntry => m.kind === 'asr',
).map((m) => ({
  id: m.id,
  nameKey: m.nameKey,
  languages: m.languages,
  engine: m.engine,
  modelType: m.modelType,
  commitStrategy: m.commitStrategy,
  dir: m.dir,
  files: m.files,
  approxBytes: m.approxBytes,
  platforms: m.availability.platforms,
}));

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
