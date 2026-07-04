// 浏览器 PWA 平台桥接：实现 @rt/core 的 AppBridge，注入给 @rt/ui。
// 镜像 apps/ios/src/bridge.ts 的结构，但全部用浏览器原生能力：
//
// 各能力来源：
//  - 设置 / 归档持久化：IndexedDB（idb 库），纯逻辑复用 @rt/core
//    （makeDefaults / withDefaults / listSummaries / makeArchiveId / toSummary）。
//  - 翻译：segment 到达且开启翻译时翻成母语，两种引擎与 macOS 对齐：
//    · engine==='cloud' → @rt/core CloudTranslator（fetch OpenAI 兼容端点）。
//    · 否则（本地）      → Transformers.js（浏览器内 WASM，见 ./translation），具体模型由注册表
//      LOCAL_TRANSLATION_MODELS 按当前 engine 选定（默认 m2m100）。
//    简繁等目标脚本后处理沿用所选 spec 的 toScript（两条路径一致）。
//  - 麦克风权限：navigator.permissions.query；openMicSettings 浏览器无法打开系统设置，空实现。
//  - ASR：Phase 2 真识别。getUserMedia + AudioWorklet 采麦（见 ./asr/web-asr），帧送进经典 Web Worker
//    (./asr/sherpa-worker) 跑 sherpa-onnx WASM（Silero VAD + 按 modelId 选定的离线识别器）。模型从
//    @rt/core ASR_MODELS 下载并缓存在 Cache Storage（见 ./asr/model-store），写入 WASM FS 后识别。
//    单线程 WASM，无需 COOP/COEP。
//
// 全部能力均已实现（可在此环境验证类型 + 打包）：设置、归档、云 + 本地翻译、事件转发、回调注册、
// 采麦 + sherpa-onnx WASM 实时识别、getSetupStatus（查缓存）、downloadAsrModels（边下边报进度）。

import { openDB, type IDBPDatabase } from 'idb';
import {
  makeDefaults,
  withDefaults,
  listSummaries,
  makeArchiveId,
  CloudTranslator,
  availableTranslationModels,
  localTranslationSupported,
  DEFAULT_TRANSLATION_MODEL_ID,
  getTranslationModel,
  translateFinalizedSegment,
  createCallbackHub,
  ASR_MODELS,
  getAsrModel,
  DEFAULT_ASR_MODEL_ID,
} from '@rt/core';
import type {
  AppBridge,
  AppSettings,
  ArchiveLine,
  ArchiveRecord,
  ArchiveSummary,
  CloudTranslationConfig,
  LocalModelSpec,
  StartResult,
  MicPermission,
  ModelInfo,
  ModelKind,
  SetupStatus,
  SetupProgress,
  SegmentPayload,
  PartialPayload,
  TranslationPayload,
  StatusPayload,
  TranslationStatusPayload,
} from '@rt/core';
import { WebAsr } from './asr/web-asr';
import {
  areModelsCached,
  ensureModelsCached,
  deleteAsrModelFromCache,
  ASR_MODEL_CACHE_NAME,
} from './asr/model-store';
import { WebLocalTranslator } from './translation/web-local-translator';
import {
  TRANSFORMERS_CACHE_NAME,
  isTranslationModelCached,
  ensureTranslationModelCached,
  deleteTranslationModelFromCache,
} from './translation/model-store';
import { isIOS } from './platform';

const DB_NAME = 'realtime-translator';
const DB_VERSION = 1;
const KV_STORE = 'kv'; // 设置等单键值
const ARCHIVE_STORE = 'archives'; // 归档记录，keyPath = id
const SETTINGS_KEY = 'settings';

