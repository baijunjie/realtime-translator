// 本地翻译 Worker（模块 worker）：在工作线程跑 Transformers.js M2M100，使主线程/UI 不被
// 模型推理阻塞。主线程的 WebLocalTranslator 只做语言码映射 + 繁體 toScript，把实际推理发到这里。
//
// 协议见 ./translate-worker-protocol.ts。串行处理 translate（同一 ORT 会话不可并发）。
/// <reference lib="webworker" />
import { pipeline, env } from '@huggingface/transformers';
import type { ToTranslateWorker, FromTranslateWorker } from './translate-worker-protocol';

// 离线加载：模型由自研下载链路（downloadTranslationModel）预先写入 Transformers.js 的 Cache API
// 缓存（键为 HF resolve URL）。装载时不联网——未缓存则 pipeline() 直接报错，交由上层引导先下载。
env.allowRemoteModels = false;

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

let translate$: TranslationFn | null = null;
let loading: Promise<void> | null = null;
// 串行队列：M2M100 的 ORT 会话不可并发调用，按到达顺序逐条处理。
let chain: Promise<void> = Promise.resolve();

const post = (msg: FromTranslateWorker): void => self.postMessage(msg);

function ensure(modelId: string, dtype: 'q8'): Promise<void> {
  if (translate$) return Promise.resolve();
  if (!loading) {
    loading = pipeline('translation', modelId, {
      dtype,
      // ORT-web 扩展图优化在该 q8 模型上会崩，关掉直接跑原始 QDQ 算子（详见 web-local-translator）。
      session_options: { graphOptimizationLevel: 'disabled' },
    })
      .then((fn) => {
        translate$ = fn as unknown as TranslationFn;
      })
      .catch((e) => {
        // 加载失败复位，允许后续 init/translate 重试；否则缓存的 rejected promise 会永久拒绝。
        loading = null;
        throw e;
      });
  }
  return loading;
}

self.onmessage = (ev: MessageEvent<ToTranslateWorker>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    ensure(msg.modelId, msg.dtype).then(
      () => post({ type: 'ready' }),
      (e: unknown) => post({ type: 'error', id: -1, error: e instanceof Error ? e.message : String(e) })
    );
    return;
  }
  // translate：入串行队列
  chain = chain.then(async () => {
    try {
      await ensure(msg.modelId, msg.dtype);
      if (!translate$) throw new Error('翻译模型未就绪');
      const out = await translate$(msg.text, {
        src_lang: msg.srcLang,
        tgt_lang: msg.tgtLang,
        // ASR 文本易复读：重复惩罚 + 禁重复 3-gram + 长度上限（与 macOS 一致）。
        no_repeat_ngram_size: 3,
        repetition_penalty: 1.3,
        max_new_tokens: 256,
      });
      post({ type: 'result', id: msg.id, text: out[0]?.translation_text ?? '' });
    } catch (e) {
      post({ type: 'error', id: msg.id, error: e instanceof Error ? e.message : String(e) });
    }
  });
};
