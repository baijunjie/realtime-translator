<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import type { TranscriptLine } from '../composables/useTranscription';
import { useScrollFade } from '../composables/useScrollFade';
import ConversationLine from './ConversationLine.vue';
import TranslatingDots from './TranslatingDots.vue';

const props = defineProps<{
  lines: TranscriptLine[];
  partial: string;
  recording?: boolean;
  emptyHint: string;
  listeningHint: string;
  translateOn?: boolean;
}>();

const scroller = ref<HTMLElement | null>(null);
const { maskStyle } = useScrollFade(scroller);

// 最新的在最上面
const reversed = computed(() => [...props.lines].reverse());

// 最新确定句：始终置顶并停留（含翻译），直到下一句确定后才被替换并落入历史。
const latest = computed(() => reversed.value[0] ?? null);
// 历史列表：除最新确定句外的所有句子。
const historyLines = computed(() => reversed.value.slice(1));

const hasContent = computed(() => props.lines.length > 0 || !!props.partial);

// 识别区只在录音时显示：录音中才存在"实时识别/聆听"，停止后隐藏（不再显示「聆听中…」）。
// 绑定 recording（整段会话恒为 true）而非 partial：外层盒子整段不重建，
// partial↔「聆听中」的切换只走内层过渡，不会重播外层盒子的入场动画。
const recogVisible = computed(() => !!props.recording);

// 历史新增时的滚动策略：
// - 已在顶部：保持置顶跟随最新，并播放“落入”动画；
// - 正在查看历史（已下滑）：静默插入（关掉动画）+ 锚定当前视口位置，让正在看的条目纹丝不动。
const AT_TOP_THRESHOLD = 24; // px，容忍极小的非零偏移仍视作“在顶部”
const atTop = ref(true);
function onScroll(): void {
  const el = scroller.value;
  if (el) atTop.value = el.scrollTop <= AT_TOP_THRESHOLD;
}

watch(
  () => props.lines.length,
  async () => {
    const el = scroller.value;
    if (!el) return;
    // 此刻 DOM 仍是旧列表（watcher 默认 pre-flush），先量旧状态
    const wasAtTop = el.scrollTop <= AT_TOP_THRESHOLD;
    const prevHeight = el.scrollHeight;
    await nextTick();
    if (wasAtTop) {
      el.scrollTop = 0;
    } else {
      // 新内容插在顶部，补偿高度差以锚定用户正在看的位置。
      // 配合关闭 transition（见模板 :name），无 FLIP 形变，视口绝对静止。
      el.scrollTop += el.scrollHeight - prevHeight;
    }
  }
);

const CUR_TEXT = 'text-[length:calc(var(--transcript-size)+14px)]';
const CUR_TR = 'text-[length:calc(var(--transcript-size)+7px)]';

// 紧凑模式（手机 <640px）：方框内边距与预留行数收紧，少占竖向空间（桌面不变）
const isCompact = ref(false);
let mq: MediaQueryList | null = null;
const onMq = (e: MediaQueryListEvent | MediaQueryList): void => {
  isCompact.value = e.matches;
};
onMounted(() => {
  mq = window.matchMedia('(max-width: 639px)');
  onMq(mq);
  mq.addEventListener('change', onMq);
});
onBeforeUnmount(() => mq?.removeEventListener('change', onMq));

// 最小高度（含内边距，border-box）：短句不塌陷，长句自然撑高。
// padding 常量须与方框的 py 类一致：手机 py-4=2rem；桌面 识别 py-6=3rem、确定句 py-7=3.5rem。
const reservedLines = computed(() => (isCompact.value ? 2.4 : 2.75));
const recogPad = computed(() => (isCompact.value ? '2rem' : '3rem'));
const finalPad = computed(() => (isCompact.value ? '2rem' : '3.5rem'));
const trGap = computed(() => (isCompact.value ? '0.5rem' : '0.9rem')); // 对应 mt-2 / mt-3.5
const recogHeight = computed(
  () => `calc((var(--transcript-size) + 14px) * ${reservedLines.value} + ${recogPad.value})`
);
// 确定句区：开启翻译时额外预留 1 行译文空间，避免译文异步到达时高度跳变。
const finalHeight = computed(() =>
  props.translateOn
    ? `calc((var(--transcript-size) + 14px) * ${reservedLines.value} + (var(--transcript-size) + 7px) * 1.45 + ${trGap.value} + ${finalPad.value})`
    : `calc((var(--transcript-size) + 14px) * ${reservedLines.value} + ${finalPad.value})`
);
// 预留 1 行译文的高度（译文未到达时占位、到达时原地淡入）。
const trLineHeight = 'calc((var(--transcript-size) + 7px) * 1.45)';
</script>

