import path from 'node:path';
import fs from 'node:fs';
import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  session,
  shell,
  systemPreferences,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import {
  M2M100_SPEC,
  translateFinalizedSegment,
  CloudTranslator,
  ASR_MODELS,
  getAsrModel,
  requiredAsrFiles,
  type SegmentTranslateRequest,
  type AsrLang,
  type ModelInfo,
  type ModelKind,
} from '@rt/core';
import { localModelCached } from './translation/model-cache';
import { loadSettings, saveSettings } from './settings';
import { asrModelsReady, downloadAsrModels } from './model-downloader';
import { listArchives, getArchive, saveArchive, deleteArchive } from './archives';
import { systemAudioSupported } from '../shared/audio-source';
import asrWorkerPath from './asr-process?modulePath';
import translateWorkerPath from './translation/translate-process?modulePath';
import type {
  StartResult,
  AppSettings,
  CloudTranslationConfig,
  SegmentPayload,
  SetupStatus,
  AsrToMain,
  TranslateToMain,
  ArchiveLine,
  MicPermission,
} from '../shared/types';

// 模型存放目录：
// - 打包后 app.getAppPath() 指向只读的 app.asar，必须写到可写的 userData；
// - 开发时用仓库根目录的 models/，便于复用已下载的模型。
const MODELS_DIR = app.isPackaged
  ? path.join(app.getPath('userData'), 'models')
  : path.join(app.getAppPath(), 'models');
const TRANSLATION_CACHE_DIR = path.join(MODELS_DIR, 'transformers');

let win: BrowserWindow | null = null;
// ASR 识别跑在独立的 utilityProcess 子进程，主进程只转发音频、不做推理
let asrChild: UtilityProcess | null = null;
let asrReady: Promise<void> | null = null;
// 当前存活的 ASR 子进程装载的模型/语言配置：设置保存时据此判断是否需要按新配置重建。
let asrChildConfig: { modelId: string; language: AsrLang } | null = null;
// 是否处于录音会话（start 进入 running 后为真、stop/子进程退出后为假）。
// prewarm 冷启动完成时据此判断：会话已由 start 接管（running）则不再发 stopped 覆盖。
let sessionActive = false;

// 渲染层的行 id：主进程单调递增，跨 ASR 子进程重启不归零。
// 子进程内部的段序号随进程生命周期从 0 计，直接透传会与既有行冲突、译文回填错行。
let nextLineId = 0;

// 翻译跑在独立的 utilityProcess 子进程：隔离原生崩溃与超大内存分配（如 NLLB 反量化
// 在主进程会被 Chromium 分配器 abort），翻译进程挂掉也不连累主窗口，仅丢一次翻译。
// 句柄携带该进程专属的在途请求表，按进程隔离：进程退出时只 reject 发往它的请求。
interface TranslateChild {
  proc: UtilityProcess;
  // 在途翻译请求：行 id → Promise 句柄。子进程 result/error 消息按 id 关联回 Promise，
  // 把消息协议封装成 async 引擎调用供 core 编排使用；进程退出时只 reject 发往它的请求，防悬挂。
  pending: Map<number, { resolve: (text: string) => void; reject: (e: Error) => void }>;
}
let translateChild: TranslateChild | null = null;

// 下载页显式下载本地翻译模型的在途等待者：单飞，多次调用复用同一 promise。
// 下载进度经既有 translation:status 通道（子进程 status 转发）上报，UI 直接消费；
// 完成/失败由子进程的首个终态（status ready/error）或异常退出兑现此等待者。
let pendingModelDownload: {
  promise: Promise<{ ok: boolean; error?: string }>;
  resolve: (r: { ok: boolean; error?: string }) => void;
} | null = null;

// 本地翻译模型是否已完整缓存：据此回答下载页「是否已缓存」，并在设置保存时门控本地模型的自动预热。
function translationModelCached(): boolean {
  return localModelCached(TRANSLATION_CACHE_DIR, M2M100_SPEC);
}

/** 本机是否支持系统音频采集（macOS 14.2+）。与 preload 的音源判定共用同一逻辑。 */
function systemAudioAvailable(): boolean {
  return process.platform === 'darwin' && systemAudioSupported(process.getSystemVersion());
}

