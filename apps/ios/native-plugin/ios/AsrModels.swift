// AsrModels.swift — GENERATED, do not edit by hand.
//
// 由 apps/ios/native-plugin/scripts/gen-asr-models-swift.mjs 从 @rt/core 的共享
// ASR 模型登记表（packages/core/src/models.ts）生成。登记表变更后请重跑：
//   pnpm --filter @rt/ios gen:models
//
// 与 macOS 端 (apps/macos/src/main/model-downloader.ts) 消费同一份登记表，保证
// URL/文件名/目录/角色/校验清单不漂移。只含 platforms 含 'ios' 的模型 + 公共依赖 Silero VAD。

import Foundation

/// 单个需下载的 ASR 模型文件（对应 @rt/core 的 AsrModelFile）。
struct AsrModelFile {
  /// 远程下载地址（URLSession 会自动跟随 GitHub/HF 重定向）。
  let url: String
  /// 落地文件名。
  let filename: String
  /// 目标子目录（相对 models 根目录）。空串表示直接放在 models 根目录下。
  let dir: String
  /// 该文件在识别器配置中的角色（model/tokens/encoder/decoder/joiner）；公共依赖 VAD 为空串。
  let role: String
  /// 近似大小（字节），用于下载进度估算，非精确值。
  let approxBytes: Int
}

/// 一个可选用的 ASR 模型规格（对应 @rt/core 的 AsrModelSpec，已按平台过滤为仅含 iOS 支持者）。
struct AsrModelSpec {
  /// 注册表 id（设置 asr.model 存的就是它）。
  let id: String
  /// 模型文件所在子目录（相对 models 根目录）。
  let dir: String
  /// 识别引擎类型，供装配对应的 sherpa-onnx 识别器（iOS 目前仅 senseVoice）。
  let engine: String
  /// 该模型的全部需下载文件（不含公共依赖 Silero VAD）。
  let files: [AsrModelFile]
  /// 该模型全部文件合计近似字节。
  let approxBytes: Int
}

enum AsrModels {
  /// 默认 ASR 模型 id（多语种、全平台可用）。
  static let defaultModelId = "sense-voice"

  /// Silero VAD：所有 ASR 模型共用的语音端点检测依赖，不进模型选择列表，随任一模型一并下载。
  static let vad = AsrModelFile(url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx", filename: "silero_vad.onnx", dir: "", role: "", approxBytes: 643854)

  /// iOS 支持的全部 ASR 模型规格（platforms 含 'ios'）。
  static let models: [AsrModelSpec] = [
    AsrModelSpec(
      id: "sense-voice",
      dir: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
      engine: "senseVoice",
      files: [
        AsrModelFile(url: "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx", filename: "model.int8.onnx", dir: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17", role: "model", approxBytes: 239233841),
        AsrModelFile(url: "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt", filename: "tokens.txt", dir: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17", role: "tokens", approxBytes: 315894),
      ],
      approxBytes: 239549735
    ),
  ]

  /// 按 id 取模型规格。
  static func model(id: String) -> AsrModelSpec? {
    return models.first { $0.id == id }
  }

  /// 某模型的全部必需文件（公共依赖 Silero VAD + 该模型自身文件）；未知 id 仅返回 VAD。
  static func requiredFiles(id: String) -> [AsrModelFile] {
    return [vad] + (model(id: id)?.files ?? [])
  }
}
