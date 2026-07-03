<script lang="ts">
/**
 * 一次下载任务：识别模型或本地翻译模型。sizeBytes 为近似体积（来自注册表），
 * 仅用于确认态展示；实际进度在下载态由各自的进度源上报。
 */
export type DownloadTask =
  | { kind: 'asr'; modelId: string; nameKey: string; sizeBytes: number }
  | { kind: 'translation'; nameKey: string; sizeBytes: number };
</script>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { NModal, NProgress, NButton } from 'naive-ui';
import { LoaderCircle } from '@lucide/vue';
import { useI18n } from 'vue-i18n';
import { bridge } from '../bridge';
import {
  translationDownloading,
  translationProgress,
  translationFiles,
} from '../composables/useTranscription';
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

// ASR 下载进度（聚合字节，来自 onSetupProgress）；翻译进度走全局 translation* ref。
const asrLoaded = ref(0);
const asrTotal = ref(0);

// 每次弹窗打开都复位到确认态，避免复用上次的下载/失败态。
watch(show, (v) => {
  if (v) {
    phase.value = 'confirm';
    current.value = 0;
    asrLoaded.value = 0;
    asrTotal.value = 0;
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
const isTranslation = computed(() => currentTask.value?.kind === 'translation');

// 当前任务进度：ASR 用聚合字节，翻译用全局 0~100 进度；无进度信号时按 indeterminate 转圈。
const percent = computed(() =>
  isTranslation.value
    ? translationProgress.value
    : asrTotal.value > 0
      ? Math.round((asrLoaded.value / asrTotal.value) * 100)
      : 0,
);
const indeterminate = computed(() =>
  isTranslation.value
    ? !translationDownloading.value || translationProgress.value === 0
    : asrTotal.value === 0,
);

// 逐文件进度（仅翻译模型）：只列 ≥1MB 的文件，小配置文件秒完、列出只是噪音（仍计入总进度）。
const MIN_FILE_BYTES = 1024 * 1024;
const fileList = computed(() =>
  isTranslation.value
    ? translationFiles.value
        .filter((f) => f.total >= MIN_FILE_BYTES)
        .map((f) => ({
          file: f.file,
          name: f.file.split('/').pop() ?? f.file,
          percent: Math.round(f.progress * 100),
        }))
    : [],
);

// 组件级订阅：卸载时反注册，避免累积持有本组件 refs 的监听器。
const offSetupProgress = bridge().onSetupProgress((p) => {
  asrLoaded.value = p.loaded;
  asrTotal.value = p.total;
});
onBeforeUnmount(offSetupProgress);

// 从 startIndex 起顺序下载剩余任务；任一失败进 error（保留 current 供重试从该项继续）。
async function run(startIndex: number): Promise<void> {
  phase.value = 'downloading';
  for (let i = startIndex; i < props.tasks.length; i += 1) {
    current.value = i;
    asrLoaded.value = 0;
    asrTotal.value = 0;
    const task = props.tasks[i];
    let res: { ok: boolean; error?: string };
    if (task.kind === 'asr') {
      res = await bridge().downloadAsrModels(task.modelId);
    } else {
      // 本页仅在桥接提供 downloadTranslationModel 时被打开（断言非空）；清零上次残留进度。
      translationProgress.value = 0;
      translationFiles.value = [];
      res = await bridge().downloadTranslationModel!();
    }
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

    <!-- 下载中：不可关闭，展示总进度（多任务时含「第 n/N 项」）与逐文件小进度条 -->
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
      <div v-if="fileList.length" class="mt-3 space-y-1">
        <div
          v-for="f in fileList"
          :key="f.file"
          class="flex items-center gap-2 text-[11px] text-neutral-400 dark:text-neutral-500"
        >
          <span class="w-36 shrink-0 truncate font-mono">{{ f.name }}</span>
          <n-progress
            class="flex-1"
            type="line"
            :percentage="f.percent"
            :show-indicator="false"
            :height="4"
          />
          <span class="w-9 shrink-0 text-right tabular-nums">{{ f.percent }}%</span>
        </div>
      </div>
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
