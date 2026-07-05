// ASR 模型存取（浏览器端）。
//
// 职责：把 @rt/core 注册表里指定 modelId 的文件（公共依赖 Silero VAD + 该模型自身文件）
// 从 HuggingFace / GitHub Release 拉下来，缓存进 Cache Storage（首次下载后离线可复用），
// 并以「已下载字节 / 总字节」的形式回吐聚合进度（透传给 bridge 的 setupProgressCb）。
//
// 为什么用 Cache Storage 而非 IndexedDB：
//  - 权重个体文件可达数百 MB，Cache Storage 以 Response（流）为单位存储大二进制最自然、内存占用低；
//  - 与 PWA/Service Worker 的缓存模型一致，可被显式管理（caches.open/match/put/delete）。
//
// 注意：模型文件本身**绝不**进仓库，只在运行时按需下载 + 缓存。WASM 侧（worker）拿到这里
// 解出的 ArrayBuffer 后，再 Module.FS.writeFile 进 MEMFS 给 sherpa 用。

import {
  SILERO_VAD,
  getAsrModel,
  requiredAsrFiles,
  type AsrModelFile,
} from '@rt/core';

/** Cache Storage 里存放 ASR 模型的缓存名（强制更新清理应用缓存时须保留）。 */
export const ASR_MODEL_CACHE_NAME = 'realtime-translator-asr-models-v1';

/**
 * 某个 ASR 模型需下载/缓存的完整文件清单：公共依赖 Silero VAD + 该模型自身文件
 * （URL/dir/filename/approxBytes 均取自 @rt/core 注册表）。未知 id 仅返回 VAD（防御，正常不发生）。
 * 各文件的 cacheKey 由 dir+filename 决定（见 cacheKey），故不同模型可共存于同一缓存、互不覆盖。
 */
function modelFiles(modelId: string): AsrModelFile[] {
  return [SILERO_VAD, ...(getAsrModel(modelId)?.files ?? [])];
}

// 浏览器跨源：GitHub Releases 不发 CORS 头（且 302 跳 S3），浏览器 fetch 会被拦。
// Silero VAD 很小（~0.6MB）且其自托管源为 GitHub release（浏览器取不到），故随应用同源托管在
// public/models/（同源无 CORS、可即时离线），此覆盖优先级最高、也是 VAD 的唯一 web 源。
// 各模型权重按端分源：web 走注册表里发 CORS 头的上游源（file.webUrl）。
const SAME_ORIGIN_BUNDLED: Record<string, string> = {
  'silero_vad.onnx': `${import.meta.env.BASE_URL}models/silero_vad.onnx`,
};

/**
 * 浏览器端某文件的 web 下载源有序列表（下载器按序 fallback、每个只试一次）：同源托管覆盖置于**首位**
 * （VAD，最快且可离线），其后接注册表的上游 web 源 file.webUrls（HF 主源 + 镜像）。空列表表示无 web
 * 端下载源（正常不可达——platforms 过滤已挡住 macOS 专属模型，downloadIntoCache 会报明确错误）。
 */
function resolveUrls(file: AsrModelFile): string[] {
  const sameOrigin = SAME_ORIGIN_BUNDLED[file.filename];
  return [...(sameOrigin ? [sameOrigin] : []), ...file.webUrls];
}

/** 聚合下载进度（与 @rt/core SetupProgress 同形）。 */
export interface DownloadProgress {
  /** 已下载字节（已缓存命中的文件按其声明大小计入） */
  loaded: number;
  /** 总字节（各文件 approxBytes 之和，作为分母；不精确但足够做进度条） */
  total: number;
}

/** 某个模型文件在 WASM FS 里应使用的扁平文件名（不带子目录，便于 recognizer 直接引用）。 */
export function fsName(file: AsrModelFile): string {
  return file.filename;
}

/** Cache Storage 里某文件的稳定 key（用文件的相对路径，避免重名冲突）。 */
function cacheKey(file: AsrModelFile): string {
  // 用一个站内绝对路径作 Request key（同源），与真实远程 URL 解耦，便于版本管理。
  const rel = file.dir ? `${file.dir}/${file.filename}` : file.filename;
  return `/__realtime-translator-asr__/${rel}`;
}

/** 指定模型全部文件（含 VAD）的 approxBytes 之和，作为进度分母。 */
function totalBytes(modelId: string): number {
  return modelFiles(modelId).reduce((sum, f) => sum + f.approxBytes, 0);
}