/**
 * 对外暴露的设置：系统版本不支持系统音频时把 audioSource 收敛为 'mic'，
 * 与 preload 上报的 audioSources 保持一致（避免 UI 拿到本机不可用的 'system'）。
 */
function effectiveSettings(): AppSettings {
  const s = loadSettings();
  if (s.audioSource === 'system' && !systemAudioAvailable()) {
    return { ...s, audioSource: 'mic' };
  }
  return s;
}

/** 递归统计目录实际占用字节（目录不存在返回 0）。 */
function dirSize(dir: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      total += dirSize(p);
    } else {
      try {
        total += fs.statSync(p).size;
      } catch {
        // 统计期文件被删/无权限：忽略该文件
      }
    }
  }
  return total;
}

// 应用图标：仅开发时手动设置（dev 下 Dock 默认显示 Electron 图标）；
// 打包后图标由 electron-builder 写入 .app，无需也无法从 asar 取此路径。
// 图标源已唯一化到仓库根 assets/icon.png（见 scripts/gen-icon.mjs）；
// getAppPath() 在 dev 下为 apps/macos，故上溯两级到仓库根取共享 PNG。
const APP_ICON = path.join(app.getAppPath(), '..', '..', 'assets', 'icon.png');

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'Realtime Translator',
    ...(app.isPackaged ? {} : { icon: APP_ICON }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
    },
  });
  // 开发用 vite dev server，生产加载打包后的 HTML
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

/** 经消息协议调用翻译子进程，返回按 id 关联的结果 Promise（注册到当前子进程的在途请求表） */
function requestTranslate(req: SegmentTranslateRequest): Promise<string> {
  const child = ensureTranslateChild();
  return new Promise<string>((resolve, reject) => {
    child.pending.set(req.id, { resolve, reject });
    child.proc.postMessage({
      type: 'translate',
      id: req.id,
      text: req.text,
      source: req.source,
      target: req.targetLang,
    });
  });
}

/** 启动翻译子进程并按当前设置初始化 */
function startTranslateChild(): TranslateChild {
  const proc = utilityProcess.fork(translateWorkerPath);
  const pending: TranslateChild['pending'] = new Map();
  const handle: TranslateChild = { proc, pending };
  translateChild = handle;
  proc.on('message', (m: TranslateToMain) => {
    if (m.type === 'status') {
      sendToRenderer('translation:status', m.payload);
      // 显式下载等待者以**当前**子进程的首个终态兑现：ready → 成功；error → 失败
      // （loading/进度不终结）。已被 reconfigure 替换的旧进程不参与兑现。
      if (translateChild === handle && pendingModelDownload) {
        if (m.payload.state === 'ready') {
          pendingModelDownload.resolve({ ok: true });
          pendingModelDownload = null;
        } else if (m.payload.state === 'error') {
          pendingModelDownload.resolve({ ok: false, error: m.payload.error });
          pendingModelDownload = null;
        }
      }
    } else if (m.type === 'result') {
      pending.get(m.id)?.resolve(m.text);
      pending.delete(m.id);
    } else if (m.type === 'error') {
      pending.get(m.id)?.reject(new Error(m.message));
      pending.delete(m.id);
    }
  });
  proc.on('exit', (code) => {
    // 仅当全局引用仍指向本进程时才清空：reconfigure 已 fork 新进程时，旧进程的异步 exit
    // 不能误清新引用（否则新进程成孤儿、发往它的在途翻译被误判失败）。
    const isCurrent = translateChild === handle;
    if (isCurrent) {
      translateChild = null;
    }
    // 只 reject 发往本进程的在途请求（core 编排据此结束对应行的等待动画），不波及其它进程。
    for (const p of pending.values()) {
      p.reject(new Error(`翻译进程退出 (${code})`));
    }
    pending.clear();
    // 下载途中**当前**子进程退出（如模型内存过大崩溃）：兑现下载等待者为失败，供下载页重试。
    // 已被 reconfigure 替换的旧进程退出不兑现——下载可能刚发往新进程，不能误判失败。
    if (isCurrent && pendingModelDownload) {
      pendingModelDownload.resolve({ ok: false, error: `翻译进程退出 (${code})` });
      pendingModelDownload = null;
    }
    if (code !== 0) {
      // 翻译进程异常退出（如模型内存过大崩溃）：主进程存活，提示失败，下次翻译自动重启
      sendToRenderer('translation:status', { state: 'error', error: `翻译进程异常退出 (${code})` });
    }
  });
  const t = loadSettings().translation;
  proc.postMessage({
    type: 'configure',
    engine: t.engine,
    cloud: t.cloud,
    cacheDir: TRANSLATION_CACHE_DIR,
  });
  return handle;
}

