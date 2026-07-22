// macOS 端转写管线适配层：切段策略与文本清理在 @rt/core 的 TranscriptionPipeline，
// 这里只负责平台绑定的部分——模型文件检查、sherpa-onnx-node（N-API）的 VAD/识别器
// 构造与预热，并把它们包装成 core 需要的 AsrInferenceEngine 注入。
// 对 asr-process/测试脚本暴露的公开面（TranscriptionPipeline / SAMPLE_RATE）保持不变。
import path from 'node:path';
import fs from 'node:fs';
import { Vad, OfflineRecognizer, type OfflineRecognizerConfig, type VadConfig } from 'sherpa-onnx-node';
import {
  SILERO_VAD,
  getAsrModel,
  requiredAsrFiles,
  SAMPLE_RATE,
  VAD_WINDOW_SIZE,
  MIN_SILENCE_SECONDS,
  TranscriptionPipeline as CorePipeline,
  type AsrInferenceEngine,
  type PipelineCallbacks,
  type AsrLang,
  type AsrModelSpec,
  type AsrModelFile,
} from '@rt/core';

export { SAMPLE_RATE } from '@rt/core';
export type { PipelineCallbacks } from '@rt/core';

/** 校验指定模型（含公共依赖 VAD）的全部文件存在，缺失则抛错（交由子进程上报重下载）。 */
function assertModelsExist(modelsDir: string, modelId: string): void {
  const missing = requiredAsrFiles(modelId).filter(
    (f) => !fs.existsSync(path.join(modelsDir, f)),
  );
  if (missing.length > 0) {
    throw new Error(`模型文件缺失: ${missing.join(', ')}。请重启应用以重新下载模型`);
  }
}

/** 按角色取模型文件并拼出本地绝对路径；缺该角色文件时抛错（注册表与实际文件不一致）。 */
function fileByRole(
  modelsDir: string,
  spec: AsrModelSpec,
  role: NonNullable<AsrModelFile['role']>,
): string {
  const f = spec.files.find((x) => x.role === role);
  if (!f) throw new Error(`模型 ${spec.id} 缺少角色为 ${role} 的文件`);
  return path.join(modelsDir, f.dir, f.filename);
}

/** 构造 Silero VAD 配置：探测参数与 core 管线的断句去抖保持一致（参数单源，评测脚本也复用）。 */
export function buildVadConfig(modelsDir: string): VadConfig {
  return {
    sileroVad: {
      model: path.join(modelsDir, SILERO_VAD.filename),
      // 偏低的阈值让 VAD 更早进入语音状态，减少句首被截断
      threshold: 0.35,
      minSpeechDuration: 0.25,
      minSilenceDuration: MIN_SILENCE_SECONDS,
      windowSize: VAD_WINDOW_SIZE,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    debug: 0,
  };
}

/** 按注册表 engine 装配 OfflineRecognizer 的 modelConfig（各引擎的文件角色与字段不同）。评测脚本复用。 */
export function buildModelConfig(
  modelsDir: string,
  spec: AsrModelSpec,
  language: AsrLang,
): OfflineRecognizerConfig['modelConfig'] {
  const tokens = fileByRole(modelsDir, spec, 'tokens');
  const common = { tokens, numThreads: 2, debug: 0 } as const;

  switch (spec.engine) {
    case 'senseVoice':
      return {
        // language 透传：'auto' 与 zh/en/ja/ko 均为 SenseVoice 合法取值（原生校验）。
        senseVoice: {
          model: fileByRole(modelsDir, spec, 'model'),
          language,
          useInverseTextNormalization: 1,
        },
        ...common,
      };
    case 'paraformer':
      return {
        paraformer: { model: fileByRole(modelsDir, spec, 'model') },
        ...common,
      };
    case 'transducer':
      return {
        transducer: {
          encoder: fileByRole(modelsDir, spec, 'encoder'),
          decoder: fileByRole(modelsDir, spec, 'decoder'),
          joiner: fileByRole(modelsDir, spec, 'joiner'),
        },
        // NeMo transducer 需显式声明子类型；标准 zipformer transducer 无 modelType，由原生自动识别。
        ...(spec.modelType ? { modelType: spec.modelType } : {}),
        ...common,
      };
  }
}

export class TranscriptionPipeline {
  private readonly core: CorePipeline;
  private readonly vad: Vad;
  private readonly recognizer: OfflineRecognizer;
  // 非 senseVoice 引擎不产语言标记，用注册表首个语言固定填充（供翻译链路当源语言）；
  // senseVoice 为 null，改用引擎返回的 <|zh|> 标记（由 core 剥离尖括号）。
  private readonly fixedLang: string | null;

  constructor(modelsDir: string, modelId: string, language: AsrLang, callbacks: PipelineCallbacks) {
    assertModelsExist(modelsDir, modelId);
    const spec = getAsrModel(modelId);
    if (!spec) throw new Error(`未知的识别模型: ${modelId}`);
    this.fixedLang = spec.engine === 'senseVoice' ? null : spec.languages[0];

    this.vad = new Vad(
      buildVadConfig(modelsDir),
      120 // 内部环形缓冲区时长(秒)
    );

    this.recognizer = new OfflineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: buildModelConfig(modelsDir, spec, language),
    });

    const engine: AsrInferenceEngine = {
      acceptVadWindow: (samples) => this.vad.acceptWaveform(samples),
      isSpeechDetected: () => this.vad.isDetected(),
      drainVad: () => {
        while (!this.vad.isEmpty()) {
          this.vad.pop();
        }
      },
      flushVad: () => this.vad.flush(),
      transcribe: (samples) => {
        const stream = this.recognizer.createStream();
        stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
        this.recognizer.decode(stream);
        const result = this.recognizer.getResult(stream);
        // tokens/timestamps 透传给 core 供窗口滑动定位提交边界（缺失时 core 走 fallback）。
        return {
          text: result.text || '',
          lang: this.fixedLang ?? (result.lang || ''),
          tokens: result.tokens,
          timestamps: result.timestamps,
          durations: result.durations,
        };
      },
    };

    // 预热识别器：ONNX 首次推理要做图优化/线程池/内存分配（可能数秒）。
    // 在构造期（=“加载模型中”，此时尚未开始采集音频）先用 1s 静音跑一次，
    // 把这次冷启动开销挪走，避免用户已经在说话时第一次推理拖垮实时管线。
    try {
      engine.transcribe(new Float32Array(SAMPLE_RATE));
    } catch {
      // 预热失败忽略，不影响正常使用
    }

    // 提交策略随模型注入：非自回归模型走一致前缀提交，自回归 transducer 走定长分块提交。
    this.core = new CorePipeline(engine, callbacks, spec.commitStrategy);
  }

  /** @param samples 16kHz 单声道 */
  acceptWaveform(samples: Float32Array): void {
    this.core.acceptWaveform(samples);
  }

  /** 录音结束时调用，把未闭合的语音段定稿 */
  flush(): void {
    this.core.flush();
  }

  /** 开始新一次录音会话：重置 segment.start 的计时基线 */
  reset(): void {
    this.core.reset();
  }
}