/** 检查指定模型所需文件（含公共依赖 VAD）是否都已在 Cache Storage 中（用于 getSetupStatus）。 */
export async function areModelsCached(modelId: string): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  // 未知 id 必须判「未就绪」：modelFiles 对未知 id 只返回公共依赖 VAD，
  // 仅按缓存命中判断会误报就绪，随后识别 worker 构造时才以「未知的识别模型」失败。
  if (!getAsrModel(modelId)) return false;
  try {
    const cache = await caches.open(ASR_MODEL_CACHE_NAME);
    // 仅判存在性：用 cache.keys()（返回 Request，只有 URL、无 body）取全部条目 URL 做成员判断，
    // 而非逐文件 cache.match()。cache.match() 返回 Response，其 body 绑定到数百 MB 权重条目，
    // 移动端 WebKit 会将其读入内存——反复进入模型管理页探测会累积成内存尖峰乃至标签页崩溃；
    // 存在性判断无需 body，keys() 即可。cache.put 存入的键即 new Request(cacheKey).url，故按此归一化比对。
    const cachedUrls = new Set((await cache.keys()).map((req) => req.url));
    return modelFiles(modelId).every((file) => cachedUrls.has(new Request(cacheKey(file)).url));
  } catch {
    return false;
  }
}

// 并行下载去重（键为 Cache 键）：多个 ASR 模型共享同一文件（Silero VAD）时只真正下一次，
// 其余并发下载等它完成后按缓存命中计入，避免重复下载与「一路失败 cache.delete 掉另一路成果」的竞态。
// 条目在页面会话内保留（极少）；文件已缓存时上层 cache.match 先命中，不会走到这里。
const sharedCacheDownloads = new Map<string, Promise<void>>();

/**
 * 确保所有模型已下载并缓存。已缓存的文件跳过下载（但其大小计入已完成进度）。
 * onProgress 以聚合字节回吐（loaded/total）；total 为各文件 approxBytes 之和。
 *
 * 跨域说明：单线程 WASM 构建不需要 COOP/COEP，因此对 HF/GitHub 的普通 `fetch` 即可，
 * 无需 credentialless 处理，响应也能正常进 Cache Storage。
 */
export async function ensureModelsCached(
  modelId: string,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof caches === 'undefined') {
    throw new Error('Cache Storage 不可用，无法缓存 ASR 模型');
  }
  const cache = await caches.open(ASR_MODEL_CACHE_NAME);
  const total = totalBytes(modelId);
  // 已完成字节按「文件粒度」累计：未开始的文件实时累加其流式进度，
  // 完成/命中的文件按 approxBytes 计入 base。
  let completedBase = 0;

  for (const file of modelFiles(modelId)) {
    // 用户取消（外部 signal）：不再开始下一个文件，直接抛出中止（在途文件由 fetchIntoCache 清理，
    // 已完成文件由 cancelModelDownload 的整体删除兜底）。
    if (signal?.aborted) throw new DOMException('下载已取消', 'AbortError');
    const key = cacheKey(file);
    if (await cache.match(key)) {
      completedBase += file.approxBytes;
      onProgress?.({ loaded: completedBase, total });
      continue;
    }
    // 并行去重：另一模型已在下同一文件（VAD）→ 等它完成，已缓存则计入并跳过；它失败（未缓存）则本路自己下。
    const inflight = sharedCacheDownloads.get(key);
    if (inflight) {
      await inflight;
      if (await cache.match(key)) {
        completedBase += file.approxBytes;
        onProgress?.({ loaded: completedBase, total });
        continue;
      }
    }

    // 本路负责下载：登记 promise（不抛版）供并发的其它模型等待；本路自身 await 原始 promise 以感知失败。
    const p = downloadIntoCache(
      cache,
      key,
      file,
      (fileLoaded) => {
        onProgress?.({ loaded: completedBase + fileLoaded, total });
      },
      signal,
    );
    sharedCacheDownloads.set(key, p.then(() => undefined, () => undefined));
    await p;
    completedBase += file.approxBytes;
    onProgress?.({ loaded: completedBase, total });
  }

  onProgress?.({ loaded: total, total });
}

/**
 * 取出指定模型已缓存的字节（用于写入 WASM FS）。返回 fsName → Uint8Array 映射。
 * 若有文件缺失则抛错（调用方应先 ensureModelsCached）。
 */
export async function readCachedModels(modelId: string): Promise<Map<string, Uint8Array>> {
  if (typeof caches === 'undefined') {
    throw new Error('Cache Storage 不可用');
  }
  const cache = await caches.open(ASR_MODEL_CACHE_NAME);
  const out = new Map<string, Uint8Array>();
  for (const file of modelFiles(modelId)) {
    const hit = await cache.match(cacheKey(file));
    if (!hit) {
      throw new Error(`模型文件缺失（未缓存）: ${file.filename}`);
    }
    const buf = await hit.arrayBuffer();
    out.set(fsName(file), new Uint8Array(buf));
  }
  return out;
}

/**
 * 从 Cache Storage 删除指定 ASR 模型「自身文件」的缓存条目；公共依赖 Silero VAD 保留
 * （其他模型仍需用它，也避免整库删除误伤）。按文件逐条删除，不删整个缓存。
 */
