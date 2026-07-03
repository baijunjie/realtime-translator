<script setup lang="ts">
import { computed, ref, h } from 'vue';
import { NButton, NModal, NInput, NDropdown } from 'naive-ui';
import type { DropdownMixedOption } from 'naive-ui/es/dropdown/src/interface';
import { Settings, Trash2, Archive, Library, Eraser, LoaderCircle, TriangleAlert, MoreHorizontal, Mic, MonitorSpeaker, Square, RefreshCw } from '@lucide/vue';
import { useI18n } from 'vue-i18n';
import { getAsrModel, M2M100_SPEC } from '@rt/core';
import { settings, saveSettings } from '../composables/useSettings';
import {
  lines,
  partial,
  recording,
  modelLoading,
  errorText,
  errorCode,
  recordBusy,
  toggleRecording,
  clearTranscript,
  translationLoading,
  translationDownloading,
  translationError,
} from '../composables/useTranscription';
import TranscriptList from '../components/TranscriptList.vue';
import ModelDownloadModal, { type DownloadTask } from '../components/ModelDownloadModal.vue';
import { fmtDateTime } from '../utils/datetime';
import { bridge } from '../bridge';

const { t } = useI18n();
const emit = defineEmits<{ 'open-settings': []; 'open-archive': [] }>();

// 仅已定稿记录才算"有内容可清"：实时 partial 是瞬时的，清它没意义（归档也只存 lines）
const hasContent = computed(() => lines.length > 0);

// 清屏按钮：点击弹下拉，选择归档或删除
const clearOptions = computed(() => [
  { key: 'archive', label: t('main.archive'), icon: () => h(Archive, { size: 16 }) },
  { key: 'delete', label: t('archive.delete'), icon: () => h(Trash2, { size: 16 }) },
]);

function onClearSelect(key: string): void {
  if (key === 'delete') {
    clearTranscript();
  } else {
    void openArchiveModal();
  }
}

const archiveModalOpen = ref(false);
const archiveName = ref('');

function defaultArchiveName(): string {
  return fmtDateTime(Date.now());
}

async function openArchiveModal(): Promise<void> {
  // 生成不与现有重复的默认名
  let name = defaultArchiveName();
  try {
    const names = new Set((await bridge().listArchives()).map((a) => a.name));
    if (names.has(name)) {
      let i = 2;
      while (names.has(`${name} (${i})`)) i += 1;
      name = `${name} (${i})`;
    }
  } catch {
    /* 取不到列表就用默认名 */
  }
  archiveName.value = name;
  archiveModalOpen.value = true;
}

async function confirmArchive(): Promise<void> {
  const snapshot = lines.map((l) => ({ time: l.time, text: l.text, translation: l.translation }));
  await bridge().saveArchive(archiveName.value.trim() || defaultArchiveName(), snapshot);
  clearTranscript();
  archiveModalOpen.value = false;
}

// 是否开启翻译：现由设置里的「翻译方式」决定（选了模型即启用），主页不再有独立开关。
// 仍需此值让转写列表决定是否显示「翻译中」等待动画。
const translateOn = computed<boolean>(() => settings.value?.translation.enabled ?? false);

// 错误显示：有稳定错误码时用本地化文案，无码回退宿主原文（自由文本，可能非界面语言）
const errorDisplay = computed(() =>
  errorCode.value ? t(`errors.${errorCode.value}`) : errorText.value,
);

// 强制更新入口仅在桥接提供该能力时显示（目前只有 Web PWA 实现，原生端无此项）。
// setup 时 bridge 已由 mountApp 注入，可同步判定。
const canForceUpdate = typeof bridge().forceUpdateApp === 'function';

// 音源开关：仅当桥接声明支持系统音频时才显示（macOS）。切换即持久化。
const supportsSystemAudio = bridge().audioSources?.includes('system') ?? false;
const audioSourceTitle = computed(() =>
  settings.value?.audioSource === 'system' ? t('main.audioSourceSystem') : t('main.audioSourceMic'),
);
function toggleAudioSource(): void {
  const s = settings.value;
  if (!s || recording.value || recordBusy.value) return;
  void saveSettings({ ...s, audioSource: s.audioSource === 'system' ? 'mic' : 'system' });
}

