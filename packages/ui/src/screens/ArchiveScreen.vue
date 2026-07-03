<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { NButton, NTooltip } from 'naive-ui';
import { ArrowLeft, Trash2 } from '@lucide/vue';
import { useI18n } from 'vue-i18n';
import type { ArchiveSummary, ArchiveRecord } from '@rt/core';
import ConversationLine from '../components/ConversationLine.vue';
import ScrollArea from '../components/ScrollArea.vue';
import { fmtDateTime } from '../utils/datetime';
import { bridge } from '../bridge';

const { t } = useI18n();
const emit = defineEmits<{ close: [] }>();

const items = ref<ArchiveSummary[]>([]);
const selected = ref<ArchiveRecord | null>(null);

async function open(id: string): Promise<void> {
  selected.value = await bridge().getArchive(id);
}

async function remove(id: string): Promise<void> {
  items.value = await bridge().deleteArchive(id);
}

// 详情里点返回回到列表；列表里点返回回到主页
function back(): void {
  if (selected.value) {
    selected.value = null;
  } else {
    emit('close');
  }
}

onMounted(async () => {
  items.value = await bridge().listArchives();
});
</script>

<template>
  <div class="flex h-full flex-col">
    <header
      class="flex items-center gap-3 border-b border-neutral-200 px-[18px] py-3 dark:border-[#3a3b44]"
    >
      <n-tooltip>
        <template #trigger>
          <n-button quaternary circle :aria-label="t('settings.back')" @click="back">
            <template #icon><ArrowLeft :size="18" /></template>
          </n-button>
        </template>
        {{ t('settings.back') }}
      </n-tooltip>
      <span class="truncate text-[15px] font-semibold">
        {{ selected ? selected.name : t('archive.title') }}
      </span>
    </header>

    <!-- 详情：某条归档的完整对话（按时间顺序） -->
    <ScrollArea v-if="selected" class="flex-1">
      <div class="mx-auto w-full max-w-[640px] px-5 py-4">
        <ConversationLine
          v-for="(line, i) in selected.lines"
          :key="i"
          :time="line.time"
          :text="line.text"
          :translation="line.translation"
        />
      </div>
    </ScrollArea>

    <!-- 列表 -->
    <ScrollArea v-else class="flex-1">
      <p
        v-if="items.length === 0"
        class="mt-16 text-center text-sm text-neutral-400 dark:text-neutral-500"
      >
        {{ t('archive.empty') }}
      </p>
      <ul v-else class="mx-auto w-full max-w-[640px] px-5 py-4">
        <li
          v-for="it in items"
          :key="it.id"
          class="flex items-start gap-3 border-b border-neutral-200 py-3 dark:border-[#2b2c33]"
        >
          <button
            class="min-w-0 flex-1 cursor-pointer text-left"
            @click="open(it.id)"
          >
            <div class="flex items-center gap-2">
              <span class="truncate font-medium">{{ it.name }}</span>
              <span class="shrink-0 text-xs text-neutral-400 dark:text-neutral-500">
                {{ fmtDateTime(it.createdAt) }}
              </span>
            </div>
            <div class="mt-0.5 truncate text-xs text-neutral-400 dark:text-neutral-500">
              {{ it.lastLine }}
            </div>
          </button>
          <n-tooltip>
            <template #trigger>
              <n-button quaternary circle size="small" :aria-label="t('archive.delete')" @click="remove(it.id)">
                <template #icon><Trash2 :size="16" /></template>
              </n-button>
            </template>
            {{ t('archive.delete') }}
          </n-tooltip>
        </li>
      </ul>
    </ScrollArea>
  </div>
</template>
