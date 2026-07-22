---
name: project-direction
description: realtime-translator（原 meeting-translator）的产品方向、技术选型理由和已否决的方案
metadata: 
  node_type: memory
  type: project
  originSessionId: e145808a-addf-44e7-aac0-97e1144979fc
---

realtime-translator（曾名 meeting-translator）是用户要分发给他人使用的应用，核心诉求：本地推理（音频不出机器）、可打包分发、实时转写上屏。最初仅 macOS，后扩为 macOS / iOS / 网页 PWA 三端 monorepo（见 2026-07-03 条目）。

**已定决策（2026-06-12）：**
- 技术栈 Electron + sherpa-onnx-node（选它是因为纯 CPU 实时、N-API 免重编译、MIT 可商用分发）
- ASR 用 SenseVoice int8（中日英韩粤自动检测）
- **已否决**：声源方向/距离定位——普通 Mac 拿不到原始多麦克风阵列数据，需要 ReSpeaker 等专用硬件，与"分发给普通用户"矛盾。
- 翻译功能在 MVP 范围外，Roadmap 上（用户倾向本地方案）

**已否决：说话人区分（声纹 diarization，2026-06-27 移除）**
- 曾用 3D-Speaker ERes2Net 提声纹 + 余弦相似度层次聚类分配说话人 ID，并支持历史标签自动修正。
- 真人麦克风实测：同人跨段相似度 0.5-0.66、不同人 0.07-0.46，两个分布几乎重叠，无论阈值怎么调都无法可靠区分，实际效果不理想。
- 用户决定彻底放弃该功能，已删除全部相关代码（extractor / 聚类 / 说话人侧栏 / onRelabel）。后续不要再尝试基于声纹的本地说话人区分，除非换更强的模型或硬件方案。

**实时上屏（2026-06-27）：**
- 之前只在 VAD 关闭语音段后才出文字，连续说话最长要等 maxSpeechDuration(15s) 才一次性显示。
- 现改为说话过程中每 ~0.6s 用 SenseVoice 对“未结束”的语音做部分识别（onPartial，灰色一行实时更新），段结束后用最终结果定稿（onSegment）。靠 vad.isDetected() + 自维护的 historyChunks 缓冲实现，模型仍是离线 SenseVoice。

**TypeScript 工程化（2026-06-27）：**
- 全量迁移到 TS（`src/`），刻意只用 `tsc` 编译到 `dist/`，不引入 bundler（esbuild/vite/electron-vite），保持依赖精简。
- 单一 `tsconfig.json`，`lib` 同时含 DOM+ES2020 覆盖主进程与渲染进程。
- 主进程文件（main/preload/pipeline）是 CommonJS 模块；渲染进程 `renderer.ts`、`audio-worklet.ts` 故意不写 import/export，使其编译成「经典脚本」，可直接被 `<script>` / `audioWorklet.addModule` 加载——一旦给它们加 import 就会变成模块、产出 require 而在浏览器/worklet 里报错。
- sherpa-onnx-node 无自带类型，手写 `src/sherpa-onnx-node.d.ts` 只声明用到的 API；IPC 负载与 window.api 类型放在 ambient 的 `src/shared.d.ts`。
- 静态资源由 `scripts/copy-assets.mjs` 拷到 `dist/renderer/`（tsc 不处理 .html/.css）。
- 模型只用 SenseVoice int8，下载脚本解包后删掉附带的全精度 model.onnx（约 900MB）。

