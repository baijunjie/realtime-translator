# 产品全貌与平台能力

Realtime Translator 是面向中文、日语、英语和韩语的实时语音转写与翻译应用。macOS、iOS 和 Web 共用同一套交互与业务规则，音频采集、识别、本地翻译和存储由各平台自行实现。

它面向需要跨语言实时字幕的用户，典型用途包括：

- 面对面对话或单人发言的实时转写与翻译；
- 将发言者的中、日、英、韩语内容转换成用户母语字幕；
- 在 macOS 14.2 及以上对电脑正在播放的系统音频生成字幕；
- 保存一次会话的已定稿原文与译文，以便稍后查看。

具体交互与翻译规则见[使用流程与产品规则](experience.md)。

## 本地处理与隐私边界

- 三端的语音识别都在当前设备上运行，应用不把音频发送给识别服务。
- 选择本地翻译时，译文也在当前设备上生成。macOS 和 Web 使用本地 M2M-100 模型；iOS 使用 Apple Translation。
- 选择云端翻译时，只有需要翻译的已定稿文本段会发送到用户配置的 OpenAI 兼容端点；同语言跳过及仅需中文字形归一化的段不发送。在设置中测试连接会发送固定的 `hello` 测试文本。音频始终不发送，端点的数据处理规则由对应服务商决定。
- 应用启动时不自动下载识别或翻译权重。用户确认下载后，应用才从模型源获取文件；Web 的 Silero VAD 是随应用外壳提供的内置例外。
- 设置、模型和会话归档只保存在当前设备或当前浏览器站点存储中，产品没有跨设备同步。
- macOS 在系统 `safeStorage` 可用时加密保存云端 API Key；加密不可用时为保证功能会明文落盘。Web 和 iOS 分别将 API Key 随设置保存到 IndexedDB 和 Preferences，应用本身不做额外加密。

## 平台能力

| 能力 | macOS | iOS 原生应用 | Web / PWA |
| --- | --- | --- | --- |
| 音频源 | 麦克风；macOS 14.2+ 可选系统音频 | 仅麦克风 | 仅麦克风 |
| 语音识别 | SenseVoice；可按语言选 Paraformer、ReazonSpeech 或 Parakeet | SenseVoice | SenseVoice；可按语言选 Paraformer、ReazonSpeech 或 Parakeet |
| 识别运行时 | sherpa-onnx Node，独立 ASR 子进程 | sherpa-onnx 原生插件 | sherpa-onnx 单线程 WASM Worker |
| 本地翻译 | M2M-100 418M 或 1.2B | Apple Translation，iOS 18+ | M2M-100 418M；iOS/iPadOS WebKit 上禁用 |
| 云端翻译 | 支持 | 支持 | 支持 |
| 主要存储 | Electron `userData` 中的文件和模型目录 | Preferences（设置/归档）与 Application Support（ASR 模型） | IndexedDB（设置/归档）与 Cache Storage（模型/应用外壳） |
| 离线使用 | 所需模型已下载时可用 | ASR 模型已下载时可离线转写；本地翻译还需对应的 Apple 翻译语言包 | 应用外壳和所需模型已缓存时可用 |

### macOS

macOS 版是 Electron 应用。麦克风由渲染进程采集；系统音频通过 CoreAudio Tap 回环采集，因此只在 macOS 14.2 及以上显示音源切换。ASR 与本地翻译分别运行在隔离子进程中，某个推理进程崩溃不会连带关闭主窗口。

### iOS 原生应用

iOS 版是 Capacitor WebView 与原生插件的组合。识别只提供多语种 SenseVoice；音频由原生 `AVAudioEngine` 采集。本地翻译依赖 Apple Translation，要求 iOS 18 及以上，并由系统管理翻译语言包；首次使用某个语言对时，系统可能显示语言包下载或同意界面。当系统版本、语言对或语言包不可用时，本地翻译会失败，用户可改用云端翻译。

### Web / PWA

Web 版可在浏览器中直接使用，也可安装为 PWA。应用外壳和 sherpa WASM 由 Service Worker 预缓存；内置 Silero VAD 由同源资源按需写入 ASR 模型缓存，其余识别与本地翻译模型也按需缓存。已安装 PWA 可在保留模型缓存的同时强制刷新应用外壳。云端翻译和首次下载仍需要网络。

iPhone 和 iPad 上的 WebKit 单标签页无法同时容纳 ASR 与 M2M-100 的内存占用，因此在这类浏览器上不显示本地翻译选项，仅可选关闭翻译或云端翻译。
