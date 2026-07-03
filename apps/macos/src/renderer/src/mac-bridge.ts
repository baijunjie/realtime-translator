// macOS（Electron 渲染层）平台桥接：把 preload 暴露的 window.api（ElectronApi）包装成
// @rt/ui 依赖的平台无关 AppBridge。音频采集（getUserMedia + AudioContext + AudioWorklet）
// 在这里完成——@rt/ui 不再感知浏览器采集细节。
//
// startPipeline：先启动 ASR 子进程（api.startPipeline），就绪后开始采集并经 api.sendAudio 送 PCM。
// stopPipeline：先停采集（停轨 + 关闭 AudioContext），再停 ASR 子进程（api.stopPipeline）。
// 其余方法全部直通 window.api。

import type { AppBridge, StartResult, PipelineErrorCode } from '@rt/core';
import type { ElectronApi } from '@shared/types';

export function createMacBridge(api: ElectronApi): AppBridge {
  let audioContext: AudioContext | null = null;
  let mediaStream: MediaStream | null = null;
  // 重入守卫：正在进行的启动 promise，供并发/重复调用复用，避免双路采集与旧流引用被覆盖泄漏
  let starting: Promise<StartResult> | null = null;

  /** 权限类采集失败（用户拒绝 / 未授权）。 */
  function isPermissionError(err: unknown): boolean {
    return err instanceof DOMException && err.name === 'NotAllowedError';
  }

  /**
   * 采集系统音频（loopback）。video 必须请求一个 4×4 的微型轨——Electron 近期版本对 0×0
   * video 的 loopback 会返回静音流，故取一个最小 video 轨规避；拿到流后立即停掉 video 轨，
   * 只保留 audio 轨接入识别链路。
   */
  async function captureSystemAudio(): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: { width: 4, height: 4, frameRate: 1 },
    });
    stream.getVideoTracks().forEach((tr) => tr.stop());
    return stream;
  }

  // 启动采集链路：ASR 子进程就绪后，按设置的音源取麦克风或系统音频，接上 AudioWorklet。
  // 任一步失败则释放已获取的 stream/context 并回滚主进程已 start 的 pipeline，返回
  // { ok: false }（StartResult 契约），避免 unhandled rejection、麦克风指示灯常亮与主进程状态残留。
  async function beginCapture(): Promise<StartResult> {
    const r = await api.startPipeline();
    if (!r.ok) return r;
    const source = (await api.getSettings()).audioSource;
    try {
      mediaStream =
        source === 'system'
          ? await captureSystemAudio()
          : await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      audioContext = new AudioContext({ sampleRate: 16000 });
      await audioContext.audioWorklet.addModule('audio-worklet.js');
      const audioSource = audioContext.createMediaStreamSource(mediaStream);
      const capture = new AudioWorkletNode(audioContext, 'capture-processor');
      capture.port.onmessage = (e: MessageEvent<Float32Array>) => api.sendAudio(e.data);
      audioSource.connect(capture);
      return r;
    } catch (err) {
      mediaStream?.getTracks().forEach((tr) => tr.stop());
      mediaStream = null;
      await audioContext?.close();
      audioContext = null;
      await api.stopPipeline();
      const error = err instanceof Error ? err.message : String(err);
      // 系统音频路径：区分「录制权限被拒」与「采集链路建立失败」；麦克风路径沿用原语义。
      if (source === 'system') {
        const code: PipelineErrorCode = isPermissionError(err)
          ? 'system-audio-permission'
          : 'audio-capture-failed';
        return { ok: false, error, code };
      }
      return { ok: false, error };
    }
  }

  return {
    platform: api.platform,
    audioSources: api.audioSources,
    // 构建期注入的发布版本串；define 缺失的环境（如单测导入）下不暴露
    appVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : undefined,
    async startPipeline() {
      if (starting) return starting;
      if (mediaStream) return { ok: true }; // 已在采集中，重复调用直接返回
      starting = beginCapture();
      try {
        return await starting;
      } finally {
        starting = null;
      }
    },

    async stopPipeline() {
      // 等在途启动先完成再拆除：保证「stop 晚于 start 调用」必然「stop 晚于 start 生效」，
      // 不会在 beginCapture 取到麦克风前拆了个寂寞、留下持续采集的流。
      if (starting) {
        await starting.catch(() => undefined);
      }
      if (mediaStream) {
        mediaStream.getTracks().forEach((tr) => tr.stop());
        mediaStream = null;
      }
      if (audioContext) {
        await audioContext.close();
        audioContext = null;
      }
      return api.stopPipeline();
    },

    // ===== 以下全部直通 window.api =====
    prewarmPipeline: () => api.prewarmPipeline(),
    getMicStatus: () => api.getMicStatus(),
    openMicSettings: () => api.openMicSettings(),
    getSettings: () => api.getSettings(),
    saveSettings: (settings) => api.saveSettings(settings),
    testCloud: (cfg) => api.testCloud(cfg),
    getSetupStatus: (modelId) => api.getSetupStatus(modelId),
    downloadAsrModels: (modelId) => api.downloadAsrModels(modelId),
    listModels: () => api.listModels(),
    deleteModel: (kind, id) => api.deleteModel(kind, id),
    getTranslationSetupStatus: (modelId) => api.getTranslationSetupStatus(modelId),
    downloadTranslationModel: (modelId) => api.downloadTranslationModel(modelId),
    saveArchive: (name, lines) => api.saveArchive(name, lines),
    listArchives: () => api.listArchives(),
    getArchive: (id) => api.getArchive(id),
    deleteArchive: (id) => api.deleteArchive(id),
    onSetupProgress: (cb) => api.onSetupProgress(cb),
    onSegment: (cb) => api.onSegment(cb),
    onPartial: (cb) => api.onPartial(cb),
    onTranslation: (cb) => api.onTranslation(cb),
    onStatus: (cb) => api.onStatus(cb),
    onTranslationStatus: (cb) => api.onTranslationStatus(cb),
  };
}
