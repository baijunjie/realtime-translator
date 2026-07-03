<script setup lang="ts">
import { computed, ref, h, watch } from 'vue';
import { NButton, NModal, NInput, NDropdown, NTooltip } from 'naive-ui';
import type { DropdownMixedOption } from 'naive-ui/es/dropdown/src/interface';
import { Settings, Trash2, Archive, Library, Eraser, LoaderCircle, TriangleAlert, MoreHorizontal, Mic, MonitorSpeaker, Square, RefreshCw } from '@lucide/vue';
import { useI18n } from 'vue-i18n';
import { getAsrModel, getTranslationModel } from '@rt/core';
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

// 顶栏内联的模型加载状态：识别/翻译的加载收敛到同一处（不插入内容行、零布局位移）。
// 多项同时加载时顶栏只显示合并文案，具体项放 tooltip。
const loadingItems = computed<string[]>(() => {
  const items: string[] = [];
  if (modelLoading.value) items.push(t('status.loadingModel'));
  // 翻译引擎装载中（下载进度另在下载弹窗展示，此处只表达装载入内存）。
  if (translateOn.value && translationLoading.value) items.push(t('status.transLoading'));
  return items;
});
const loadingSummary = computed(() =>
  loadingItems.value.length > 1 ? t('status.preparing') : (loadingItems.value[0] ?? ''),
);

// 录音进行中（含启停在途）：顶栏除录音按钮外全部禁用，避免录音过程中误操作打断会话
const headerLocked = computed(() => recording.value || recordBusy.value);