/** 确保翻译子进程已就绪（懒启动 + 复用） */
function ensureTranslateChild(): TranslateChild {
  return translateChild ?? startTranslateChild();
}

/** 设置变更后让翻译子进程按新配置重建（kill 后下次按需重启） */
function reconfigureTranslate(): void {
  // 同步置空引用；旧进程的 exit 只 reject 发往它的在途请求，不影响之后按需 fork 的新进程
  translateChild?.proc.kill();
  translateChild = null;
}

/** 对一条定稿段做翻译（fire-and-forget），失败不影响转写。目标恒为母语。
 *  编排（是否翻 / pending / 字形归一化 / 错误上报）统一在 @rt/core.translateFinalizedSegment，
 *  与 web/iOS 一致；这里注入的引擎是翻译子进程消息协议的 Promise 封装。 */
function translateSegment(segment: SegmentPayload): void {
  const settings = loadSettings();
  void translateFinalizedSegment({
    spec: M2M100_SPEC,
    segment,
    enabled: settings.translation.enabled,
    nativeLang: settings.nativeLang,
    translate: requestTranslate,
    emitTranslation: (p) => sendToRenderer('pipeline:translation', p),
  });
}

/** 启动 ASR 子进程并完成初始化（含模型加载 + 预热），resolve 表示就绪 */
function startAsrChild(): Promise<void> {
  const child = utilityProcess.fork(asrWorkerPath);
  asrChild = child;
  // 按当前设置装载模型/语言，并记录本子进程所用配置（设置变更时据此判断是否需重建）。
  const asr = loadSettings().asr;
  asrChildConfig = { modelId: asr.model, language: asr.language };

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    child.on('message', (m: AsrToMain) => {
      switch (m.type) {
        case 'ready':
          settled = true;
          resolve();
          break;
        case 'segment': {
          // 行 id 改写为主进程计数器的值：UI 上屏与译文回填都以它对应
          const payload: SegmentPayload = { ...m.payload, id: nextLineId++ };
          sendToRenderer('pipeline:segment', payload); // 原文立即上屏
          translateSegment(payload); // 译文异步回填
          break;
        }
        case 'partial':
          sendToRenderer('pipeline:partial', m.payload);
          break;
        case 'error':
          sendToRenderer('pipeline:status', { state: 'error', error: m.message, code: 'asr-init-failed' });
          if (!settled) {
            // 初始化阶段就出错：销毁子进程，让 exit 清空引用，下次 start 可重新 fork 恢复
            settled = true;
            reject(new Error(m.message));
            child.kill();
          }
          break;
      }
    });
    child.on('exit', (code) => {
      // 仅当全局引用仍指向本进程时才清空并上报：设置变更/删除模型主动 kill 时已同步置空引用，
      // 其异步 exit 不应误报「识别进程异常退出」，也不应清掉随后新建的子进程引用。
      const isCurrent = asrChild === child;
      if (isCurrent) {
        asrChild = null;
        asrReady = null;
        asrChildConfig = null;
        sessionActive = false;
        if (code !== 0) {
          sendToRenderer('pipeline:status', { state: 'error', error: `识别进程异常退出 (${code})`, code: 'asr-crashed' });
        }
      }
      if (code !== 0 && !settled) {
        settled = true;
        reject(new Error(`识别进程退出 ${code}`));
      }
    });
    child.postMessage({ type: 'init', modelsDir: MODELS_DIR, modelId: asr.model, language: asr.language });
  });
}

