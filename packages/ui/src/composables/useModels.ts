// 模型列表单例：把「模型管理」页的列表状态从组件里提出来，跨挂载复用同一份快照。
//
// 动机：设置页各分区用 v-if 渲染，每次切到「模型管理」都会重新挂载组件。若在 onMounted 里
// 无脑重新 listModels()，就会每次全量探测 Cache Storage（移动端慢——首屏空 1 秒多才出模型；
// 且反复切 tab 会累积内存压力乃至崩溃）。这里只在**真正变化**时刷新：首次加载、下载完成/失败/取消、
// 删除后；其余进入页面直接用缓存快照，秒开。
import { ref, type Ref } from 'vue';
import type { ModelInfo } from '@rt/core';
import { bridge } from '../bridge';
import { onDownloadDone } from './useModelDownloads';

// —— 单例状态 ——
// 模型列表快照（跨组件挂载共享）、首次加载标记、在途探测句柄（并发去重）。
const models = ref<ModelInfo[]>([]);
let loaded = false;
let inFlight: Promise<void> | null = null;

/** 重新探测并更新模型列表。并发调用共享同一次探测（去重），避免快速切 tab 时重复打缓存。 */
export function refreshModels(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = bridge()
    .listModels()
    .then((list) => {
      models.value = list;
      loaded = true;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

// 应用级只注册一次：下载完成/失败/取消后刷新列表，保持展示与实际缓存一致
// （取消失败态是同步清理、不发 done 事件，由删除/取消处显式 refreshModels 兜底）。
let doneRegistered = false;
function ensureDoneListener(): void {
  if (doneRegistered) return;
  doneRegistered = true;
  onDownloadDone(() => {
    void refreshModels();
  });
}

/**
 * 模型管理页数据源：返回共享的 models 快照与刷新方法。
 * 首次使用触发一次探测（此后进入页面直接用快照，秒开）；删除/取消等本地变更由调用方显式 refreshModels()。
 */
export function useModels(): { models: Ref<ModelInfo[]>; refreshModels: () => Promise<void> } {
  ensureDoneListener();
  if (!loaded && !inFlight) void refreshModels();
  return { models, refreshModels };
}