**翻译功能（2026-06-27，MVP 已落地）：**
- 用户优先级：本地推理 > 许可证可商用 > 免费 > 不介意重 > 想保留云 API 选项；方向是**多语言自由互译**。
- 选 **Meta M2M100-418M（MIT 许可）**,经 **Transformers.js（@huggingface/transformers v4）** 在 onnxruntime-node 上跑,与 sherpa 同为 ONNX 栈、无需 llama 原生模块。int8(q8)量化 encoder + merged decoder 共约 630MB,首次从 HuggingFace 自动下载到 `models/transformers/`(env.cacheDir),之后离线;**会议文本不出机器**,只有模型权重一次性联网。
- **架构刻意做成可插拔**(用户硬性要求模型与实现分离):`src/translation/translator.ts` 定义 `Translator` 接口 + `createTranslator` 工厂,`m2m100-translator.ts` 是 MVP 实现。以后换 LLM(Qwen 等)或云 API 只加一个实现,main/pipeline/渲染层不动。
- 只翻**定稿段**(onSegment),partial 不翻;译文异步靠 segment `id` 回填对应行;同语言(如 zh→zh)直接返回原文跳过。
- 已否决方案:NLLB(CC-BY-NC 禁商用)、Qwen2.5-3B(非 Apache,是受限 Qwen-Research 许可——若以后上 Qwen 要用 7B/1.5B 这些 Apache-2.0 档)。
- 实测:模型首次加载~30s,之后每句 0.4–0.9s(CPU),多向互译质量可用。
- **云端后端(2026-06-27 已加)**:用户选"通用 OpenAI 兼容"(自带 baseURL+key+model,走 chat/completions),不绑定具体厂商。`src/translation/cloud-translator.ts`,工厂 `backend: 'cloud'`。密钥等存本地 `src/settings.ts`(electron userData/settings.json,**明文**,后续可改 safeStorage 加密),设置弹窗在渲染层。引擎(local/cloud)/目标语言切换即重建翻译器。**云端会把文本发往第三方**,与"不出机器"相悖,故默认本地、云端为显式可选项。

**UI 重构：母语驱动 + 多语言界面 + 首次引导（2026-06-27）：**
- **「母语」是单一核心设置 = 界面语言 + 翻译目标**（用户确认）。会议里识别到的其他语言统一翻成母语，主页面只有「翻译开/关」开关，没有独立目标语言下拉。
- 支持的母语/界面语言：zh / ja / en / ko（粤语 yue 仅作 ASR 识别源，不作界面语言）。
- i18n：渲染层是经典脚本，新增 `src/renderer/i18n.ts` 也写成经典脚本（无 import/export，提供全局 `I18N`/`t()`/`applyI18n()`/`setLocale()`/`LANG_NAMES`），`index.html` 先于 `renderer.js` 引入。HTML 用 `data-i18n` / `data-i18n-ph` / `data-i18n-title` 标注，动态文案（按钮三态、状态栏）由 renderer 用 `t()` 拼。改这类多文件经典脚本要保持「无 import/export」否则会编译成模块、在浏览器里 require 报错。
- 三屏单页：`#onboarding` / `#main-screen` / `#settings-screen`，靠 `.hidden` 切换；`AppSettings.onboarded` 决定首启是否进引导。
- `AppSettings` 重构为 `{ onboarded, nativeLang, fontSize, translation:{ enabled, engine, cloud } }`，去掉了旧的 `translation.targetLang`（`settings.ts withDefaults` 做了旧字段迁移，并按 `app.getLocale()` 猜默认母语）。
- 字体大小用 CSS 变量 `--transcript-size`（small/medium/large 档），设置页即时预览。

**渲染层迁移到 Vue 3 + electron-vite（2026-06-27）：**
- 之前是手写 DOM + 经典脚本 + tsc/copy-assets。用户要成熟 UI 库，改为 **electron-vite v5 + Vue 3（`<script setup>`）+ Naive UI（暗色主题）+ vue-i18n**；只重写渲染层，主进程/转写/翻译逻辑不变。
- 工程结构改成 electron-vite 约定：`src/main/`（原 main/pipeline/settings/translation/sherpa.d.ts）、`src/preload/`、`src/shared/types.ts`（原 ambient shared.d.ts 改为具名导出）、`src/renderer/`（Vue 应用 + `index.html` + `public/audio-worklet.js`）。
- 关键点：electron-vite v5 **默认外部化主进程依赖**，sherpa-onnx-node / @huggingface/transformers(onnxruntime-node) 不被打包、运行时 require（已验证 out/main/index.js 里是 require）。AudioWorklet 放 `renderer/public/` 作静态资源（addModule('audio-worklet.js')），绕开 vite worklet 处理。`MODELS_DIR` 改用 `app.getAppPath()`（__dirname 现指向 out/main）。
- 别名 `@`=renderer src、`@shared`=src/shared（vite + tsconfig paths 同步）。类型检查用 `vue-tsc --noEmit`，构建 `electron-vite build`，开发 `electron-vite dev`。
- i18n 改用 vue-i18n（嵌套 messages，复用原 4 语言文案）；渲染层状态用组合式单例：`useSettings`（设置 + 语言/字体应用）、`useTranscription`（IPC 监听只注册一次 + 录音 + 响应式行列表）。
- Naive UI 全量引入致 renderer bundle ~1.25MB，可后续按需引入优化（范围外）。

