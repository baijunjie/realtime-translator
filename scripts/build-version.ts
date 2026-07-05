// 构建期版本串：<工作区根 package.json 的 version>+<构建时 commit 短哈希>，如 0.1.0-beta.2+abc1234。
// 版本单一来源：只有根 package.json 记版本；三端 app 的 version 恒为 0.0.0（占位，不参与展示）。
// 三端 Vite 配置共用，经 define 注入为 __APP_VERSION__，桥接以 appVersion 暴露给设置页展示。
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

// pkgDir 为调用方的 app 目录（apps/<app>）；版本统一取工作区根（上溯两级）的 package.json，
// 仅用 pkgDir 作为读取 git hash 的 cwd。
export function buildVersion(pkgDir: string): string {
  const { version } = JSON.parse(
    readFileSync(join(pkgDir, '..', '..', 'package.json'), 'utf8')
  ) as {
    version: string;
  };
  let hash = '';
  try {
    hash = execSync('git rev-parse --short HEAD', {
      cwd: pkgDir,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    /* 无 git 环境（如源码包构建）：只留包版本号 */
  }
  return hash ? `${version}+${hash}` : version;
}