export async function deleteAsrModelFromCache(modelId: string): Promise<void> {
  if (typeof caches === 'undefined') return;
  const cache = await caches.open(ASR_MODEL_CACHE_NAME);
  const files = getAsrModel(modelId)?.files ?? [];
  await Promise.all(files.map((f) => cache.delete(cacheKey(f))));
}

/** 已缓存文件的相对路径清单（与 @rt/core requiredAsrFiles 对齐，调试用）。 */
export function modelFileList(modelId: string): string[] {
  return requiredAsrFiles(modelId);
}

// 无进展看门狗超时：连续这么久没收到任何新字节即判定连接停滞并中止本次下载。
// 「无进展超时」而非「总时长超时」——大文件慢速下载合法，只在字节流真正停滞时触发。
const STALL_TIMEOUT_MS = 30_000;

/**
 * 下载单个文件并写入 Cache Storage：按 resolveUrls 给出的有序 web 源（同源覆盖 + 上游 + 镜像）依次尝试、
 * 每个只试一次，成功即返回，全部失败才抛聚合错误。单源写入/清理由 fetchIntoCache 负责（失败会删缓存条目），
 * 故换源不残留半截缓存。无 web 源时报明确错误（正常不可达，见 resolveUrls）。
 */
async function downloadIntoCache(
  cache: Cache,
  key: string,
  file: AsrModelFile,
  onFileProgress: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const urls = resolveUrls(file);
  if (urls.length === 0) {
    throw new Error(`该模型无 web 端下载源: ${file.filename}`);
  }
  const errors: string[] = [];
  for (const url of urls) {
    try {
      await fetchIntoCache(cache, key, url, file, onFileProgress, signal);
      return;
    } catch (err) {
      // 用户取消：立即停止，不再尝试后续源（否则会拿已 abort 的 signal 空转一轮）。
      if (signal?.aborted) throw err;
      errors.push(`${url} → ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`下载失败（全部源均不可用） ${file.filename}:\n${errors.join('\n')}`);
}

/**
 * 从单一 URL 流式下载并写入 Cache Storage：res.body.tee() 双分支，一支直接作为
 * Response 体交给 cache.put 边下边落缓存，另一支只统计字节数回吐单文件进度——
 * 全程不在 JS 堆里聚合完整文件，内存峰值与文件大小无关（网络是瓶颈，两支都按
 * 网络速率消费，tee 的内部缓冲不会堆积）。
 * cache.put 的体流中途出错时按规范不会写入条目，失败不会留下半截缓存。
 * 字节流停滞（TCP 静默断开、无 RST）时由无进展看门狗 abort，交给失败→重试 UI 接管。
 */
async function fetchIntoCache(
  cache: Cache,
  key: string,
  url: string,
  file: AsrModelFile,
  onFileProgress: (loaded: number) => void,
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
  // stalled 保持 false，故走「取消/一般错误」分支而非「下载停滞」文案。
  const onExternalAbort = (): void => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  armWatchdog(); // 连接/响应头阶段也受同一 signal 约束
  try {
    const res = await fetch(url, {
      mode: 'cors',
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`下载失败 ${file.filename}: HTTP ${res.status}`);
    }

    // 无法读 body 流：退化为整体读取，进度按 approxBytes 兜底。
    // 无逐块事件可喂看门狗，先解除以免大文件整体读取被误判停滞。
    if (!res.body) {
      clearTimeout(watchdog);
      watchdog = undefined;
      const buf = await res.arrayBuffer();
      await cache.put(key, new Response(buf));
      onFileProgress(file.approxBytes);
      return;
    }

    const [cacheStream, progressStream] = res.body.tee();

    // 进度分支：只计数、不保留数据；收到新字节即重置无进展计时。
    const trackProgress = async (): Promise<void> => {
      const reader = progressStream.getReader();
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          received += value.length;
          armWatchdog();
          // 单文件进度用真实已收字节，但封顶到 approxBytes，避免超过分母里该文件的份额。
          onFileProgress(Math.min(received, file.approxBytes));
        }
      }
    };

    try {
      await Promise.all([cache.put(key, new Response(cacheStream)), trackProgress()]);
    } catch (err) {
      // 任一支失败（网络中断/写缓存失败/看门狗 abort）：取消两支释放资源（已被锁定的流返回
      // rejected promise，allSettled 吞掉即可），并兜底删除可能存在的缓存条目。
      await Promise.allSettled([cacheStream.cancel(), progressStream.cancel()]);
      await cache.delete(key).catch(() => undefined);
      throw err;
    }
  } catch (err) {
    // 看门狗触发的 abort 转成明确的停滞错误，交给上层失败→重试 UI 接管。
    // 外部取消（signal.aborted）不改文案，按 AbortError 原样上抛，由 downloadIntoCache/管理器识别为取消。
    if (stalled && !signal?.aborted) throw new Error(`下载停滞，请检查网络后重试: ${file.filename}`);
    throw err;
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}