**主题切换 + Tailwind v4（2026-06-27）：**
- 加了 浅/深/跟随系统 三态主题,顶栏 lucide Sun/Moon/Monitor 按钮循环切换(`cycleTheme`),持久化在 `AppSettings.theme`(默认 `system`)。
- 生效:`useSettings` 里 `applyTheme` 切 `document.documentElement` 的 `.dark` 类(给 Tailwind `dark:` 变体)+ 维护响应式 `isDark` 驱动 `App.vue` 的 `NConfigProvider :theme`(darkTheme/lightTheme);`system` 时监听 `matchMedia('(prefers-color-scheme: dark)')` 实时跟随。
- 样式改用 **Tailwind v4**:`@tailwindcss/vite` 插件 + `styles.css` 用 `@import "tailwindcss"; @custom-variant dark (&:where(.dark,.dark *));`。所有组件去掉 `<style scoped>`,改 Tailwind class + `dark:`。字体档位仍用 CSS 变量,Tailwind 任意值 `text-[length:var(--transcript-size)]`。
- Naive UI 仍作组件库,跟随主题;**风险**:Tailwind preflight 可能与 Naive 冲突,需 `pnpm dev` 实测(目前 build/type-check 通过,但 GUI 未实际渲染验证)。

**模型分发（2026-06-27，方案 B：不打包、运行时下载）：**
- 用户选定**不把模型打进安装包**,改为运行时下载。**ASR(Silero VAD + SenseVoice int8,~230MB)首次启动下载**(应用内,带下载页);**翻译 M2M100(~630MB)按需下**(开翻译开关时,已实现)。
- 实现:`src/main/model-downloader.ts`(`asrModelsReady` / `downloadAsrModels`,Node fetch 流式 + `tar xf` 解包,URL 沿用 download-models.sh)。IPC `setup:get-status`/`setup:download-asr`/`setup:progress`。渲染层 `SetupScreen.vue`,App 流程 引导→(缺ASR则)下载页→主页。
- ASR 下载改为**直接从 HuggingFace 拉 int8 文件**(`model.int8.onnx` + `tokens.txt`)+ silero(GitHub),约 230MB——不再用 GitHub 的 tar 包(那个含 894MB 全精度模型、压缩后约 1GB)。
- `scripts/download-models.sh` 与 `npm run download-models` **已删除**(应用自下,无需预下载脚本);`test-pipeline` 等无界面验证依赖应用先下过模型(或本机 models/ 已有)。
- **遗留(打包时必处理)**:`MODELS_DIR = app.getAppPath()/models` 在打包后只读,届时模型目录(含翻译 cacheDir)要迁到 `userData`。tar 依赖 macOS 自带(目标平台 macOS)。

**识别移到独立进程（2026-06-27，utilityProcess）：**
- 识别(VAD + SenseVoice)原在主进程同步跑会卡 UI；改为跑在 **Electron `utilityProcess` 子进程**(`src/main/asr-process.ts`)。主进程只转发音频、收 segment/partial(`MainToAsr`/`AsrToMain` 协议在 shared/types.ts)。
- 选 utilityProcess 而非 worker_threads：**独立进程隔离原生崩溃**(本项目早先有 Electron 原生 VAD 崩溃史),挂了主进程仍在、可报错重启;原生模块在完整 Node 进程里最稳。
- electron-vite 用 `import x from './asr-process?modulePath'` 产出子进程入口(**必须相对路径**,别名在 ?modulePath 下不可靠);`*?modulePath` 的类型声明在 `src/main/worker.d.ts`。
- 翻译仍留主进程(云端 async 不阻塞;本地 m2m100 每段一次,可接受)。
- 部分识别的「窗口封顶 8s + 自适应降频 + 构造期预热」仍保留(在子进程里)。`maxSpeechDuration` 15→**6**(连续说话最多 6s 断句,累积更及时)。
- 子进程懒启动(首次录音 fork+加载+预热,期间状态 loading),保活复用,window-all-closed 时 kill。

