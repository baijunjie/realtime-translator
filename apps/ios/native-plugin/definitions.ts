// RealtimeAsr / RealtimeTranslate 原生插件的 JS 类型契约。
// 原生实现见 ./ios/RealtimeAsrPlugin.swift（sherpa-onnx 端上 ASR + AVAudioEngine 采集）
// 与 ./ios/RealtimeTranslate.swift（Apple Translation 框架端上翻译，iOS 18+）。
// 桥接层（apps/ios/src/bridge.ts）只依赖这些类型，不关心原生如何实现。

import type { PluginListenerHandle } from '@capacitor/core';
import type {
  SegmentPayload,
  PartialPayload,
  StatusPayload,
  SetupStatus,
  SetupProgress,
} from '@rt/core';

/** 插件向 JS 发的事件名 → 事件载荷类型 */
export interface RealtimeAsrEventMap {
  /** 实时部分识别结果（说话过程中持续更新；text 为空表示清除） */
  partial: PartialPayload;
  /** 一段最终确定的识别结果 */
  segment: SegmentPayload;
  /** 引擎/管线状态：loading / running / error / stopped */
  status: StatusPayload;
  /** ASR 模型下载进度（仅在 downloadModels 期间触发） */
  setupProgress: SetupProgress;
}

export interface RealtimeAsrPlugin {
  /**
   * 启动端上 ASR 管线：按 modelId 加载对应识别模型（若已就绪）、打开麦克风
   * （AVAudioEngine，16kHz 单声道）、开始识别。后续通过 'partial' / 'segment' / 'status'
   * 事件回吐结果。iOS 由原生直接采集麦克风，无需 JS 侧 getUserMedia / sendAudio。
   * language 为 SenseVoice 的识别语言（auto/zh/en/ja/ko/yue）；与已加载识别器不同（或 modelId
   * 不同）时原生会重建识别器。options 省略时原生按默认模型 + auto 处理。
   */
  start(options?: { modelId: string; language: string }): Promise<{ ok: boolean; error?: string }>;

  /** 停止采集与识别，释放音频会话。 */
  stop(): Promise<{ ok: boolean }>;

  /**
   * 预热 ASR 管线：把 modelId 对应的识别模型装载进内存，不触碰麦克风、不申请权限；
   * 模型未下载时静默跳过。立即 resolve，装载在原生串行队列异步进行，与随后的 start() 天然合流
   * （引擎已按相同 modelId+language 加载则秒过）。预热期间经 'status' 报 loading、完成后报 stopped。
   */
  prewarm(options?: { modelId: string; language: string }): Promise<void>;

  /** 查询指定 ASR 模型（含公共依赖 VAD）是否已就绪（已下载/已随包内置）。 */
  getSetupStatus(options: { modelId: string }): Promise<SetupStatus>;

  /**
   * 确保指定 ASR 模型已就绪（首次需下载该模型 + Silero VAD）。
   * 进度通过 'setupProgress' 事件上报。
   */
  downloadModels(options: { modelId: string }): Promise<{ ok: boolean; error?: string }>;

  /**
   * 列出本地各 ASR 模型的占用与状态（遍历生成表逐模型判断文件是否齐全、磁盘字节和）。
   * inUse 由 JS 侧按当前设置判定，不在此携带。
   */
  listModels(): Promise<{ models: { id: string; sizeBytes: number; downloaded: boolean }[] }>;

  /**
   * 删除某个已下载 ASR 模型（录音中拒绝；仅删该模型目录，公共依赖 VAD 不删；
   * 删的是当前已加载模型时原生会释放识别器）。失败带 error。
   */
  deleteModel(options: { id: string }): Promise<{ ok: boolean; error?: string }>;

  /** 查询麦克风权限状态（映射到 @rt/core 的 MicPermission）。 */
  getMicStatus(): Promise<{ status: string }>;

  /** 打开系统设置（iOS 应用设置页，供用户授予麦克风权限）。 */
  openMicSettings(): Promise<void>;

  /** 订阅插件事件，返回可用于反注册的句柄。 */
  addListener<E extends keyof RealtimeAsrEventMap>(
    eventName: E,
    listenerFunc: (data: RealtimeAsrEventMap[E]) => void,
  ): Promise<PluginListenerHandle>;

  /** 移除该插件的所有监听。 */
  removeAllListeners(): Promise<void>;
}

/** translate() 的返回：成功给 text；不可用时 unavailable=true + reason（不会 reject）。 */
export interface TranslateResult {
  /** 译文（不可用时为空串） */
  text: string;
  /** 该语言对/系统不支持端上翻译时为 true，桥接层据此回退/提示用户 */
  unavailable?: boolean;
  /** unavailable 时的原因（英文，便于排查；UI 通常提示改用云翻译） */
  reason?: string;
}

/** availability() 的返回：语言包状态。 */
export interface TranslateAvailability {
  /** installed=已就绪可立即译；supported=支持但需先下载语言包；unsupported=不支持该语言对 */
  status: 'installed' | 'supported' | 'unsupported';
}

/**
 * RealtimeTranslate：Apple Translation 框架的端上（离线）文本翻译（iOS 18+）。
 * 原生实现见 ./ios/RealtimeTranslate.swift。云翻译仍由 JS 侧 @rt/core CloudTranslator
 * 承担（见 bridge.ts），二者为「云 / 设备端」两种引擎，互不替代。
 *
 * 短码：zh / en / ja / ko / yue（与 ASR/翻译规格一致）。繁体已在 @rt/core 并入简体 zh；
 * yue 无对应 Apple 语言，尽力映射为 zh（不支持时返回 unavailable）。
 */
export interface RealtimeTranslatePlugin {
  /**
   * 端上翻译一段文本（source/target 为短码）。永不 reject：
   * - 成功 → { text }
   * - iOS<18 / 不支持的语言对 / 语言包缺失等 → { text: '', unavailable: true, reason }
   */
  translate(options: {
    text: string;
    source: string;
    target: string;
  }): Promise<TranslateResult>;

  /** 查询某语言对的端上可用性（installed / supported / unsupported）。 */
  availability(options: {
    source: string;
    target: string;
  }): Promise<TranslateAvailability>;
}