// iOS/iPadOS 的 WebKit 单标签页内存装不下本地翻译模型（与 ASR 共存会崩，且 4-bit 量化在
// ORT-web 里也跑不起来），故这些设备不提供本地翻译、引擎恒为云端。所有产出 settings 的
// 路径（读/写）统一经此收口，保证 getSettings 与翻译热路径看到的引擎一致，且不会去建本地模型。
function applyPlatformConstraints(s: AppSettings): AppSettings {
  // 内存受限运行环境（iOS/iPadOS WebKit 单标签页）：本地翻译大模型与 ASR 共存会 OOM，
  // 故本地翻译按内存门槛排除（见 @rt/core availableTranslationModels）。
  const memoryConstrained = isIOS();
  // web 不支持系统音频（getDisplayMedia 无法可靠采到系统声音），音源恒收敛为麦克风。
  s.audioSource = 'mic';
  // 识别模型若在 web 平台不可用（注册表 platforms 不含 web，或 id 未知），回落默认模型
  // （sense-voice，全平台可用且支持全部识别语言，与已归一化的 asr.language 不冲突）。
  const spec = getAsrModel(s.asr.model);
  if (!spec || !spec.platforms.includes('web')) {
    s.asr.model = DEFAULT_ASR_MODEL_ID;
  }
  // 本地翻译引擎：仅当在本端「实际可用」（含内存门槛）时保留；否则若默认本地模型仍可用则回落它，
  // 否则回落云端。iOS/iPadOS WebKit 上全部本地翻译因 memoryHeavy 被排除 → 恒回落 cloud
  // （回落前先判默认模型是否可用，避免把被排除的默认模型又选回、与门槛互相打架）。
  if (s.translation.engine !== 'cloud') {
    const available = availableTranslationModels('web', { memoryConstrained });
    const stillOk = available.some((m) => m.id === s.translation.engine);
    if (!stillOk) {
      s.translation.engine = available.some((m) => m.id === DEFAULT_TRANSLATION_MODEL_ID)
        ? DEFAULT_TRANSLATION_MODEL_ID
        : 'cloud';
    }
  }
  return s;
}

