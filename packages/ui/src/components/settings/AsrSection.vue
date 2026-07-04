<script setup lang="ts">
import { computed, watch } from 'vue';
import { NSelect, NFormItem } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { UI_LANGS, asrModelsFor, DEFAULT_ASR_MODEL_ID, type AsrLang } from '@rt/core';
import { bridge } from '../../bridge';
import { humanBytes } from '../../utils/bytes';
import { LANG_LABELS } from './form';
import type { SettingsFormData } from './form';

const { t } = useI18n();
// 父组件持有 reactive 表单对象，子组件直接修改其字段
const props = defineProps<{ form: SettingsFormData }>();


// —— 语音识别：识别语言 + 识别模型 ——
// 识别语言下拉：auto 置顶，其余 en/ja/ko/zh 字母序（复用 UI_LANGS 顺序）。
const asrLangOptions = computed(() => [
  { label: t('settings.asrLanguageAuto'), value: 'auto' },
  ...UI_LANGS.map((l) => ({ label: LANG_LABELS[l], value: l as string })),
]);
// 识别模型下拉：按当前识别语言 + 平台过滤，label 附模型近似大小。
const platform = bridge().platform;
const asrModelOptions = computed(() =>
  asrModelsFor(props.form.asr.language, platform).map((m) => ({
    label: `${t(m.nameKey)}（${humanBytes(m.approxBytes)}）`,
    value: m.id,
  })),
);
// 识别语言切换后，若当前模型已不在新语言的可选列表中，自动落到默认模型。
watch(
  () => props.form.asr.language,
  (lang: AsrLang) => {
    const available = asrModelsFor(lang, platform);
    if (!available.some((m) => m.id === props.form.asr.model)) {
      props.form.asr.model = DEFAULT_ASR_MODEL_ID;
    }
  },
);
</script>

<template>
  <div>
    <n-form-item :label="t('settings.asrLanguage')">
      <n-select v-model:value="form.asr.language" :options="asrLangOptions" />
    </n-form-item>
    <n-form-item :label="t('settings.asrModel')">
      <n-select v-model:value="form.asr.model" :options="asrModelOptions" />
    </n-form-item>
  </div>
</template>
