// 浏览器端本地翻译模型的下载与缓存（与 ASR 一致的自研下载链路）。
//
// 把 @rt/core 注册表里指定翻译模型的全部文件从「下载源 URL」拉下来，以「Transformers.js 将要请求
// 的缓存键」写入 Cache Storage，之后翻译 Worker 以 allowRemoteModels=false 离线加载。
//
// 下载源 URL 与缓存键解耦（这是本模块的关键）：
//  - 下载源 = spec.files[].webUrl（web 端专用上游 HF resolve 直链；按端分源，web 不走自托管 url）。
//  - 缓存键 = Transformers.js 浏览器端对该文件实际发起请求时用的键。查证 @huggingface/transformers
//    的 src/utils/hub.js（buildResourcePaths）：非 FileCache（浏览器原生 Cache）时
//    proposedCacheKey = remoteURL = env.remoteHost + '{model}/resolve/{revision}/' + 文件路径，
//    默认 remoteHost='https://huggingface.co/'、revision='main'。存进这个键，离线加载才能命中。
//  对 m2m100 下载源与缓存键恰好同为 HF URL；缓存键始终按 modelId 构造成 HF 目录式布局，与下载源无关。

import {
  TRANSFORMERS_REMOTE_HOST,
  type LocalModelSpec,
  type LocalModelFile,
} from '@rt/core';

// Transformers.js（本项目 v4）浏览器端默认用 Cache API 缓存模型，缓存名取 env.cacheKey，默认即此值
// （本项目未改）。forceUpdateApp 清应用外壳缓存时须保留此缓存。
export const TRANSFORMERS_CACHE_NAME = 'transformers-cache';

/** 聚合下载进度（与 @rt/core SetupProgress 同形）。 */
export interface DownloadProgress {
  loaded: number;
  total: number;
}

/**
 * 某文件在 Transformers.js 缓存里的键：其 HF resolve URL（由 modelId + 缓存布局相对路径构造，
 * 与下载源 URL 无关）。离线加载时 Transformers.js 用同一键 cache.match，故必须一致。
 */
function cacheKey(modelId: string, file: LocalModelFile): string {
  const rel = file.dir ? `${file.dir}/${file.filename}` : file.filename;
  // 缓存键主机恒用 Transformers.js 默认 remoteHost（不可变，见 @rt/core model-sources 的
  // TRANSFORMERS_REMOTE_HOST）——与可切换镜像的下载源严格分离，否则离线加载 cache.match 落空。
  return `${TRANSFORMERS_REMOTE_HOST}${modelId}/resolve/main/${rel}`;
}

/**
 * 指定本地翻译模型是否已缓存（全部文件条目齐备）。Cache API 不可用或查询异常
 * 时返回 false（宁可多提示一次下载，命中缓存会瞬间完成，也不误判为已就绪而加载失败）。
 */
export async function isTranslationModelCached(spec: LocalModelSpec): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  try {
    const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
    // 仅判存在性：用 cache.keys()（返回 Request，只有 URL、无 body）取全部条目 URL 做成员判断，
    // 而非逐文件 cache.match()。cache.match() 返回 Response，其 body 绑定到数百 MB 权重条目，
    // 移动端 WebKit 会将其读入内存——反复进入模型管理页探测会累积成内存尖峰乃至标签页崩溃；
    // 存在性判断无需 body，keys() 即可。缓存键即 HF resolve URL（与 Transformers.js 存入的键一致）。
    //
    // spec 的**全部**文件条目都在才算就绪：Cache Storage 按条目逐出，离线加载
    // （allowRemoteModels=false）缺任一文件（含 tokenizer/config 小文件）都会失败，
    // 只查权重会把部分逐出误判为已就绪、且就绪后 UI 不再提供补下载入口。
    const cachedUrls = new Set((await cache.keys()).map((req) => req.url));
    return spec.files.every((f) => cachedUrls.has(new Request(cacheKey(spec.modelId, f)).url));
  } catch {
    return false;
  }
}

/**
 * 确保指定本地翻译模型的全部文件已下载并缓存。已缓存的文件跳过（按条目粒度）。
 * onProgress 以聚合字节回吐（loaded/total）；total 取 spec.approxDownloadBytes（各文件不单独记大小），
 * loaded 跨文件累计。收尾贴到满格（各文件实收合计与近似分母有出入）。
 */
export async function ensureTranslationModelCached(
  spec: LocalModelSpec,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof caches === 'undefined') {
    throw new Error('Cache Storage 不可用，无法缓存翻译模型');
  }
  const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
  const total = spec.approxDownloadBytes;
  let base = 0; // 已完成文件的累计实收字节

  for (const file of spec.files) {
    // 用户取消：不再开始下一个文件，直接抛出中止（已完成文件由 cancelModelDownload 整体删除兜底）。
    if (signal?.aborted) throw new DOMException('下载已取消', 'AbortError');
    const key = cacheKey(spec.modelId, file);
    if (await cache.match(key)) continue; // 已缓存：跳过（其字节份额由收尾贴满兜底）
    let last = 0;
    await downloadIntoCache(
      cache,
      key,
      file,
      (received) => {
        last = received;
        onProgress?.({ loaded: Math.min(base + received, total), total });
      },
      signal,
    );
    base += last;
  }

  onProgress?.({ loaded: total, total });

  if (!(await isTranslationModelCached(spec))) {
    throw new Error('翻译模型安装后校验失败');
  }
}

