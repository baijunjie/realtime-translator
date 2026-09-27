// CER 评测脚本（识别准确率对照基建，手动运行，非自动化测试）:
//   npm run eval-cer                          # 本地已下载的全部模型 × test-audio/eval 全部用例
//   npm run eval-cer -- --models sense-voice --language zh --dump
//
// 参数：
//   --models <id,id>   要评测的模型（默认：注册表中本地文件齐全的全部模型）
//   --language <lang>  识别语言设置 auto|zh|en|ja|ko（默认 auto；仅 senseVoice 生效，
//                      用于量化「锁定语言 vs auto」的准确率差）
//   --cases <dir>      用例目录（默认 test-audio/eval，相对 app 根）
//   --dump             额外打印每个用例的参考文本与两种识别结果，供人工核对
//   --max-cer <pct>     任一模型的 pipeline 加权 CER 超过该百分比时退出失败
//   --max-drift <pct>   任一模型的「实时最佳→最终确认」加权漂移超过该百分比时退出失败
//
// 用例目录约定（每个用例一组同名文件）：
//   <name>.wav    16kHz 单声道 PCM WAV（转换: afconvert -f WAVE -d LEI16@16000 -c 1 in.wav out.wav）
//   <name>.txt    参考转写全文（自然书写即可，对比前统一归一化）
//   <name>.json   可选元数据 { "lang": "zh" }——声明后 zh 用例对比前做简体归一化，
//                 并统计 senseVoice auto 模式下按段的语种误判数（LID）
//
// 每个 用例×模型 报告两个 CER 和一个交互稳定性指标：
//   pipeline —— 产品同款实时管线（流式喂入 + 滑动窗口提交），即用户实际看到的准确率
//   offline  —— 同一模型对 VAD 切出的整段做一次性离线解码（非流式上限），
//               两者之差即实时管线本身引入的损耗
//   final drift —— 每段实时展示过的最长文本到最终确认文本的编辑距离；它不代表准确率，
//                 专门捕获「识别区一整段，确认时突然变短/变样」这类体验回归
// 注意：自回归 transducer（reazon/parakeet）对过长段会整块坍缩（见 dev-memory），
// offline 一列对这类模型只在段长可控时才是可信上限。
// CER 归一化：NFKC + 小写 + 去空白/标点/符号（英文因此近似字符级对比），编辑距离按码点计。
// TTS 合成用例（scripts/gen-eval-audio.sh）音质过于干净，只用于冒烟与粗对比，
// 调参结论请以真实录音用例为准。
import path from 'node:path';
import fs from 'node:fs';
import { readWave, OfflineRecognizer, Vad } from 'sherpa-onnx-node';
import { sify } from 'chinese-conv';
import {
  ASR_MODELS,
  getAsrModel,
  requiredAsrFiles,
  SAMPLE_RATE,
  VAD_WINDOW_SIZE,
  FinalizationDriftTracker,
  type AsrLang,
  type SegmentPayload,
} from '@rt/core';
import { TranscriptionPipeline, buildModelConfig, buildVadConfig } from '../src/main/pipeline';

const appRoot = path.join(__dirname, '..', '..');
const modelsDir = path.join(appRoot, 'models');

// ===== CLI 参数 =====

interface CliArgs {
  models: string[];
  language: AsrLang;
  casesDir: string;
  dump: boolean;
  maxCer?: number;
  maxDrift?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    models: [],
    language: 'auto',
    casesDir: path.join(appRoot, 'test-audio', 'eval'),
    dump: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue; // pnpm/npm 透传参数时的分隔符
    if (a === '--models') args.models = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--language') args.language = (argv[++i] ?? 'auto') as AsrLang;
    else if (a === '--cases') args.casesDir = path.resolve(appRoot, argv[++i] ?? '');
    else if (a === '--dump') args.dump = true;
    else if (a === '--max-cer') args.maxCer = parsePercent(argv[++i], a);
    else if (a === '--max-drift') args.maxDrift = parsePercent(argv[++i], a);
    else {
      console.error(`未知参数: ${a}`);
      process.exit(1);
    }
  }
  if (args.models.length === 0) {
    // 默认评测所有本地文件齐全的模型（模型由应用内下载，评测不负责下载）
    args.models = ASR_MODELS.filter((m) =>
      requiredAsrFiles(m.id).every((f) => fs.existsSync(path.join(modelsDir, f))),
    ).map((m) => m.id);
  }
  return args;
}

