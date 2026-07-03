// 运行时下载本地翻译模型（与 ASR 一致的自研下载链路：注册表声明 URL、按 id 参数化）。
// 逐个下载 spec.files 到 Transformers.js 缓存布局 `<cacheDir>/<modelId>/<dir>/<filename>`，
// 之后翻译子进程以 allowRemoteModels=false 离线加载。不再经 Transformers.js 内置联网下载，
// 也不再绑定当前引擎——下载哪个模型完全由 modelId 决定。
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
  onProgress: (p: SetupProgress) => void
): Promise<void> {
  const spec = getTranslationModel(modelId);
  if (!spec) throw new Error(`未知的翻译模型: ${modelId}`);

  const localPath = (f: LocalModelFile): string => path.join(cacheDir, spec.modelId, f.dir, f.filename);
  const toDownload = spec.files.filter((f) => !fs.existsSync(localPath(f)));
  const total = spec.approxDownloadBytes;
  for (const f of toDownload) {
    fs.mkdirSync(path.dirname(localPath(f)), { recursive: true });
  }

  let base = 0; // 已完成文件的累计实收字节
  for (const f of toDownload) {
    let last = 0;
    // 主源失效时 downloadFile 内部会以 fallbackUrl 从头重下：loaded 归零后 last 随之被覆盖，
    // 聚合进度里该文件的份额回退再爬升，收尾 base += last 仍是最终实收字节，累计正确。
    await downloadFile(
      f.url,
      localPath(f),
      (loaded) => {
        last = loaded;
        // 实收字节可能略超近似分母（q8 实际略大于估值）：封顶到 total，避免进度条越界。
        onProgress({ loaded: Math.min(base + loaded, total), total });
      },
      f.fallbackUrl
    );
    base += last;
  }
  // 末尾对齐 100%：各文件实收合计与近似分母有出入，收尾时把进度贴到满格。
  onProgress({ loaded: total, total });

  if (!localModelCached(cacheDir, spec)) {
    throw new Error('翻译模型安装后校验失败');
  }
}