<template>
  <div class="relative flex flex-1 flex-col overflow-hidden">
    <!-- inset-x-0 撑满整宽再居中；若用 left-1/2 不给宽度会被限到半宽而提前折行 -->
    <p
      v-if="!recording && !hasContent"
      class="absolute inset-x-0 top-1/2 -translate-y-1/2 px-6 text-center text-[13px] text-neutral-400 dark:text-neutral-500"
    >
      {{ emptyHint }}
    </p>

    <!-- 顶部固定区：实时识别 +「最新确定句（含翻译）」，不随历史滚动。两区高度固定、互不影响。
         入场/退场统一用 <transition name="rise">：升起淡入、下沉淡出。
         识别区绑定 recogVisible（录音会话）、确定句外层盒子绑定 latest，二者整段会话内都不会重建，
         故各自只在出现时升起一次、消失时沉出一次；内部内容切换各走独立的 <transition>。 -->
    <div class="shrink-0">
      <!-- 识别区：进行中显示实时识别文字（partial），停顿时显示「聆听中」提示 -->
      <transition name="rise">
        <div
          v-if="recogVisible"
          :style="{ minHeight: recogHeight }"
          class="mx-auto mt-5 flex max-w-[88%] items-center justify-center rounded-2xl border border-dashed border-amber-500/45 bg-amber-500/[0.07] px-6 py-6 text-center max-sm:mt-3 max-sm:max-w-[94%] max-sm:px-4 max-sm:py-4"
        >
          <!-- 已识别文字↔「聆听中」切换：识别完成、句子落入确定句区时，识别文字向下淡出（呼应确定句区
               新句的向下淡入 card 入场）。位移只作用在"已识别文字"上；「聆听中」占位仅做无位移的淡入淡出。
               out-in 保证先淡出再切换，两分支各带稳定 key，故识别中 partial 文本原地更新不触发过渡。 -->
          <transition name="recog" mode="out-in">
            <div
              v-if="partial"
              key="partial"
              :class="[
                'recog-text',
                CUR_TEXT,
                'font-semibold leading-snug text-amber-700 dark:text-amber-300',
              ]"
            >
              {{ partial }}
            </div>
            <div
              v-else
              key="hint"
              :class="[
                'recog-hint',
                CUR_TEXT,
                'font-medium leading-snug text-amber-700/45 dark:text-amber-300/45',
              ]"
            >
              {{ listeningHint }}
            </div>
          </transition>
        </div>
      </transition>

      <!-- 最新确定句 + 翻译（蓝色区）：外层盒子常驻不重建（只有内部内容随新句切换），停留到下一句确定后才被替换 -->
      <transition name="rise">
        <div
          v-if="latest"
          :style="{ minHeight: finalHeight }"
          class="mx-auto mt-5 flex max-w-[88%] flex-col items-center justify-center rounded-2xl border border-blue-500/30 bg-blue-500/10 px-6 py-7 text-center max-sm:mt-3 max-sm:max-w-[94%] max-sm:px-4 max-sm:py-4"
        >
          <transition name="card" mode="out-in">
            <div :key="latest.id">
              <div :class="[CUR_TEXT, 'font-semibold leading-snug text-neutral-900 dark:text-white']">
                {{ latest.text }}
              </div>
              <!-- 有译文或翻译进行中时才渲染此区并预留一行译文高度：进行中显示"翻译中"等待动画、
                   译文到达后原地淡入，全程不撑高、避免文字被顶动。
                   同语言等无需翻译的场景两者皆无、此区不渲染，原文得以在方框内垂直居中。 -->
              <div
                v-if="translateOn && (latest.translation || latest.translating)"
                class="mt-3.5 max-sm:mt-2"
                :style="{ minHeight: trLineHeight }"
              >
                <transition name="tr-fade" mode="out-in">
                  <div
                    v-if="latest.translation"
                    key="tr"
                    :class="[CUR_TR, 'leading-snug text-blue-600 dark:text-[#9db0ff]']"
                  >
                    {{ latest.translation }}
                  </div>
                  <div
                    v-else-if="latest.translating"
                    key="wait"
                    :style="{ minHeight: trLineHeight }"
                    :class="[CUR_TR, 'flex items-center justify-center leading-snug text-blue-600/60 dark:text-[#9db0ff]/60']"
                  >
                    <TranslatingDots />
                  </div>
                </transition>
              </div>
            </div>
          </transition>
        </div>
      </transition>
    </div>

    <!-- 历史：最新在上，可滚动。在顶部时新句"落入"并整体下移；查看历史时关闭动画，静默插入保持视口静止。
         [overflow-anchor:none] 关闭浏览器原生滚动锚定，避免它与下方手动补偿叠加导致“多滚一条”的偏移。 -->
    <div
      ref="scroller"
      class="flex-1 overflow-y-auto px-5 pb-5 pt-7 max-sm:pb-28 [overflow-anchor:none]"
      :style="maskStyle"
      @scroll="onScroll"
    >
      <transition-group :name="atTop ? 'drop' : 'silent'" tag="div" class="relative">
        <ConversationLine
          v-for="line in historyLines"
          :key="line.id"
          :time="line.time"
          :text="line.text"
          :translation="line.translation"
          :translating="line.translating"
          :failed="line.failed"
          :failed-detail="line.failedDetail"
          dim
        />
      </transition-group>
    </div>
  </div>