function parsePercent(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`${flag} 需要非负百分比数字`);
    process.exit(1);
  }
  return parsed;
}

// ===== 用例发现 =====

interface EvalCase {
  name: string;
  samples: Float32Array;
  ref: string;
  /** 声明的语种（可选，来自 <name>.json），用于 zh 简体归一化与 LID 误判统计 */
  lang?: string;
}

function loadCases(dir: string): EvalCase[] {
  if (!fs.existsSync(dir)) {
    console.error(`用例目录不存在: ${dir}`);
    console.error('先运行 scripts/gen-eval-audio.sh 生成冒烟用例，或用 --cases 指定目录');
    process.exit(1);
  }
  const cases: EvalCase[] = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.wav')) continue;
    const name = file.slice(0, -4);
    const refPath = path.join(dir, `${name}.txt`);
    if (!fs.existsSync(refPath)) {
      console.warn(`跳过 ${file}: 缺少参考文本 ${name}.txt`);
      continue;
    }
    const wave = readWave(path.join(dir, file));
    if (wave.sampleRate !== SAMPLE_RATE) {
      console.warn(
        `跳过 ${file}: 需要 ${SAMPLE_RATE}Hz（实际 ${wave.sampleRate}Hz），` +
          `转换: afconvert -f WAVE -d LEI16@16000 -c 1 in.wav out.wav`,
      );
      continue;
    }
    let lang: string | undefined;
    const metaPath = path.join(dir, `${name}.json`);
    if (fs.existsSync(metaPath)) {
      lang = (JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { lang?: string }).lang;
    }
    cases.push({ name, samples: wave.samples, ref: fs.readFileSync(refPath, 'utf8'), lang });
  }
  if (cases.length === 0) {
    console.error(`用例目录为空: ${dir}（需要 <name>.wav + <name>.txt）`);
    process.exit(1);
  }
  return cases;
}

// ===== CER =====

/**
 * CER 对比前的归一化：NFKC（全角→半角等）+ 小写 + 去空白/标点/符号。
 * 声明为 zh 的用例再做简体归一化（容忍繁简差异；不能对 ja 用——会误改日文汉字）。
 */
function normalizeForCer(text: string, lang?: string): string {
  let t = text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  if (lang === 'zh') t = sify(t);
  return t;
}

