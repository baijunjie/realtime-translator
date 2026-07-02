import { nextTick, reactive, ref } from 'vue';
import type { PipelineErrorCode, TranslationFileProgress } from '@rt/core';
import { fmtClock } from '../utils/datetime';
import { bridge } from '../bridge';

export interface TranscriptLine {
  id: number;
  time: string;
  text: string;
  translation: string;
  /** 译文进行中：已派发翻译、结果未到，UI 在译文区显示等待动画。同语言/未开启翻译时恒 false */
  translating: boolean;
  /** 该行翻译失败：在译文区显示失败标记（failedDetail 为宿主原始错误，供悬停提示） */
  failed: boolean;
  failedDetail?: string;
}

export const lines = reactive<TranscriptLine[]>([]);
export const partial = ref('');
export const recording = ref(false);

// 软件未就绪：加载 ASR 模型中（录音管线就绪前）
export const modelLoading = ref(false);
// 录音/管线错误：原始文案（宿主自由文本，可能非界面语言）+ 稳定错误码（有码时 UI 按码取本地化文案）
export const errorText = ref('');
export const errorCode = ref<PipelineErrorCode | null>(null);

// 翻译模型状态（独立，显示在翻译开关旁，不影响录音）
export const translationLoading = ref(false);
export const translationDownloading = ref(false); // true=首次下载(有进度)，false=载入内存
export const translationProgress = ref(0); // 0~100
// 各文件独立下载进度（下载页逐文件展示进度条），仅 loading 阶段有值，ready/error 清空
export const translationFiles = ref<TranslationFileProgress[]>([]);
export const translationError = ref(false);

// 录音开始时的本地时刻（epoch ms），用于把片段的相对偏移换算成本地时钟时间
let recordStartEpoch = 0;

// 录音开关在途状态：start/stop 尚未 await 完成时为真——既作并发守卫（忽略新的切换请求，
// 消除 stop 进行中被并发 start 拆掉音频通路的窗口期），也供 UI 禁用录音按钮并显示加载态
// （启动含取麦克风等待，可达数秒，无反馈会让用户以为没点上而连点）。
export const recordBusy = ref(false);

// 把片段相对录音起点的偏移（秒）换算成本地时钟时间 HH:MM:SS
function fmtTime(offsetSeconds: number): string {
  return fmtClock(recordStartEpoch + offsetSeconds * 1000);
}

// 应用生命周期级监听：只注册一次即可（bridge on* 支持反注册，但这些订阅与应用同寿，无需退订）。
// 由 mountApp 在 setBridge 之后调用 registerTranscriptionListeners()，
// 不再在模块导入时注册——此时 bridge 尚未注入。
let registered = false;
export function registerTranscriptionListeners(): void {
  if (registered) return;
  registered = true;

  bridge().onSegment((seg) => {
    lines.push({
      id: seg.id,
      time: fmtTime(seg.start),
      text: seg.text,
      translation: '',
      translating: false,
      failed: false,
    });
    // 识别区里有实时识别文字时才做交接：把它定格成这条定稿文本、下一 tick 再清空，
    // 使向下淡出的正是落入确定句区的同一句（而非早期实时猜测）。识别区本就为空（无中间结果）则不动，停留「聆听中」。
    if (partial.value !== '') {
      partial.value = seg.text;
      void nextTick(() => {
        if (partial.value === seg.text) partial.value = '';
      });
    }
  });
  bridge().onPartial((p) => {
    partial.value = p.text;
  });
  bridge().onTranslation((tr) => {
    const line = lines.find((l) => l.id === tr.id);
    if (!line) return;
    if (tr.pending) {
      // 翻译已开始、结果未到：显示等待动画
      line.translating = true;
      line.failed = false;
    } else if (tr.failed) {
      // 该行翻译失败：结束等待动画、行内显示失败标记（不进全局引擎状态）
      line.translating = false;
      line.failed = true;
      line.failedDetail = tr.error;
    } else {
      // 最终结果（空串表示无需翻译，仅结束等待、不展示）
      line.translation = tr.text;
      line.translating = false;
      line.failed = false;
    }
  });
  bridge().onStatus((s) => {
    if (s.state === 'loading') {
      modelLoading.value = true;
    } else if (s.state === 'running') {
      modelLoading.value = false;
      errorText.value = '';
      errorCode.value = null;
    } else if (s.state === 'error') {
      modelLoading.value = false;
      errorText.value = s.error ?? 'Error';
      errorCode.value = s.code ?? null;
      // 经守卫收停：stopPipeline 在途期间用户点录音会被 recordBusy 挡住，避免 start/stop 交错
      if (recording.value) {
        recordBusy.value = true;
        void stopRecording().finally(() => {
          recordBusy.value = false;
        });
      }
    } else if (s.state === 'stopped') {
      modelLoading.value = false;
      // 管线可能在宿主侧结束（如 iOS 来电/拔耳机等系统音频中断），同步 UI 回到停止态；
      // 用户主动停止时 recording 已为 false，重复赋值无副作用。
      recording.value = false;
    }
  });
  bridge().onTranslationStatus((s) => {
    if (s.state === 'loading') {
      translationLoading.value = true;
      translationError.value = false;
      // 有进度=正在下载文件；无进度=从缓存载入内存
      if (typeof s.progress === 'number') {
        translationDownloading.value = true;
        translationProgress.value = Math.round(s.progress * 100);
      }
      if (s.files) translationFiles.value = s.files;
    } else if (s.state === 'error') {
      translationLoading.value = false;
      translationDownloading.value = false;
      translationFiles.value = [];
      translationError.value = true;
      // 翻译失败（含子进程崩溃）：结束所有仍在等待的译文动画，避免永久转圈
      for (const l of lines) l.translating = false;
    } else if (s.state === 'ready') {
      translationLoading.value = false;
      translationDownloading.value = false;
      translationFiles.value = [];
      translationError.value = false; // 引擎恢复就绪，清除全局失败提示
    }
  });
}

export async function startRecording(): Promise<void> {
  errorText.value = '';
  errorCode.value = null;
  // 桥接内部负责音频采集（macOS 渲染层用 AudioWorklet，iOS 原生采麦），UI 不感知平台细节。
  const result = await bridge().startPipeline();
  if (!result.ok) {
    errorText.value = result.error ?? 'Error';
    errorCode.value = result.code ?? null;
    return;
  }
  // 计时基线在管线确认启动后才取：segment.start 的 0 点是管线启动之后，
  // 首次录音需加载模型耗时数秒，若在 await 前取值会让所有行的时钟偏早整个加载时长。
  recordStartEpoch = Date.now();
  recording.value = true;
}

export async function stopRecording(): Promise<void> {
  recording.value = false;
  await bridge().stopPipeline();
  partial.value = '';
}

export function toggleRecording(): void {
  // 上一次切换（含 onStatus error 分支触发的收停）尚在途时忽略本次点击，避免 start/stop 交错并发。
  if (recordBusy.value) return;
  recordBusy.value = true;
  const action = recording.value ? stopRecording() : startRecording();
  void action.finally(() => {
    recordBusy.value = false;
  });
}

/** 清空转写历史 */
export function clearTranscript(): void {
  lines.splice(0, lines.length);
  partial.value = '';
}
