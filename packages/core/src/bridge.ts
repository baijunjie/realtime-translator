// 平台无关的 UI ←→ 平台桥接契约。
// 渲染层（@rt/ui）只依赖此接口，由各宿主（Electron 渲染层 / iOS Capacitor 等）注入实现。
// 仅引用 @rt/core 内的领域类型与回调，保持平台无关；音频采集不在此契约内（隐藏在各宿主实现中）。

import type {
  SegmentPayload,
  PartialPayload,
  TranslationPayload,
  StatusPayload,
  TranslationStatusPayload,
  StartResult,
  MicPermission,
  Platform,
  AudioSource,
  ModelInfo,
  ModelKind,
  AppSettings,
  CloudTranslationConfig,
  SetupStatus,
  SetupProgress,
  ArchiveLine,
  ArchiveSummary,
  ArchiveRecord,
} from './types';

/**
 * 宿主提供给渲染层（@rt/ui）的平台桥接契约，由各宿主实现并注入。
 * UI 只负责开/停会话与接收事件，音频采集隐藏在桥接背后、按平台实现：
 *  - macOS（Electron）：渲染层 createMacBridge 用 getUserMedia/AudioWorklet 采集，经 IPC 送音频。
 *  - iOS（Capacitor）：原生插件直接采麦，JS 侧无需送音频。
 */
export interface AppBridge {
  /** 运行平台标识；UI 据此按平台过滤可用模型、决定音源开关等。 */
  platform: Platform;
  /**
   * 本平台支持的音频采集来源；缺省视为 `['mic']`。
   * UI 仅当其中含 `'system'` 时才渲染「系统音频 / 麦克风」音源开关。
   */
  audioSources?: readonly AudioSource[];
  /** 开始整个实时会话（含音频采集） */
  startPipeline(): Promise<StartResult>;
  /**
   * 预热 ASR 管线：把识别模型装载进内存，不触碰麦克风、不申请任何权限。
   * 幂等、可重复调用；模型尚未下载时静默跳过。UI 在进入主界面时 fire-and-forget
   * 调用，使首次点击录音免等冷启动；预热未完成时 startPipeline 与其合流等待。
   * 预热期间经 onStatus 报 loading（录音按钮据此禁用）、完成后报 stopped。
   */
  prewarmPipeline?(): void;
  /** 停止整个实时会话（含音频采集） */
  stopPipeline(): Promise<{ ok: boolean }>;
  /**
   * 本平台是否支持本地（离线）翻译引擎。省略/undefined 视为 true。
   * Web 在 iOS/iPadOS 上为 false：WebKit 单标签页内存装不下本地翻译模型（会崩），只提供
   * 云端翻译——设置里不展示本地引擎选项，引擎恒为 cloud（见 apps/web/src/bridge.ts）。
   */
  localTranslationAvailable?: boolean;
  /**
   * 本应用的发布版本串：构建期注入的「包版本+commit 短哈希」（如 0.1.0-beta.1+abc1234）。
   * 设置页据此展示；缺省时不展示。
   */
  appVersion?: string;
  /** 查询麦克风权限状态（用于在请求权限前先弹说明） */
  getMicStatus(): Promise<MicPermission>;
  /** 打开系统设置的麦克风隐私页（macOS） */
  openMicSettings(): void;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
  /**
   * 测试云端翻译配置是否可用：真实打一次最小请求，验证端点 / 密钥 / 模型。ok=false 时带 error。
   * Web / iOS 在 JS 内直接 fetch；macOS 在主进程用 Node fetch（preload 处收紧为必选实现）。
   * UI 仅在本方法存在时才显示「测试连接」按钮。
   */
  testCloud?(cfg: CloudTranslationConfig): Promise<{ ok: boolean; error?: string }>;
  /**
   * 强制更新应用资源（Web PWA 专用）：注销 Service Worker、清除应用外壳缓存后整页重载，
   * 供已安装 PWA 长期拿不到新版本时手动拉取最新产物；模型等大文件缓存保留不动。
   * UI 仅在本方法存在时才在主屏幕菜单显示「强制更新」入口，原生端（macOS/iOS）无需实现。
   */
  forceUpdateApp?(): Promise<void>;
  /** 查询指定 ASR 模型（含公共依赖 VAD）是否已就绪 */
  getSetupStatus(modelId: string): Promise<SetupStatus>;
  /** 下载指定 ASR 模型（含公共依赖 VAD），返回结果（失败带 error，供重试） */
  downloadAsrModels(modelId: string): Promise<{ ok: boolean; error?: string }>;
  /** 列出本地各模型（ASR / 翻译）的占用与状态，供模型管理页展示 */
  listModels(): Promise<ModelInfo[]>;
  /** 删除某个已下载模型，返回结果（失败带 error） */
  deleteModel(kind: ModelKind, id: string): Promise<{ ok: boolean; error?: string }>;
  /**
   * 指定本地翻译模型（按注册表 id，语义与当前选中引擎无关）是否已下载到本地缓存。
   * 仅当平台需要自行下载本地翻译模型时提供（macOS / Web 的 M2M100）；缺省表示无需下载
   * （如 iOS 走系统翻译，语言包由系统管理）。UI 据此在开启本地翻译/录音前决定是否先下载该模型。
   */
  getTranslationSetupStatus?(modelId: string): Promise<{ ready: boolean }>;
  /**
   * 下载指定本地翻译模型（按注册表 id）：与 ASR 下载同一套自研链路，进度经 onSetupProgress
   * （loaded/total）上报，完成/失败由返回值表达（失败带 error 供重试）。与 getTranslationSetupStatus 成对提供。
   */
  downloadTranslationModel?(modelId: string): Promise<{ ok: boolean; error?: string }>;
  /** 归档：保存一次对话，返回更新后的列表 */
  saveArchive(name: string, lines: ArchiveLine[]): Promise<ArchiveSummary[]>;
  listArchives(): Promise<ArchiveSummary[]>;
  getArchive(id: string): Promise<ArchiveRecord | null>;
  deleteArchive(id: string): Promise<ArchiveSummary[]>;
  // 事件订阅：追加语义（同一事件可注册多个回调），返回本次注册的反注册函数。
  // 组件级订阅（如 SetupScreen）须在卸载时反注册，避免监听器持有已卸载组件的闭包累积。
  onSetupProgress(cb: (progress: SetupProgress) => void): () => void;
  onSegment(cb: (segment: SegmentPayload) => void): () => void;
  onPartial(cb: (partial: PartialPayload) => void): () => void;
  onTranslation(cb: (translation: TranslationPayload) => void): () => void;
  onStatus(cb: (status: StatusPayload) => void): () => void;
  onTranslationStatus(cb: (status: TranslationStatusPayload) => void): () => void;
}