**Monorepo 三端化（2026-06-28 前后，补记）：**
- 更名 realtime-translator，pnpm workspace 拆为 `@rt/core`（平台无关逻辑）+ `@rt/ui`（共享 Vue UI）+ 三端 app；三端只差注入的 `AppBridge` 实现。切段管线、翻译编排、模型登记表等一律下沉 core——「调参改一处三端生效」是硬约束（iOS 原生管线是已知例外，存在漂移）。
- 翻译已移入独立 utilityProcess（前文 2026-06-27「翻译仍留主进程」已过时）。

**模型下载与预热 UX（2026-07-02/03）：**
- 蜂窝确认与专门下载页已被下文 2026-07-03「模型按需下载」重构取代（getNetworkType/SetupScreen 均已删除）；本节仍有效的是预热与看门狗两条。
- 翻译模型（约 630MB）逐文件进度 + 按字节聚合总进度、分母用 spec 近似总量预置防回落；**取消下载 = 翻译开关回退为关闭**。
- 保存设置/应用启动只在模型**已缓存**时自动预热，未缓存不静默下载（否则蜂窝确认形同虚设）。
- ASR 预热：进主界面即后台装载（绝不触碰麦克风/权限）；UI 先行禁用录音按钮、平台保证任何路径以终态 status 收尾解禁；start 仅真冷启动才报 loading。
- 下载器一律带无进展看门狗（30s 无新字节即中止报错），不做总时长超时。

**错误呈现（2026-07-03）：**
- 单条翻译失败=**行内失败标记**（TranslationPayload.failed），不进全局通道；全局翻译红条只报引擎级故障（模型加载失败/进程崩溃）且引擎恢复即清除。
- 管线错误带稳定错误码（PipelineErrorCode），UI 按码取本地化文案、无码回退宿主原文——宿主不再决定错误文案语言。

**发布流程（beta 阶段约定，2026-07-02）：**
- 同版本号重发 = `main` 重置/推进后把 tag 强推到新 commit + `gh release upload --clobber` 替换 dmg；**不 revert/不留版本号往返提交**。构建间用「包版本+commit 短哈希」（设置页底部可见）区分。正式版发布后不得再重置已发布 tag。
- 存储命名统一用项目全名 realtime-translator（网页 IndexedDB/Cache、iOS Preferences），测试阶段更名不做数据迁移。

**UI 教训（已两次踩坑）：**
- Tailwind 工具类**不能直接挂在 n-button 上**（Naive 运行时注入的样式表在 Tailwind 之后，会覆盖 `sm:hidden`、`mt-4` 等）；间距/显隐一律由外层普通 div 承载。

