// 渲染层共用的字节数人类可读格式化

/** 字节数 → 人类可读大小（MB/GB，保留一位小数）。用于模型大小/下载体积展示。 */
export function humanBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
}
