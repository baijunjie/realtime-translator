// 离线验证转写管线（手动冒烟脚本，非自动化测试）:
//   npm run test-pipeline -- <16kHz-mono.wav>
import path from 'node:path';
import { readWave } from 'sherpa-onnx-node';
import { DEFAULT_ASR_MODEL_ID } from '@rt/core';
import { TranscriptionPipeline, SAMPLE_RATE } from '../src/main/pipeline';

const wavPath = process.argv[2];
if (!wavPath) {
  console.error('用法: npm run test-pipeline -- <wav文件>');
  process.exit(1);
}

const wave = readWave(wavPath);
if (wave.sampleRate !== SAMPLE_RATE) {
  console.error(`需要 ${SAMPLE_RATE}Hz 的 WAV, 实际为 ${wave.sampleRate}Hz`);
  console.error(`转换: afconvert -f WAVE -d LEI16@16000 -c 1 in.wav out.wav`);
  process.exit(1);
}

const modelsDir = path.join(__dirname, '..', '..', 'models');
console.log('加载模型...');
const t0 = Date.now();
const pipeline = new TranscriptionPipeline(modelsDir, DEFAULT_ASR_MODEL_ID, 'auto', {
  onSegment: (seg) => {
    const ts = seg.start.toFixed(1).padStart(6);
    console.log(`[${ts}s] [${seg.lang}] ${seg.text}`);
  },
});
console.log(`模型加载完成 (${Date.now() - t0}ms), 开始处理...`);

const t1 = Date.now();
// 模拟流式输入, 每次 100ms
const chunk = SAMPLE_RATE / 10;
for (let i = 0; i < wave.samples.length; i += chunk) {
  pipeline.acceptWaveform(wave.samples.subarray(i, i + chunk));
}
pipeline.flush();

const audioSec = wave.samples.length / SAMPLE_RATE;
const procSec = (Date.now() - t1) / 1000;
console.log(
  `音频时长 ${audioSec.toFixed(1)}s, 处理耗时 ${procSec.toFixed(1)}s ` +
    `(RTF=${(procSec / audioSec).toFixed(2)})`
);