**模型按需下载 + 多识别模型体系 + 系统音频采集（2026-07-03）：**
- 这轮重构源于「识别不准」的讨论。已定结论：**准确率第一杠杆是锁定识别语言**（SenseVoice auto 模式对短段/强切段的语种误判是主要错误来源之一），其次是按语言换专用模型；评测基建（CER 对照脚本）已于 2026-07-22 建成（见 [asr-eval](asr-eval.md)）。
- **下载流程**：启动不再自动下载模型，改为点「开始录音」时汇总缺失模型（当前选中的 ASR 模型 + 已开启的本地翻译模型），`ModelDownloadModal` 通用弹窗确认（名称+大小）→ 不可关闭的下载态 → 完成自动继续录音；取消即终止。设置页开启本地翻译时同一弹窗就地下载。
- **多模型注册表**（core `models.ts`，`AsrModelSpec[]`）：`sense-voice`（多语，全平台）、`paraformer-zh`（中文，227MB）、`zipformer-ja-reazonspeech`（日语，169MB）、`parakeet-tdt-0.6b-v2-en`（英语 NeMo transducer，661MB，需 `modelType:'nemo_transducer'`）。专用模型 iOS 不放开；web 于 2026-07-03 试验性放开（platforms 加 web，worker 已支持三类引擎装配），**用户实测中、去留待定**——预期 Paraformer-zh 可行、Parakeet-en（661MB）内存吃紧，实测后按数据收敛 platforms。ReazonSpeech 官方只发 tar 整包，文件直链取自源仓 `csukuangfj/reazonspeech-k2-v2`、落地目录沿用预置包命名。VAD（silero，0.6MB）是公共依赖，不进选择列表、删除模型时不删。
- **识别设置**：`AppSettings.asr = { language: 'auto'|en|ja|ko|zh, model }`。senseVoice 的 `language` 原生合法值 auto/zh/en/ja/ko/yue（三端均已透传：macOS N-API / web WASM 包装器 / iOS Swift）。语言或模型变更 → kill ASR 子进程（macOS）/重建 recognizer（web/iOS），下次录音生效。
- **语言体系精简**：繁体并入简体（保留 `sify` 简体归一化，繁体方向弃用）、粤语从用户选项移除（仅作 auto 模式内部语言码，翻译链路保留处理）、`UI_LANGS=['en','ja','ko','zh']` 字母序、**旧设置不迁移**（withDefaults 无效值一律回落默认）。
- **模型管理页**：`listModels`/`deleteModel` 契约。web 端已下载 sizeBytes 直接用注册表 approxBytes（Cache API 取真实字节要整读 blob，不值得）；iOS 无可删翻译模型（Apple Translation 语言包系统管理），只列 ASR。
- **音源开关（仅 macOS）**：主画面切换「麦克风（默认）/ 系统音频」，录音中禁切。系统音频走 Chromium loopback（CoreAudio Tap，**要求 macOS 14.2+**，preload 按 `process.getSystemVersion()` 门控 `audioSources`，不支持时设置收敛为 mic）；渲染层 `getDisplayMedia` 必须请求 **4×4 微型 video 轨**再丢弃——0×0 会触发 electron#49607 的静音 bug；主进程 handler 的 video 流用**请求方自身 frame**（`callback({ video: request.frame, audio: 'loopback' })`）而非 desktopCapturer 屏幕源——后者要求「屏幕录制」权限且取源失败会产生未处理拒绝，frame 方案两者皆免；Info.plist 需 `NSAudioCaptureUsageDescription`。**dev 模式大坑（2026-07-03 实测定性）**：CoreAudio Tap 的 TCC 责任进程是「启动 Electron 的父程序」——终端/IDE 拉起的 `pnpm dev` 责任在终端/IDE，其 Info.plist 无该 key，macOS 给**不弹窗、无报错的静音流**（Electron 官方文档明载）；同一代码经 `open` 以 Electron.app 自身身份启动即正常（本机实测 maxRms 0.18）。dev 下要测系统音频：给终端/IDE 手动授「仅录制系统音频」，或用 `pnpm dist:dir` 打包产物。排查用诊断脚本思路：getDisplayMedia 拿流 → AnalyserNode 测 RMS。麦克风权限只在环境音模式请求；系统音频权限被拒走错误码 `system-audio-permission`。
- **已否决**：Web 端系统音频（Chromium 141+/macOS 14.2+ 技术可行，但每次录音都要过屏幕共享选择器、Safari/Firefox 不支持，按「不支持」处理）；iOS 系统音频（三方 App 无实时途径，ReplayKit 广播不适用）；FireRedASR-AED-L 作中文首选（~1.1GB 且 CPU 实时性存疑，待评测基建建立后再议）。

