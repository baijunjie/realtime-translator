# sherpa-onnx WebAssembly (vad-asr, single-threaded)

浏览器端 Silero VAD + 语音识别（SenseVoice / Paraformer / ReazonSpeech / Parakeet）用的
WASM 产物。运行时由 `src/asr/sherpa-worker.ts` 在 Web Worker 里 `importScripts` 加载;
模型文件(silero_vad.onnx 与各识别模型的权重/词表)**不在这里**,由 `src/asr/model-store.ts`
运行时从 HuggingFace（`@rt/core` 的 `ASR_MODELS`）拉取并缓存进 Cache Storage,再写入
WASM 文件系统。

文件:
- `sherpa-onnx-wasm-main-vad-asr.js` / `.wasm` — Emscripten 胶水 + 编译产物
- `sherpa-onnx-asr.js` / `sherpa-onnx-vad.js` — OfflineRecognizer / Vad 包装类(官方 wrapper)

## 为什么自己构建（单线程）
官方预编译是**多线程**(`-pthread` + SharedArrayBuffer),需要 COOP/COEP 跨源隔离 ——
在 GitHub Pages 上要靠 service-worker 垫片,且 COEP 会挡住从 HuggingFace 跨源拉模型、
iOS Safari 也不支持 credentialless。**单线程构建免去这一切**:无需任何响应头,模型可直接
跨源 fetch,iOS 也能用。

## 如何重建（升级 sherpa-onnx 或模型时）
```bash
# 1) emsdk（Emscripten 4.0.23）
git clone https://github.com/emscripten-core/emsdk && cd emsdk
./emsdk install 4.0.23 && ./emsdk activate 4.0.23 && source ./emsdk_env.sh
brew install cmake   # 构建需要

# 2) sherpa-onnx
git clone https://github.com/k2-fsa/sherpa-onnx && cd sherpa-onnx

# 3) 去掉线程、改成运行时加载模型，再构建：
#   - 根 CMakeLists.txt：删掉给 WASM 目标强加的 -pthread（约 333-341 行）
#   - wasm/vad-asr/CMakeLists.txt：删 -pthread / PTHREAD_POOL_SIZE；
#     删 `--preload-file ...assets@.` 与 assets 不存在时的 FATAL_ERROR（模型运行时再写入 FS）；
#     EXPORTED_RUNTIME_METHODS 增加 FS、cwrap；加 -sENVIRONMENT=web,worker
./build-wasm-simd-vad-asr.sh

# 4) 产物在 build-wasm-simd-vad-asr/install/bin/wasm/vad-asr/，拷贝这 4 个文件到本目录。
#    校验：glue 里不应再出现 SharedArrayBuffer / em-pthread / ENVIRONMENT_IS_PTHREAD。
```
基于 k2-fsa/sherpa-onnx（master，2025-06），ONNX Runtime WASM 静态库 1.24.4。
