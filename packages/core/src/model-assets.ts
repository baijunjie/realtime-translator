// 模型下载资产的源治理（平台无关，纯逻辑）：自托管 GitHub Release 主源的 URL 构造，
// 以及浏览器端受 CORS 约束的源选择。ASR 与翻译两个注册表、macOS 与 web 两端共用，
// 避免各处硬编码基址/判定而漂移。
//
// 双源策略：模型资产以自托管 GitHub Release 为主源、上游（HF/k2-fsa 等）为 fallback。
// macOS 为 Node fetch（无 CORS 约束）→ 主用自托管、失效回退上游；web 为浏览器 fetch
// （受 CORS 约束）→ 见 browserDownloadUrls。

/**
 * 自托管模型资产的 GitHub Release 基址。资产以扁平命名 `<模型id>-<原文件名>`
 * （公共依赖 Silero VAD 无前缀）上传到同一 Release tag，各注册表据此构造主源直链。
 */
const GH_RELEASE_ASSET_BASE =
  'https://github.com/baijunjie/realtime-translator/releases/download/models-v1';

/** 构造自托管 GitHub Release 资产的下载直链。asset 为已按约定命名的扁平资产名。 */
export function ghModelAsset(asset: string): string {
  return `${GH_RELEASE_ASSET_BASE}/${asset}`;
}

/** 是否为 GitHub Release 资产直链（github.com/<owner>/<repo>/releases/download/…）。 */
export function isGithubReleaseUrl(url: string): boolean {
  return /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//.test(url);
}

/**
 * 浏览器端可依次尝试的下载源（按优先级）。设计约束：GitHub Release 资产不发 CORS 头
 * （两跳 302→200 均无 access-control-allow-origin），浏览器 fetch 必败——故自托管的
 * GitHub 主源在 web 端不可用，直接跳过、改用上游 fallback（HF 发 CORS 头）；主源非
 * GitHub（未来其他 CORS 可用源）则先试主源、失败再回退 fallback。
 * 返回空数组表示浏览器端无可用源（调用方应报明确错误）。
 */
export function browserDownloadUrls(url: string, fallbackUrl?: string): string[] {
  const urls = isGithubReleaseUrl(url) ? [] : [url];
  if (fallbackUrl) urls.push(fallbackUrl);
  return urls;
}
