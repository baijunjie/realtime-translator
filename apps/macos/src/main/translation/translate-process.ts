// 翻译子进程（ELECTRON_RUN_AS_NODE 的纯 Node 进程，经 child_process.fork 启动）。
// 把翻译模型(transformers.js + onnxruntime-node)隔离到独立进程：原生崩溃、超大内存
// 分配都被隔离在这里，翻译进程即便挂掉也不连累主窗口，主进程会在下次翻译时自动重启它。
// 必须脱离 Electron 的 utilityProcess：后者挂着 Chromium 的内存分配器，翻译模型推理时
// 的超大分配（约 870MB 及以上）会触发分配器对巨型分配的 abort（EXC_BREAKPOINT）而崩溃；
// 纯 Node 用系统 malloc 无此限制，故这里以标准 Node IPC（process.send / process.on）通信。
import { createTranslator, type Translator } from './translator';
import type {
  MainToTranslate,
  TranslateToMain,
  TranslationEngine,
  CloudTranslationConfig,
} from '../../shared/types';

let translator: Translator | null = null;
let ready: Promise<void> | null = null;
let config: { engine: TranslationEngine; cloud: CloudTranslationConfig; cacheDir: string } | null = null;

function post(msg: TranslateToMain): void {
  process.send!(msg);
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
    // 装载：把已下载的本地模型载入内存（未缓存则 init 直接报错，不联网），或云端引擎懒初始化。
    // 本进程只负责装载与推理（下载由主进程的自研下载链路完成），故仅上报 loading/ready/error 状态。
    ready = instance
      .init()
      .then(() => post({ type: 'status', payload: { state: 'ready' } }))
      .catch((err) => {
        ready = null; // 允许下次重试
        post({ type: 'status', payload: { state: 'error', error: (err as Error).message } });
        throw err;
      });
  }
  return ready.then(() => instance);
}

process.on('message', (msg: MainToTranslate) => {
  switch (msg.type) {
    case 'configure':
      // 配置变更：丢弃旧翻译器，下次按新配置重建
      config = { engine: msg.engine, cloud: msg.cloud, cacheDir: msg.cacheDir };
      translator = null;
      ready = null;
      break;
    case 'preheat':
      // 仅装载模型入内存（降低首句翻译延迟）；补发 ready 使装载状态明确终结。
      // 首次预热会与 ensure 内部的 ready 重复一次，UI 幂等，无害。
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
