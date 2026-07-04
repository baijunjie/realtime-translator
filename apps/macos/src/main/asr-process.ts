// ASR 识别子进程（Electron utilityProcess，完整 Node）。
// VAD + SenseVoice 推理都在这里跑，主进程因此永不被识别阻塞；
// 独立进程也隔离了原生崩溃（挂了主进程仍在，可报错重启）。
import fs from 'node:fs';
import { TranscriptionPipeline } from './pipeline';
import type { AsrToMain, MainToAsr } from '../shared/types';

// utilityProcess 子进程通过 process.parentPort 与主进程通信（Electron 提供）
const parentPort = process.parentPort;

// TODO 临时诊断日志（排查定稿内容丢失，随排查结束移除）：管线在关键决策点
// （语音起止/partial/强切/定稿/丢弃/抢救）输出的结构化行追加写入固定路径，复现后直接取读。
const DEBUG_LOG_PATH = '/tmp/rt-asr-debug.log';
const debugLog = fs.createWriteStream(DEBUG_LOG_PATH, { flags: 'a' });
function dlog(line: string): void {
  debugLog.write(`${new Date().toISOString().slice(11, 23)} ${line}\n`);
}

let pipeline: TranscriptionPipeline | null = null;

function post(msg: AsrToMain): void {
  parentPort.postMessage(msg);
}

parentPort.on('message', (e: { data: MainToAsr }) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init':
        dlog(`=== init model=${msg.modelId} lang=${msg.language} ===`);
        // 构造里会加载模型并预热（冷启动开销发生在这里，主进程不受影响）
        pipeline = new TranscriptionPipeline(msg.modelsDir, msg.modelId, msg.language, {
          onSegment: (payload) => post({ type: 'segment', payload }),
          onPartial: (payload) => post({ type: 'partial', payload }),
          onLog: dlog,
        });
        post({ type: 'ready' });
        break;
      case 'audio':
        pipeline?.acceptWaveform(msg.samples);
        break;
      case 'flush':
        pipeline?.flush();
        break;
      case 'reset':
        dlog('=== reset（新录音会话） ===');
        pipeline?.reset();
        break;
    }
  } catch (err) {
    dlog(`ERROR ${(err as Error).message}`);
    post({ type: 'error', message: (err as Error).message });
  }
});
