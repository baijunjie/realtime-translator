<script setup lang="ts">
// 一行对话：时间 + 原文 + 可选译文。主页历史与归档详情共用。
// dim=true 用于主页历史（弱化，让当前句更突出）。
// translating=true 表示译文尚未到达、仍在翻译中：在译文区显示等待动画（归档详情不传，恒 false）。
// failed=true 表示该行翻译失败：译文区显示失败标记，悬停可见 failedDetail 原始错误。
import { NTooltip } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import TranslatingDots from './TranslatingDots.vue';
const { t } = useI18n();
defineProps<{
  time: string;
  text: string;
  translation?: string;
  dim?: boolean;
  translating?: boolean;
  failed?: boolean;
  failedDetail?: string;
}>();
</script>

<template>
  <div class="mb-3.5 flex gap-3">
    <div
      class="w-12 shrink-0 whitespace-nowrap pt-[3px] text-[11px] tabular-nums text-neutral-400 dark:text-neutral-500"
    >
      {{ time }}
    </div>
    <div class="min-w-0 flex-1">
      <div
        :class="[
          'text-[length:var(--transcript-size)] leading-relaxed',
          dim ? 'text-neutral-600 dark:text-neutral-300' : 'text-neutral-700 dark:text-neutral-200',
        ]"
      >
        {{ text }}
      </div>
      <div
        v-if="translation || translating || failed"
        :class="[
          'mt-1 border-l-2 pl-2.5 text-[length:calc(var(--transcript-size)-1px)] leading-relaxed',
          failed && !translation && !translating
            ? 'border-red-400/70 text-red-500/80'
            : 'border-blue-500 text-neutral-500 dark:text-neutral-400',
        ]"
      >
        <template v-if="translation">{{ translation }}</template>
        <TranslatingDots v-else-if="translating" class="text-blue-500/70" />
        <!-- 失败标记：有原始错误时用 tooltip 悬停展示，无错误详情则仅显示标记 -->
        <n-tooltip v-else-if="failedDetail">
          <template #trigger>
            <span>{{ t('status.transFailedLine') }}</span>
          </template>
          {{ failedDetail }}
        </n-tooltip>
        <span v-else>{{ t('status.transFailedLine') }}</span>
      </div>
    </div>
  </div>
</template>
