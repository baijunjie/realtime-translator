# 项目地图

Realtime Translator 是 pnpm workspace 单仓库。`@rt/core` 提供平台无关规则与契约，`@rt/ui` 提供三端共享界面，macOS、iOS 和 Web 宿主通过 `AppBridge` 注入平台能力。外部可见的产品行为见[product/overview.md](product/overview.md) 和 [product/experience.md](product/experience.md)。

## 模块导航

| 模块 | 职责与关键入口 |
| --- | --- |
| `packages/core` (`@rt/core`) | 领域类型、`AppBridge` 契约、设置/归档纯逻辑、模型注册表、macOS/Web 共用的实时转写管线，以及三端共用的翻译编排；公共入口为 `packages/core/src/index.ts`。 |
| `packages/ui` (`@rt/ui`) | 共享 Vue 3 单页界面，包含引导、主页、设置、归档和跨页状态；平台业务能力及设置、模型、归档持久化通过 `AppBridge` 访问宿主，纯界面状态可直接使用 DOM、媒体查询和 `localStorage` 等浏览器运行时能力。挂载入口为 `packages/ui/src/index.ts`，屏幕切换入口为 `packages/ui/src/App.vue`。 |
| `apps/macos` (`@rt/macos`) | Electron 宿主：渲染层采集麦克风/系统音频，preload 暴露收紧后的 IPC，主进程管理设置、归档、模型和推理子进程；宿主入口是 `apps/macos/src/main/index.ts`，UI 适配入口是 `apps/macos/src/renderer/src/mac-bridge.ts`。 |
| `apps/web` (`@rt/web`) | 浏览器 PWA 宿主：使用 IndexedDB/Cache Storage 存储，AudioWorklet 采集，Web Worker 中运行 sherpa-onnx WASM 与本地翻译，并管理 Service Worker 外壳缓存；应用入口是 `apps/web/src/main.ts`，平台契约实现是 `apps/web/src/bridge.ts`。 |
| `apps/ios` (`@rt/ios`) | Capacitor 宿主和 WebView 侧桥接，设置/归档使用 Preferences；应用入口是 `apps/ios/src/main.ts`，平台契约实现是 `apps/ios/src/bridge.ts`。 |
| `apps/ios/native-plugin` | iOS 原生能力：`AVAudioEngine` 音频采集、sherpa-onnx ASR、模型下载/管理和 iOS 18+ Apple Translation；TypeScript 契约从 `definitions.ts` 导出，Swift 主入口是 `ios/RealtimeAsrPlugin.swift`。 |
| `assets` | 三端图标的共享源资产；各端构建脚本由此生成所需尺寸和格式。 |
| 根工作区配置 | `package.json` 和 `pnpm-workspace.yaml` 定义工作区、共享依赖版本与跨模块质量门禁；`.github/workflows/ci.yml` 运行检查并在 Web 相关变更进入 `main` 后部署 GitHub Pages。 |

## 关键数据流

### 录音与转写

1. `@rt/ui` 调用注入的 `AppBridge.startPipeline()`。
2. 宿主按平台采集音频：macOS 在渲染层采集后经 IPC 传给主进程，Web 用 AudioWorklet 传给 ASR Worker，iOS 在原生插件内采集。
3. macOS 和 Web 将音频送入 `@rt/core` 的共享转写管线，分别在 utility process 和 WASM Worker 中执行 VAD 与 ASR；iOS 原生插件在自身 ASR 队列中执行对应的 VAD、部分识别与定稿。
4. 部分文本与定稿段经 `AppBridge` 事件返回 `@rt/ui`；UI 将定稿段追加为对话行。

### 翻译

1. 宿主在定稿段到达时调用 `packages/core/src/translation/segment-translation.ts` 的共享编排。
2. 共享编排根据母语、识别语言和会话内最近外语决定跳过、字形归一化或发起翻译。
3. 宿主执行具体引擎：macOS 将 M2M-100/云端请求放在纯 Node 子进程，Web 用 Transformers.js Worker 或直接调云端，iOS 调 Apple Translation 或直接调云端。
4. pending、成功或失败事件按段 ID 回到 UI 的原文行；翻译不阻塞后续识别。

### 设置、模型与归档

- `@rt/ui` 只持有表单和当前会话状态；设置、模型和归档持久化经 `AppBridge`。默认值、字段校验、归档摘要和排序在 `@rt/core` 复用，各宿主只选择文件、Preferences 或 IndexedDB 作为存储后端。
- 模型清单、大小、语言、平台可用性和有序下载源的单一事实源是 `packages/core/src/model-registry.ts`。各宿主将文件下载到本端模型目录或 Cache Storage，再由对应推理运行时离线装载。

## 测试与构建位置

- 根 `package.json` 的 `pnpm check` 运行 `@rt/core` 单元测试，以及 macOS、Web、iOS 三端类型检查。
- `packages/core/src/**/*.test.ts` 覆盖设置、归档、模型源、转写管线和翻译决策等共享逻辑。
- `apps/macos/test` 包含无 GUI 管线、CER 评测和翻译脚本；入口命令由 `apps/macos/package.json` 的 `test-pipeline`、`eval-cer` 和 `test-translate` 定义。
- 根 `pnpm build` / `pnpm dist` 构建或打包 macOS；Web 和 iOS Web 资源分别由各自 `package.json` 的 `build` 脚本构建。iOS 原生工程位于 `apps/ios/ios/App`，注册表到 Swift 的生成入口是 `apps/ios/native-plugin/scripts/gen-asr-models-swift.mjs`。
- `.github/workflows/ci.yml` 在 PR、`main` 分支推送和手动触发时执行根命令对应的测试/类型检查，并额外校验 iOS 生成的模型清单未与注册表漂移；Web 部署只在门禁通过后执行。
