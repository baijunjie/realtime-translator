<script setup lang="ts">
import { reactive, ref } from 'vue';
import { NButton } from 'naive-ui';
import { ArrowLeft, HardDrive } from '@lucide/vue';
import { useI18n } from 'vue-i18n';
import { M2M100_SPEC } from '@rt/core';
import { settings, saveSettings, previewLocale, applyFontSize, previewTheme } from '../composables/useSettings';
import { bridge } from '../bridge';
import SettingsForm, { type SettingsFormData } from '../components/SettingsForm.vue';
import ModelDownloadModal, { type DownloadTask } from '../components/ModelDownloadModal.vue';

const { t } = useI18n();
const emit = defineEmits<{ close: []; openModels: [] }>();

// 发布版本串（构建期注入的包版本+commit 短哈希）；宿主未提供则不展示
const appVersion = bridge().appVersion;

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

// 云端引擎需先「测试连接」通过才允许保存；由 SettingsForm 回传（非云端恒为 true）。
const saveable = ref(true);

// 本地翻译模型未缓存时的就地下载弹窗
const downloadModalOpen = ref(false);
const downloadTasks = ref<DownloadTask[]>([]);

async function save(): Promise<void> {
  // 三态映射回持久化：选「无」→ enabled=false（引擎保留原值）；选模型 → enabled=true + 该引擎。
  const enabled = form.engine !== 'none';
  const engine = form.engine === 'none' ? current.translation.engine : form.engine;
  const saved = await saveSettings({
    ...current,
    nativeLang: form.nativeLang,
    fontSize: form.fontSize,
    theme: form.theme,
    asr: { ...form.asr },
    translation: { ...current.translation, enabled, engine, cloud: { ...form.cloud } },
  });
  // 开启了本地翻译且模型未缓存 → 就地弹下载弹窗；其余情况正常关闭回主界面。
  if (saved.translation.enabled && saved.translation.engine !== 'cloud') {
    const getStatus = bridge().getTranslationSetupStatus;
    if (getStatus && bridge().downloadTranslationModel) {
      try {
        const { ready } = await getStatus();
        if (!ready) {
          downloadTasks.value = [
            { kind: 'translation', nameKey: 'models.m2m100', sizeBytes: M2M100_SPEC.approxDownloadBytes },
          ];
          downloadModalOpen.value = true;
          return;
        }
      } catch {
        /* 查询失败：正常关闭；缺模型会在首次录音触发按需下载 */
      }
    }
  }
  emit('close');
}

// 下载完成 → 设置已生效，关闭回主界面
function onDownloadDone(): void {
  emit('close');
}

// 取消下载即「不开启本地翻译」：把翻译开关回退为关闭并落盘，再关闭。
async function onDownloadCancel(): Promise<void> {
  const s = settings.value;
  if (s) {
    await saveSettings({ ...s, translation: { ...s.translation, enabled: false } });
  }
  emit('close');
}

function cancel(): void {
  // 放弃未保存的预览
  previewLocale(current.nativeLang);
  applyFontSize(current.fontSize);
  previewTheme(current.theme);
  emit('close');
}
</script>

<template>
  <div class="flex h-full flex-col">
    <header
      class="flex items-center gap-3 border-b border-neutral-200 px-[18px] py-3 dark:border-[#3a3b44]"
    >
      <n-button quaternary circle :title="t('settings.back')" @click="cancel">
        <template #icon><ArrowLeft :size="18" /></template>
      </n-button>
      <span class="text-[15px] font-semibold">{{ t('settings.title') }}</span>
      <div class="flex-1" />
      <n-button type="primary" :disabled="!saveable" @click="save">{{ t('settings.save') }}</n-button>
    </header>

    <div class="flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-[560px] px-5 py-6">
        <settings-form :form="form" require-dirty v-model:saveable="saveable" />

        <!-- 模型管理入口：切到模型管理页 -->
        <n-button block class="mt-2" @click="emit('openModels')">
          <template #icon><HardDrive :size="16" /></template>
          {{ t('settings.modelManagement') }}
        </n-button>

        <p
          v-if="appVersion"
          class="mt-8 text-center text-xs text-neutral-400 select-text dark:text-neutral-500"
        >
          {{ t('settings.version') }} {{ appVersion }}
        </p>
      </div>
    </div>

    <!-- 本地翻译模型就地下载：done 生效关闭，cancel 回退翻译开关 -->
    <model-download-modal
      v-model:show="downloadModalOpen"
      :tasks="downloadTasks"
      @done="onDownloadDone"
      @cancel="onDownloadCancel"
    />
  </div>
</template>
