<script setup lang="ts">
import { reactive, watch } from 'vue';
import { NButton } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { settings, saveSettings, previewLocale, previewTheme, applyFontSize } from '../composables/useSettings';
import GeneralSection from '../components/settings/GeneralSection.vue';
import type { GeneralFormData } from '../components/settings/form';

const { t } = useI18n();
const emit = defineEmits<{ done: [] }>();

const current = settings.value!;
const form = reactive<GeneralFormData>({
  nativeLang: current.nativeLang,
  fontSize: current.fontSize,
  theme: current.theme,
});

// 引导页在「开始」前不落盘，仅即时预览界面语言/主题/字体（自动保存通道只在设置页）。
watch(() => form.nativeLang, (v) => previewLocale(v));
watch(() => form.theme, (v) => previewTheme(v));
watch(() => form.fontSize, (v) => applyFontSize(v));

async function start(): Promise<void> {
  // 仅落盘通用设置；asr 与 translation 沿用 current 的默认值。
  await saveSettings({
    ...current,
    onboarded: true,
    nativeLang: form.nativeLang,
    fontSize: form.fontSize,
    theme: form.theme,
  });
  emit('done');
}
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="flex min-h-full items-center justify-center p-6">
      <div class="w-full max-w-[460px]">
        <div class="mb-6 text-center">
          <h1 class="mb-2 text-[22px] font-semibold">{{ t('onboarding.title') }}</h1>
          <p class="text-neutral-500 dark:text-neutral-400">{{ t('onboarding.configure') }}</p>
        </div>
        <general-section :form="form" />
        <!-- 间距放外层 div：Naive 注入的样式会盖过直接写在 n-button 上的工具类（同 MainScreen 的 sm:hidden 教训） -->
        <div class="mt-6">
          <n-button type="primary" block size="large" @click="start">
            {{ t('onboarding.start') }}
          </n-button>
        </div>
      </div>
    </div>
  </div>
</template>
