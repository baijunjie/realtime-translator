// 本地翻译模型缓存的完整性检查（Node fs 侧）。主进程（下载页状态/预热门控）与
// 翻译子进程的 LocalTranslator 共用此判据，避免两处各写一份而漂移。
import fs from 'node:fs';
import path from 'node:path';
import type { LocalModelSpec } from '@rt/core';

/**
 * 模型是否已完整缓存于 cacheDir（transformers.js FileCache 布局：<cacheDir>/<modelId>/）。
 * spec 的**全部**文件（权重 + tokenizer/config）都在才算已缓存：离线加载
 * （allowRemoteModels=false）缺任一文件都会失败，只查权重会把 tokenizer/config
 * 缺失的残缺缓存误判为已就绪，且就绪后 UI 不再提供补下载入口。
 */
export function localModelCached(cacheDir: string, spec: LocalModelSpec): boolean {
  return spec.files.every((f) =>
    fs.existsSync(path.join(cacheDir, spec.modelId, f.dir, f.filename)),
  );
}
