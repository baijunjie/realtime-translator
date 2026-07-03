<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { NConfigProvider, darkTheme, lightTheme } from 'naive-ui';
import Onboarding from './screens/Onboarding.vue';
import MainScreen from './screens/MainScreen.vue';
import SettingsScreen from './screens/SettingsScreen.vue';
import ArchiveScreen from './screens/ArchiveScreen.vue';
import ModelsScreen from './screens/ModelsScreen.vue';
import { loadSettings, isDark } from './composables/useSettings';
import { modelLoading } from './composables/useTranscription';
import { bridge } from './bridge';

type Screen = 'loading' | 'onboarding' | 'main' | 'settings' | 'archive' | 'models';
const screen = ref<Screen>('loading');

const naiveTheme = computed(() => (isDark.value ? darkTheme : lightTheme));

// 进主界面：模型不再在此下载（改为点击录音时按需确认下载），仅后台预热已就绪的 ASR 模型，
// 使首次点击录音免等冷启动（不触麦克风）。调用前先置 modelLoading，消除 loading 事件到达前的
// 可点空窗；平台保证预热的任何路径（含跳过/失败）都以终态 status 收尾解禁。
async function enterMain(): Promise<void> {
  if (bridge().prewarmPipeline) {
    modelLoading.value = true;
    bridge().prewarmPipeline!();
  }
  screen.value = 'main';
}

onMounted(async () => {
  const s = await loadSettings();
  if (s.onboarded) {
    await enterMain();
  } else {
    screen.value = 'onboarding';
  }
});
</script>

<template>
  <n-config-provider :theme="naiveTheme">
    <!-- safe-area 内边距：iOS 刘海/灵动岛/Home 指示条留白；env() 在桌面端恒为 0，故 macOS 不受影响 -->
    <div
      class="h-svh overflow-hidden bg-white text-neutral-900 dark:bg-[#1e1f24] dark:text-neutral-100"
      style="padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)"
    >
      <onboarding v-if="screen === 'onboarding'" @done="enterMain" />
      <main-screen
        v-else-if="screen === 'main'"
        @open-settings="screen = 'settings'"
        @open-archive="screen = 'archive'"
      />
      <settings-screen
        v-else-if="screen === 'settings'"
        @close="screen = 'main'"
        @open-models="screen = 'models'"
      />
      <archive-screen v-else-if="screen === 'archive'" @close="screen = 'main'" />
      <models-screen v-else-if="screen === 'models'" @close="screen = 'settings'" />
    </div>
  </n-config-provider>
</template>
