// sherpa-onnx-node 没有自带 .d.ts，这里只声明本项目实际用到的 API 表面。
declare module 'sherpa-onnx-node' {
  export interface SileroVadConfig {
    model: string;
    threshold?: number;
    minSpeechDuration?: number;
    minSilenceDuration?: number;
    maxSpeechDuration?: number;
    windowSize?: number;
  }

  export interface VadConfig {
    sileroVad: SileroVadConfig;
    sampleRate: number;
    numThreads?: number;
    debug?: number;
  }

  export interface SpeechSegment {
    samples: Float32Array;
    /** 段起始处在整段音频里的绝对采样序号 */
    start: number;
  }

  export class Vad {
    constructor(config: VadConfig, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    isDetected(): boolean;
    pop(): void;
    front(enableExternalBuffer?: boolean): SpeechSegment;
    flush(): void;
    clear(): void;
    reset(): void;
  }

  export interface OfflineRecognizerConfig {
    featConfig?: { sampleRate: number; featureDim: number };
    modelConfig: {
      // SenseVoice：language 合法取值 auto/zh/en/ja/ko/yue（或空串=auto），由原生校验。
      senseVoice?: { model: string; language?: string; useInverseTextNormalization?: number };
      // Paraformer：单一模型文件。
      paraformer?: { model: string };
      // Transducer：encoder/decoder/joiner 三件套（zipformer / NeMo 通用）。
      transducer?: { encoder: string; decoder: string; joiner: string };
      tokens: string;
      // 模型子类型：NeMo transducer 需设为 'nemo_transducer'；标准 zipformer 由原生自动识别，不设。
      modelType?: string;
      numThreads?: number;
      debug?: number;
    };
  }

  export interface OfflineStream {
    acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
  }

  export interface OfflineResult {
    text: string;
    /** SenseVoice 的语言标记，形如 "<|zh|>" */
    lang: string;
  }

  export class OfflineRecognizer {
    constructor(config: OfflineRecognizerConfig);
    createStream(): OfflineStream;
    decode(stream: OfflineStream): void;
    getResult(stream: OfflineStream): OfflineResult;
  }

  export interface Wave {
    samples: Float32Array;
    sampleRate: number;
  }

  export function readWave(path: string): Wave;
}
