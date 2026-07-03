// 音频采集来源的平台可用性判定：主进程与 preload 共用同一处逻辑，避免两侧漂移。
// 系统音频采集依赖 CoreAudio Tap，要求 macOS 14.2 及以上；不满足时仅提供麦克风。
import type { AudioSource } from '@rt/core';

/** 系统版本（形如 "14.2" / "15.1.1"，取自 process.getSystemVersion()）是否支持系统音频采集。 */
export function systemAudioSupported(systemVersion: string): boolean {
  const [major, minor] = systemVersion.split('.').map((n) => parseInt(n, 10) || 0);
  return major > 14 || (major === 14 && minor >= 2);
}

/** 本机可用的音频采集来源列表：支持系统音频时为 ['system','mic']，否则仅 ['mic']。 */
export function availableAudioSources(systemVersion: string): AudioSource[] {
  return systemAudioSupported(systemVersion) ? ['system', 'mic'] : ['mic'];
}
