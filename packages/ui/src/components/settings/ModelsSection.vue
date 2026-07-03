<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { NButton, NTag, NPopconfirm, NTooltip } from 'naive-ui';
import { Download, Trash2 } from '@lucide/vue';
import { useI18n } from 'vue-i18n';
import { getAsrModel, getTranslationModel, type ModelInfo } from '@rt/core';
import { bridge } from '../../bridge';
import { recording, recordBusy, modelLoading } from '../../composables/useTranscription';
import { humanBytes } from '../../utils/bytes';
import ModelDownloadModal, { type DownloadTask } from '../ModelDownloadModal.vue';

const { t } = useI18n();

const models = ref<ModelInfo[]>([]);
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

async function refresh(): Promise<void> {
  models.value = await bridge().listModels();
}

async function remove(m: ModelInfo): Promise<void> {
  await bridge().deleteModel(m.kind, m.id);
  await refresh();
}

// —— 手动下载未下载的模型：复用全局下载弹窗（确认体积 → 进度 → 失败重试）——
const downloadModalOpen = ref(false);
const downloadTasks = ref<DownloadTask[]>([]);

// 翻译模型仅在桥接提供下载能力时可手动下载（iOS 走系统翻译、无此方法）；ASR 下载各平台必有。
const canDownloadTranslation = typeof bridge().downloadTranslationModel === 'function';
function canDownload(m: ModelInfo): boolean {
  return m.kind === 'asr' || canDownloadTranslation;
}

function download(m: ModelInfo): void {
  downloadTasks.value =
    m.kind === 'asr'
      ? [
          {
            kind: 'asr',
            modelId: m.id,
            nameKey: getAsrModel(m.id)?.nameKey ?? m.id,
            sizeBytes: registryBytes(m),
          },
        ]
      : [{ kind: 'translation', modelId: m.id, nameKey: getTranslationModel(m.id)?.nameKey ?? m.id, sizeBytes: registryBytes(m) }];
  downloadModalOpen.value = true;
}

onMounted(refresh);
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
              <span v-if="!m.downloaded"> · {{ t('modelsScreen.notDownloaded') }}</span>
            </div>
          </div>
          <n-popconfirm
            v-if="m.downloaded"
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
              <span v-if="!m.downloaded"> · {{ t('modelsScreen.notDownloaded') }}</span>
            </div>
          </div>
          <n-popconfirm
            v-if="m.downloaded"
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

    <!-- 手动下载：done 后刷新列表；cancel（含失败放弃）也刷新，保持展示与实际缓存一致 -->
    <model-download-modal
      v-model:show="downloadModalOpen"
      :tasks="downloadTasks"
      @done="refresh"
      @cancel="refresh"
    />
  </div>
</template>