/** 码点级 Levenshtein 编辑距离（两行 DP，不做回溯）。 */
function editDistance(a: string[], b: string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Int32Array(b.length + 1);
  let cur = new Int32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

interface CerResult {
  dist: number;
  refLen: number;
}

function cer(hyp: string, ref: string, lang?: string): CerResult {
  const refCp = Array.from(normalizeForCer(ref, lang));
  const hypCp = Array.from(normalizeForCer(hyp, lang));
  return { dist: editDistance(hypCp, refCp), refLen: refCp.length };
}

const pct = (r: CerResult): string =>
  r.refLen === 0 ? '-' : `${((r.dist / r.refLen) * 100).toFixed(1)}%`;

// ===== 两种识别方式 =====

interface RunResult {
  hyp: string;
  /** 每个定稿段的语种（LID 误判统计用） */
  segLangs: string[];
  /** 处理耗时 / 音频时长 */
  rtf: number;
  /** 实时展示的最佳候选到最终确认文本的加权编辑距离 */
  finalDrift: CerResult;
}

/** 产品同款实时管线：流式喂入 100ms 块，收集定稿段（与 App 内录音路径一致）。 */
function runPipeline(
  pipeline: TranscriptionPipeline,
  sink: SegmentPayload[],
  tracker: FinalizationDriftTracker,
  c: EvalCase,
): RunResult {
  sink.length = 0;
  tracker.reset();
  pipeline.reset();
  const t0 = Date.now();
  const chunk = SAMPLE_RATE / 10;
  for (let i = 0; i < c.samples.length; i += chunk) {
    pipeline.acceptWaveform(c.samples.subarray(i, i + chunk));
  }
  pipeline.flush();
  tracker.finish();
  const procSec = (Date.now() - t0) / 1000;
  const finalDrift = tracker.pairs.reduce<CerResult>(
    (sum, pair) => {
      if (!pair.partial) return sum;
      const one = cer(pair.final, pair.partial, c.lang);
      return { dist: sum.dist + one.dist, refLen: sum.refLen + one.refLen };
    },
    { dist: 0, refLen: 0 },
  );
  return {
    hyp: sink.map((s) => s.text).join(' '),
    segLangs: sink.map((s) => s.lang),
    rtf: procSec / (c.samples.length / SAMPLE_RATE),
    finalDrift,
  };
}

// 过短输入在 transducer 原生层会崩子进程（与 core MIN_DECODE_SECONDS 同源的边界），补零到 0.5s
const MIN_DECODE_SAMPLES = SAMPLE_RATE / 2;

/** 非流式上限：VAD 切段后每段做一次整段离线解码，拼接全部结果。 */
function runOffline(recognizer: OfflineRecognizer, c: EvalCase): RunResult {
  const vad = new Vad(buildVadConfig(modelsDir), 120);
  const texts: string[] = [];
  const t0 = Date.now();
  const decodeSegment = (samples: Float32Array): void => {
    if (samples.length < MIN_DECODE_SAMPLES) {
      const padded = new Float32Array(MIN_DECODE_SAMPLES);
      padded.set(samples);
      samples = padded;
    }
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    recognizer.decode(stream);
    const text = recognizer.getResult(stream).text.trim();
    if (text) texts.push(text);
  };
  const drain = (): void => {
    while (!vad.isEmpty()) {
      decodeSegment(vad.front().samples);
      vad.pop();
    }
  };
  for (let i = 0; i + VAD_WINDOW_SIZE <= c.samples.length; i += VAD_WINDOW_SIZE) {
    vad.acceptWaveform(c.samples.subarray(i, i + VAD_WINDOW_SIZE));
    drain();
  }
  vad.flush();
  drain();
  const procSec = (Date.now() - t0) / 1000;
  return {
    hyp: texts.join(' '),
    segLangs: [],
    rtf: procSec / (c.samples.length / SAMPLE_RATE),
    finalDrift: { dist: 0, refLen: 0 },
  };
}

// ===== 主流程 =====

interface Row {
  model: string;
  name: string;
  durSec: number;
  pipe: CerResult;
  off: CerResult;
  drift: CerResult;
  lid: string;
  rtf: number;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const cases = loadCases(args.casesDir);
  console.log(
    `模型: ${args.models.join(', ') || '(无可用模型)'} | 语言: ${args.language} | 用例: ${cases.length} 个\n`,
  );

  const rows: Row[] = [];
  for (const modelId of args.models) {
    const spec = getAsrModel(modelId);
    if (!spec) {
      console.warn(`跳过未知模型: ${modelId}`);
      continue;
    }
    const missing = requiredAsrFiles(modelId).filter(
      (f) => !fs.existsSync(path.join(modelsDir, f)),
    );
    if (missing.length > 0) {
      console.warn(`跳过 ${modelId}: 模型文件缺失（先在 App 内下载）: ${missing[0]} 等`);
      continue;
    }

    console.log(`加载 ${modelId} ...`);
    const sink: SegmentPayload[] = [];
    const tracker = new FinalizationDriftTracker(normalizeForCer);
    const pipeline = new TranscriptionPipeline(modelsDir, modelId, args.language, {
      onSegment: (seg) => {
        sink.push(seg);
        tracker.onSegment(seg.text);
      },
      onPartial: (partial) => tracker.onPartial(partial.text),
    });
    const offlineRecognizer = new OfflineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: buildModelConfig(modelsDir, spec, args.language),
    });

    for (const c of cases) {
      // 模型不支持该用例声明的语种时跳过（如日语专用模型 × zh 用例），避免垃圾行污染合计
      if (c.lang && !spec.languages.includes(c.lang as AsrLang)) {
        console.log(`跳过 ${c.name} × ${modelId}: 模型不支持语种 ${c.lang}`);
        continue;
      }
      const pipeRun = runPipeline(pipeline, sink, tracker, c);
      const offRun = runOffline(offlineRecognizer, c);
      // LID 误判：仅 senseVoice + auto + 用例声明了语种时有意义（其余模型语种为注册表固定值）
      const lid =
        spec.engine === 'senseVoice' && args.language === 'auto' && c.lang
          ? `${pipeRun.segLangs.filter((l) => l !== c.lang).length}/${pipeRun.segLangs.length}`
          : '-';
      rows.push({
        model: modelId,
        name: c.name,
        durSec: c.samples.length / SAMPLE_RATE,
        pipe: cer(pipeRun.hyp, c.ref, c.lang),
        off: cer(offRun.hyp, c.ref, c.lang),
        drift: pipeRun.finalDrift,
        lid,
        rtf: pipeRun.rtf,
      });
      if (args.dump) {
        console.log(`\n===== ${c.name} × ${modelId} =====`);
        console.log(`REF : ${c.ref.trim()}`);
        console.log(`PIPE: ${pipeRun.hyp}`);
        console.log(`OFF : ${offRun.hyp}`);
        for (const [i, pair] of tracker.pairs.entries()) {
          console.log(`LIVE${i + 1}: ${pair.partial || '(无实时文本)'}`);
          console.log(`FINAL${i + 1}: ${pair.final}`);
        }
      }
    }
  }

  if (rows.length === 0) {
    console.error('没有产生任何评测结果（无可用模型？）');
    process.exit(1);
  }
  printReport(rows, args.models);
  enforceThresholds(rows, args.models, args.maxCer, args.maxDrift);
}