**本地翻译模型注册表（2026-07-03）：**
- 与 ASR 同构的注册表多选：`m2m100`（默认，轻量 ~630MB）+ `mbart50`（Xenova/mbart-large-50-many-to-many-mmt，q8 ~890MB，基座 MIT，质量更高），均 platforms ['macos','web']；iOS 走 Apple Translation 不感知模型 id。设置页翻译方式三态「无/本地/云端」，本地时出模型下拉。
- **翻译模型选型已否决**：NLLB-200 与 SeamlessM4T（CC-BY-NC 不可商用）、MADLAD-400-3B（3B CPU 非实时）、M2M100-1.2B 与 SMaLL-100（MIT 但无现成 ONNX 转换，将来可自转再入册）、OPUS-MT（按语言对一模型，四语互译需 12 个且 ja↔zh 覆盖差）、端上 LLM（逐段生成太慢）。
- **mBART-50 已下架（2026-07-03，实证根因）**：q8 约 870MB 的推理在 **Electron utilityProcess 里触发 Chromium 分配器对超大分配的 SIGTRAP 终止**（EXC_BREAKPOINT，栈底 `_malloc_zone_memalign`；本机 utilityProcess 复现 100% 崩、与用户侧 Realtime Translator Helper 崩溃报告完全同源）——每段翻译崩一次子进程，UI 表现为行行「翻译失败」。**分端差异**：web（WASM 内存）可用（用户实测）、纯 Node（系统 malloc）可用、macOS utilityProcess 必崩——纯 Node 测试结果不能代表 utilityProcess，排查大模型问题必须在真实 utilityProcess 里复现。相对 M2M-100 体积增量收益有限（用户判断），不值得为其改造运行时，故下架。次生加固：翻译子进程构造期异常（如产物版本错位导致的未知引擎 id）已改为报错不崩溃。
- **翻译模型下载已统一自研链路（2026-07-03）**：spec 声明文件 URL、按 modelId 参数化下载（与当前引擎解耦，修复了管理页下载秒关）、落 Transformers.js 缓存布局后 `allowRemoteModels=false` 离线装载；下载进度统一走 setup:progress。**缓存键与下载源 URL 解耦**（web 端按 HF 目录式键 cache.put），模型可托管到 GitHub Releases（扁平资产名，单文件 2GB 内免流量费）——大文件不用 HF 账号也不用 LFS。
- **引入更大本地翻译模型的硬前置（已完成，2026-07-03）**：macOS 翻译子进程已改为 `ELECTRON_RUN_AS_NODE` 纯 Node child_process（c46519a，脱离 Chromium 分配器；打包态注意纯 Node 读不了 asar → fork 目标与翻译依赖闭包全部 asarUnpack，闭包经 Module._load hook 实测核定）。ASR 子进程保持 utilityProcess。
- **M2M100-1.2B 已上线（2026-07-03，自转换 + 自托管）**：官方无 ONNX（lopatnov 仓 fp32 6GB 不可用），用 transformers.js v3.7.6 官方 convert 脚本（torch 必须锁 2.5.x，新 torch 外置数据命名不兼容 pinned optimum）+ 手动收尾（>2GB 合并 decoder 无法单文件序列化 → **先逐个量化再合并 q8**，顺带把峰值内存从 25GB+ 降到 ~10GB——曾因直接合并 fp32 把整机内存打爆，重内存任务必须先估峰值、告知用户再跑）。418M/1.2B 分词器同源（spm oid 一致），tokenizer.json 直接复用 Xenova/418M。产物托管本仓 GitHub Release `models-v1`（扁平资产名前缀 m2m100_1.2B-，encoder 642MB + decoder 881MB，均 <2GB 资产限）；registry 的 modelId `realtime-translator/m2m100_1.2B` 仅作缓存布局键。门槛实测：ja↔zh 双向正确（mBART 翻车句全过）、每句 80~242ms、装载 1.8s。仅 macOS 放开（web WASM 装不下 1.5GB）。
- **模型资产双源（2026-07-03）**：全部模型文件（VAD/四个 ASR/M2M100 系）镜像到本仓 GitHub Release `models-v1`（资产名 `<模型id>-<原文件名>`，共 25 个）；注册表 url=自托管主源、fallbackUrl=上游（HF csukuangfj/Xenova、k2-fsa）。**关键事实：GitHub Release 资产不发 CORS 头**（302 与终点均无 ACAO，实测），浏览器 fetch 必败 → web 端经 `browserDownloadUrls` 跳过 GitHub 主源直用上游 HF（HF 有 CORS）；web 的 VAD 走站内静态资源（public/models/）。macOS（Node fetch）主用自托管、失败回退上游。新模型上镜像：文件传 models-v1 + 注册表双 URL 即可。
- **系统音频权限 UX（2026-07-03）**：CoreAudio Tap 无权限查询 API → 无法复刻麦克风的按状态分流；采用「首次说明弹窗（localStorage 标记 rt.systemAudioPrompted，本机一次）+ 被拒后（system-audio-permission 错误码）弹引导去 系统设置›屏幕与系统音频录制（openSystemAudioSettings 可选桥接，Privacy_ScreenCapture 锚点）」。

