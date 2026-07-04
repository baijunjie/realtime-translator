import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ElectronApi } from '../shared/types';
import { availableAudioSources } from '../shared/audio-source';

// 订阅主进程事件并返回反注册函数（AppBridge on* 契约：追加语义 + 可退订）
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: ElectronApi = {
  platform: 'macos',
  // 系统音频采集要求 macOS 14.2+；不满足时仅暴露麦克风（与主进程的音源收敛判定共用逻辑）。
  audioSources: availableAudioSources(process.getSystemVersion()),
  startPipeline: () => ipcRenderer.invoke('pipeline:start'),
  prewarmPipeline: () => ipcRenderer.send('pipeline:prewarm'),
  stopPipeline: () => ipcRenderer.invoke('pipeline:stop'),
  sendAudio: (samples) => ipcRenderer.send('pipeline:audio', samples),
  getMicStatus: () => ipcRenderer.invoke('mic:get-status'),
  openMicSettings: () => ipcRenderer.send('mic:open-settings'),
  openSystemAudioSettings: () => ipcRenderer.send('system-audio:open-settings'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  testCloud: (cfg) => ipcRenderer.invoke('translation:test-cloud', cfg),
  getSetupStatus: (modelId) => ipcRenderer.invoke('setup:get-status', modelId),
  downloadAsrModels: (modelId) => ipcRenderer.invoke('setup:download-asr', modelId),
  listModels: () => ipcRenderer.invoke('models:list'),
  deleteModel: (kind, id) => ipcRenderer.invoke('models:delete', kind, id),
  cancelModelDownload: (kind, id) => ipcRenderer.invoke('models:cancel-download', kind, id),
  getTranslationSetupStatus: (modelId) => ipcRenderer.invoke('translation:setup-status', modelId),
  downloadTranslationModel: (modelId) => ipcRenderer.invoke('translation:download', modelId),
  onSetupProgress: (cb) => subscribe('setup:progress', cb),
  saveArchive: (name, lines) => ipcRenderer.invoke('archive:save', name, lines),
  listArchives: () => ipcRenderer.invoke('archive:list'),
  getArchive: (id) => ipcRenderer.invoke('archive:get', id),
  deleteArchive: (id) => ipcRenderer.invoke('archive:delete', id),
  onSegment: (cb) => subscribe('pipeline:segment', cb),
  onPartial: (cb) => subscribe('pipeline:partial', cb),
  onTranslation: (cb) => subscribe('pipeline:translation', cb),
  onStatus: (cb) => subscribe('pipeline:status', cb),
  onTranslationStatus: (cb) => subscribe('translation:status', cb),
};

contextBridge.exposeInMainWorld('api', api);
