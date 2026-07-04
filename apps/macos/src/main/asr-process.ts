// ASR 识别子进程（Electron utilityProcess，完整 Node）。
// VAD + SenseVoice 推理都在这里跑，主进程因此永不被识别阻塞；
// 独立进程也隔离了原生崩溃（挂了主进程仍在，可报错重启）。
import { TranscriptionPipeline } from './pipeline';
import type { AsrToMain, MainToAsr } from '../shared/types';

// utilityProcess 子进程通过 process.parentPort 与主进程通信（Electron 提供）
const parentPort = process.parentPort;

let pipeline: TranscriptionPipeline | null = null;

function post(msg: AsrToMain): void {
  parentPort.postMessage(msg);
}

parentPort.on('message', (e: { data: MainToAsr }) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init':
        // 构造里会加载模型并预热（冷启动开销发生在这里，主进程不受影响）
        pipeline = new TranscriptionPipeline(msg.modelsDir, msg.modelId, msg.language, {
          onSegment: (payload) => post({ type: 'segment', payload }),
          onPartial: (payload) => post({ type: 'partial', payload }),
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
        pipeline?.reset();
        break;
    }
  } catch (err) {
    post({ type: 'error', message: (err as Error).message });
  }
});
