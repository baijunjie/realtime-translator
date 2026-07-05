// macOS 打包：解决 pnpm workspace 下 electron-builder 找不到 node_modules 的问题。
// 流程：electron-vite 构建 → pnpm deploy 导出自包含副本（带真实 node_modules + out/）
// → 在副本里跑 electron-builder → 产物回写到 apps/macos/release。
// 不签名构建：CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @rt/macos dist
import { execSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..'); // apps/macos
const root = path.resolve(appDir, '..', '..'); // 工作区根
const deployDir = path.join(root, '.deploy-macos'); // 自包含副本（已 gitignore）
const releaseDir = path.join(appDir, 'release'); // 最终产物位置
const dirOnly = process.argv.includes('--dir');

const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });

console.log('▶ 1/4 构建 (electron-vite)');
run('pnpm run build', appDir);

console.log('▶ 2/4 生成应用图标 (从共享 assets/ 重建 build/icon.icns)');
run('pnpm run icons', appDir);

console.log('▶ 3/4 导出自包含副本 (pnpm deploy)');
rmSync(deployDir, { recursive: true, force: true });
// --prod=false 以带上 electron / electron-builder（构建期需要）；electron-builder 只把生产依赖打进 .app
run(`pnpm --filter @rt/macos deploy --prod=false --legacy "${deployDir}"`, root);

console.log('▶ 4/4 打包 (electron-builder)');
const target = dirOnly ? '--dir' : '';
// 版本单一来源：apps/macos/package.json 恒为 0.0.0 占位，打包时用根 package.json 的版本
// 覆盖（-c.extraMetadata.version），决定 dmg 文件名与 App 的 CFBundleShortVersionString。
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
run(
  `./node_modules/.bin/electron-builder --mac ${target} -c.extraMetadata.version="${version}" -c.directories.output="${releaseDir}"`,
  deployDir
);

console.log(`✓ 完成，产物在 ${releaseDir}`);