/**
 * 从 Cache Storage 删除属于指定本地翻译模型的全部缓存条目：按 URL 含 modelId 逐条删，
 * 不清整个缓存（同缓存名可能存放其它模型/资源），也覆盖到本清单外的任何残留条目。
 * 删后对应翻译器实例须置空重建。
 */
export async function deleteTranslationModelFromCache(spec: LocalModelSpec): Promise<void> {
  if (typeof caches === 'undefined') return;
  const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
  const keys = await cache.keys();
  await Promise.all(
    keys.filter((req) => req.url.includes(spec.modelId)).map((req) => cache.delete(req)),
  );
}

// 无进展看门狗超时：连续这么久没收到任何新字节即判定连接停滞并中止本次下载。
// 「无进展超时」而非「总时长超时」——大文件慢速下载合法，只在字节流真正停滞时触发。
const STALL_TIMEOUT_MS = 30_000;

/**
 * 下载单个文件并以 key 写入 Cache Storage：按注册表上游有序源 file.webUrls（HF 主源 + 镜像，发 CORS 头）
 * 依次尝试、每个只试一次，成功即返回，全部失败才抛聚合错误。单源写入/清理由 fetchIntoCache 负责（失败会删
 * 缓存条目），故换源不残留半截缓存。webUrls 为空时报明确错误（正常不可达——platforms 过滤已挡住 macOS 专属模型如 1.2B）。
 */
async function downloadIntoCache(
  cache: Cache,
  key: string,
  file: LocalModelFile,
  onFileProgress: (received: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const urls = file.webUrls;
  if (urls.length === 0) {
    throw new Error(`该模型无 web 端下载源: ${file.filename}`);
  }
  const errors: string[] = [];
  for (const url of urls) {
    try {
      await fetchIntoCache(cache, key, url, file, onFileProgress, signal);
      return;
    } catch (err) {
      // 用户取消：立即停止，不再尝试后续源。
      if (signal?.aborted) throw err;
      errors.push(`${url} → ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`下载失败（全部源均不可用） ${file.filename}:\n${errors.join('\n')}`);
}

/**
 * 从单一 URL 流式下载并以 key 写入 Cache Storage：res.body.tee() 双分支，一支直接作为 Response
 * 体交给 cache.put 边下边落缓存，另一支只统计字节数回吐单文件进度——全程不在 JS 堆里聚合完整文件，
 * 内存峰值与文件大小无关。cache.put 的体流中途出错时按规范不写入条目，失败不留半截缓存。
 * 字节流停滞时由无进展看门狗 abort，交给失败→重试 UI 接管。
 */
async function fetchIntoCache(
  cache: Cache,
  key: string,
  url: string,
  file: LocalModelFile,
  onFileProgress: (received: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  let stalled = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const armWatchdog = (): void => {
    if (watchdog !== undefined) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, STALL_TIMEOUT_MS);
  };

  // 用户取消（外部 signal）与内部停滞看门狗合流：外部 abort 触发内部 controller.abort()。
  const onExternalAbort = (): void => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  armWatchdog(); // 连接/响应头阶段也受同一 signal 约束
  try {
    const res = await fetch(url, { mode: 'cors', redirect: 'follow', signal: controller.signal });
    if (!res.ok) {
      throw new Error(`下载失败 ${file.filename}: HTTP ${res.status}`);
    }

    // 无法读 body 流：退化为整体读取（无逐块事件喂看门狗，先解除以免大文件整体读取被误判停滞）。
    if (!res.body) {
      clearTimeout(watchdog);
      watchdog = undefined;
      const buf = await res.arrayBuffer();
      await cache.put(key, new Response(buf));
      onFileProgress(buf.byteLength);
      return;
    }

    const [cacheStream, progressStream] = res.body.tee();

    const trackProgress = async (): Promise<void> => {
      const reader = progressStream.getReader();
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          received += value.length;
          armWatchdog(); // 收到新字节即重置无进展计时
          onFileProgress(received);
        }
      }
    };

    try {
      await Promise.all([cache.put(key, new Response(cacheStream)), trackProgress()]);
    } catch (err) {
      // 任一支失败：取消两支释放资源，并兜底删除可能存在的缓存条目。
      await Promise.allSettled([cacheStream.cancel(), progressStream.cancel()]);
      await cache.delete(key).catch(() => undefined);
      throw err;
    }
  } catch (err) {
    // 外部取消（signal.aborted）不改文案，按 AbortError 原样上抛，由上层识别为取消。
    if (stalled && !signal?.aborted) throw new Error(`下载停滞，请检查网络后重试: ${file.filename}`);
    throw err;
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}