</template>

<style scoped>
/* 两个大文字框统一的入场/退场：升起淡入、下沉淡出。
   外层盒子整段会话不重建，故入场只在出现时播一次、退场只在消失时播一次。 */
.rise-enter-active {
  transition: opacity 0.2s cubic-bezier(0.22, 0.61, 0.36, 1),
    transform 0.2s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.rise-enter-from {
  opacity: 0;
  transform: translateY(18px) scale(0.96);
}
.rise-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.rise-leave-to {
  opacity: 0;
  transform: translateY(-14px) scale(0.97);
}

/* 识别区文字换页：已识别文字被确认、落入确定句区时向下淡出，与确定句区新句向下淡入（card 入场）呼应。
   关键：向下位移只作用在"已识别文字"（.recog-text）上；「聆听中」占位（.recog-hint）仅做无位移的淡入淡出。 */
.recog-enter-active {
  transition: opacity 0.2s ease;
}
.recog-enter-from {
  opacity: 0;
}
.recog-text.recog-leave-active {
  transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.recog-text.recog-leave-to {
  opacity: 0;
  transform: translateY(18px) scale(0.985);
}
.recog-hint.recog-leave-active {
  transition: opacity 0.2s ease;
}
.recog-hint.recog-leave-to {
  opacity: 0;
}

/* 译文异步到达：在预留空间内先淡出"翻译中"动画、再淡入译文，不撑动文字 */
.tr-fade-enter-active,
.tr-fade-leave-active {
  transition: opacity 0.2s ease;
}
.tr-fade-enter-from,
.tr-fade-leave-to {
  opacity: 0;
}

/* 确定句卡片切换：新句从上方（识别区方向）落入，旧句向下离开（落向历史），形成自上而下的流动 */
.card-enter-active {
  transition: opacity 0.2s cubic-bezier(0.22, 0.61, 0.36, 1),
    transform 0.2s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.card-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.card-enter-from {
  opacity: 0;
  transform: translateY(-22px) scale(0.985);
}
.card-leave-to {
  opacity: 0;
  transform: translateY(14px);
}

/* 历史列表：
   - 顶部跟随时（drop）：新句从上方落入，下方各句通过 FLIP 平滑下移；
   - 查看历史时（silent）：不做入场/位移，保持视口静止（见模板说明）；
   - 两种模式下离场（清屏）都淡出，保证退场也有动画。 */
.drop-enter-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.drop-enter-from {
  opacity: 0;
  transform: translateY(-14px);
}
.drop-move {
  transition: transform 0.2s ease;
}
.drop-leave-active,
.silent-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.drop-leave-to,
.silent-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}

/* 尊重系统「减少动态效果」：去掉所有位移/缩放，仅保留不致眩晕的透明度淡入淡出。 */
@media (prefers-reduced-motion: reduce) {
  .rise-enter-from,
  .rise-leave-to,
  .recog-text.recog-leave-to,
  .card-enter-from,
  .card-leave-to,
  .drop-enter-from,
  .drop-leave-to,
  .silent-leave-to {
    transform: none;
  }
  .drop-move {
    transition: none;
  }
}
</style>
