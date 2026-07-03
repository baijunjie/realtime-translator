// 主进程与渲染进程之间通过 IPC 传递的数据结构，以及暴露给渲染进程的 API。
// 平台无关的领域类型已下沉到 @rt/core，这里再导出以保持既有 import 路径不变；
// 本文件只保留 Electron 进程相关的 IPC 契约与 preload API。

import type {
  SegmentPayload,
  PartialPayload,
  TranslationStatusPayload,
  TranslationEngine,
  CloudTranslationConfig,
  AsrLang,
} from '@rt/core';

// 重新导出领域类型与桥接契约，使 apps/macos 内既有的 `from '../shared/types'` / `@shared/types` 继续可用。
// AppBridge 已下沉到 @rt/core（packages/core/src/bridge.ts），这里转出以保持 preload/main 的导入路径不变。
import type { AppBridge } from '@rt/core';

export type {
  SegmentPayload,
  TranslationPayload,
  PartialPayload,
  StatusPayload,
  StartResult,
  TranslationStatusPayload,
  SetupStatus,
  SetupProgress,
  CloudTranslationConfig,
  TranslationSettings,
  LocalEngine,
  TranslationEngine,
  FontSize,
  UiLang,
  ThemePref,
  MicPermission,
  ArchiveLine,
  ArchiveRecord,
  ArchiveSummary,
  AppSettings,
  AppBridge,
  AsrLang,
  AsrSettings,
  Platform,
  AudioSource,
  ModelInfo,
  ModelKind,
} from '@rt/core';

// Electron preload 暴露给渲染层的 window.api 的实际形状：在平台无关的 AppBridge 之上，
// 额外保留 sendAudio（IPC 送 PCM）。注意：这里的 startPipeline/stopPipeline 是“ASR 子进程
// 的启停”（不含音频采集）——渲染层的 createMacBridge 在其外再叠加 getUserMedia/AudioWorklet 采集，
// 对 @rt/ui 呈现为完整会话的 AppBridge。
export type ElectronApi = AppBridge & {
  /** 渲染层采集到的 PCM 帧经 IPC 送往主进程/ASR 子进程 */
  sendAudio(samples: Float32Array): void;
  /** 预热 ASR 管线（后台装模型、不采麦）。preload 恒实现，故在 AppBridge 的可选之上收紧为必实现。 */
  prewarmPipeline: NonNullable<AppBridge['prewarmPipeline']>;
  /**
   * 云端配置连通性测试。macOS 在主进程用 Node fetch 打一次最小请求（无浏览器 CORS 限制，
   * 与实际云翻译同环境）。AppBridge 上是可选，这里收紧为必实现——好让设置页的「测试连接」
   * 与 Web/iOS 行为一致（见 packages/ui SettingsForm 的 canTestCloud）。
   */
  testCloud: NonNullable<AppBridge['testCloud']>;
  /**
   * 本地翻译模型的下载页所需：查询是否已缓存 / 显式下载。macOS 需自行下载 M2M100，
   * preload 恒实现这两个方法，故在 AppBridge 的可选之上收紧为必实现。
   */
  getTranslationSetupStatus: NonNullable<AppBridge['getTranslationSetupStatus']>;
  downloadTranslationModel: NonNullable<AppBridge['downloadTranslationModel']>;
};

/** ASR 子进程(utilityProcess) ←→ 主进程 的消息协议 */
export type MainToAsr =
  | { type: 'init'; modelsDir: string; modelId: string; language: AsrLang }
  | { type: 'audio'; samples: Float32Array }
  | { type: 'flush' }
  /** 开始新一次录音会话：重置 segment.start 的计时基线（子进程跨会话复用） */
  | { type: 'reset' };

export type AsrToMain =
  | { type: 'ready' }
  | { type: 'segment'; payload: SegmentPayload }
  | { type: 'partial'; payload: PartialPayload }
  | { type: 'error'; message: string };

/** 翻译子进程(utilityProcess) ←→ 主进程 的消息协议 */
export type MainToTranslate =
  | { type: 'configure'; engine: TranslationEngine; cloud: CloudTranslationConfig; cacheDir: string }
  | { type: 'preheat' }
  | { type: 'translate'; id: number; text: string; source?: string; target: string };

export type TranslateToMain =
  | { type: 'status'; payload: TranslationStatusPayload }
  | { type: 'result'; id: number; text: string }
  /** 单次翻译失败，按 id 关联回主进程的在途请求；引擎级失败（模型加载等）仍走 status */
  | { type: 'error'; id: number; message: string };
