// 从 @rt/core 的共享 ASR 模型登记表生成 Swift 常量文件 AsrModels.swift。
//
// 目的：iOS 原生下载器 / 路径解析 / 识别器装配必须消费与 macOS 同一份登记表
// （packages/core/src/models.ts 的 ASR_MODELS / SILERO_VAD），不在 Swift 里各自硬编码
// URL/文件名/目录/角色，避免与 macOS 漂移。Swift 运行时无法 import TS 模块，因此用本脚本
// 把登记表编译期“拍平”成一个生成的 Swift 文件并提交进仓库。
//
// 用法：
//   pnpm --filter @rt/ios gen:models          # 写出 AsrModels.swift
//   pnpm --filter @rt/ios gen:models --check   # 只校验已提交的生成物是否最新（CI 用）
//
// @rt/core 以源码 TS 形式发布（main: src/index.ts，靠 bundler 消费），普通 Node ESM
// 无法直接 import。models.ts 是从统一清单 model-registry.ts（纯数据）派生的 ASR 视图，仅静态可达
// 纯数据/纯逻辑（model-registry + 构造下载源 URL 的 model-sources），故这里用 esbuild 打包这一子图
// （内联 model-registry / model-sources、擦除 type-only 的 ./types 引用）转成自包含 JS 后动态 import，
// 绕开 @rt/core 整个 barrel 的解析。**红线**：models.ts 绝不能 import translation/local-spec 或任何带
// 运行时行为的翻译模块（如 chinese-conv），否则会被 bundle 进 iOS 产物——本脚本对此有护栏（见下）。
//
// 生成物只包含 platforms 含 'ios' 的模型（iOS 目前仅 sense-voice）+ 公共依赖 Silero VAD。
//
// 注意：生成的 AsrModels.swift 是“生成物”，请勿手改——改 packages/core/src/models.ts 后重跑本脚本。

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const modelsTs = path.join(repoRoot, 'packages', 'core', 'src', 'models.ts');
const outPath = path.join(here, '..', 'ios', 'AsrModels.swift');

// esbuild 打包 models.ts 这一子图：内联其运行时依赖（model-registry / model-sources）、擦除 type-only
// 的 ./types 引用，产出自包含 ESM（不写盘）。
const { outputFiles } = await build({
  entryPoints: [modelsTs],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'esnext',
  write: false,
});
const jsSource = outputFiles[0].text;

// 护栏：ASR 子图必须纯净——绝不能静态可达翻译行为（chinese-conv 等），否则会被 bundle 进 iOS 产物、
// 凭空多一个带数据文件的依赖甚至打包失败。若命中说明有人把翻译行为拖进了以 models.ts 为入口的子图。
if (jsSource.includes('chinese-conv')) {
  throw new Error(
    '[gen:models] ASR 子图意外包含 chinese-conv：请确保 packages/core/src/models.ts 不 import ' +
      'translation/local-spec 或任何带运行时行为的翻译模块（统一清单 model-registry 须保持纯数据）。',
  );
}
// 以 data: URL 动态 import，拿到登记表常量。
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(jsSource).toString('base64');
const { ASR_MODELS, SILERO_VAD, DEFAULT_ASR_MODEL_ID } = await import(dataUrl);

const swiftString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// platforms 含 'ios' 的模型才编进 iOS 生成物。
const iosModels = ASR_MODELS.filter((m) => m.platforms.includes('ios'));

/** 一个 AsrModelFile 的 Swift 字面量（缩进由调用方拼接）。 */
function fileLiteral(f, role) {
  const urls = f.nativeUrls.map(swiftString).join(', ');
  return (
    `AsrModelFile(urls: [${urls}], ` +
    `filename: ${swiftString(f.filename)}, ` +
    `dir: ${swiftString(f.dir)}, ` +
    `role: ${swiftString(role ?? f.role ?? '')}, ` +
    `approxBytes: ${f.approxBytes})`
  );
}

const modelEntries = iosModels
  .map((m) => {
    const files = m.files.map((f) => `        ${fileLiteral(f)},`).join('\n');
    return (
      `    AsrModelSpec(\n` +
      `      id: ${swiftString(m.id)},\n` +
      `      dir: ${swiftString(m.dir)},\n` +
      `      engine: ${swiftString(m.engine)},\n` +
      `      files: [\n${files}\n      ],\n` +
      `      approxBytes: ${m.approxBytes}\n` +
      `    ),`
    );
  })
  .join('\n');

const out = `// AsrModels.swift — GENERATED, do not edit by hand.
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
  /// 下载源有序列表（native：自托管 GitHub Release 优先 + HF 上游兜底）。下载器按序尝试、每个只试一次，
  /// 全部失败才判失败；URLSession 自动跟随重定向。
  let urls: [String]
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
  static let defaultModelId = ${swiftString(DEFAULT_ASR_MODEL_ID)}

  /// Silero VAD：所有 ASR 模型共用的语音端点检测依赖，不进模型选择列表，随任一模型一并下载。
  static let vad = ${fileLiteral(SILERO_VAD, '')}

  /// iOS 支持的全部 ASR 模型规格（platforms 含 'ios'）。
  static let models: [AsrModelSpec] = [
${modelEntries}
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
`;

if (process.argv.includes('--check')) {
  // CI 模式：不写盘，只校验已提交的生成物是否与当前登记表一致。
  const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
  if (current !== out) {
    console.error(
      `[gen:models] ${path.relative(repoRoot, outPath)} 已过期，请运行 ` +
        '`pnpm --filter @rt/ios gen:models` 并提交。',
    );
    process.exit(1);
  }
  console.log('[gen:models] up to date');
} else {
  fs.writeFileSync(outPath, out, 'utf8');
  console.log(`[gen:models] wrote ${path.relative(repoRoot, outPath)}`);
}
