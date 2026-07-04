// @rt/core 公共出口：平台无关的领域类型、纯逻辑与端口契约。
export * from './types';
export * from './callbacks';
export * from './settings';
export * from './archive';
export * from './ports';
export * from './bridge';
export * from './model-sources';
export * from './model-registry';
export * from './models';

// ASR 实时转写管线（切段策略 + 文本清理；推理引擎由各端注入）
export * from './asr/transcription-pipeline';

// 翻译
export * from './translation/translator';
export * from './translation/cloud-translator';
export * from './translation/local-spec';
export * from './translation/segment-translation';
