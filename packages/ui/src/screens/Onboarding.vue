<script setup lang="ts">
import { reactive, ref } from 'vue';
import { NButton } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { settings, saveSettings } from '../composables/useSettings';
import SettingsForm, { type SettingsFormData } from '../components/SettingsForm.vue';

const { t } = useI18n();
const emit = defineEmits<{ done: [] }>();

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

// 云端引擎需先「测试连接」通过才允许开始；由 SettingsForm 回传（非云端恒为 true）。
const saveable = ref(true);

async function start(): Promise<void> {
  // 三态映射回持久化：选「无」→ enabled=false（引擎保留原值）；选模型 → enabled=true + 该引擎。
  const enabled = form.engine !== 'none';
  const engine = form.engine === 'none' ? current.translation.engine : form.engine;
  await saveSettings({
    ...current,
    onboarded: true,
    nativeLang: form.nativeLang,
    fontSize: form.fontSize,
    theme: form.theme,
    asr: { ...form.asr },
    translation: { ...current.translation, enabled, engine, cloud: { ...form.cloud } },
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
        <settings-form :form="form" v-model:saveable="saveable" />
        <!-- 间距放外层 div：Naive 注入的样式会盖过直接写在 n-button 上的工具类（同 MainScreen 的 sm:hidden 教训） -->
        <div class="mt-6">
          <n-button type="primary" block size="large" :disabled="!saveable" @click="start">
            {{ t('onboarding.start') }}
          </n-button>
        </div>
      </div>
    </div>
  </div>
</template>
