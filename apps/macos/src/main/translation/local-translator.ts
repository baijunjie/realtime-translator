// 本地翻译通用实现：Transformers.js 跑 seq2seq 翻译模型（onnxruntime-node，纯本地，Node 专用）。
// 模型的差异全部收敛到「LocalModelSpec」这份数据里——新增本地模型只需加一份 spec，
// 翻译流程（懒加载 / 缓存判定 / 语言码映射 / 简繁脚本回退）完全通用，做到优雅插拔。
// 模型规格 / 语言映射 / 简繁归一化是平台无关的，已下沉到 @rt/core，这里只保留依赖原生模块的执行层。
import { pipeline, env } from '@huggingface/transformers';
import { getTranslationModel, type LocalModelSpec, type Translator } from '@rt/core';
import { localModelCached } from './model-cache';
import type { LocalEngine } from '../../shared/types';

/** 某本地引擎的模型规格；未知引擎抛错（应由校验层拦住）。 */
function localSpecFor(engine: LocalEngine): LocalModelSpec {
  const spec = getTranslationModel(engine);
  if (!spec) {
    throw new Error(`未知的本地翻译模型: ${engine}`);
  }
  return spec;
}

// pipeline() 返回的可调用对象：输入文本 + 源/目标语言码，输出 [{ translation_text }]
type TranslationFn = (
  text: string,
  opts: {
    src_lang: string;
    tgt_lang: string;
    no_repeat_ngram_size?: number;
    repetition_penalty?: number;
    max_new_tokens?: number;
  }
) => Promise<Array<{ translation_text: string }>>;

class LocalTranslator implements Translator {
  private translate$: TranslationFn | null = null;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly spec: LocalModelSpec,
    private readonly cacheDir: string
  ) {
    env.cacheDir = cacheDir;
    // 离线加载：模型由自研下载链路（translation:download）预先落盘，装载时不联网。
    // 未缓存则在 init 里显式报错（录音前检查会引导先下载），绝不在此静默联网拉取大模型。
    env.allowRemoteModels = false;
  }

  /** 取某 app 语言在本模型下的处理项，未知语言回退 */
  private entry(lang?: string): LocalModelSpec['langs'][string] {
    return this.spec.langs[lang ?? ''] ?? this.spec.langs[this.spec.fallbackLang];
  }

  /** 模型是否已完整缓存（残缺缓存视为未缓存） */
  private isCached(): boolean {
    return localModelCached(this.cacheDir, this.spec);
  }

  init(): Promise<void> {
    if (this.translate$) return Promise.resolve();
    if (!this.loading) {
      // 未缓存：不联网下载（allowRemoteModels=false 也会拒绝），直接报错交由上层引导下载。
      if (!this.isCached()) {
        return Promise.reject(new Error('本地翻译模型未下载，请先在模型管理页下载'));
      }
      // 已缓存：把模型从磁盘载入内存（离线，不报字节进度）。
      this.loading = pipeline('translation', this.spec.modelId, { dtype: this.spec.dtype })
        .then((fn) => {
          this.translate$ = fn as unknown as TranslationFn;
        })
        .catch((e) => {
          // 加载失败复位，允许重试；否则缓存的 rejected promise 会让后续 init 永久失败
          this.loading = null;
          throw e;
        });
    }
    return this.loading;
  }

  async translate(text: string, opts: { source?: string; target: string }): Promise<string> {
    if (!text.trim()) return text;
    const src = this.entry(opts.source);
    const tgt = this.entry(opts.target);

    // 模型层面同语言：无需经模型；但若目标需脚本后处理（如 M2M100 简体语音→繁體目标）仍要转换
    if (src.code === tgt.code) {
      return tgt.toScript ? tgt.toScript(text) : text;
    }

    await this.init();
    if (!this.translate$) {
      throw new Error('翻译模型未就绪');
    }
    const out = await this.translate$(text, {
      src_lang: src.code,
      tgt_lang: tgt.code,
      // 杂乱的 ASR 文本容易让模型陷入复读，加重复惩罚 + 禁止重复 3-gram + 长度上限兜底
      no_repeat_ngram_size: 3,
      repetition_penalty: 1.3,
      max_new_tokens: 256,
    });
    const result = out[0]?.translation_text ?? '';
    return tgt.toScript ? tgt.toScript(result) : result;
  }
}

/** 按引擎 id 创建本地翻译器 */
export function createLocalTranslator(engine: LocalEngine, cacheDir: string): Translator {
  return new LocalTranslator(localSpecFor(engine), cacheDir);
}
