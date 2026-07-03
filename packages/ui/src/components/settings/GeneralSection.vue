<script setup lang="ts">
import { computed } from 'vue';
import { NSelect, NFormItem } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { UI_LANGS, type UiLang } from '@rt/core';
import type { GeneralFormData } from './form';

const { t } = useI18n();
// 父组件持有 reactive 表单对象，子组件直接修改其字段
defineProps<{ form: GeneralFormData }>();

// 母语下拉：选项与顺序（en/ja/ko/zh）由 UI_LANGS 派生，label 用各语言的自称。
const LANG_LABELS: Record<UiLang, string> = {
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  zh: '中文',
};
const langOptions = UI_LANGS.map((l) => ({ label: LANG_LABELS[l], value: l }));
const fontOptions = computed(() => [
  { label: t('settings.fontSmall'), value: 'small' },
  { label: t('settings.fontMedium'), value: 'medium' },
  { label: t('settings.fontLarge'), value: 'large' },
]);
const themeOptions = computed(() => [
  { label: t('main.themeLight'), value: 'light' },
  { label: t('main.themeDark'), value: 'dark' },
  { label: t('main.themeSystem'), value: 'system' },
]);
</script>

<template>
  <div>
    <n-form-item :label="t('settings.nativeLang')">
      <n-select v-model:value="form.nativeLang" :options="langOptions" />
    </n-form-item>

    <n-form-item :label="t('settings.fontSize')">
      <n-select v-model:value="form.fontSize" :options="fontOptions" />
    </n-form-item>

    <n-form-item :label="t('main.theme')">
      <n-select v-model:value="form.theme" :options="themeOptions" />
    </n-form-item>
  </div>
</template>
