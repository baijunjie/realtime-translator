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
  browserDownloadUrls,
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
// Silero VAD 很小（~0.6MB）且其主源与上游均为 GitHub release（浏览器都取不到），故随应用
// 同源托管在 public/models/（同源无 CORS、可即时离线），此覆盖优先级最高。
// 各模型权重的自托管主源同样是 GitHub（web 取不到），由 browserDownloadUrls 跳过、改走上游 fallback。
const SAME_ORIGIN_BUNDLED: Record<string, string> = {
  'silero_vad.onnx': `${import.meta.env.BASE_URL}models/silero_vad.onnx`,
};

/**
 * 浏览器可依次尝试的 fetch 源（按优先级）：同源托管覆盖最高；其余按 browserDownloadUrls
 * 决策（GitHub 主源无 CORS 必跳过、改走上游 fallback；主源非 GitHub 则先主源后 fallback）。
 * 空数组表示浏览器端无可用源（downloadIntoCache 会报明确错误）。
 */
function resolveUrls(file: AsrModelFile): string[] {
  const bundled = SAME_ORIGIN_BUNDLED[file.filename];
  const remote = browserDownloadUrls(file.url, file.fallbackUrl);
  return bundled ? [bundled, ...remote] : remote;
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
  try {
    const cache = await caches.open(ASR_MODEL_CACHE_NAME);
    for (const file of modelFiles(modelId)) {
      const hit = await cache.match(cacheKey(file));
      if (!hit) return false;
    }
    return true;
  } catch {
    return false;
  }
}

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
    const key = cacheKey(file);
    const cached = await cache.match(key);
    if (cached) {
      completedBase += file.approxBytes;
      onProgress?.({ loaded: completedBase, total });
      continue;
    }

    await downloadIntoCache(cache, key, file, (fileLoaded) => {
      onProgress?.({ loaded: completedBase + fileLoaded, total });
    });
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
 * 下载单个文件并写入 Cache Storage：依次尝试 resolveUrls 的候选源（主源失败或停滞时回退到
 * 下一候选，全部失败才抛错）。回退重试会以新连接从头下载，onFileProgress 从 0 重新计数
 * （聚合进度里该文件的份额回退再爬升，是同文件重下的正确表现）。
 */
async function downloadIntoCache(
  cache: Cache,
  key: string,
  file: AsrModelFile,
  onFileProgress: (loaded: number) => void,
): Promise<void> {
  const urls = resolveUrls(file);
  if (urls.length === 0) {
    throw new Error(`浏览器端无可用下载源: ${file.filename}`);
  }
  let lastErr: unknown;
  for (const url of urls) {
    try {
      await fetchIntoCache(cache, key, url, file, onFileProgress);
      return;
    } catch (err) {
      lastErr = err; // 还有候选源则继续回退重试；否则抛出末次错误
    }
  }
  throw lastErr;
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
    if (stalled) throw new Error(`下载停滞，请检查网络后重试: ${file.filename}`);
    throw err;
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
  }
}
