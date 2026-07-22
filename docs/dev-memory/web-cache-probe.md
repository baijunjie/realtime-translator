# web 端 Cache Storage 探测：性能与内存（模型管理页）

「模型管理」页曾在移动端出现两个连锁问题：每次打开空 1 秒多才出模型；反复切 tab 后标签页崩溃（内存耗尽）。根因是**模型列表探测缓存的方式**，两条经验须长期遵守。

## 红线一：判「是否已缓存」只用 `cache.keys()`，不要用 `cache.match()`

- `cache.match(key)` 返回 **`Response`**，其 body 绑定到缓存条目。ASR/翻译权重单文件可达数百 MB（parakeet 661MB、m2m100 640MB…），移动端 WebKit 的 Cache Storage 会把 body 读入内存。仅做存在性判断却反复 match 这些巨型条目 → 内存尖峰累积 → iOS 单标签页（~200–400MB 上限）被系统杀。
- `cache.keys()` 返回 **`Request`**（只有 URL、无 body）。存在性判断只需比对 URL 集合，`keys()` 足够且**绝不碰 body**。
- 归一化比对：`cache.put(key,…)` 存入的键即 `new Request(key).url`，故用 `new Set((await cache.keys()).map(r => r.url))` 后按 `set.has(new Request(cacheKey).url)` 判断。ASR 的 cacheKey 是站内路径、翻译的 cacheKey 是 HF resolve URL（与 Transformers.js 存入的键一致），两者都能命中。
- 落点：`apps/web/src/asr/model-store.ts` `areModelsCached`、`apps/web/src/translation/model-store.ts` `isTranslationModelCached`。桌面 Chrome 里 Cache body 是磁盘/off-heap 流式的，match 不进 JS 堆，所以桌面「不崩」——但这是实现差异，**不能**据此认为 match 安全，移动端会崩。

## 红线二：设置页分区是 v-if 重挂载，别在 onMounted 无脑重新探测

- `SettingsScreen.vue` 各分区用 `v-if`/`v-else-if` 渲染（无 `keep-alive`），每次切到「模型管理」都**重新挂载** `ModelsSection`。若在 `onMounted` 里直接 `listModels()`，就会每次全量探测 Cache Storage（移动端慢 + 内存压力，反复切累积到崩）。
- 方案：模型列表提到应用级单例 `packages/ui/src/composables/useModels.ts`（`models` 快照 + `refreshModels()` + 并发去重 `inFlight`）。**只在真正变化时刷新**：首次加载、下载完成/失败/取消（单例内 `onDownloadDone` 只注册一次）、删除/取消（`ModelsSection` 显式调 `refreshModels`）。其余进入页面直接用缓存快照 → 秒开。
- 注意：取消**失败态**下载是同步清理、不发 `onDownloadDone` 事件（见 [download-ux](download-ux.md) 的 `cancelDownload`），故删除/取消处必须显式 `refreshModels` 兜底，不能只依赖 done 监听。

## listModels 的字节数策略（沿用，勿改）

`bridge.listModels`（`apps/web/src/bridge.ts`）已下载条目的 `sizeBytes` 直接取注册表 `approxBytes`/`approxDownloadBytes`，**不逐条读 blob 统计真实字节**——Cache API 无低成本取真实大小的途径，读 blob 会把数百 MB 拉进内存，与红线一同理。
