// 运行时下载 ASR 模型（方案 B：不打包，首次启动/按需联网下载）。
// 每个模型只下其注册表登记的文件（多为 int8 量化版），另加所有模型共用的 Silero VAD 依赖。
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { SILERO_VAD, getAsrModel, requiredAsrFiles, type AsrModelFile } from '@rt/core';
import type { SetupProgress } from '../shared/types';

/** 指定模型（含公共依赖 VAD）是否齐全（清单来自 @rt/core 的共享登记表）。 */
export function asrModelsReady(modelsDir: string, modelId: string): boolean {
  // 未知 id 必须判「未就绪」：requiredAsrFiles 对未知 id 只返回公共依赖 VAD，
  // 仅按文件存在性判断会误报就绪，随后识别管线构造时才以「未知的识别模型」崩溃。
  if (!getAsrModel(modelId)) return false;
  return requiredAsrFiles(modelId).every((f) => fs.existsSync(path.join(modelsDir, f)));
}

// 无进展看门狗超时：连续这么久没收到任何新字节即判定连接停滞并中止本次下载。
// 「无进展超时」而非「总时长超时」——大文件慢速下载合法，只在字节流真正停滞时触发。
const STALL_TIMEOUT_MS = 30_000;

// .part 临时文件的进程内唯一序号：即使去重失效（防御性），也不会有两路写同一个 .part 互相破坏。
let partSeq = 0;

// 并行下载去重（键为最终落地路径）：多个 ASR 模型共享同一文件（Silero VAD，最小、每个下载都先下），
// 只有一路真正下载，其余并发下载等它完成后按「文件是否已落地」计入，避免重复下载与并发写同一目标。
// 条目在会话内保留（数量=曾下过的文件数，极少）；某文件已在磁盘时上层的 existsSync 先命中，不会走到这里。
const sharedDownloads = new Map<string, Promise<void>>();

/**
 * 从多个下载源按序尝试下载到 dest：每个 URL 只试一次，成功即返回，全部失败才抛出聚合错误。
 * urls 为按端分源的有序列表（macOS native 端取注册表 file.nativeUrls：自托管 GitHub Release 优先、
 * 可含 HF 上游兜底）。ASR 与翻译模型的自研下载链路共用此函数（翻译模型见 ./translation/model-downloader）。
 * 每次失败前会清理本次 .part（见 downloadFromUrl），故换源不残留半截文件；停滞/HTTP 错误均计为该源失败。
 */