/** 让当前 ASR 子进程按新配置重建：同步置空引用，下次 start/prewarm 时以最新设置重新 fork。 */
function reconfigureAsr(): void {
  asrChild?.kill();
  asrChild = null;
  asrReady = null;
  asrChildConfig = null;
}

/** 确保 ASR 子进程已就绪（懒启动 + 复用） */
function ensureAsr(): Promise<void> {
  if (!asrChild) {
    asrReady = startAsrChild();
  }
  return asrReady ?? Promise.resolve();
}

ipcMain.handle('pipeline:start', async (): Promise<StartResult> => {
  // 仅麦克风音源需申请麦克风权限；系统音频音源不触碰麦克风权限
  // （系统音频的录制授权在渲染层 getDisplayMedia 时由系统弹出，见 mac-bridge）。
  if (effectiveSettings().audioSource === 'mic' && process.platform === 'darwin') {
    const granted = await systemPreferences.askForMediaAccess('microphone');
    if (!granted) {
      return { ok: false, error: '未获得麦克风权限，请在系统设置中授权', code: 'mic-permission' };
    }
  }

  try {
    // 仅真冷启动（fork 子进程装模型）才报 loading：预热后复用路径瞬时完成，
    // 报 loading 会让每次开始录音都闪一次「识别模型加载中」的误导提示。
    if (!asrChild) {
      sendToRenderer('pipeline:status', { state: 'loading' });
    }
    await ensureAsr();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  // 子进程跨会话复用：每次开始录音都重置计时基线，segment.start 相对本次会话起点
  asrChild?.postMessage({ type: 'reset' });
  sendToRenderer('pipeline:status', { state: 'running' });
  sessionActive = true;
  return { ok: true };
});

// 预热 ASR 管线：把识别模型装载进内存，绝不触碰麦克风、不申请权限；模型未下载时静默跳过。
// 幂等——UI 在调用前先行禁用录音按钮，故除会话已由 start 接管（sessionActive，完成时不发
// stopped 覆盖 running）外，任何路径（模型缺失的跳过 / 子进程已就绪 / 冷启动成败）都必须以
// pipeline:status 的 stopped 终态收尾解禁。与并发的 pipeline:start 共用 ensureAsr 单飞天然合流。
// 冷启动失败时子进程的 error 状态会照常上报（用户未操作也能看到提示），随后仍以 stopped 收尾。
ipcMain.on('pipeline:prewarm', () => {
  if (!asrModelsReady(MODELS_DIR, loadSettings().asr.model)) {
    sendToRenderer('pipeline:status', { state: 'stopped' });
    return;
  }
  if (!asrChild) {
    sendToRenderer('pipeline:status', { state: 'loading' });
  }
  ensureAsr()
    .catch((err) => {
      console.error('[prewarm] ASR 预热失败', err);
    })
    .finally(() => {
      if (!sessionActive) sendToRenderer('pipeline:status', { state: 'stopped' });
    });
});

// 麦克风权限：渲染层在请求权限前先查状态，自行决定是否弹说明弹窗
ipcMain.handle('mic:get-status', (): MicPermission =>
  process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'granted'
);

ipcMain.on('mic:open-settings', () => {
  if (process.platform === 'darwin') {
    void shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
    );
  }
});

ipcMain.handle('setup:get-status', (_event, modelId: string): SetupStatus => ({
  asrReady: asrModelsReady(MODELS_DIR, modelId),
}));

