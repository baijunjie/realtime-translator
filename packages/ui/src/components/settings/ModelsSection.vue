<script setup lang="ts">
import { ref, computed } from 'vue';
import { NButton, NTag, NPopconfirm, NTooltip, NProgress } from 'naive-ui';
import { Download, Trash2, X, RotateCw } from '@lucide/vue';
import { useI18n } from 'vue-i18n';
import { getAsrModel, getTranslationModel, type ModelInfo } from '@rt/core';
import { bridge } from '../../bridge';
import { recording, recordBusy, modelLoading } from '../../composables/useTranscription';
import {
  type DownloadTask,
  startDownloads,
  cancelDownload,
  retryDownload,
  isDownloading,
  downloadFailed,
  downloadEntry,
  percentOf,
} from '../../composables/useModelDownloads';
import { useModels } from '../../composables/useModels';
import { humanBytes } from '../../utils/bytes';
import ModelDownloadModal from '../ModelDownloadModal.vue';

const { t } = useI18n();

// 模型列表来自应用级单例：首次探测后跨挂载复用快照，进入页面秒开；
// 下载完成/失败/取消由单例内部监听刷新，删除/取消在本组件显式 refreshModels。
const { models, refreshModels } = useModels();
const asrModels = computed(() => models.value.filter((m) => m.kind === 'asr'));
const translationModels = computed(() => models.value.filter((m) => m.kind === 'translation'));

// 录音 / 启停在途 / 模型加载中一律禁用删除，避免删掉正在使用或正在装载的模型。
const deleteDisabled = computed(() => recording.value || recordBusy.value || modelLoading.value);

// 显示名：ASR / 翻译均按各自注册表 nameKey 解析；未知 id 直接显示 id。
function displayName(m: ModelInfo): string {
  const spec = m.kind === 'asr' ? getAsrModel(m.id) : getTranslationModel(m.id);
  return spec ? t(spec.nameKey) : m.id;
}

// 未下载时显示注册表近似体积；已下载显示实际占用。
function registryBytes(m: ModelInfo): number {
  return m.kind === 'asr'
    ? (getAsrModel(m.id)?.approxBytes ?? 0)
    : (getTranslationModel(m.id)?.approxDownloadBytes ?? 0);
}

function sizeText(m: ModelInfo): string {
  return humanBytes(m.downloaded ? m.sizeBytes : registryBytes(m));
}

// 下载中该行的进度未知（total===0，首个进度事件前）时进度条走 indeterminate。
function indeterminate(m: ModelInfo): boolean {
  return (downloadEntry(m.kind, m.id)?.total ?? 0) === 0;
}

async function remove(m: ModelInfo): Promise<void> {
  await bridge().deleteModel(m.kind, m.id);
  await refreshModels();
}

// —— 后台下载：确认弹窗仅征询体积，确认后交给下载管理器后台下载（行内进度条 + X 取消）——
const downloadModalOpen = ref(false);
const downloadTasks = ref<DownloadTask[]>([]);

// 翻译模型仅在桥接提供下载能力时可手动下载（iOS 走系统翻译、无此方法）；ASR 下载各平台必有。
const canDownloadTranslation = typeof bridge().downloadTranslationModel === 'function';
function canDownload(m: ModelInfo): boolean {
  return m.kind === 'asr' || canDownloadTranslation;
}

function download(m: ModelInfo): void {
  const nameKey =
    (m.kind === 'asr' ? getAsrModel(m.id)?.nameKey : getTranslationModel(m.id)?.nameKey) ?? m.id;
  downloadTasks.value = [{ kind: m.kind, modelId: m.id, nameKey, sizeBytes: registryBytes(m) }];
  downloadModalOpen.value = true;
}

// 确认后转后台下载；行会据下载管理器状态自动切到「进度条 + X」。
function onConfirm(tasks: DownloadTask[]): void {
  startDownloads(tasks);
}

async function cancel(m: ModelInfo): Promise<void> {
  await cancelDownload(m.kind, m.id);
  await refreshModels();
}

function retry(m: ModelInfo): void {
  retryDownload(m.kind, m.id);
}
</script>

