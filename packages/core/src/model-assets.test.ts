// 模型资产源治理的单元测试：自托管主源 URL 构造、GitHub release 判定、
// 浏览器端受 CORS 约束的源选择（web 下载器回退逻辑的纯函数抽取）。
import { describe, expect, it } from 'vitest';
import { browserDownloadUrls, ghModelAsset, isGithubReleaseUrl } from './model-assets';

describe('ghModelAsset', () => {
  it('拼接自托管 GitHub Release（models-v1）的扁平资产直链', () => {
    expect(ghModelAsset('silero_vad.onnx')).toBe(
      'https://github.com/baijunjie/realtime-translator/releases/download/models-v1/silero_vad.onnx',
    );
    expect(ghModelAsset('sense-voice-model.int8.onnx')).toBe(
      'https://github.com/baijunjie/realtime-translator/releases/download/models-v1/sense-voice-model.int8.onnx',
    );
  });
});

describe('isGithubReleaseUrl', () => {
  it('识别 GitHub release 资产直链', () => {
    expect(isGithubReleaseUrl(ghModelAsset('x'))).toBe(true);
    expect(
      isGithubReleaseUrl(
        'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
      ),
    ).toBe(true);
  });

  it('非 release 直链（HF resolve、github 仓库页）判否', () => {
    expect(isGithubReleaseUrl('https://huggingface.co/Xenova/m2m100_418M/resolve/main/config.json')).toBe(
      false,
    );
    expect(isGithubReleaseUrl('https://github.com/baijunjie/realtime-translator')).toBe(false);
  });
});

describe('browserDownloadUrls（浏览器端源选择）', () => {
  const gh = ghModelAsset('m2m100_418M-config.json');
  const hf = 'https://huggingface.co/Xenova/m2m100_418M/resolve/main/config.json';

  it('GitHub 主源无 CORS：跳过主源，仅用上游 fallback', () => {
    expect(browserDownloadUrls(gh, hf)).toEqual([hf]);
  });

  it('GitHub 主源且无 fallback：无可用源（空数组，调用方应报错）', () => {
    expect(browserDownloadUrls(gh)).toEqual([]);
  });

  it('主源非 GitHub：先试主源，有 fallback 则其后回退', () => {
    const other = 'https://cdn.example.com/config.json';
    expect(browserDownloadUrls(other, hf)).toEqual([other, hf]);
    expect(browserDownloadUrls(other)).toEqual([other]);
  });
});
