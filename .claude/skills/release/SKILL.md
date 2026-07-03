---
name: release
description: 发布/重发 Realtime Translator 的 release（macOS dmg + web 自动部署）。当用户说「发布」「重新发布」「打包发版」「重发 release」时使用。
---

# Release 流程

本仓库的发布物有两个，**一次 push 会同时影响两者**：

- **macOS dmg**：手动打包后上传到 GitHub Release 资产。
- **Web PWA**：push 到 `main` 后由 `.github/workflows/ci.yml` 的 `deploy-web` job 部署到 GitHub Pages，**且仅在 check job 全绿后执行**（坏代码进不了线上）。发 macOS 版前仍需确认 main 上没有「不想同时上线 web」的改动。

## 1. 发布前检查（必须全绿才继续）

```bash
git status --porcelain          # 工作树必须干净
pnpm check                      # core 测试 + 三端 type-check（与 CI 的 check job 完全一致）
```

本地过了，push 后 CI 必绿、web 部署才会放行。

## 2. 版本号

- **新版本**：`pnpm set-version <x.y.z[-tag]>`（统一写入 根 / apps/macos / apps/ios 的 package.json，packages/* 不动），用 `chore: bump version to <ver>` 之类的 Conventional Commit 提交。
- **beta 同版本重发**：版本号不动。构建之间靠「包版本+commit 短哈希」区分（构建期注入 `__APP_VERSION__`，设置页底部可见）。

## 3. 打包 macOS

```bash
pnpm --filter @rt/macos dist    # 产物在 apps/macos/release/
```

注意事项：

- 打包脚本（`scripts/package-mac.mjs`）会把工程同步到 `.deploy-macos/` 自包含副本后在那里跑 electron-builder——日志里显示加载的是 `.deploy-macos/electron-builder.yml` 属正常，配置源头仍是 `apps/macos/electron-builder.yml`。
- **产物核验**（每次必做）：

  ```bash
  plutil -p "apps/macos/release/mac-arm64/Realtime Translator.app/Contents/Info.plist" \
    | grep -E "UsageDescription|CFBundleShortVersion"
  ```

  必须包含 `NSMicrophoneUsageDescription` 与 `NSAudioCaptureUsageDescription`（系统音频采集依赖后者，缺失会得到不弹窗、无报错的静音流）。
- 当前无 Developer ID 证书，产物**未签名**（日志有 skipped code signing 警告属预期），用户首次打开需右键 → 打开。
- 模型不打进包（运行时按需下载）；打包版模型目录在 `userData` 下，与 dev 的 `apps/macos/models/` 不共享。

## 4. 发布

### beta 同版本重发（覆盖既有 release）

```bash
git push origin main
git tag -f v<ver> && git push -f origin v<ver>
gh release upload v<ver> \
  "apps/macos/release/Realtime Translator-<ver>-arm64.dmg" \
  "apps/macos/release/Realtime Translator-<ver>-arm64.dmg.blockmap" --clobber
```

- 约定：**不 revert、不留版本号往返提交**，tag 直接强推到新 commit。
- GitHub 会把资产名里的空格替换为点（`Realtime.Translator-...`），`--clobber` 按替换后的名字正常覆盖。

### 新版本

```bash
git push origin main
git tag v<ver> && git push origin v<ver>
gh release create v<ver> --prerelease --title "Realtime Translator <ver>" --notes "<要点>" \
  "apps/macos/release/Realtime Translator-<ver>-arm64.dmg" \
  "apps/macos/release/Realtime Translator-<ver>-arm64.dmg.blockmap"
```

- beta 阶段用 `--prerelease`。

## 5. 发布后确认

```bash
gh run list --branch main --limit 2       # CI 与 web 部署均 success
gh release view v<ver> --json assets -q '.assets[] | "\(.name)  \(.size)  \(.updatedAt)"'
```

资产的 `updatedAt` 应为刚才的上传时间（重发时用它确认覆盖成功）。

## 模型资产（models-v1）

新模型（识别 / 本地翻译）上架步骤：

1. **上传资产**：资产按 `<模型id>-<原文件名>` 扁平命名（公共依赖 Silero VAD 无前缀，直接 `silero_vad.onnx`），全部上传到同一 `models-v1` release：

   ```bash
   gh release upload models-v1 <files> --clobber
   ```

2. **登记注册表**（`packages/core`：ASR 见 `models.ts`，翻译见 `translation/local-spec.ts`）：
   - 每个文件填自托管 GitHub Release 直链 `url`（`ghModelAsset('<模型id>-<原文件名>')`）——**macOS / iOS** 走这个。
   - `platforms` 含 `web` 的模型，另给每个文件填上游、发 CORS 头的 `webUrl`（如 HuggingFace resolve 直链）：GitHub Release 资产**不发 CORS 头**，浏览器 fetch 用不了，web 只能走 `webUrl`。macOS-only 模型（如 M2M100-1.2B）无需 `webUrl`。

3. **核验 URL**：对注册表里全部 URL 做 HEAD 核验，确认最终都 200（GitHub Release 会 302 到 CDN，`-L` 跟随后应为 200）：

   ```bash
   curl -sIL <url> | grep -E '^HTTP'   # 期望最后一行 200
   ```

## 红线

- **正式版（非 beta）发布后，不得再重置/强推已发布的 tag**。
- 大文件（模型权重等）不进 git，也不走 GitHub LFS（免费带宽仅 1GB/月）；托管用 **GitHub Releases 资产**（单文件上限 2GB，公开仓免流量费）。
