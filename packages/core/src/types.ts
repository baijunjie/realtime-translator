// 平台无关的领域类型：在 macOS/iOS 等各端之间共享的纯数据结构。
// Electron 进程间的 IPC 契约（MainToAsr 等）保留在各端，不放这里。

/** 一条最终确定的转写结果 */
export interface SegmentPayload {
  /** 段序号，译文异步回来时用它对应到正确的行 */
  id: number;
  text: string;
  /** 语言代码，如 zh / ja / en */
  lang: string;
  /** 段起始时间（秒） */
  start: number;
  /** 段时长（秒） */
  duration: number;
}

/** 某条转写段的译文，按 id 对应回原文行 */
export interface TranslationPayload {
  id: number;
  /** 译文文本；pending / failed 阶段为占位空串 */
  text: string;
  /**
   * true=翻译已派发、结果尚未到达（UI 在译文区显示等待动画）；
   * 缺省/false=最终结果（text 即译文，空串表示无需翻译，仅用于结束等待、不展示）。
   * 同语言等「无需翻译」的场景不发本事件，故不会出现等待动画。
   */
  pending?: boolean;
  /**
   * true=该行翻译失败：结束等待动画并在该行显示失败标记。单条失败只影响本行，
   * 不进入全局引擎状态通道（onTranslationStatus 的 error 专指引擎级故障）。
   */
  failed?: boolean;
  /** 失败原文（宿主自由文本，供悬停提示/排查），仅 failed 时有值 */
  error?: string;
}

/** 说话过程中实时更新的部分识别结果，text 为空表示清除 */
export interface PartialPayload {
  text: string;
}

/**
 * 管线错误的稳定错误码：宿主上报错误时随 error 原文一并携带，UI 据此显示
 * 本地化文案；无码或未知码时回退 error 原文（宿主自由文本，可能非界面语言）。
 */
export type PipelineErrorCode =
  | 'mic-permission' // 麦克风权限被拒/未授予
  | 'audio-capture-failed' // 音频采集链路建立失败（无输入设备/被占用等）
  | 'audio-interrupted' // 系统音频中断（媒体服务重置等）
  | 'asr-init-failed' // 识别引擎初始化/模型加载失败
  | 'asr-crashed'; // 识别进程/引擎异常退出

export interface StatusPayload {
  state: 'loading' | 'running' | 'error' | 'stopped';
  error?: string;
  /** 错误码（state 为 error 时可选携带） */
  code?: PipelineErrorCode;
}

export interface StartResult {
  ok: boolean;
  error?: string;
  /** 错误码（ok 为 false 时可选携带） */
  code?: PipelineErrorCode;
}

/** 翻译模型单个文件的下载进度（模型由多个文件组成，供 UI 逐文件展示独立进度条） */
export interface TranslationFileProgress {
  /** 文件相对路径（如 onnx/encoder_model_quantized.onnx） */
  file: string;
  /** 该文件的 0~1 进度 */
  progress: number;
  /** 已下载字节 */
  loaded: number;
  /** 总字节 */
  total: number;
}

/** 翻译模型的加载状态（首次需联网下载约 600MB） */
export interface TranslationStatusPayload {
  state: 'loading' | 'ready' | 'error';
  /** 0~1 总进度（按全部文件的字节聚合，若有） */
  progress?: number;
  /** 各文件独立进度（若有）；文件按发现顺序排列 */
  files?: TranslationFileProgress[];
  error?: string;
}

/** 首次启动下载 ASR 模型的状态 */
export interface SetupStatus {
  asrReady: boolean;
}

/** ASR 模型下载进度 */
export interface SetupProgress {
  /** 已下载字节 */
  loaded: number;
  /** 总字节 */
  total: number;
}

/** OpenAI 兼容云端翻译配置 */
export interface CloudTranslationConfig {
  /** 形如 https://api.openai.com/v1 */
  baseURL: string;
  apiKey: string;
  /** 模型名，如 gpt-4o-mini */
  model: string;
}

/** 本地翻译模型：即插即用，新增模型只加一份 spec（许可须可自由分发） */
export type LocalEngine = 'm2m100';
/** 翻译引擎：本地模型 + 云端 */
export type TranslationEngine = LocalEngine | 'cloud';

export interface TranslationSettings {
  /** 是否开启翻译（目标恒为母语 nativeLang） */
  enabled: boolean;
  engine: TranslationEngine;
  cloud: CloudTranslationConfig;
}

/** 主页转写字体大小档位 */
export type FontSize = 'small' | 'medium' | 'large';

/** 界面/母语语言码（界面文案 + 翻译目标）。zh=简体中文，zh-Hant=繁體中文 */
export type UiLang = 'zh' | 'zh-Hant' | 'ja' | 'en' | 'ko';

/** 主题偏好：浅色 / 深色 / 跟随系统 */
export type ThemePref = 'light' | 'dark' | 'system';

/** 麦克风权限状态（macOS systemPreferences.getMediaAccessStatus） */
export type MicPermission = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

/**
 * 网络连接类型，用于蜂窝网络下下载模型（ASR 约 230MB / 本地翻译约 630MB）前的确认。
 * unknown 表示平台无法判断连接类型，按「不打扰」处理（不弹确认、维持现状直接下载）。
 */
export type NetworkType = 'wifi' | 'cellular' | 'unknown';

/** 归档里的一行对话 */
export interface ArchiveLine {
  time: string;
  text: string;
  translation: string;
}

/** 一条完整归档记录（持久化） */
export interface ArchiveRecord {
  id: string;
  name: string;
  createdAt: number;
  lines: ArchiveLine[];
}

/** 归档列表项（不含完整内容，仅摘要） */
export interface ArchiveSummary {
  id: string;
  name: string;
  createdAt: number;
  /** 最后一条对话的原文，列表里弱色小字显示 */
  lastLine: string;
}

/** 持久化到本地（electron userData）的应用设置 */
export interface AppSettings {
  /** 是否已完成首次语言引导 */
  onboarded: boolean;
  /** 母语：界面语言 + 翻译目标 */
  nativeLang: UiLang;
  fontSize: FontSize;
  /** 主题偏好 */
  theme: ThemePref;
  translation: TranslationSettings;
}
