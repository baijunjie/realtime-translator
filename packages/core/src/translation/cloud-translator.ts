// 云端翻译实现：调用任意 OpenAI 兼容的 chat completions 端点。
// 注意：启用云翻译意味着文本会发往第三方，与“本地不出机器”相悖，应作为可选项。
// 纯 fetch 实现，平台无关。
import type { Translator } from './translator';
import type { CloudTranslationConfig } from '../types';

// 单次请求超时上限：无超时的挂起请求会让该行的「翻译中」动画无法结束
const REQUEST_TIMEOUT_MS = 30_000;

const LANG_NAMES: Record<string, string> = {
  zh: 'Chinese (Simplified)',
  ja: 'Japanese',
  en: 'English',
  ko: 'Korean',
  yue: 'Cantonese',
};

export class CloudTranslator implements Translator {
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(cfg: CloudTranslationConfig) {
    this.baseURL = cfg.baseURL.replace(/\/+$/, '');
    this.apiKey = cfg.apiKey;
    this.model = cfg.model;
  }

  async init(): Promise<void> {
    if (!this.apiKey) {
      throw new Error('云翻译未配置 API Key，请在设置里填写');
    }
  }

  async translate(text: string, opts: { source?: string; target: string }): Promise<string> {
    if (!text.trim() || opts.source === opts.target) {
      return text;
    }
    await this.init();
    const targetName = LANG_NAMES[opts.target] ?? opts.target;

    let res: Response;
    try {
      res = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        // 特性检测：旧 Safari 无 AbortSignal.timeout（PWA 会跑在浏览器里），缺失时不设超时
        signal:
          typeof AbortSignal.timeout === 'function'
            ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            : undefined,
        body: JSON.stringify({
          model: this.model,
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content:
                `You are a professional translator. Translate the user's text into ${targetName}. ` +
                'Output only the translation itself, with no quotes, explanations, or extra text.',
            },
            { role: 'user', content: text },
          ],
        }),
      });
    } catch (e) {
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        throw new Error('云翻译请求超时，请检查网络或端点是否可用');
      }
      throw e;
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`云翻译请求失败: ${res.status} ${detail.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return (data.choices?.[0]?.message?.content ?? '').trim();
  }
}