// 音源开关：仅当桥接声明支持系统音频时才显示（macOS）。切换即持久化。
const supportsSystemAudio = bridge().audioSources?.includes('system') ?? false;
const audioSourceTitle = computed(() =>
  settings.value?.audioSource === 'system' ? t('main.audioSourceSystem') : t('main.audioSourceMic'),
);
function toggleAudioSource(): void {
  const s = settings.value;
  if (!s || headerLocked.value) return;
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
          disabled: headerLocked.value,
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
  // 本地翻译模型：开启翻译且用本地引擎、桥接需自行下载且未就绪时加下载任务（按引擎 id，此时必为本地 id）
  const getTrStatus = bridge().getTranslationSetupStatus;
  const trSpec = s.translation.engine !== 'cloud' ? getTranslationModel(s.translation.engine) : undefined;
  if (s.translation.enabled && trSpec && getTrStatus && bridge().downloadTranslationModel) {
    try {
      const { ready } = await getTrStatus(trSpec.id);
      if (!ready) tasks.push({ kind: 'translation', modelId: trSpec.id, nameKey: trSpec.nameKey, sizeBytes: trSpec.approxDownloadBytes });
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

// 系统音频权限说明弹窗：CoreAudio Tap 无权限查询 API，无法像麦克风那样按状态分流——
// 「首次说明」用本地持久化标记补齐（本机只提示一次），「已拒绝去设置」在采集报
// system-audio-permission 错误码时事后弹出。
const SYS_AUDIO_PROMPTED_KEY = 'rt.systemAudioPrompted';
const sysAudioModal = ref<'' | 'ask' | 'denied'>('');
const showSysAudioModal = computed({
  get: () => sysAudioModal.value !== '',
  set: (v: boolean) => {
    if (!v) sysAudioModal.value = '';
  },
});
watch(errorCode, (code) => {
  if (code === 'system-audio-permission') sysAudioModal.value = 'denied';
});

function confirmSysAudio(): void {
  localStorage.setItem(SYS_AUDIO_PROMPTED_KEY, '1');
  sysAudioModal.value = '';
  toggleRecording(); // 此时才触发系统音频录制的系统授权
}

function openSysAudioSettings(): void {
  bridge().openSystemAudioSettings?.();
  sysAudioModal.value = '';
}

// 模型就绪后的权限 + 启动流程。麦克风音源走权限说明流程；系统音源首次先弹说明，
// 之后直接启动（授权由宿主处理，被拒会以 system-audio-permission 错误码回来）。
async function proceedToRecord(): Promise<void> {
  const usesSystem = supportsSystemAudio && settings.value?.audioSource === 'system';
  if (usesSystem) {
    if (!localStorage.getItem(SYS_AUDIO_PROMPTED_KEY)) {
      sysAudioModal.value = 'ask';
      return;
    }
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

      <!-- 模型加载状态：顶栏内联，窄屏只留转圈图标；hover 看具体加载项 -->
      <n-tooltip v-if="loadingItems.length">
        <template #trigger>
          <div class="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            <LoaderCircle :size="14" class="animate-spin" />
            <span class="max-sm:hidden">{{ loadingSummary }}</span>
          </div>
        </template>
        <div v-for="item in loadingItems" :key="item">{{ item }}</div>
      </n-tooltip>
      <!-- 翻译引擎级错误：同一位置收敛为红色警示图标（行级失败仍在对应行内展示） -->
      <n-tooltip v-else-if="translateOn && translationError">
        <template #trigger>
          <TriangleAlert :size="14" class="text-red-500" />
        </template>
        {{ t('status.transFailed') }}
      </n-tooltip>

      <!-- 窄屏隐藏，改用下方「...」菜单与底部圆形录音按钮 -->
      <div class="flex items-center gap-3.5 max-sm:hidden">
        <!-- NDropdown 无 disabled 属性：无内容或录音锁定时直接渲染禁用按钮，避免仍能弹出菜单 -->
        <n-dropdown v-if="hasContent && !headerLocked" trigger="click" :options="clearOptions" @select="onClearSelect">
          <n-tooltip>
            <template #trigger>
              <n-button quaternary circle :aria-label="t('main.clear')">
                <template #icon><Eraser :size="18" /></template>
              </n-button>
            </template>
            {{ t('main.clear') }}
          </n-tooltip>
        </n-dropdown>
        <n-tooltip v-else>
          <template #trigger>
            <n-button quaternary circle disabled :aria-label="t('main.clear')">
              <template #icon><Eraser :size="18" /></template>
            </n-button>
          </template>
          {{ t('main.clear') }}
        </n-tooltip>
        <n-tooltip>
          <template #trigger>
            <n-button quaternary circle :disabled="headerLocked" :aria-label="t('main.viewArchives')" @click="$emit('open-archive')">
              <template #icon><Library :size="18" /></template>
            </n-button>
          </template>
          {{ t('main.viewArchives') }}
        </n-tooltip>
        <n-tooltip>
          <template #trigger>
            <n-button quaternary circle :disabled="headerLocked" :aria-label="t('main.settings')" @click="$emit('open-settings')">
              <template #icon><Settings :size="18" /></template>
            </n-button>
          </template>
          {{ t('main.settings') }}
        </n-tooltip>
        <!-- 音源开关：仅桥接支持系统音频时显示，图标即当前音源，点击切换 -->
        <n-tooltip v-if="supportsSystemAudio">
          <template #trigger>
            <n-button
              quaternary
              circle
              :disabled="headerLocked"
              :aria-label="audioSourceTitle"
              @click="toggleAudioSource"
            >
              <template #icon>
                <component :is="settings?.audioSource === 'system' ? MonitorSpeaker : Mic" :size="18" />
              </template>
            </n-button>
          </template>
          {{ audioSourceTitle }}
        </n-tooltip>
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
        <!-- NDropdown 无 disabled 属性：录音锁定时直接渲染禁用按钮，避免仍能弹出菜单 -->
        <n-dropdown
          v-if="!headerLocked"
          trigger="click"
          placement="bottom-end"
          :options="mobileMenuOptions"
          @select="onMobileMenuSelect"
        >
          <n-tooltip>
            <template #trigger>
              <n-button quaternary circle :aria-label="t('main.menu')">
                <template #icon><MoreHorizontal :size="20" /></template>
              </n-button>
            </template>
            {{ t('main.menu') }}
          </n-tooltip>
        </n-dropdown>
        <n-tooltip v-else>
          <template #trigger>
            <n-button quaternary circle disabled :aria-label="t('main.menu')">
              <template #icon><MoreHorizontal :size="20" /></template>
            </n-button>
          </template>
          {{ t('main.menu') }}
        </n-tooltip>
      </div>
    </header>

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

    <!-- 系统音频权限弹窗：首次说明（本机一次）/ 被拒后引导去「屏幕与系统音频录制」设置 -->
    <n-modal
      v-model:show="showSysAudioModal"
      preset="card"
      :title="sysAudioModal === 'denied' ? t('sysAudio.deniedTitle') : t('sysAudio.title')"
      style="width: 420px; max-width: 90vw"
    >
      <p class="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
        {{ sysAudioModal === 'denied' ? t('sysAudio.deniedDesc') : t('sysAudio.desc') }}
      </p>
      <template #footer>
        <div class="flex justify-end gap-2">
          <n-button @click="sysAudioModal = ''">{{ t('mic.cancel') }}</n-button>
          <n-button v-if="sysAudioModal === 'denied'" type="primary" @click="openSysAudioSettings">
            {{ t('mic.openSettings') }}
          </n-button>
          <n-button v-else type="primary" @click="confirmSysAudio">{{ t('mic.allow') }}</n-button>
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
    <n-tooltip>
      <template #trigger>
        <button
          class="fixed left-1/2 z-20 flex h-16 w-16 -translate-x-1/2 items-center justify-center rounded-full text-white shadow-lg transition-colors disabled:opacity-40 sm:hidden"
          :class="recording ? 'bg-red-500 active:bg-red-600' : 'bg-emerald-500 active:bg-emerald-600'"
          :style="{ bottom: 'calc(env(safe-area-inset-bottom) + 22px)' }"
          :disabled="preparing || recordBusy"
          :aria-label="recording ? t('main.stop') : t('main.start')"
          @click="onRecordClick"
        >
          <LoaderCircle v-if="recordBusy" :size="26" class="animate-spin" />
          <component v-else :is="recording ? Square : Mic" :size="26" :fill="recording ? 'currentColor' : 'none'" />
        </button>
      </template>
      {{ recording ? t('main.stop') : t('main.start') }}
    </n-tooltip>
  </div>
</template>