// 移动端「...」溢出菜单（翻译开/关已移至设置的「翻译方式」，此处不再有翻译项）
const mobileMenuOptions = computed<DropdownMixedOption[]>(() => [
  ...(supportsSystemAudio
    ? ([
        {
          key: 'audio-source',
          label: audioSourceTitle.value,
          icon: () => h(settings.value?.audioSource === 'system' ? MonitorSpeaker : Mic, { size: 16 }),
          disabled: recording.value || recordBusy.value,
        },
        { type: 'divider', key: 'd0' },
      ] satisfies DropdownMixedOption[])
    : []),
  { key: 'delete', label: t('archive.delete'), icon: () => h(Trash2, { size: 16 }), disabled: !hasContent.value },
  { key: 'archive', label: t('main.archive'), icon: () => h(Archive, { size: 16 }), disabled: !hasContent.value },
  { type: 'divider', key: 'd3' },
  { key: 'view-archive', label: t('main.viewArchives'), icon: () => h(Library, { size: 16 }) },
  { key: 'settings', label: t('main.settings'), icon: () => h(Settings, { size: 16 }) },
  ...(canForceUpdate
    ? ([
        { type: 'divider', key: 'd4' },
        { key: 'force-update', label: t('main.forceUpdate'), icon: () => h(RefreshCw, { size: 16 }) },
      ] satisfies DropdownMixedOption[])
    : []),
]);

function onMobileMenuSelect(key: string): void {
  switch (key) {
    case 'audio-source':
      toggleAudioSource();
      break;
    case 'archive':
      void openArchiveModal();
      break;
    case 'delete':
      clearTranscript();
      break;
    case 'view-archive':
      emit('open-archive');
      break;
    case 'settings':
      emit('open-settings');
      break;
    case 'force-update':
      // 注销 SW、清应用外壳缓存并整页重载（模型缓存保留），随后页面即以最新资源启动。
      void bridge().forceUpdateApp?.();
      break;
  }
}

// 仅 ASR 模型加载属于"软件未就绪"：显示进度条并禁用录音。
// 翻译模型加载/下载是可选项，只在翻译开关旁提示，不挡录音。
const preparing = computed(() => modelLoading.value);

// 麦克风权限弹窗：''=不显示；'ask'=首次说明；'denied'=已拒绝去设置
const micModal = ref<'' | 'ask' | 'denied'>('');
const showMicModal = computed({
  get: () => micModal.value !== '',
  set: (v: boolean) => {
    if (!v) micModal.value = '';
  },
});

// 按需下载弹窗：录音前汇总缺失模型，确认后逐个下载，完成再继续启动流程。
const downloadModalOpen = ref(false);
const downloadTasks = ref<DownloadTask[]>([]);

// 录音按钮：停止无需检查；开始前先汇总缺失模型（缺则弹下载弹窗），再走音源对应的权限/启动流程。
async function onRecordClick(): Promise<void> {
  // 启停在途一律忽略，按钮同时也已禁用
  if (recordBusy.value) return;
  if (recording.value) {
    toggleRecording();
    return;
  }
  const s = settings.value;
  if (!s) return;
  const tasks: DownloadTask[] = [];
  // ASR 模型：当前选中的识别模型未就绪则加下载任务
  try {
    const { asrReady } = await bridge().getSetupStatus(s.asr.model);
    if (!asrReady) {
      const spec = getAsrModel(s.asr.model);
      if (spec) tasks.push({ kind: 'asr', modelId: spec.id, nameKey: spec.nameKey, sizeBytes: spec.approxBytes });
    }
  } catch {
    /* 查询失败不拦截，按已就绪继续 */
  }
  // 本地翻译模型：开启翻译且用本地引擎、桥接需自行下载且未就绪时加下载任务
  const getTrStatus = bridge().getTranslationSetupStatus;
  if (s.translation.enabled && s.translation.engine !== 'cloud' && getTrStatus && bridge().downloadTranslationModel) {
    try {
      const { ready } = await getTrStatus();
      if (!ready) tasks.push({ kind: 'translation', nameKey: 'models.m2m100', sizeBytes: M2M100_SPEC.approxDownloadBytes });
    } catch {
      /* 查询失败不拦截，按已就绪继续 */
    }
  }
  if (tasks.length) {
    // 有缺失：弹下载弹窗，done 后自动继续、cancel 则终止（不录音）
    downloadTasks.value = tasks;
    downloadModalOpen.value = true;
    return;
  }
  await proceedToRecord();
}

