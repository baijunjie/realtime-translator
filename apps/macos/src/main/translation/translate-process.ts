// 翻译子进程（Electron utilityProcess，完整 Node）。
// 把翻译模型(transformers.js + onnxruntime-node)隔离到独立进程：原生崩溃、超大内存
// 分配（如 NLLB 反量化的 ~1GB 分配在主进程会被 Chromium 分配器直接 abort）都被隔离在
// 这里，翻译进程即便挂掉也不连累主窗口，主进程会在下次翻译时自动重启它。
import { createTranslator, type Translator } from './translator';
import { localSpecFor } from './local-translator';
import { createTranslateProgressAggregator } from '@rt/core';
import type {
  MainToTranslate,
  TranslateToMain,
  TranslationEngine,
  CloudTranslationConfig,
} from '../../shared/types';

const parentPort = process.parentPort;

let translator: Translator | null = null;
let ready: Promise<void> | null = null;
let config: { engine: TranslationEngine; cloud: CloudTranslationConfig; cacheDir: string } | null = null;

function post(msg: TranslateToMain): void {
  parentPort.postMessage(msg);
}

function build(): Translator {
  if (!config) {
    throw new Error('翻译器未配置');
  }
  if (config.engine === 'cloud') {
    return createTranslator({ backend: 'cloud', cloud: config.cloud });
  }
  return createTranslator({ backend: config.engine, cacheDir: config.cacheDir });
}

/** 懒加载翻译器，并把加载/下载进度报回主进程；重复调用幂等 */
function ensure(): Promise<Translator> {
  if (!translator) {
    try {
      translator = build();
    } catch (err) {
      // 构造期错误（如主进程与本产物版本错位导致的未知引擎 id）：报引擎级错误并拒绝本次
      // 请求。若任由异常从消息回调逃逸，子进程会整个崩掉并被主进程反复重启（崩溃循环）。
      post({ type: 'status', payload: { state: 'error', error: (err as Error).message } });
      return Promise.reject(err);
    }
  }
  const instance = translator;
  if (!ready) {
    post({ type: 'status', payload: { state: 'loading' } });
    // 模型由多个文件并行下载，经聚合器换成按字节聚合的总进度 + 各文件独立进度，避免逐文件来回跳；
    // 本地引擎用 spec 的近似总字节预置分母，总进度不因文件陆续注册而回落（cloud 无进度事件，不预置）
    const aggregate = createTranslateProgressAggregator(
      config && config.engine !== 'cloud' ? localSpecFor(config.engine).approxDownloadBytes : undefined,
    );
    ready = instance
      .init((p) => {
        const agg = aggregate(p);
        if (agg) {
          post({ type: 'status', payload: { state: 'loading', progress: agg.progress, files: agg.files } });
        }
      })
      .then(() => post({ type: 'status', payload: { state: 'ready' } }))
      .catch((err) => {
        ready = null; // 允许下次重试
        post({ type: 'status', payload: { state: 'error', error: (err as Error).message } });
        throw err;
      });
  }
  return ready.then(() => instance);
}

parentPort.on('message', (e: { data: MainToTranslate }) => {
  const msg = e.data;
  switch (msg.type) {
    case 'configure':
      // 配置变更：丢弃旧翻译器，下次按新配置重建
      config = { engine: msg.engine, cloud: msg.cloud, cacheDir: msg.cacheDir };
      translator = null;
      ready = null;
      break;
    case 'preheat':
      // ensure 已就绪时不再自发状态；补发 ready 使显式下载（translation:download）的等待者必然兑现。
      // 首次预热会与 ensure 内部的 ready 重复一次，UI 与等待者均幂等，无害。
      ensure()
        .then(() => post({ type: 'status', payload: { state: 'ready' } }))
        .catch(() => {});
      break;
    case 'translate':
      ensure()
        .then((t) => t.translate(msg.text, { source: msg.source, target: msg.target }))
        .then((text) => post({ type: 'result', id: msg.id, text }))
        // 带 id 上报失败，让主进程 reject 对应的在途请求（引擎级失败已由 ensure 内部走 status）
        .catch((err) => post({ type: 'error', id: msg.id, message: (err as Error).message }));
      break;
  }
});
