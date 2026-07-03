// 翻译工厂（macOS）：上层（main/pipeline/渲染）只依赖 Translator 接口，
// 具体用哪个本地模型 / 云 API 由工厂决定，方便以后替换。
// Translator 接口、TranslateProgress、CloudTranslator 均来自 @rt/core；
// 本地 LocalTranslator 依赖原生模块，留在 macOS。
import { createLocalTranslator } from './local-translator';
import { CloudTranslator, type Translator, type TranslateProgress } from '@rt/core';
import type { CloudTranslationConfig, TranslationEngine } from '../../shared/types';

// 透传 core 的契约类型，保持既有 `from './translator'` 的 import 路径可用。
export type { Translator, TranslateProgress };

export interface TranslatorConfig {
  /** 引擎：本地模型（注册表 id，如 m2m100 / mbart50）或云端 */
  backend: TranslationEngine;
  /** [本地] 模型缓存目录（首次下载后离线复用） */
  cacheDir?: string;
  /** [cloud] OpenAI 兼容端点配置 */
  cloud?: CloudTranslationConfig;
}

export function createTranslator(cfg: TranslatorConfig): Translator {
  if (cfg.backend === 'cloud') {
    if (!cfg.cloud) {
      throw new Error('云翻译缺少配置');
    }
    return new CloudTranslator(cfg.cloud);
  }
  if (!cfg.cacheDir) {
    throw new Error('本地翻译缺少 cacheDir');
  }
  return createLocalTranslator(cfg.backend, cfg.cacheDir);
}