**识别丢失定性与管线范式（2026-07-04，重构后现状）：**
- **交叠语音（双人对谈互相插话）污染解码窗口前缀**：含污染前缀的窗口越长输出越坍缩（诊断日志实录：同段 [0.81,3.97] 解出完整问候、[0.81,7.56] 只剩「はい」），脱离污染前缀的窗口解码正常。这是模型固有行为，管线对策是控窗+单调提交（见下），不再靠定稿后抢救（旧「整窗重解码+三层抢救」范式已整体退役）。
- **管线现范式：滑动窗口 + 按模型分流提交**（`AsrModelSpec.commitStrategy`，A/B 实证选型）：
  - 非自回归（SenseVoice/paraformer）→ `agreement`（LocalAgreement-2）：连续两次解码的公共前缀落定、已提交音频滑出窗口逐出污染。**「前缀单调稳定」假设已于 2026-07-22 被证伪并修正**（翻供重基/定稿择长/标点容忍对齐，见 [pipeline-recant](pipeline-recant.md)）；
  - 自回归 transducer（reazon zipformer/NeMo TDT）→ `chunk`（定长 3s 分块提交）：增长窗口下输出**非单调震荡**（探针实录 [0,0.6]こんにちは→[0,1.2~2.4]はい→[0,3]完整句→[0,4.2]はい），agreement 会把震荡巧合当一致前缀锁死；而定长 3s 窗各自解码连贯（4s+ 开始整块坍缩），故按块独立解码提交、切点选块尾可信 token 间隙（≥0.25s，发射抖动会造假间隙）。
  - A/B 结论：两类模型在干净与交叠场景均不劣于旧范式，交叠下「整句无声丢失」显著改善（reazon 两场景各救回一整句）；残余瑕疵为块边界字词级毛刺与句尾短幻听，属模型行为，勿再加启发式抢救去修。
- 关键实现事实：sherpa-onnx node/WASM 的 result 均含 tokens/timestamps（同一 C API 序列化）；**reazon 的 durations 为空数组**，token 终点须按 ~0.2s 估计；transducer 时间戳是发射时刻、比声学起点偏晚（切点要回退）。短音频补零 ≥0.5s 防原生崩溃（reazon <0.1s 输入崩子进程）仍然必须保留。
- 双人对谈素材仍建议优先 SenseVoice（交叠退化更温和）；transducer 专用模型适合单人清晰语音。更彻底的后手（未做）：专用模型换 sherpa-onnx 真流式（streaming zipformer）变体，从模型层根除窗口重解码。

