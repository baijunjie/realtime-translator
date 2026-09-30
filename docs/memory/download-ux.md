# 模型下载体验（后台下载 + 进度/取消 + 录音等待）

下载不再阻塞界面：确认弹窗只负责征询，确认后交给 app 级下载管理器后台下载，进度/取消在行内与主屏非阻塞呈现。

## 关键设计

- **下载管理器（单例）** `packages/ui/src/composables/useModelDownloads.ts`：把下载生命周期从弹窗里提出来，跨屏共享。
  - 由 `mountApp`（`packages/ui/src/index.ts`）调 `registerModelDownloadListeners()` **只订阅一次** `onSetupProgress`。
  - **并行下载**：多个模型可同时下载，各自一个 entry、各自进度。`SetupProgress` 携带 `kind`+`id`（三端下载器发事件时带上），管理器据此把进度路由到对应 entry。`startDownloads` 对每个任务并发起 `runTask`（不排队、不串行）。
  - `DownloadTask` 类型的权威定义在此（弹窗/各屏从这里 import，别再从弹窗 import）。
  - `cancelledKeys` 区分「用户取消」与「真失败」：取消的任务 settle 后不进 error 态。`onDownloadDone(cb)` 供等待者（录音）订阅。
- **取消契约** `AppBridge.cancelModelDownload(kind, id)`（`@rt/core`）：中止在途下载 + **删除该模型全部残留**（回未下载态，用户选择「全部删光」）。三端实现（取消句柄按模型键 `${kind}:${id}` 索引，并行下载互不影响）：
  - web `apps/web/src/bridge.ts`：`downloadAborts: Map<key, AbortController>` + 把外部 `AbortSignal` 传进 `ensureModelsCached`/`ensureTranslationModelCached`/`fetchIntoCache`，与内部停滞看门狗 controller 合流；取消后 `deleteAsr/TranslationFromCache`。
  - macOS `apps/macos/src/main/index.ts`：`downloadAborts: Map` + `downloadFile(...,signal)` 透传；IPC `models:cancel-download` → 按键 abort + 复用 `deleteModelFiles`（同步删，先删目录再让在途下载在下次 I/O 失败，避免残留）。
  - iOS `RealtimeAsrPlugin.swift`：下载跑在 `asrQueue` 且被信号量阻塞，故 `cancelDownload` **必须在别的线程**置 `downloadCancelled`（`NSLock` 保护）并 `currentDownloadTask?.cancel()` 解除阻塞，再把删除排到 asrQueue（在下载解绑后执行）。iOS 仅一个 ASR 模型、无翻译下载，实际不并发。
  - 各端 abort 语义：算「取消」不误报「下载停滞」；外部 signal aborted 时按 AbortError 上抛，fallback 循环遇取消立即停止、不再试后续源。
- **共享文件并行去重**：**每个 ASR 模型的下载清单都含公共依赖 Silero VAD**（`silero_vad.onnx`，最小、每个下载都先下），两个 ASR 模型并行时会同时下它。故 `downloadAsrModels`（macOS）/`ensureModelsCached`（web）按「目标路径 / Cache 键」维护 `sharedDownloads` in-flight Map：同一文件只有一路真正下载，其余并发下载 `await` 它完成后按「文件是否已落地 / 已缓存」计入并跳过（对端失败则本路自己补下）。get→set 之间无 await，天然无竞态。消除了重复下载与 web「一路失败 cache.delete 掉另一路成果」的竞态。按模型删除/取消**始终保留 VAD**（macOS 只删模型子目录、web `deleteAsrModelFromCache` 留 VAD、iOS 同），故取消一个模型不影响并发的另一个。macOS `.part` 另加进程内唯一后缀（`partSeq`）作防御性隔离。iOS 无并发、不涉及。
- **录音等待（进度模态）** `packages/ui/src/screens/MainScreen.vue` 的 `awaitingRecord`：点录音若所需模型正在（后台）下载 → 弹进度模态（列出所等模型各自进度），可「取消本次录音」（`stopAwait` 不取消下载、后台续）；经 `onDownloadDone` 观察所等任务全部成功 → 自动 `proceedToRecord()`。区别于 `modelLoading`（引擎装载）与 `recordBusy`（启停在途）。设置页/手动下载则是行内进度 + X（`ModelsSection.vue`）。

## 续传现状（本次未改）

三端**文件级续传**（重触发跳过已下完整文件），**无字节级续传**（半截文件从零重下），**无重开自动续传**（重开/刷新后不自动续，需再次触发）。用户接受此兜底（重新下载会弹确认窗，但已完成文件不重下）。字节级续传（HTTP Range / URLSession resumeData）是更大的独立工程，未做。