// 下载完成后自动继续启动录音；下载取消则不录音。
function onDownloadDone(): void {
  void proceedToRecord();
}

// 模型就绪后的权限 + 启动流程。麦克风音源走权限说明流程；系统音源直接启动（授权由宿主处理，
// 被拒会以 system-audio-permission 错误码回来）。
async function proceedToRecord(): Promise<void> {
  const usesSystem = supportsSystemAudio && settings.value?.audioSource === 'system';
  if (usesSystem) {
    toggleRecording();
    return;
  }
  let status = 'granted';
  try {
    status = await bridge().getMicStatus();
  } catch {
    /* 查询失败按已授权处理，让系统弹窗兜底 */
  }
  if (status === 'granted') {
    toggleRecording();
  } else if (status === 'denied' || status === 'restricted') {
    micModal.value = 'denied';
  } else {
    micModal.value = 'ask';
  }
}

function confirmMic(): void {
  micModal.value = '';
  toggleRecording(); // 此时才触发系统权限请求
}

function openMicSettings(): void {
  bridge().openMicSettings();
  micModal.value = '';
}
</script>

<template>
  <div class="flex h-full flex-col">
    <header
      class="flex items-center gap-3.5 border-b border-neutral-200 px-[18px] py-3 dark:border-[#3a3b44]"
    >
      <span class="text-[15px] font-semibold">{{ t('main.appTitle') }}</span>
      <span v-if="errorText" class="text-xs text-red-500">{{ errorDisplay }}</span>

      <div class="flex-1" />

      <!-- 窄屏隐藏，改用下方「...」菜单与底部圆形录音按钮 -->
      <div class="flex items-center gap-3.5 max-sm:hidden">
        <!-- NDropdown 无 disabled 属性：无内容时直接渲染禁用按钮，避免空状态仍能弹出菜单 -->
        <n-dropdown v-if="hasContent" trigger="click" :options="clearOptions" @select="onClearSelect">
          <n-button quaternary circle :title="t('main.clear')">
            <template #icon><Eraser :size="18" /></template>
          </n-button>
        </n-dropdown>
        <n-button v-else quaternary circle disabled :title="t('main.clear')">
          <template #icon><Eraser :size="18" /></template>
        </n-button>
        <n-button quaternary circle :title="t('main.viewArchives')" @click="$emit('open-archive')">
          <template #icon><Library :size="18" /></template>
        </n-button>
        <n-button quaternary circle :title="t('main.settings')" @click="$emit('open-settings')">
          <template #icon><Settings :size="18" /></template>
        </n-button>
        <!-- 音源开关：仅桥接支持系统音频时显示，图标即当前音源，点击切换 -->
        <n-button
          v-if="supportsSystemAudio"
          quaternary
          circle
          :disabled="recording || recordBusy"
          :title="audioSourceTitle"
          @click="toggleAudioSource"
        >
          <template #icon>
            <component :is="settings?.audioSource === 'system' ? MonitorSpeaker : Mic" :size="18" />
          </template>
        </n-button>
        <n-button
          :type="recording ? 'error' : 'primary'"
          :disabled="preparing || recordBusy"
          :loading="recordBusy"
          @click="onRecordClick"
        >
          {{ recording ? t('main.stop') : t('main.start') }}
        </n-button>
      </div>

      <!-- sm:hidden 放在外层 div：Naive 运行时注入的 .n-button{display:inline-flex} 会盖过
           直接加在按钮上的 sm:hidden，故由普通 div 承载响应式隐藏（桌面 ≥640px 隐藏整组）。 -->
      <div class="sm:hidden">
        <n-dropdown
          trigger="click"
          placement="bottom-end"
          :options="mobileMenuOptions"
          @select="onMobileMenuSelect"
        >
          <n-button quaternary circle :title="t('main.menu')">
            <template #icon><MoreHorizontal :size="20" /></template>
          </n-button>
        </n-dropdown>
      </div>
    </header>

    <!-- ASR 模型加载中：转圈提示并禁用录音（预热无进度信号，与「准备翻译」一致的轻量样式） -->
    <div
      v-if="preparing"
      class="flex items-center gap-2 border-b border-neutral-200 px-5 py-3 text-xs text-neutral-500 dark:border-[#3a3b44] dark:text-neutral-400"
    >
      <LoaderCircle :size="14" class="animate-spin" />
      <span>{{ t('status.loadingModel') }}</span>
    </div>

    <!-- 翻译模型状态条（与识别模型同款样式）：加载/下载不挡录音，仅提示。 -->
    <div
      v-if="translateOn && translationLoading"
      class="flex items-center gap-2 border-b border-neutral-200 px-5 py-3 text-xs text-neutral-500 dark:border-[#3a3b44] dark:text-neutral-400"
    >
      <LoaderCircle :size="14" class="animate-spin" />
      <span>{{ translationDownloading ? t('status.transDownloading') : t('status.transLoading') }}</span>
    </div>
    <div
      v-else-if="translateOn && translationError"
      class="flex items-center gap-2 border-b border-neutral-200 px-5 py-3 text-xs text-red-500 dark:border-[#3a3b44]"
    >
      <TriangleAlert :size="14" />
      <span>{{ t('status.transFailed') }}</span>
    </div>

    <transcript-list
      :lines="lines"
      :partial="partial"
      :recording="recording"
      :empty-hint="t('main.emptyHint')"
      :listening-hint="t('main.listening')"
      :translate-on="translateOn"
    />

    <!-- 归档命名弹窗 -->
    <n-modal
      v-model:show="archiveModalOpen"
      preset="card"
      :title="t('archive.modalTitle')"
      style="width: 420px; max-width: 90vw"
    >
      <div class="mb-1.5 text-xs text-neutral-500 dark:text-neutral-400">{{ t('archive.nameLabel') }}</div>
      <n-input v-model:value="archiveName" autofocus @keydown.enter="confirmArchive" />
      <template #footer>
        <div class="flex justify-end gap-2">
          <n-button @click="archiveModalOpen = false">{{ t('archive.cancel') }}</n-button>
          <n-button type="primary" @click="confirmArchive">{{ t('archive.save') }}</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 麦克风权限说明弹窗：在触发系统授权前先告知用途 -->
    <n-modal
      v-model:show="showMicModal"
      preset="card"
      :title="micModal === 'denied' ? t('mic.deniedTitle') : t('mic.title')"
      style="width: 420px; max-width: 90vw"
    >
      <p class="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
        {{ micModal === 'denied' ? t('mic.deniedDesc') : t('mic.desc') }}
      </p>
      <template #footer>
        <div class="flex justify-end gap-2">
          <n-button @click="micModal = ''">{{ t('mic.cancel') }}</n-button>
          <n-button v-if="micModal === 'denied'" type="primary" @click="openMicSettings">
            {{ t('mic.openSettings') }}
          </n-button>
          <n-button v-else type="primary" @click="confirmMic">{{ t('mic.allow') }}</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 录音前的按需模型下载弹窗：done 后自动继续启动，cancel 则不录音 -->
    <model-download-modal
      v-model:show="downloadModalOpen"
      :tasks="downloadTasks"
      @done="onDownloadDone"
    />

    <!-- bottom 计入 safe-area，避开 Home 指示条 -->
    <button
      class="fixed left-1/2 z-20 flex h-16 w-16 -translate-x-1/2 items-center justify-center rounded-full text-white shadow-lg transition-colors disabled:opacity-40 sm:hidden"
      :class="recording ? 'bg-red-500 active:bg-red-600' : 'bg-emerald-500 active:bg-emerald-600'"
      :style="{ bottom: 'calc(env(safe-area-inset-bottom) + 22px)' }"
      :disabled="preparing || recordBusy"
      :title="recording ? t('main.stop') : t('main.start')"
      @click="onRecordClick"
    >
      <LoaderCircle v-if="recordBusy" :size="26" class="animate-spin" />
      <component v-else :is="recording ? Square : Mic" :size="26" :fill="recording ? 'currentColor' : 'none'" />
    </button>
  </div>
</template>
