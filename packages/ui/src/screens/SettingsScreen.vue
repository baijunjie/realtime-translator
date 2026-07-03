<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { NButton, NTooltip } from 'naive-ui';
import { ArrowLeft, SlidersHorizontal, Mic, Languages, HardDrive } from '@lucide/vue';
import { useI18n } from 'vue-i18n';
import { M2M100_SPEC } from '@rt/core';
import { settings, saveSettings } from '../composables/useSettings';
import { bridge } from '../bridge';
import type { SettingsFormData } from '../components/settings/form';
import GeneralSection from '../components/settings/GeneralSection.vue';
import AsrSection from '../components/settings/AsrSection.vue';
import TranslationSection from '../components/settings/TranslationSection.vue';
import ModelsSection from '../components/settings/ModelsSection.vue';
import ModelDownloadModal, { type DownloadTask } from '../components/ModelDownloadModal.vue';

const { t } = useI18n();
const emit = defineEmits<{ close: [] }>();

// 发布版本串（构建期注入的包版本+commit 短哈希）；宿主未提供则不展示
const appVersion = bridge().appVersion;

// 左侧竖排 tab：通用 / 语音识别 / 翻译 / 模型管理，标签复用现有 i18n key。
type Tab = 'general' | 'asr' | 'translation' | 'models';
const tabs = [
  { key: 'general', icon: SlidersHorizontal, labelKey: 'settings.generalSection' },
  { key: 'asr', icon: Mic, labelKey: 'settings.asrSection' },
  { key: 'translation', icon: Languages, labelKey: 'settings.translationSection' },
  { key: 'models', icon: HardDrive, labelKey: 'settings.modelManagement' },
] as const;
const tab = ref<Tab>('general');

const current = settings.value!;
const form = reactive<SettingsFormData>({
  nativeLang: current.nativeLang,
  fontSize: current.fontSize,
  theme: current.theme,
  asr: { ...current.asr },
  // 三态：未开启翻译 → 无；开启 → 对应引擎（选了模型即视为开启，主页无独立开关）。
  engine: current.translation.enabled ? current.translation.engine : 'none',
  cloud: { ...current.translation.cloud },
});

// 本地翻译模型未缓存时的就地下载弹窗
const downloadModalOpen = ref(false);
const downloadTasks = ref<DownloadTask[]>([]);

// 自动保存串行化：把每次保存追加到 promise 链尾，避免并发写互相覆盖。
// 基底读保存时刻的 settings.value（每次保存后更新）而非打开时快照，
// 否则多次保存的会话里「无 → 本地 → 无」会把引擎记忆回退成打开时的旧值。
let saveChain: Promise<unknown> = Promise.resolve();
function persist(): Promise<unknown> {
  saveChain = saveChain.then(() => {
    const base = settings.value!;
    // 三态映射回持久化：选「无」→ enabled=false（引擎保留原值）；选模型 → enabled=true + 该引擎。
    const enabled = form.engine !== 'none';
    const engine = form.engine === 'none' ? base.translation.engine : form.engine;
    // saveSettings 内部会重新应用语言/字体/主题，故设置页无需任何 preview 调用。
    return saveSettings({
      ...base,
      nativeLang: form.nativeLang,
      fontSize: form.fontSize,
      theme: form.theme,
      asr: { ...form.asr },
      translation: { ...base.translation, enabled, engine, cloud: { ...form.cloud } },
    });
  });
  return saveChain;
}

// 保存通道 a：选择器类字段变化即刻落盘（含即时的语言/字体/主题预览）。
watch(
  [
    () => form.nativeLang,
    () => form.fontSize,
    () => form.theme,
    () => form.asr.language,
    () => form.asr.model,
    () => form.engine,
  ],
  () => {
    void persist();
  },
);

// 保存通道 b：云端三个文本字段（Base URL / 模型 / API Key）连续输入时防抖 500ms 再落盘。
let cloudTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => form.cloud,
  () => {
    clearTimeout(cloudTimer);
    cloudTimer = setTimeout(() => void persist(), 500);
  },
  { deep: true },
);