<template>
  <div>
    <section v-if="asrModels.length" class="mb-6">
      <h2 class="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        {{ t('modelsScreen.asrGroup') }}
      </h2>
      <ul>
        <li
          v-for="m in asrModels"
          :key="m.id"
          class="flex items-center gap-3 border-b border-neutral-200 py-3 dark:border-[#2b2c33]"
        >
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate font-medium">{{ displayName(m) }}</span>
              <n-tag v-if="m.inUse" size="small" type="success" :bordered="false">
                {{ t('modelsScreen.inUse') }}
              </n-tag>
            </div>
            <div class="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">
              <span class="tabular-nums">{{ sizeText(m) }}</span>
              <span v-if="isDownloading(m.kind, m.id)"> · {{ t('download.downloading') }}</span>
              <span v-else-if="!m.downloaded"> · {{ t('modelsScreen.notDownloaded') }}</span>
            </div>
          </div>
          <!-- 下载中：进度条 + 取消 X -->
          <div v-if="isDownloading(m.kind, m.id)" class="flex w-32 items-center gap-2">
            <n-progress
              type="line"
              class="flex-1"
              :percentage="percentOf(m.kind, m.id)"
              :show-indicator="false"
              :height="6"
              :processing="indeterminate(m)"
            />
            <n-tooltip>
              <template #trigger>
                <n-button quaternary circle size="small" :aria-label="t('modelsScreen.cancelDownload')" @click="cancel(m)">
                  <template #icon><X :size="16" /></template>
                </n-button>
              </template>
              {{ t('modelsScreen.cancelDownload') }}
            </n-tooltip>
          </div>
          <!-- 失败：重试 -->
          <n-tooltip v-else-if="downloadFailed(m.kind, m.id)">
            <template #trigger>
              <n-button quaternary circle size="small" type="error" :aria-label="t('download.retry')" @click="retry(m)">
                <template #icon><RotateCw :size="16" /></template>
              </n-button>
            </template>
            {{ t('download.retry') }}
          </n-tooltip>
          <!-- 已下载：删除 -->
          <n-popconfirm
            v-else-if="m.downloaded"
            :positive-text="t('modelsScreen.delete')"
            :negative-text="t('archive.cancel')"
            @positive-click="remove(m)"
          >
            <template #trigger>
              <n-tooltip>
                <template #trigger>
                  <n-button quaternary circle size="small" :disabled="deleteDisabled" :aria-label="t('modelsScreen.delete')">
                    <template #icon><Trash2 :size="16" /></template>
                  </n-button>
                </template>
                {{ t('modelsScreen.delete') }}
              </n-tooltip>
            </template>
            {{ m.inUse ? t('modelsScreen.deleteInUseWarn') : t('modelsScreen.deleteConfirm') }}
          </n-popconfirm>
          <!-- 未下载：下载 -->
          <n-tooltip v-else-if="canDownload(m)">
            <template #trigger>
              <n-button
                quaternary
                circle
                size="small"
                :aria-label="t('modelsScreen.download')"
                @click="download(m)"
              >
                <template #icon><Download :size="16" /></template>
              </n-button>
            </template>
            {{ t('modelsScreen.download') }}
          </n-tooltip>
        </li>
      </ul>
    </section>

    <section v-if="translationModels.length">
      <h2 class="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        {{ t('modelsScreen.translationGroup') }}
      </h2>
      <ul>
        <li
          v-for="m in translationModels"
          :key="m.id"
          class="flex items-center gap-3 border-b border-neutral-200 py-3 dark:border-[#2b2c33]"
        >
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate font-medium">{{ displayName(m) }}</span>
              <n-tag v-if="m.inUse" size="small" type="success" :bordered="false">
                {{ t('modelsScreen.inUse') }}
              </n-tag>
            </div>
            <div class="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">
              <span class="tabular-nums">{{ sizeText(m) }}</span>
              <span v-if="isDownloading(m.kind, m.id)"> · {{ t('download.downloading') }}</span>
              <span v-else-if="!m.downloaded"> · {{ t('modelsScreen.notDownloaded') }}</span>
            </div>
          </div>
          <div v-if="isDownloading(m.kind, m.id)" class="flex w-32 items-center gap-2">
            <n-progress
              type="line"
              class="flex-1"
              :percentage="percentOf(m.kind, m.id)"
              :show-indicator="false"
              :height="6"
              :processing="indeterminate(m)"
            />
            <n-tooltip>
              <template #trigger>
                <n-button quaternary circle size="small" :aria-label="t('modelsScreen.cancelDownload')" @click="cancel(m)">
                  <template #icon><X :size="16" /></template>
                </n-button>
              </template>
              {{ t('modelsScreen.cancelDownload') }}
            </n-tooltip>
          </div>
          <n-tooltip v-else-if="downloadFailed(m.kind, m.id)">
            <template #trigger>
              <n-button quaternary circle size="small" type="error" :aria-label="t('download.retry')" @click="retry(m)">
                <template #icon><RotateCw :size="16" /></template>
              </n-button>
            </template>
            {{ t('download.retry') }}
          </n-tooltip>
          <n-popconfirm
            v-else-if="m.downloaded"
            :positive-text="t('modelsScreen.delete')"
            :negative-text="t('archive.cancel')"
            @positive-click="remove(m)"
          >
            <template #trigger>
              <n-tooltip>
                <template #trigger>
                  <n-button quaternary circle size="small" :disabled="deleteDisabled" :aria-label="t('modelsScreen.delete')">
                    <template #icon><Trash2 :size="16" /></template>
                  </n-button>
                </template>
                {{ t('modelsScreen.delete') }}
              </n-tooltip>
            </template>
            {{ m.inUse ? t('modelsScreen.deleteInUseWarn') : t('modelsScreen.deleteConfirm') }}
          </n-popconfirm>
          <n-tooltip v-else-if="canDownload(m)">
            <template #trigger>
              <n-button
                quaternary
                circle
                size="small"
                :aria-label="t('modelsScreen.download')"
                @click="download(m)"
              >
                <template #icon><Download :size="16" /></template>
              </n-button>
            </template>
            {{ t('modelsScreen.download') }}
          </n-tooltip>
        </li>
      </ul>
    </section>

    <!-- 下载确认弹窗：确认后转后台下载（行内进度）；取消即关闭 -->
    <model-download-modal
      v-model:show="downloadModalOpen"
      :tasks="downloadTasks"
      @confirm="onConfirm"
    />
  </div>
</template>