export async function downloadFile(
  urls: string[],
  dest: string,
  onBytes?: (loaded: number, total: number) => void,
  signal?: AbortSignal
): Promise<void> {
  if (urls.length === 0) throw new Error(`无可用下载源: ${dest}`);
  const errors: string[] = [];
  for (const url of urls) {
    try {
      await downloadFromUrl(url, dest, onBytes, signal);
      return;
    } catch (err) {
      // 用户取消（外部 signal aborted）：立即停止，不再尝试后续源。
      if (signal?.aborted) throw err;
      errors.push(`${url} → ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // 全部源耗尽：把各源失败原因聚合抛出（含停滞/HTTP 等），交给上层失败→重试 UI 接管。
  throw new Error(`全部下载源均失败:\n${errors.join('\n')}`);
}

/**
 * 从单一 URL 流式下载到 dest（先写 .part 再原子 rename），带无进展看门狗。失败/中断时清理本次 .part。
 * 外部 signal（用户取消）与内部停滞看门狗合流：外部 abort 触发内部 controller.abort()。
 */
async function downloadFromUrl(
  url: string,
  dest: string,
  onBytes?: (loaded: number, total: number) => void,
  signal?: AbortSignal
): Promise<void> {
  // 无进展看门狗：字节流停滞（TCP 静默断开、无 RST）时主动 abort，避免永久挂起。
  const controller = new AbortController();
  let stalled = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const armWatchdog = () => {
    if (watchdog !== undefined) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, STALL_TIMEOUT_MS);
  };

  // 外部取消 → 中止本次 fetch（stalled 保持 false，故不误报「下载停滞」，按 AbortError 上抛）。
  const onExternalAbort = (): void => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  armWatchdog(); // 连接/响应头阶段也受同一 signal 约束
  try {
    const res = await fetch(url, { signal: controller.signal }); // 自动跟随 HF/GitHub 的重定向
    if (!res.ok || !res.body) {
      throw new Error(`下载失败 ${res.status}: ${url}`);
    }
    const total = Number(res.headers.get('content-length')) || 0;
    let loaded = 0;
    const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    body.on('data', (chunk: Buffer) => {
      loaded += chunk.length;
      armWatchdog(); // 收到新字节即重置无进展计时
      onBytes?.(loaded, total);
    });
    // 先写 .part 临时文件，校验完整后原子 rename 到最终路径：中断/失败不会在最终路径
    // 留下半截文件（模型就绪检查按最终路径的存在性判断，半截文件会被误判为就绪）。
    // 唯一后缀避免并行下载共享文件（VAD）时并发写同一 .part 互相破坏。
    const part = `${dest}.${partSeq++}.part`;
    armWatchdog(); // 连接完成，为首字节到达重置一次计时
    try {
      await streamPipeline(body, fs.createWriteStream(part));
      // 只把「少收」判为不完整：CDN 对文本文件可能压缩传输（content-length 为压缩后大小，
      // fetch 自动解压导致实收字节更多）；截断的压缩流会在解压时直接报错，由上面的管道兜底。
      if (total > 0 && loaded < total) {
        throw new Error(`下载不完整 (${loaded}/${total} 字节): ${url}`);
      }
      fs.renameSync(part, dest);
    } catch (err) {
      fs.rmSync(part, { force: true });
      throw err;
    }
  } catch (err) {
    // 看门狗触发的 abort 转成明确的中文停滞错误；外部取消（signal aborted）不改文案，按原样上抛。
    if (stalled && !signal?.aborted) throw new Error('下载停滞，请检查网络后重试');
    throw err;
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * 下载并安装指定 ASR 模型：公共依赖 Silero VAD（缺失才下）+ 该模型全部文件。
 * 进度按本次全部待下载文件的合计字节聚合上报：total 取注册表 approxBytes 之和，
 * loaded 跨文件累计（已完成文件的实收字节 + 当前文件的实时字节）。小文件在前、大文件在后。
 */
export async function downloadAsrModels(
  modelsDir: string,
  modelId: string,
  onProgress: (p: SetupProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  const spec = getAsrModel(modelId);
  if (!spec) throw new Error(`未知的识别模型: ${modelId}`);

  const localPath = (f: AsrModelFile) => path.join(modelsDir, f.dir, f.filename);
  // 公共依赖 VAD + 该模型全部文件；已存在的跳过（只补缺）。按近似大小升序：小文件先下。
  const toDownload = [SILERO_VAD, ...spec.files]
    .filter((f) => !fs.existsSync(localPath(f)))
    .sort((a, b) => a.approxBytes - b.approxBytes);

  const total = toDownload.reduce((sum, f) => sum + f.approxBytes, 0);
  for (const f of toDownload) {
    fs.mkdirSync(path.dirname(localPath(f)), { recursive: true });
  }

  let base = 0; // 已完成文件的累计实收字节
  for (const f of toDownload) {
    // 用户取消：不再开始下一个文件（在途文件由 downloadFile 中止清理，已完成文件由 cancel 整体删除）。
    if (signal?.aborted) throw new Error('下载已取消');
    const dest = localPath(f);
    // 并行去重：另一模型已在下同一文件（VAD）→ 等它完成，已落地则按文件字节计入并跳过；
    // 它失败（文件未落地）则本路自己下（落到下面）。
    const inflight = sharedDownloads.get(dest);
    if (inflight) {
      await inflight;
      if (fs.existsSync(dest)) {
        base += f.approxBytes;
        onProgress({ loaded: base, total });
        continue;
      }
    }
    let last = 0;
    // 本路负责下载：登记 promise（不抛版）供并发的其它模型等待；本路自身仍 await 原始 promise 以感知失败。
    const p = downloadFile(
      f.nativeUrls,
      dest,
      (loaded) => {
        last = loaded;
        onProgress({ loaded: base + loaded, total });
      },
      signal
    );
    sharedDownloads.set(dest, p.then(() => undefined, () => undefined));
    await p;
    base += last;
  }

  if (!asrModelsReady(modelsDir, modelId)) {
    throw new Error('ASR 模型安装后校验失败');
  }
}