function printReport(rows: Row[], modelOrder: string[]): void {
  const headers = [
    '用例',
    '模型',
    '时长',
    'CER(pipeline)',
    'CER(offline)',
    'Final漂移',
    'LID误判',
    'RTF',
  ];
  const table: string[][] = rows.map((r) => [
    r.name,
    r.model,
    `${r.durSec.toFixed(1)}s`,
    pct(r.pipe),
    pct(r.off),
    pct(r.drift),
    r.lid,
    r.rtf.toFixed(2),
  ]);
  // 每个模型追加一行加权汇总（总编辑距离 / 总参考字数），供跨模型/跨参数对比
  for (const modelId of modelOrder) {
    const mine = rows.filter((r) => r.model === modelId);
    if (mine.length === 0) continue;
    const total = (pick: (r: Row) => CerResult): CerResult => ({
      dist: mine.reduce((s, r) => s + pick(r).dist, 0),
      refLen: mine.reduce((s, r) => s + pick(r).refLen, 0),
    });
    table.push([
      '(合计)',
      modelId,
      `${mine.reduce((s, r) => s + r.durSec, 0).toFixed(1)}s`,
      pct(total((r) => r.pipe)),
      pct(total((r) => r.off)),
      pct(total((r) => r.drift)),
      '-',
      '-',
    ]);
  }

  // 终端对齐：按显示宽度补空格（CJK 按 2 列计）
  const dispWidth = (s: string): number =>
    Array.from(s).reduce(
      (w, ch) => w + (/[ᄀ-ᅟ⺀-鿿가-힣豈-﫿＀-｠]/.test(ch) ? 2 : 1),
      0,
    );
  const widths = headers.map((h, i) =>
    Math.max(dispWidth(h), ...table.map((row) => dispWidth(row[i]))),
  );
  const fmt = (row: string[]): string =>
    row.map((cell, i) => cell + ' '.repeat(widths[i] - dispWidth(cell))).join('  ');
  console.log(`\n${fmt(headers)}`);
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of table) console.log(fmt(row));
  console.log(
    '\nCER(pipeline)=实时管线（产品实际），CER(offline)=VAD 切段整段离线解码（非流式上限），' +
      '两者之差≈管线损耗。\nFinal漂移=实时展示过的最长文本到最终确认文本的编辑距离，' +
      '用于捕获确认时变短/变样；LID误判=senseVoice auto 模式下定稿段语种≠用例声明语种的段数。',
  );
}

function enforceThresholds(
  rows: Row[],
  modelOrder: string[],
  maxCer?: number,
  maxDrift?: number,
): void {
  if (maxCer === undefined && maxDrift === undefined) return;
  let failed = false;
  for (const modelId of modelOrder) {
    const mine = rows.filter((row) => row.model === modelId);
    if (mine.length === 0) continue;
    const weighted = (pick: (row: Row) => CerResult): number => {
      const dist = mine.reduce((sum, row) => sum + pick(row).dist, 0);
      const refLen = mine.reduce((sum, row) => sum + pick(row).refLen, 0);
      return refLen === 0 ? 0 : (dist / refLen) * 100;
    };
    const pipelineCer = weighted((row) => row.pipe);
    const finalDrift = weighted((row) => row.drift);
    if (maxCer !== undefined && pipelineCer > maxCer) {
      console.error(`${modelId}: pipeline CER ${pipelineCer.toFixed(1)}% > ${maxCer}%`);
      failed = true;
    }
    if (maxDrift !== undefined && finalDrift > maxDrift) {
      console.error(`${modelId}: final drift ${finalDrift.toFixed(1)}% > ${maxDrift}%`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
}

main();
