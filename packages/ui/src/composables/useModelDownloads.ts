// app 级模型下载管理器（单例，仿 useTranscription 的模式）：把下载生命周期从下载弹窗里「提」出来，
// 使下载在后台进行、跨屏（设置页行内进度 / 主屏录音进度模态）共享同一份状态与取消入口。
//
// 并行下载：多个模型可同时下载，各自一个 entry、各自进度。进度事件（onSetupProgress）携带 kind+id，
// 管理器据此把进度路由到对应 entry（不再依赖「单活跃」假设）。取消按模型独立（见 bridge.cancelModelDownload）。
import { reactive } from 'vue';
import type { ModelKind } from '@rt/core';
import { bridge } from '../bridge';

/** 一次下载任务：识别或本地翻译模型（均按注册表 id 参数化）。sizeBytes 为确认态展示的近似体积。 */
export type DownloadTask =
  | { kind: 'asr'; modelId: string; nameKey: string; sizeBytes: number }
  | { kind: 'translation'; modelId: string; nameKey: string; sizeBytes: number };

interface DownloadEntry {
  task: DownloadTask;
  /** downloading=在途；error=失败（可重试）。成功/取消的条目直接移除。 */
  status: 'downloading' | 'error';
  loaded: number;
  total: number;
}

function keyOf(kind: string, id: string): string {
  return `${kind}:${id}`;
}
function taskKey(t: DownloadTask): string {
  return keyOf(t.kind, t.modelId);
}

// —— 单例状态 ——
// 每模型下载态（下载中 / 失败），供设置页行、主屏进度模态响应式观察。成功/取消即删。
const entries = reactive<Record<string, DownloadEntry>>({});
const cancelledKeys = new Set<string>(); // 已请求取消的 key：任务 settle 后据此判「取消」而非「失败」
type DoneCb = (task: DownloadTask, ok: boolean) => void;
const doneCbs = new Set<DoneCb>();

function emitDone(task: DownloadTask, ok: boolean): void {
  for (const cb of doneCbs) cb(task, ok);
}

// 应用生命周期级：只订阅一次 onSetupProgress，按事件 kind+id 路由到对应 entry。由 mountApp 调用。
let registered = false;
export function registerModelDownloadListeners(): void {
  if (registered) return;
  registered = true;
  bridge().onSetupProgress((p) => {
    if (!p.kind || !p.id) return;
    const e = entries[keyOf(p.kind, p.id)];
    if (e && e.status === 'downloading') {
      e.loaded = p.loaded;
      e.total = p.total;
    }
  });
}

// 单个任务的下载生命周期（并行：每个任务各跑一份，互不阻塞）。
async function runTask(task: DownloadTask): Promise<void> {
  const k = taskKey(task);
  let ok = false;
  try {
    const res =
      task.kind === 'asr'
        ? await bridge().downloadAsrModels(task.modelId)
        : await bridge().downloadTranslationModel!(task.modelId);
    ok = res.ok;
  } catch {
    ok = false;
  }

  if (cancelledKeys.has(k)) {
    // 用户取消：不进失败态，直接移除条目（残留已由 bridge().cancelModelDownload 删除）。
    cancelledKeys.delete(k);
    delete entries[k];
    emitDone(task, false);
  } else if (ok) {
    delete entries[k];
    emitDone(task, true);
  } else {
    // 失败：保留条目 + 已见进度供 UI 展示错误与重试。
    entries[k] = {
      task,
      status: 'error',
      loaded: entries[k]?.loaded ?? 0,
      total: entries[k]?.total ?? 0,
    };
    emitDone(task, false);
  }
}

/** 启动下载（并行）：每个未在下载的模型各起一份。已在下载的同一模型跳过；失败态的会清错误后重下。 */
export function startDownloads(tasks: DownloadTask[]): void {
  for (const t of tasks) {
    const k = taskKey(t);
    if (entries[k]?.status === 'downloading') continue;
    cancelledKeys.delete(k);
    entries[k] = { task: t, status: 'downloading', loaded: 0, total: 0 };
    void runTask(t);
  }
}

/** 取消某模型下载：中止其在途下载 + 删除全部残留（回未下载态）；并行下载互不影响。 */
export async function cancelDownload(kind: ModelKind, id: string): Promise<void> {
  const k = keyOf(kind, id);
  cancelledKeys.add(k);
  // 中止在途 fetch（若活跃）并删除该模型全部已下文件/缓存。
  await bridge().cancelModelDownload(kind, id);
  // 失败态条目（非在途，runTask 已结束）：此处直接清理。
  if (entries[k]?.status === 'error') {
    delete entries[k];
    cancelledKeys.delete(k);
  }
}

/** 重试失败的下载。 */
export function retryDownload(kind: ModelKind, id: string): void {
  const e = entries[keyOf(kind, id)];
  if (e?.status === 'error') startDownloads([e.task]);
}

/** 订阅任务完成（ok=true）/失败或取消（ok=false）；返回反注册函数。 */
export function onDownloadDone(cb: DoneCb): () => void {
  doneCbs.add(cb);
  return () => {
    doneCbs.delete(cb);
  };
}

// —— 响应式派生（模板/计算属性中调用即建立依赖）——
export function downloadEntry(kind: string, id: string): DownloadEntry | undefined {
  return entries[keyOf(kind, id)];
}
export function isDownloading(kind: string, id: string): boolean {
  return entries[keyOf(kind, id)]?.status === 'downloading';
}
export function downloadFailed(kind: string, id: string): boolean {
  return entries[keyOf(kind, id)]?.status === 'error';
}
/** 当前在途/失败任务的百分比（total 未知时返回 0，UI 据 total===0 走 indeterminate）。 */
export function percentOf(kind: string, id: string): number {
  const e = entries[keyOf(kind, id)];
  if (!e || e.total <= 0) return 0;
  return Math.min(100, Math.round((e.loaded / e.total) * 100));
}