export function createWebBridge(): AppBridge {
  // —— UI 注册的回调（mountApp → registerTranscriptionListeners 时注入） ——
  const segmentCb = createCallbackHub<SegmentPayload>();
  const partialCb = createCallbackHub<PartialPayload>();
  const translationCb = createCallbackHub<TranslationPayload>();
  const statusCb = createCallbackHub<StatusPayload>();
  const translationStatusCb = createCallbackHub<TranslationStatusPayload>();
  const setupProgressCb = createCallbackHub<SetupProgress>();

  // 各模型在途下载的中止句柄（后台并行下载 + 按模型取消用），键为 `${kind}:${id}`。
  // cancelModelDownload 只 abort 对应模型的在途 fetch；下载结束时删除自身条目。
  const downloadAborts = new Map<string, AbortController>();

  // —— 缓存设置：翻译热路径（segment 到达）同步读开关/引擎/母语，免得每段都 await IndexedDB。
  //    翻译开关就是 cachedSettings.translation.enabled，改后即时生效并落盘，不再另存一份布尔。 ——
  let cachedSettings: AppSettings | null = null;

  // —— 本地翻译器（懒建，缓存模型实例，首次翻译触发下载）。按当前引擎对应的 spec 建：
  //    引擎变化（切换本地模型）时丢弃旧实例、按新 spec 重建，保证保存路径与翻译热路径一致。 ——
  let localTranslator: WebLocalTranslator | null = null;
  let localTranslatorId: string | null = null;

  // 当前设置对应的本地翻译模型 spec：engine 为 cloud/未知时回落默认本地模型（仅作占位，
  // 云端路径不会用到它做推理）。applyPlatformConstraints 已保证 engine 为 web 可用的本地 id 或 cloud。
  function currentTranslationSpec(): LocalModelSpec {
    const engine = cachedSettings?.translation.engine;
    const id = engine && engine !== 'cloud' ? engine : DEFAULT_TRANSLATION_MODEL_ID;
    return getTranslationModel(id) ?? getTranslationModel(DEFAULT_TRANSLATION_MODEL_ID)!;
  }

  function getLocalTranslator(): WebLocalTranslator {
    const spec = currentTranslationSpec();
    if (!localTranslator || localTranslatorId !== spec.id) {
      localTranslator = new WebLocalTranslator(spec);
      localTranslatorId = spec.id;
    }
    return localTranslator;
  }

  // —— 本地模型预热（只装载不翻译）：把已下载的模型从 Cache Storage 读入内存（Worker 内
  //    allowRemoteModels=false，未缓存直接报错、绝不联网）。状态经 onTranslationStatus 上报
  //    loading→ready/error，不带字节进度（下载进度归 onSetupProgress，见 downloadTranslationModel）。
  //    warmUp 幂等、重复调用安全；失败向上抛，供不关心结果的调用方自行 .catch 吞掉（错误已上报）。 ——
  async function warmUpLocalModel(): Promise<void> {
    translationStatusCb.emit({ state: 'loading' });
    return getLocalTranslator()
      .warmUp()
      .then(() => {
        translationStatusCb.emit({ state: 'ready' });
      })
      .catch((e) => {
        console.error('[translate:warmup]', e);
        translationStatusCb.emit({
          state: 'error',
          error: e instanceof Error ? e.message : String(e),
        });
        throw e;
      });
  }

  // —— IndexedDB 句柄（懒开，幂等） ——
  let dbPromise: Promise<IDBPDatabase> | null = null;
  function db(): Promise<IDBPDatabase> {
    if (!dbPromise) {
      dbPromise = openDB(DB_NAME, DB_VERSION, {
        upgrade(database) {
          if (!database.objectStoreNames.contains(KV_STORE)) {
            database.createObjectStore(KV_STORE);
          }
          if (!database.objectStoreNames.contains(ARCHIVE_STORE)) {
            database.createObjectStore(ARCHIVE_STORE, { keyPath: 'id' });
          }
        },
      }).catch((e) => {
        // 打开失败复位，允许下次重试；否则缓存的 rejected promise 会让后续读写永久失败。
        dbPromise = null;
        throw e;
      });
    }
    return dbPromise;
  }

  // ---- 持久化：设置 ----
  async function readSettings(): Promise<AppSettings> {
    const defaults = makeDefaults(navigator.languages ? [...navigator.languages] : []);
    let raw: unknown = null;
    try {
      raw = (await (await db()).get(KV_STORE, SETTINGS_KEY)) ?? null;
    } catch {
      raw = null;
    }
    cachedSettings = applyPlatformConstraints(withDefaults(raw, defaults));
    return cachedSettings;
  }

  // 写设置：补齐/校验后落盘并刷新缓存。所有写入路径（保存设置、切翻译开关）都走这里。
  async function writeSettings(next: AppSettings): Promise<AppSettings> {
    cachedSettings = applyPlatformConstraints(withDefaults(next, makeDefaults([])));
    await (await db()).put(KV_STORE, cachedSettings, SETTINGS_KEY);
    return cachedSettings;
  }

  // 首次读取去重：启动预读与 UI 首次 getSettings() 并发触发，共享同一次 IndexedDB 读；
  // 读完即释放，之后再调用会重新读盘（保存后仍能拿到最新值）。
  let readInFlight: Promise<AppSettings> | null = null;
  function readSettingsOnce(): Promise<AppSettings> {
    if (!readInFlight) {
      readInFlight = readSettings().finally(() => {
        readInFlight = null;
      });
    }
    return readInFlight;
  }

  // ---- 持久化：归档 ----
  async function readArchives(): Promise<ArchiveRecord[]> {
    try {
      const all = (await (await db()).getAll(ARCHIVE_STORE)) as ArchiveRecord[];
      return Array.isArray(all) ? all : [];
    } catch {
      return [];
    }
  }

  // ---- 翻译：segment 到达时按当前设置翻成母语。编排（是否翻 / pending / 字形归一化 /
  //      错误上报）统一在 @rt/core.translateFinalizedSegment，三端一致；这里只注入引擎调用：
  //      云端 CloudTranslator 或本地 WebLocalTranslator（首次下载模型的进度经 status 上报）。 ----
  async function translateSegment(seg: SegmentPayload): Promise<void> {
    const s = cachedSettings ?? (await readSettingsOnce());
    await translateFinalizedSegment({
      // 规划用 spec 按当前引擎查表；云端/未知回落默认本地模型（skip/script/toScript 判定与模型无关，
      // 云端路径只用 targetLang 而非 targetCode，故回落不影响云端译文）。
      spec: currentTranslationSpec(),
      segment: seg,
      enabled: s.translation.enabled,
      nativeLang: s.nativeLang,
      translate: (req) => {
        if (s.translation.engine === 'cloud') {
          // 云端传母语 app 语言键（zh-Hant 等），让 LLM 直接产出对应字形。
          return new CloudTranslator(s.translation.cloud).translate(req.text, {
            source: req.source,
            target: req.targetLang,
          });
        }
        // 本地 target 同样传 app 语言键：translate 内部按 langs 条目映射模型码并做字形归一化。
        // 模型已由下载链路落盘、装载走 warmUp 上报状态，翻译热路径不再关心加载进度。
        return getLocalTranslator().translate(req.text, {
          source: req.source,
          target: req.targetLang,
        });
      },
      emitTranslation: (p) => translationCb.emit(p),
    });
  }

  // ---- Web ASR（Phase 2：sherpa-onnx WASM 真识别）。回调转发给 UI；segment 还会触发翻译 ----
  // 行 id 由桥接层统一分配，跨录音会话单调递增：识别 worker 每次 start 都会重建、其内部
  // id 从 0 计数，而 UI 的行与译文回填都按 id 对应，必须全局唯一，故在此改写后再上抛。
  let nextLineId = 0;
  const asr = new WebAsr({
    onStatus: (st) => statusCb.emit(st),
    onPartial: (p) => partialCb.emit(p),
    onSegment: (seg) => {
      const line: SegmentPayload = { ...seg, id: nextLineId++ };
      segmentCb.emit(line);
      void translateSegment(line);
    },
  });

  // 按当前设置（识别模型 + 识别语言）同步给 WebAsr：在每次 start/prewarm 前调用，
  // 使冷启动 init 或复用重建都用到最新配置（识别语言变化触发 recognizer 重建，模型不重下）。
  // cachedSettings 尚未就绪时 WebAsr 沿用其默认（sense-voice / auto）。
  function syncAsrConfig(): void {
    if (cachedSettings) {
      asr.setConfig({ modelId: cachedSettings.asr.model, language: cachedSettings.asr.language });
    }
  }

  // ---- MicPermission 归一化（Permissions API 的字符串 → @rt/core 联合类型） ----
  // 浏览器只有 granted/denied/prompt；prompt 对应「尚未决定」。
  function asMicPermission(state: PermissionState): MicPermission {
    if (state === 'granted') return 'granted';
    if (state === 'denied') return 'denied';
    return 'not-determined'; // 'prompt'
  }

  const api: AppBridge = {
    // 运行平台标识：UI 据此按 platform 过滤可用模型（web 含 sense-voice 及各语言专用模型）等。
    platform: 'web',
    // audioSources 不声明：web 不支持系统音频，缺省即视为 ['mic']（UI 不渲染音源开关）。
    // iOS/iPadOS 上本地翻译模型装不下 WebKit 内存 → 只提供云端翻译（UI 据此隐藏本地引擎选项）。
    // 构建期注入的发布版本串；define 缺失的环境（如单测导入）下不暴露
    appVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : undefined,
    localTranslationAvailable: localTranslationSupported('web', { memoryConstrained: isIOS() }),

    // ===== ASR 管线 =====
    async startPipeline(): Promise<StartResult> {
      // 请求麦克风 + 建 AudioWorklet 采音，帧送 sherpa worker 实时识别。
      syncAsrConfig();
      return asr.start();
    },
    prewarmPipeline(): void {
      // 进主界面即后台装载 ASR 模型（不触麦克风）：fire-and-forget，失败静默（预热内部已处理并解禁按钮）。
      syncAsrConfig();
      void asr.prewarm().catch(() => undefined);
    },
    async stopPipeline(): Promise<{ ok: boolean }> {
      return asr.stop();
    },

    // ===== 麦克风权限（Permissions API） =====
    async getMicStatus(): Promise<MicPermission> {
      try {
        // 'microphone' 不在标准 PermissionName 联合里，浏览器实际支持，断言绕过类型。
        const status = await navigator.permissions.query({
          name: 'microphone' as PermissionName,
        });
        return asMicPermission(status.state);
      } catch {
        // 不支持 Permissions API（如部分 Safari 版本）：未知，UI 会照常尝试 getUserMedia。
        return 'unknown';
      }
    },
    openMicSettings(): void {
      // 浏览器无法以编程方式打开系统/站点设置；空实现（UI 已对 web 做引导文案）。
    },

    // ===== 设置（IndexedDB） =====
    getSettings(): Promise<AppSettings> {
      return readSettingsOnce();
    },
    async saveSettings(settings: AppSettings): Promise<AppSettings> {
      const saved = await writeSettings(settings);
      // 开启本地翻译时：仅当模型已缓存才在此自动预热（warmUp 幂等），让第一句不再等装载。
      // 未缓存则不在此启动下载——下载改由翻译模型下载页驱动（含蜂窝确认），否则蜂窝确认形同虚设。
      // iOS 上 engine 已被收敛为 cloud，不会触发本地加载。
      if (
        saved.translation.enabled &&
        saved.translation.engine !== 'cloud' &&
        (await isTranslationModelCached(currentTranslationSpec()))
      ) {
        void warmUpLocalModel().catch(() => undefined);
      }
      return saved;
    },
    async testCloud(cfg: CloudTranslationConfig): Promise<{ ok: boolean; error?: string }> {
      // 真打一次最小翻译请求验证端点/密钥/模型；source≠target 避免被同语言短路直接返回原文。
      try {
        await new CloudTranslator(cfg).translate('hello', { source: 'en', target: 'ja' });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    // ===== 首次安装 / 模型下载（Phase 2） =====
    async getSetupStatus(modelId: string): Promise<SetupStatus> {
      // 检查 Cache Storage 里指定模型（含公共依赖 VAD）是否齐全。
      // 齐全则直接落主界面；否则 UI 显示 SetupScreen 触发 downloadAsrModels。
      try {
        return { asrReady: await areModelsCached(modelId) };
      } catch {
        return { asrReady: false };
      }
    },
    async downloadAsrModels(modelId: string): Promise<{ ok: boolean; error?: string }> {
      // 按 @rt/core 注册表下载指定模型的 Silero VAD + 模型文件到 Cache Storage，
      // 边下边通过 setupProgressCb 回吐 { loaded, total } 聚合进度。首次后命中缓存即秒回。
      // 挂 AbortController 支持后台取消（cancelModelDownload），按模型键索引以支持并行。
      const key = `asr:${modelId}`;
      const abort = new AbortController();
      downloadAborts.set(key, abort);
      try {
        await ensureModelsCached(
          modelId,
          (p) => setupProgressCb.emit({ kind: 'asr', id: modelId, loaded: p.loaded, total: p.total }),
          abort.signal,
        );
        return { ok: true };
      } catch (e) {
        // 用户取消（signal aborted）：返回失败但带 cancelled 语义；管理器凭自身取消标记区分。
        if (abort.signal.aborted) return { ok: false, error: 'cancelled' };
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      } finally {
        if (downloadAborts.get(key) === abort) downloadAborts.delete(key);
      }
    },

    // ===== 模型管理页：列出 / 删除本地模型 =====
    async listModels(): Promise<ModelInfo[]> {
      const s = cachedSettings ?? (await readSettingsOnce());
      // 各模型的缓存探测互相独立，并行执行（避免逐个 await 串行放大 Cache Storage 延迟）。
      const asrSpecs = ASR_MODELS.filter((spec) => spec.platforms.includes('web'));
      const asrEntries = Promise.all(
        asrSpecs.map(async (spec): Promise<ModelInfo> => {
          const downloaded = await areModelsCached(spec.id);
          // sizeBytes：已下载时直接用注册表 approxBytes——Cache API 无低成本取真实字节数的途径，
          // 逐条读 blob 统计会把 ~230MB 拉进内存，得不偿失；未下载为 0。
          return {
            kind: 'asr',
            id: spec.id,
            sizeBytes: downloaded ? spec.approxBytes : 0,
            downloaded,
            inUse: s.asr.model === spec.id,
          };
        }),
      );
      // 翻译（M2M100 系，Transformers.js Cache API 缓存）。同理已缓存时用规格近似字节。
      // 按内存门槛过滤：iOS/iPadOS WebKit 上本地翻译大模型被排除（引擎恒为云端，见 applyPlatformConstraints），
      // availableTranslationModels 在受限端返回空 → 不列该组。
      const trEntries = Promise.all(
        availableTranslationModels('web', { memoryConstrained: isIOS() }).map(
          async (spec): Promise<ModelInfo> => {
            const downloaded = await isTranslationModelCached(spec);
            return {
              kind: 'translation',
              id: spec.id,
              sizeBytes: downloaded ? spec.approxDownloadBytes : 0,
              downloaded,
              inUse: s.translation.engine === spec.id,
            };
          },
        ),
      );
      const [asrList, trList] = await Promise.all([asrEntries, trEntries]);
      return [...asrList, ...trList];
    },
    async deleteModel(kind: ModelKind, id: string): Promise<{ ok: boolean; error?: string }> {
      // 录音进行中拒绝删除（模型正被 worker/内存占用）。
      if (asr.isRunning()) {
        return { ok: false, error: '录音进行中，无法删除模型' };
      }
      try {
        if (kind === 'asr') {
          const spec = getAsrModel(id);
          if (!spec || !spec.platforms.includes('web')) {
            return { ok: false, error: '未知的识别模型' };
          }
          // 按文件删该模型条目（公共依赖 VAD 保留，供其他模型/下次下载复用）。
          await deleteAsrModelFromCache(id);
          // 常驻 worker 可能仍在内存里持有该模型：丢弃，令下次 start 重查缓存、必要时重下载。
          await asr.dropIdleWorker();
        } else {
          // 翻译模型：按 spec 删该模型缓存条目；若删的正是当前已建的翻译器实例，则置空，
          // 下次翻译按当前引擎重新懒建（会触发重新下载）。
          const spec = getTranslationModel(id);
          if (!spec || !spec.platforms.includes('web')) {
            return { ok: false, error: '未知的翻译模型' };
          }
          await deleteTranslationModelFromCache(spec);
          if (localTranslatorId === id) {
            localTranslator = null;
            localTranslatorId = null;
          }
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    // ===== 本地翻译模型（M2M100，Transformers.js Cache API 缓存） =====
    async getTranslationSetupStatus(modelId: string): Promise<{ ready: boolean }> {
      // 查 Transformers.js 缓存里是否已有指定模型（按 id，与当前引擎无关）的 onnx 权重。
      // 未知/非 web 平台模型视为未就绪。未缓存则 UI 在开启本地翻译/录音前先下载该模型。
      const spec = getTranslationModel(modelId);
      if (!spec || !spec.platforms.includes('web')) return { ready: false };
      return { ready: await isTranslationModelCached(spec) };
    },
    async downloadTranslationModel(modelId: string): Promise<{ ok: boolean; error?: string }> {
      // 自研下载指定本地翻译模型（与 ASR 一致）：按注册表逐个下载文件到 Transformers.js 缓存布局，
      // 进度经 setupProgressCb 回吐 { loaded, total }。首次下数百 MB 权重，命中缓存则秒回。
      // 装载入内存由后续 warmUp/翻译触发，与下载解耦。
      const spec = getTranslationModel(modelId);
      if (!spec || !spec.platforms.includes('web')) {
        return { ok: false, error: '未知的翻译模型' };
      }
      const key = `translation:${modelId}`;
      const abort = new AbortController();
      downloadAborts.set(key, abort);
      try {
        await ensureTranslationModelCached(
          spec,
          (p) => setupProgressCb.emit({ kind: 'translation', id: modelId, loaded: p.loaded, total: p.total }),
          abort.signal,
        );
        return { ok: true };
      } catch (e) {
        if (abort.signal.aborted) return { ok: false, error: 'cancelled' };
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      } finally {
        if (downloadAborts.get(key) === abort) downloadAborts.delete(key);
      }
    },
    async cancelModelDownload(kind, id): Promise<void> {
      // 只中止该模型的在途下载（并行下载互不影响），并删除其全部残留（在途文件由 fetchIntoCache 中止时删条目、
      // 已完成文件在此整体删除），回到未下载态。非在途时仅做清理（安全 no-op）。
      downloadAborts.get(`${kind}:${id}`)?.abort();
      try {
        if (kind === 'asr') {
          await deleteAsrModelFromCache(id);
        } else {
          const spec = getTranslationModel(id);
          if (spec) await deleteTranslationModelFromCache(spec);
        }
      } catch {
        /* 清理失败忽略：listModels 刷新会反映真实缓存状态 */
      }
    },

    // ===== 强制更新应用资源（已安装 PWA 长期拿不到新版本时的手动出口） =====
    async forceUpdateApp(): Promise<void> {
      // 注销 SW + 清应用外壳缓存后整页重载：重载时无 SW 拦截、直接回源取最新 index.html
      // 与构建产物，随后 SW 重新注册并按新产物重新预缓存。
      // 模型缓存必须保留（ASR 与本地翻译权重合计数百 MB～GB，误删会让用户重新下载）。
      const keep = new Set([
        ASR_MODEL_CACHE_NAME,
        // Transformers.js 模型缓存（env.cacheKey 默认值，本项目未改）。
        TRANSFORMERS_CACHE_NAME,
      ]);
      try {
        const regs = (await navigator.serviceWorker?.getRegistrations()) ?? [];
        await Promise.all(regs.map((r) => r.unregister()));
      } catch {
        /* SW 不可用（非安全上下文等）：继续清缓存 + 重载 */
      }
      try {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)));
      } catch {
        /* Cache Storage 不可用：仅靠注销 SW + 重载兜底 */
      }
      location.reload();
    },

    // ===== 归档（IndexedDB） =====
    async saveArchive(name: string, lines: ArchiveLine[]): Promise<ArchiveSummary[]> {
      const createdAt = Date.now();
      const record: ArchiveRecord = {
        id: makeArchiveId(createdAt),
        name,
        createdAt,
        lines,
      };
      await (await db()).put(ARCHIVE_STORE, record);
      return listSummaries(await readArchives());
    },
    async listArchives(): Promise<ArchiveSummary[]> {
      return listSummaries(await readArchives());
    },
    async getArchive(id: string): Promise<ArchiveRecord | null> {
      const r = (await (await db()).get(ARCHIVE_STORE, id)) as ArchiveRecord | undefined;
      return r ?? null;
    },
    async deleteArchive(id: string): Promise<ArchiveSummary[]> {
      await (await db()).delete(ARCHIVE_STORE, id);
      return listSummaries(await readArchives());
    },

    // ===== 回调注册（与 macOS/iOS 语义一致：仅记录，事件由 WebAsr 转发） =====
    onSetupProgress(cb: (progress: SetupProgress) => void): (() => void) {
      return setupProgressCb.on(cb);
    },
    onSegment(cb: (segment: SegmentPayload) => void): (() => void) {
      return segmentCb.on(cb);
    },
    onPartial(cb: (partial: PartialPayload) => void): (() => void) {
      return partialCb.on(cb);
    },
    onTranslation(cb: (translation: TranslationPayload) => void): (() => void) {
      return translationCb.on(cb);
    },
    onStatus(cb: (status: StatusPayload) => void): (() => void) {
      return statusCb.on(cb);
    },
    onTranslationStatus(cb: (status: TranslationStatusPayload) => void): (() => void) {
      return translationStatusCb.on(cb);
    },
  };

  // 预读一次设置，填充缓存（异步，不阻塞返回）。与 UI 首次 getSettings() 共享同一次读。
  // 翻译已开 + 本地引擎且模型已缓存时，启动即预热（保存设置之外的另一预热入口：重开/刷新时设置
  // 早已持久化为开），让第一句不再等装载；未缓存则不在此下载——首次下载交给翻译模型下载页（含蜂窝
  // 确认），否则重开应用会绕过确认直接开下。
  // .then 在 IndexedDB 读完后才跑，届时 registerTranscriptionListeners 已注册好状态回调。
  void readSettingsOnce().then(async (s) => {
    if (
      s.translation.enabled &&
      s.translation.engine !== 'cloud' &&
      (await isTranslationModelCached(currentTranslationSpec()))
    ) {
      void warmUpLocalModel().catch(() => undefined);
    }
  });

  return api;
}