ipcMain.handle(
  'setup:download-asr',
  async (_event, modelId: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      await downloadAsrModels(MODELS_DIR, modelId, (p) => sendToRenderer('setup:progress', p));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
);

// 模型管理页：列出各模型（ASR + 翻译）的占用与状态
ipcMain.handle('models:list', (): ModelInfo[] => {
  const settings = loadSettings();
  const models: ModelInfo[] = [];
  for (const spec of ASR_MODELS) {
    if (!spec.platforms.includes('macos')) continue;
    // sizeBytes 为该模型自身文件的实际字节和（不含公共依赖 VAD）
    let sizeBytes = 0;
    for (const f of spec.files) {
      try {
        sizeBytes += fs.statSync(path.join(MODELS_DIR, f.dir, f.filename)).size;
      } catch {
        // 未下载/缺文件：不计入
      }
    }
    models.push({
      kind: 'asr',
      id: spec.id,
      sizeBytes,
      downloaded: requiredAsrFiles(spec.id).every((rel) => fs.existsSync(path.join(MODELS_DIR, rel))),
      inUse: settings.asr.model === spec.id,
    });
  }
  models.push({
    kind: 'translation',
    id: 'm2m100',
    sizeBytes: dirSize(TRANSLATION_CACHE_DIR),
    downloaded: translationModelCached(),
    inUse: settings.translation.engine === 'm2m100',
  });
  return models;
});

// 模型管理页：删除某个已下载模型（录音会话中拒绝）
ipcMain.handle(
  'models:delete',
  (_event, kind: ModelKind, id: string): { ok: boolean; error?: string } => {
    if (sessionActive) {
      return { ok: false, error: '录音进行中，无法删除模型' };
    }
    try {
      if (kind === 'asr') {
        const spec = getAsrModel(id);
        if (!spec) return { ok: false, error: '未知的识别模型' };
        // 删除该模型目录（公共依赖 VAD 位于 models 根目录，不受影响）
        fs.rmSync(path.join(MODELS_DIR, spec.dir), { recursive: true, force: true });
        // 删的是当前子进程在用的模型：kill，下次 start/prewarm 按新设置重建
        if (asrChildConfig?.modelId === id) {
          reconfigureAsr();
        }
      } else {
        // 翻译模型：先 kill 翻译子进程释放文件句柄，再删缓存目录
        reconfigureTranslate();
        fs.rmSync(TRANSLATION_CACHE_DIR, { recursive: true, force: true });
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
);

// 下载页：本地翻译模型是否已缓存（无需下载则 ready:true，可直接进入主界面）
ipcMain.handle('translation:setup-status', (): { ready: boolean } => ({
  ready: translationModelCached(),
}));

// 下载页：显式下载本地翻译模型，等待子进程完成初始化后兑现。进度经 translation:status 上报。
ipcMain.handle('translation:download', (): Promise<{ ok: boolean; error?: string }> => {
  // 云端引擎无本地模型可下载（UI 不会在 cloud 下路由到下载页，此处仅防御）
  if (loadSettings().translation.engine === 'cloud') {
    return Promise.resolve({ ok: true });
  }
  // 单飞：在途下载复用同一 promise，避免重复 preheat 与竞态兑现
  if (pendingModelDownload) {
    return pendingModelDownload.promise;
  }
  let resolve!: (r: { ok: boolean; error?: string }) => void;
  const promise = new Promise<{ ok: boolean; error?: string }>((res) => {
    resolve = res;
  });
  pendingModelDownload = { promise, resolve };
  // 触发子进程按当前配置懒加载模型；未缓存时即为联网下载，加载/下载进度经 status 转发到下载页
  ensureTranslateChild().proc.postMessage({ type: 'preheat' });
  return promise;
});

ipcMain.on('pipeline:audio', (_event, samples: Float32Array) => {
  if (!asrChild) return;
  // IPC 过来的其实是字节视图，必须还原成 Float32Array 再转发，否则子进程会把
  // 8192 字节当成 8192 个浮点（值为 0-255）→ 音频变噪声、识别全错
  const f = new Float32Array(
    samples.buffer as ArrayBuffer,
    samples.byteOffset,
    samples.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
  // 主进程只转发音频给识别子进程，不做推理
  asrChild.postMessage({ type: 'audio', samples: f });
});

ipcMain.handle('archive:list', () => listArchives());
ipcMain.handle('archive:get', (_event, id: string) => getArchive(id));
ipcMain.handle('archive:save', (_event, name: string, lines: ArchiveLine[]) =>
  saveArchive(name, lines, Date.now())
);
ipcMain.handle('archive:delete', (_event, id: string) => deleteArchive(id));

ipcMain.handle('settings:get', (): AppSettings => effectiveSettings());

ipcMain.handle('settings:save', (_event, next: AppSettings): AppSettings => {
  const prev = loadSettings().translation;
  const cur = next.translation;
  // 只有翻译引擎/云端配置变了才需要重建翻译器；
  // 改主题/字体/母语不应触动翻译器（否则会误触发模型重新加载）
  const engineChanged =
    prev.engine !== cur.engine ||
    prev.cloud.baseURL !== cur.cloud.baseURL ||
    prev.cloud.apiKey !== cur.cloud.apiKey ||
    prev.cloud.model !== cur.cloud.model;

  // 主页已无翻译开关，开启改由保存触发：翻译刚从关变开也要预热（引擎未变时也是）。
  const enabledTurnedOn = !prev.enabled && cur.enabled;

  const saved = saveSettings(next);
  if (engineChanged) {
    reconfigureTranslate();
  }
  // 识别模型/语言变了：kill 当前 ASR 子进程，下次 start/prewarm 按新配置重建
  // （与翻译器的 reconfigure 同风格；比对存活子进程实际装载的配置，无子进程时无需处理）。
  if (
    asrChildConfig &&
    (asrChildConfig.modelId !== saved.asr.model || asrChildConfig.language !== saved.asr.language)
  ) {
    reconfigureAsr();
  }
  // 保存后自动预热（降低首句翻译延迟）：
  // - cloud：无本地模型，直接预热（发起云端引擎的懒初始化，开销小）；
  // - 本地：仅当模型已缓存时预热（把磁盘模型载入内存）；未缓存则不在此下载，
  //   改由下载页显式调用 downloadTranslationModel 驱动，避免保存设置时静默触发大文件下载。
  if (saved.translation.enabled && (engineChanged || enabledTurnedOn)) {
    const canPreheat = saved.translation.engine === 'cloud' || translationModelCached();
    if (canPreheat) {
      ensureTranslateChild().proc.postMessage({ type: 'preheat' });
    }
  }
  // 返回收敛后的设置（与 settings:get 一致），保证 UI 拿到本机实际生效的音源。
  return effectiveSettings();
});

// 云端配置连通性测试：主进程用 Node fetch 打一次最小翻译请求（无浏览器 CORS 限制，与实际云翻译
// 同环境）。供设置页「测试连接」，与 Web/iOS 的 testCloud 行为一致。source≠target 避免被短路。
ipcMain.handle(
  'translation:test-cloud',
  async (_event, cfg: CloudTranslationConfig): Promise<{ ok: boolean; error?: string }> => {
    try {
      await new CloudTranslator(cfg).translate('hello', { source: 'en', target: 'ja' });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
);

ipcMain.handle('pipeline:stop', () => {
  asrChild?.postMessage({ type: 'flush' });
  sessionActive = false;
  sendToRenderer('pipeline:status', { state: 'stopped' });
  return { ok: true };
});

app.whenReady().then(() => {
  // macOS dev：Dock 默认显示 Electron 图标，手动替换；打包后用 .app 内置图标
  if (!app.isPackaged && process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(APP_ICON);
  }
  // 系统音频采集：渲染层 getDisplayMedia 走到这里。取主屏作为 video 源（渲染层随即停掉 video 轨，
  // 只用 audio），audio:'loopback' 采集系统播放的声音。不使用系统选择器（useSystemPicker）。
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => {
        if (sources[0]) {
          callback({ video: sources[0], audio: 'loopback' });
        } else {
          callback({}); // 无屏幕源：拒绝，渲染层 getDisplayMedia 随之 reject
        }
      })
      .catch(() => callback({}));
  });
  createWindow();
  // 启动即按「翻译已开 + 本地引擎 + 模型已缓存」预热本地翻译模型，降低首句翻译延迟；
  // 未缓存则不在此下载（首次下载交给翻译模型下载页）。cloud 引擎的预热仍只在设置保存时触发。
  const t = loadSettings().translation;
  if (t.enabled && t.engine !== 'cloud' && translationModelCached()) {
    ensureTranslateChild().proc.postMessage({ type: 'preheat' });
  }
});

app.on('window-all-closed', () => {
  asrChild?.kill();
  translateChild?.proc.kill();
  app.quit();
});