**模型配置化 + 下载体验重构（2026-07-04）：** 详见专题记忆 [model-config](model-config.md) 与 [download-ux](download-ux.md)，此处只记方向与对上文的取代。
- **模型下载配置化**：全项目「可用模型 / 下载地址 / 可用端」收敛到 `@rt/core` 单一事实源——统一清单 `model-registry.ts`（纯数据，ASR + 翻译一份、kind 判别）+ 源治理 `model-sources.ts`。**取代上文 2026-07-03 的资产双源字段命名**：文件级 `url`/`fallbackUrl`/`browserDownloadUrls` → **按端分源的有序列表 `nativeUrls`/`webUrls`**（native 自托管优先 + HF 上游兜底；web HF 主源 + 可选 `HF_MIRRORS` 镜像），下载器按序 fallback、每源只试一次。web 翻译缓存键主机固定为不可变 `TRANSFORMERS_REMOTE_HOST`（与可切换下载源解耦）。可用端新增能力门槛 `availability.memoryHeavy`（模型属性）× 宿主 `memoryConstrained`（iOS WebKit）——把「m2m100 在移动 Safari 不显示」从命令式 `isIOS()` 改为声明式。iOS `AsrModels.swift` 仍由 `gen-asr-models-swift.mjs` 从注册表生成（加了 chinese-conv 护栏、CI `gen:models --check`）。
- **下载体验重构**：**取代上文 2026-07-03「不可关闭的下载态 → 完成自动继续录音；取消即终止」与 2026-07-02「取消下载=翻译开关回退为关闭」**。现为：确认弹窗只征询 → **后台下载**（app 级管理器 `useModelDownloads`，**多模型并行**，进度事件带 kind/id 归属）；「模型管理」页行内进度条 + **取消(✕)**（新桥接契约 `cancelModelDownload`：按模型中止 + 删全部残留，三端实现）；点录音若模型在下 → **进度模态**，可取消本次录音而下载后台继续，下完自动开始录音。共享文件（Silero VAD，每个 ASR 模型都先下）并行去重：同一文件只真正下一路、其余等它完成后按落地/缓存计入。
- **续传现状（未改）**：三端文件级续传（重触发跳过已下完整文件）、无字节级续传、重开不自动续（用户接受「重新下载 + 弹窗」兜底）。

**反向翻译（母语→上一次的外语，2026-07-07）：**
- 需求：识别语言为 **auto** 时，听到母语的段不再「同语言跳过」，而是反向翻译到**上一次识别到的非母语语言**；识别语言为指定语言时理论上不会识别出母语，保持单向翻译（现有跳过逻辑不变）。
- 实现全落在 `@rt/core` 翻译编排（三端一致）：`planTranslation` 泛化——第 3 参 `nativeLang`→`targetLang`（翻向任意目标，判定逻辑不变），并抽出 `langIdentity(spec,lang)`（yue≠zh 的身份判定复用）。`segment-translation.ts` 新增 `ReverseTranslationContext`（`{ lastForeignLang }`）+ `createReverseTranslationContext()`，`translateFinalizedSegment` 在**任何 await 之前同步**跑 `resolveTargetLang`：外语段→记录 lastForeignLang、正向翻母语；母语段→仅当 `asrLanguage==='auto'` 且有外语历史时目标改为该外语，否则仍以母语为目标（→ 原 skip/script）。
- 状态载体是**各端桥接持有的模块级单例**（macOS main / web / iOS bridge 各 `const reverseCtx = createReverseTranslationContext()`，随 `asrLanguage`+`reverse` 一起传入）；**外语历史只在本次录音会话内有效**——三端在 `startPipeline` / `pipeline:start` 入口调 `resetReverseTranslationContext(reverseCtx)` 清空，故会话第一句若是母语则无可翻外语、直接不翻。未传 `reverse` 即关闭反向翻译（向后兼容）。
- 反向目标沿用检测到的源码：目标 en/ja/ko 无 toScript（不会把日文误做简体归一化）；yue 历史时 targetCode 回落 'zh' 但 targetLang 仍 'yue'（云端提示词据之产出粤语），属可接受边角。测试见 `segment-translation.test.ts`。

**Why:** 这些是对话里反复权衡过的方向性结论，避免以后重新讨论或推荐已否决的方案。
**How to apply:** 后续功能开发不要引入云端 STT、不要再加声纹说话人区分；推荐方案时记得用户的硬性约束是"普通用户开箱即用"。调识别准确率先跑 CER 评测留基线再动参数（`pnpm --filter @rt/macos eval-cer`，见 [asr-eval](asr-eval.md)）；新增 ASR 模型只加一份 `AsrModelSpec`（platforms 按端实测标注）。
