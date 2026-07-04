// 运行时下载本地翻译模型（与 ASR 一致的自研下载链路：注册表声明 URL、按 id 参数化，
// 下载哪个模型完全由 modelId 决定、与当前翻译引擎设置无关）。逐个下载 spec.files 到
// Transformers.js 缓存布局 `<cacheDir>/<modelId>/<dir>/<filename>`，之后翻译子进程以
// allowRemoteModels=false 离线加载。
import fs from 'node:fs';
import path from 'node:path';
import { getTranslationModel, type LocalModelFile } from '@rt/core';
import { downloadFile } from '../model-downloader';
import { localModelCached } from './model-cache';
import type { SetupProgress } from '../../shared/types';

/**
 * 下载并安装指定本地翻译模型：逐个下载其注册表登记的全部文件（已存在的跳过，只补缺）。
 * 进度按 spec.approxDownloadBytes 作分母聚合上报（loaded 跨文件累计），经既有 setup:progress 通道，
 * 与 ASR 完全一致。文件按注册表声明顺序（体积升序）下载。
 */
export async function downloadTranslationModel(
  cacheDir: string,
  modelId: string,
  onProgress: (p: SetupProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  const spec = getTranslationModel(modelId);
  if (!spec) throw new Error(`未知的翻译模型: ${modelId}`);

  const localPath = (f: LocalModelFile): string => path.join(cacheDir, spec.modelId, f.dir, f.filename);
  const toDownload = spec.files.filter((f) => !fs.existsSync(localPath(f)));
  const total = spec.approxDownloadBytes;
  for (const f of toDownload) {
    fs.mkdirSync(path.dirname(localPath(f)), { recursive: true });
  }

  // 累计起点计入已存在文件的字节（断点续传只补缺文件）：分母恒为全量近似值，
  // 不预置的话进度会从 0 只爬到剩余占比、收尾跳变 100%。
  let base = spec.files
    .filter((f) => !toDownload.includes(f))
    .reduce((sum, f) => {
      try {
        return sum + fs.statSync(localPath(f)).size;
      } catch {
        return sum;
      }
    }, 0);
  for (const f of toDownload) {
    // 用户取消：不再开始下一个文件（在途文件由 downloadFile 中止清理，已完成文件由 cancel 整体删除）。
    if (signal?.aborted) throw new Error('下载已取消');
    let last = 0;
    await downloadFile(
      f.nativeUrls,
      localPath(f),
      (loaded) => {
        last = loaded;
        // 实收字节可能略超近似分母（q8 实际略大于估值）：封顶到 total，避免进度条越界。
        onProgress({ loaded: Math.min(base + loaded, total), total });
      },
      signal
    );
    base += last;
  }
  // 末尾对齐 100%：各文件实收合计与近似分母有出入，收尾时把进度贴到满格。
  onProgress({ loaded: total, total });

  if (!localModelCached(cacheDir, spec)) {
    throw new Error('翻译模型安装后校验失败');
  }
}