// 切到本地翻译引擎时按需弹下载弹窗。先 await 保存链，确保本次 engine 变更已落盘再查就绪状态，
// 避免与保存竞态（保存通道 a 的 watch 声明在前，此处 await 到的正是那次保存）。
watch(
  () => form.engine,
  async (engine, prev) => {
    if (engine !== 'm2m100' || prev === 'm2m100') return;
    await saveChain;
    const getStatus = bridge().getTranslationSetupStatus;
    if (getStatus && bridge().downloadTranslationModel) {
      try {
        const { ready } = await getStatus();
        if (!ready) {
          downloadTasks.value = [
            { kind: 'translation', nameKey: 'models.m2m100', sizeBytes: M2M100_SPEC.approxDownloadBytes },
          ];
          downloadModalOpen.value = true;
        }
      } catch {
        /* 查询失败：不弹窗；缺模型会在首次录音触发按需下载 */
      }
    }
  },
);

// 下载完成 → 设置已生效，仅关闭弹窗（不离开设置页）
function onDownloadDone(): void {
  downloadModalOpen.value = false;
}

// 取消下载即「不开启本地翻译」：把翻译方式置回「无」，经保存通道 a 落盘为 translation.enabled=false。
function onDownloadCancel(): void {
  form.engine = 'none';
}
</script>

<template>
  <div class="flex h-full flex-col">
    <header
      class="flex items-center gap-3 border-b border-neutral-200 px-[18px] py-3 dark:border-[#3a3b44]"
    >
      <n-tooltip>
        <template #trigger>
          <n-button quaternary circle :aria-label="t('settings.back')" @click="emit('close')">
            <template #icon><ArrowLeft :size="18" /></template>
          </n-button>
        </template>
        {{ t('settings.back') }}
      </n-tooltip>
      <span class="text-[15px] font-semibold">{{ t('settings.title') }}</span>
    </header>

    <!-- 窄屏（<sm）tab 栏横排在顶部、可横向滚动；≥sm 竖排在左侧 -->
    <div class="flex min-h-0 flex-1 flex-col sm:flex-row">
      <!-- tab 栏：桌面端底部 flex-1 撑开后放版本号；窄屏版本号移到内容区底部 -->
      <nav
        class="flex shrink-0 gap-1 overflow-x-auto border-b border-neutral-200 px-3 py-2 dark:border-[#3a3b44] sm:w-44 sm:flex-col sm:overflow-x-visible sm:border-b-0 sm:border-r sm:py-4"
      >
        <button
          v-for="item in tabs"
          :key="item.key"
          type="button"
          class="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-left text-sm sm:w-full"
          :class="
            tab === item.key
              ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-[#2b2c33] dark:text-neutral-100'
              : 'text-neutral-500 hover:bg-neutral-100/60 dark:text-neutral-400 dark:hover:bg-[#26272e]'
          "
          @click="tab = item.key"
        >
          <component :is="item.icon" :size="16" />
          <span>{{ t(item.labelKey) }}</span>
        </button>
        <div class="hidden flex-1 sm:block" />
        <p
          v-if="appVersion"
          class="hidden text-center text-[11px] text-neutral-400 select-text dark:text-neutral-500 sm:block"
        >
          {{ t('settings.version') }} {{ appVersion }}
        </p>
      </nav>

      <div class="flex-1 overflow-y-auto">
        <div class="mx-auto w-full max-w-[560px] px-5 py-6">
          <general-section v-if="tab === 'general'" :form="form" />
          <asr-section v-else-if="tab === 'asr'" :form="form" />
          <translation-section v-else-if="tab === 'translation'" :form="form" />
          <models-section v-else-if="tab === 'models'" />

          <p
            v-if="appVersion"
            class="mt-8 text-center text-[11px] text-neutral-400 select-text dark:text-neutral-500 sm:hidden"
          >
            {{ t('settings.version') }} {{ appVersion }}
          </p>
        </div>
      </div>
    </div>

    <!-- 本地翻译模型就地下载：done 仅关闭弹窗，cancel 回退翻译方式为「无」 -->
    <model-download-modal
      v-model:show="downloadModalOpen"
      :tasks="downloadTasks"
      @done="onDownloadDone"
      @cancel="onDownloadCancel"
    />
  </div>
</template>
