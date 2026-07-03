// 主线程 (web-local-translator) 与本地翻译 Worker (translate-worker) 的消息协议（type-only）。

/** 主线程 → Worker。 */
export type ToTranslateWorker =
  // 预热/加载模型（可选；translate 也会按需懒加载）。
  | { type: 'init'; modelId: string; dtype: 'q8' }
  // 翻译一条；id 用于和结果对应。srcLang/tgtLang 为模型语言码（如 zh/en/ja/ko）。
  | { type: 'translate'; id: number; text: string; srcLang: string; tgtLang: string; modelId: string; dtype: 'q8' };

/** Worker → 主线程。 */
export type FromTranslateWorker =
  // 模型就绪（响应 init）。
  | { type: 'ready' }
  // 翻译结果。
  | { type: 'result'; id: number; text: string }
  // 出错（id=-1 表示初始化错误）。
  | { type: 'error'; id: number; error: string };
