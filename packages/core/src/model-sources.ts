// 模型下载源的单一治理点（平台无关、纯逻辑）：所有下载源基址 / host / release tag / 命名约定
// 收敛于此。ASR 与翻译两类模型、macOS/iOS/web 三端共用，避免各处硬编码基址而漂移。
//
// 按端分源：native（macOS/iOS，Node fetch / URLSession，自动跟随重定向、不受 CORS 约束）优先走
// 自托管 GitHub Release；web（浏览器 fetch，受 CORS 约束）走发 CORS 头的上游 HuggingFace 源。
// 每个文件在每一端都是一个「有序 URL 列表」，下载器按序尝试、每个只试一次、全部失败才判失败
// （见各端下载器）。上游可追加镜像做 fallback（HF_MIRRORS）。
//
// 关键：下载源（可切换镜像）与 Transformers.js 缓存键（不可变，见 TRANSFORMERS_REMOTE_HOST）
// 严格分离——换镜像只影响下载走哪个地址，缓存键恒定，web 翻译离线加载才不会 miss。

/**
 * 自托管模型资产源（GitHub Release）。资产以扁平命名 `<模型id>-<原文件名>`
 * （公共依赖 Silero VAD 无前缀）上传到同一 release tag，各注册表据此构造下载直链。
 */
export const SELF_HOSTED = {
  host: 'https://github.com',
  owner: 'baijunjie',
  repo: 'realtime-translator',
  tag: 'models-v1',
} as const;

/** 上游 HuggingFace 主机（web 端下载主源，可切换镜像；见 HF_MIRRORS）。 */
export const HF = {
  host: 'https://huggingface.co',
} as const;

/**
 * 可选的 HuggingFace 下载镜像，按序追加到主源之后作为 fallback（如国内 'https://hf-mirror.com'）。
 * 空数组表示无镜像兜底。**只影响下载源**，绝不影响 Transformers.js 缓存键（见 TRANSFORMERS_REMOTE_HOST）。
 */
export const HF_MIRRORS: readonly string[] = [];

/**
 * Transformers.js 浏览器端缓存键使用的固定主机（其 env.remoteHost 默认值）。web 翻译模型以
 * allowRemoteModels=false 离线加载时，Transformers.js 按此主机构造缓存键 cache.match，故此值
 * **不可变、绝不跟随 HF 下载镜像切换**——否则 web 下载落在镜像键、而离线加载按此主机键查找，缓存全 miss。
 * 与下载源（HF/HF_MIRRORS）解耦：下载走哪个镜像都行，缓存键恒为此主机。
 */
export const TRANSFORMERS_REMOTE_HOST = 'https://huggingface.co/';

/** 构造自托管 GitHub Release 资产的下载直链。asset 为已按约定命名的扁平资产名。 */
export function selfHostedAsset(asset: string): string {
  const { host, owner, repo, tag } = SELF_HOSTED;
  return `${host}/${owner}/${repo}/releases/download/${tag}/${asset}`;
}

/**
 * 构造某 HuggingFace 仓库某文件的上游 resolve 直链列表（主源 + 各镜像，按序，主源在首）。
 * @param repo 仓库标识，形如 'csukuangfj/sherpa-onnx-...' 或 'Xenova/m2m100_418M'
 * @param rel  仓内相对路径（含子目录，如 'onnx/encoder_model_quantized.onnx'）
 */
export function hfResolveUrls(repo: string, rel: string): string[] {
  return [HF.host, ...HF_MIRRORS].map((host) => `${host}/${repo}/resolve/main/${rel}`);
}
