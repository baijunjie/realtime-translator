// 模型下载资产的源治理（平台无关，纯逻辑）：自托管 GitHub Release 源的 URL 构造。
// ASR 与翻译两个注册表、macOS 与 web 两端共用，避免各处硬编码基址而漂移。
//
// 按端分源：下载源按平台固定、各端单源、无回退。macOS/iOS 走自托管 GitHub Release
// （注册表 AsrModelFile.url / LocalModelFile.url）；web 因浏览器 fetch 受 CORS 约束、
// 而 GitHub Release 资产不发 CORS 头，改走发 CORS 头的上游 HF 源（注册表里的 webUrl，
// 仅 platforms 含 web 的模型设）。上游 web 源直接写在各注册表里，本模块只构造自托管源直链。

/**
 * 自托管模型资产的 GitHub Release 基址。资产以扁平命名 `<模型id>-<原文件名>`
 * （公共依赖 Silero VAD 无前缀）上传到同一 Release tag，各注册表据此构造下载直链。
 */
const GH_RELEASE_ASSET_BASE =
  'https://github.com/baijunjie/realtime-translator/releases/download/models-v1';

/** 构造自托管 GitHub Release 资产的下载直链。asset 为已按约定命名的扁平资产名。 */
export function ghModelAsset(asset: string): string {
  return `${GH_RELEASE_ASSET_BASE}/${asset}`;
}
