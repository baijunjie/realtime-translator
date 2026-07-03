<script lang="ts">
/**
 * 一次下载任务：识别模型或本地翻译模型（均按注册表 id 参数化）。sizeBytes 为近似体积（来自
 * 注册表），仅用于确认态展示；实际进度在下载态统一由 onSetupProgress 上报（asr/translation 一致）。
 */
export type DownloadTask =
  | { kind: 'asr'; modelId: string; nameKey: string; sizeBytes: number }
  | { kind: 'translation'; modelId: string; nameKey: string; sizeBytes: number };
</script>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { NModal, NProgress, NButton } from 'naive-ui';
import { LoaderCircle } from '@lucide/vue';
import { useI18n } from 'vue-i18n';
import { bridge } from '../bridge';
import { humanBytes } from '../utils/bytes';

const { t } = useI18n();
// 所有模型下载共用的弹窗：确认 → 下载中 → （失败）三态。多任务时按顺序逐个下载。
const props = defineProps<{ tasks: DownloadTask[] }>();
const show = defineModel<boolean>('show', { default: false });
const emit = defineEmits<{ done: []; cancel: [] }>();

type Phase = 'confirm' | 'downloading' | 'error';
const phase = ref<Phase>('confirm');
// 当前正在下载的任务下标（也是失败后重试的起点）
const current = ref(0);

// 当前任务的下载进度（聚合字节，来自 onSetupProgress）：ASR 与翻译统一同一套 loaded/total。
const loaded = ref(0);
const total = ref(0);

// 每次弹窗打开都复位到确认态，避免复用上次的下载/失败态。
watch(show, (v) => {
  if (v) {
    phase.value = 'confirm';
    current.value = 0;
    loaded.value = 0;
    total.value = 0;
  }
});

const totalBytes = computed(() => props.tasks.reduce((sum, task) => sum + task.sizeBytes, 0));

// 弹窗标题随阶段切换：确认征询 / 下载进行中 / 失败
const modalTitle = computed(() => {
  if (phase.value === 'downloading') return t('download.titleDownloading');
  if (phase.value === 'error') return t('download.titleFailed');
  return t('download.title');
});

const currentTask = computed<DownloadTask | undefined>(() => props.tasks[current.value]);

// 当前任务进度：聚合字节的百分比；尚无进度信号（total 为 0）时按 indeterminate 转圈。
const percent = computed(() =>
  total.value > 0 ? Math.round((loaded.value / total.value) * 100) : 0,
);
const indeterminate = computed(() => total.value === 0);

// 组件级订阅：卸载时反注册，避免累积持有本组件 refs 的监听器。
const offSetupProgress = bridge().onSetupProgress((p) => {
  loaded.value = p.loaded;
  total.value = p.total;
});
onBeforeUnmount(offSetupProgress);

// 从 startIndex 起顺序下载剩余任务；任一失败进 error（保留 current 供重试从该项继续）。
async function run(startIndex: number): Promise<void> {
  phase.value = 'downloading';
  for (let i = startIndex; i < props.tasks.length; i += 1) {
    current.value = i;
    loaded.value = 0;
    total.value = 0;
    const task = props.tasks[i];
    // 翻译任务仅在桥接提供 downloadTranslationModel 时才会入列（断言非空）。
    const res =
      task.kind === 'asr'
        ? await bridge().downloadAsrModels(task.modelId)
        : await bridge().downloadTranslationModel!(task.modelId);
    if (!res.ok) {
      phase.value = 'error';
      return;
    }
  }
  show.value = false;
  emit('done');
}

function onCancel(): void {
  show.value = false;
  emit('cancel');
}
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    :title="modalTitle"
    style="width: 460px; max-width: 90vw"
    :closable="false"
    :mask-closable="false"
    :close-on-esc="false"
  >
    <!-- 确认态：逐行列出待下载模型 + 合计，征询后再下载 -->
    <template v-if="phase === 'confirm'">
      <p class="mb-3 text-sm text-neutral-500 dark:text-neutral-400">{{ t('download.desc') }}</p>
      <ul class="mb-2 space-y-1.5">
        <li
          v-for="(task, i) in tasks"
          :key="i"
          class="flex items-center justify-between gap-3 text-sm"
        >
          <span class="min-w-0 truncate">{{ t(task.nameKey) }}</span>
          <span class="shrink-0 tabular-nums text-neutral-500 dark:text-neutral-400">{{ humanBytes(task.sizeBytes) }}</span>
        </li>
      </ul>
      <div
        v-if="tasks.length > 1"
        class="flex items-center justify-between gap-3 border-t border-neutral-200 pt-2 text-sm font-medium dark:border-[#3a3b44]"
      >
        <span>{{ t('download.total') }}</span>
        <span class="tabular-nums">{{ humanBytes(totalBytes) }}</span>
      </div>
      <div class="mt-5 flex justify-end gap-2">
        <n-button @click="onCancel">{{ t('download.cancel') }}</n-button>
        <n-button type="primary" @click="run(0)">{{ t('download.start') }}</n-button>
      </div>
    </template>

    <!-- 下载中：不可关闭，展示总进度（多任务时含「第 n/N 项」）。逐文件进度不再展示，
         下载进度归此弹窗、引擎装载状态归全局翻译状态，职责分离。 -->
    <template v-else-if="phase === 'downloading'">
      <div class="mb-2 flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
        <LoaderCircle :size="14" class="animate-spin" />
        <span>{{ t('download.downloading') }}</span>
        <span v-if="tasks.length > 1">· {{ t('download.step', { n: current + 1, total: tasks.length }) }}</span>
        <span v-if="!indeterminate" class="tabular-nums">{{ percent }}%</span>
      </div>
      <div v-if="currentTask" class="mb-1 truncate text-sm">{{ t(currentTask.nameKey) }}</div>
      <n-progress
        type="line"
        :percentage="indeterminate ? 0 : percent"
        :show-indicator="false"
        :height="8"
        :processing="indeterminate"
      />
    </template>

    <!-- 失败：放弃（终止）或从失败项重试 -->
    <template v-else>
      <p class="text-sm text-red-500">{{ t('download.failed') }}</p>
      <div class="mt-5 flex justify-end gap-2">
        <n-button @click="onCancel">{{ t('download.giveUp') }}</n-button>
        <n-button type="primary" @click="run(current)">{{ t('download.retry') }}</n-button>
      </div>
    </template>
  </n-modal>
</template>
