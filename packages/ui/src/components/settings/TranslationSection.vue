<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NSelect, NInput, NAutoComplete, NFormItem, NAlert, NButton, type SelectOption } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { bridge } from '../../bridge';
import type { SettingsFormData } from './form';

const { t } = useI18n();
// 父组件持有 reactive 表单对象，子组件直接修改其字段
const props = defineProps<{ form: SettingsFormData }>();

// 平台是否支持本地翻译引擎（Web 在 iOS 上为 false：WebKit 内存装不下本地模型）。
// 不可用时仅从「翻译方式」下拉里去掉「本地」项（仍保留 无 / 云端）。iOS 上持久化的 engine
// 也已被 bridge 收敛为 cloud（applyPlatformConstraints），故表单不会停在无法选中的本地项。
const localTranslationAvailable = bridge().localTranslationAvailable !== false;

// —— 云端连接测试（自查工具，不阻断任何操作）——
// 平台是否支持云端测试：Web / iOS 用 JS fetch 实现；macOS 云翻译在独立进程、未提供本方法
// → 不显示测试按钮（沿用旧行为）。
const canTestCloud = typeof bridge().testCloud === 'function';
type CloudTestState = 'idle' | 'testing' | 'ok' | 'error';
const cloudTest = ref<CloudTestState>('idle');
const cloudTestError = ref('');

// 云端三项必填齐全才允许测试。
const cloudFilled = computed(
  () =>
    props.form.cloud.baseURL.trim() !== '' &&
    props.form.cloud.apiKey.trim() !== '' &&
    props.form.cloud.model.trim() !== '',
);
const canTest = computed(() => cloudFilled.value && cloudTest.value !== 'testing');

async function runCloudTest(): Promise<void> {
  if (!canTest.value) return;
  cloudTest.value = 'testing';
  cloudTestError.value = '';
  const r = await bridge().testCloud!({ ...props.form.cloud });
  cloudTest.value = r.ok ? 'ok' : 'error';
  if (!r.ok) cloudTestError.value = r.error ?? '';
}

// 引擎或任一云端字段变化 → 作废上次测试结果（配置已变，旧结果不再对应当前配置）。
watch(
  [
    () => props.form.engine,
    () => props.form.cloud.baseURL,
    () => props.form.cloud.apiKey,
    () => props.form.cloud.model,
  ],
  () => {
    cloudTest.value = 'idle';
    cloudTestError.value = '';
  },
);

// 三态：无 / 本地（仅本地引擎可用时）/ 云端。选中模型即开启翻译，选「无」即关闭。
const engineOptions = computed(() => [
  { label: t('settings.engineNone'), value: 'none' },
  ...(localTranslationAvailable ? [{ label: t('settings.engineM2m100'), value: 'm2m100' }] : []),
  { label: t('settings.engineCloud'), value: 'cloud' },
]);

// —— 云端服务商预设（Base URL / 模型可选可自定义）——
// name 为服务商品牌名（不本地化）；baseURL 不带结尾斜杠（CloudTranslator 会再拼 /chat/completions）；
// models 优先列快速、便宜、适合翻译的主力型号。用户仍可在输入框手输任意值。
interface ProviderPreset {
  name: string;
  baseURL: string;
  models: string[];
}
const providerPresets: ProviderPreset[] = [
  {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-5-mini'],
  },
  {
    // Anthropic 的 OpenAI 兼容端点（官方定位为测试/对比用，非生产长期方案）；原生接口为 /v1/messages，本 app 不走。
    name: 'Claude',
    baseURL: 'https://api.anthropic.com/v1',
    models: ['claude-haiku-4-5', 'claude-sonnet-4-6'],
  },
  {
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    models: ['deepseek-v4-flash', 'deepseek-chat'],
  },
  {
    name: 'Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  },
  {
    name: '通义千问 Qwen',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-mt-flash', 'qwen-mt-turbo', 'qwen-flash', 'qwen-plus'],
  },
  {
    name: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.7-flash', 'glm-4-flash', 'glm-4.6'],
  },
  {
    name: 'MiniMax',
    baseURL: 'https://api.minimax.io/v1',
    models: ['MiniMax-M2.7-highspeed', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.5'],
  },
  {
    name: '硅基流动 SiliconFlow',
    baseURL: 'https://api.siliconflow.cn/v1',
    models: ['Qwen/Qwen2.5-7B-Instruct', 'deepseek-ai/DeepSeek-V3', 'THUDM/glm-4-9b-chat'],
  },
];

const normalizeUrl = (u: string): string => u.trim().replace(/\/+$/, '').toLowerCase();

// Base URL 候选：按输入过滤（匹配服务商名或 URL），无匹配则回退全部。
// NAutoComplete 选中时把 label 填入输入框，故 label 必须是纯 URL（否则品牌名会进
// baseURL，且模型联动因匹配不到服务商而失效）；服务商名放自定义字段，经 render-label 仅在下拉展示。
const baseUrlOptions = computed(() => {
  const q = props.form.cloud.baseURL.trim().toLowerCase();
  const matched = providerPresets.filter(
    (p) => !q || p.name.toLowerCase().includes(q) || p.baseURL.toLowerCase().includes(q),
  );
  const list = matched.length ? matched : providerPresets;
  return list.map((p) => ({ label: p.baseURL, value: p.baseURL, provider: p.name }));
});

// 下拉项显示「服务商 · URL」；选中填入的仍是纯 URL
function renderBaseUrlLabel(option: SelectOption): string {
  return `${option.provider as string} · ${option.label as string}`;
}

// 模型候选：随当前 Base URL 联动到对应服务商的模型；未匹配到服务商则用全部预设模型去重兜底。
const modelOptions = computed(() => {
  const base = normalizeUrl(props.form.cloud.baseURL);
  const provider = providerPresets.find((p) => normalizeUrl(p.baseURL) === base);
  const models = provider
    ? provider.models
    : [...new Set(providerPresets.flatMap((p) => p.models))];
  const q = props.form.cloud.model.trim().toLowerCase();
  const matched = q ? models.filter((m) => m.toLowerCase().includes(q)) : models;
  const list = matched.length ? matched : models;
  return list.map((m) => ({ label: m, value: m }));
});
</script>

<template>
  <div>
    <n-form-item :label="t('settings.engine')">
      <n-select v-model:value="form.engine" :options="engineOptions" />
    </n-form-item>

    <template v-if="form.engine === 'cloud'">
      <n-alert type="warning" :show-icon="true" class="mb-3.5">{{ t('settings.cloudWarn') }}</n-alert>
      <n-form-item :label="t('settings.baseUrl')">
        <n-auto-complete
          v-model:value="form.cloud.baseURL"
          :options="baseUrlOptions"
          :render-label="renderBaseUrlLabel"
          :get-show="() => true"
          clearable
          placeholder="https://api.openai.com/v1"
        />
      </n-form-item>
      <n-form-item :label="t('settings.model')">
        <n-auto-complete
          v-model:value="form.cloud.model"
          :options="modelOptions"
          :get-show="() => true"
          clearable
          placeholder="gpt-4o-mini"
        />
      </n-form-item>
      <n-form-item :label="t('settings.apiKey')">
        <n-input v-model:value="form.cloud.apiKey" type="password" show-password-on="click" placeholder="sk-..." />
      </n-form-item>
      <!-- 云端提示 + 连接测试为表单的收尾区块：用 pb-6 垫出与 n-form-item 反馈区（24px）
           等高的底部留白，保证无论以哪种状态收尾（有无测试按钮/错误文案），表单底边与
           后续内容的间距都一致。用 padding 而非 margin，避免与相邻元素发生外边距折叠。 -->
      <div class="pb-6">
        <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{{ t('settings.cloudHint') }}</p>

        <!-- 平台支持时才有测试：必填齐全才可点击；仅作连通性自查，不阻断保存 -->
        <template v-if="canTestCloud">
          <div class="mt-3 flex items-center gap-3">
            <n-button
              size="small"
              :disabled="!canTest"
              :loading="cloudTest === 'testing'"
              @click="runCloudTest"
            >
              {{ cloudTest === 'testing' ? t('settings.testing') : t('settings.testConn') }}
            </n-button>
            <span
              v-if="cloudTest === 'ok'"
              class="text-xs font-medium text-green-600 dark:text-green-400"
            >✓ {{ t('settings.testOk') }}</span>
            <span
              v-else-if="cloudTest === 'error'"
              class="text-xs font-medium text-red-600 dark:text-red-400"
            >{{ t('settings.testFail') }}</span>
          </div>
          <p
            v-if="cloudTest === 'error' && cloudTestError"
            class="mt-1 break-words text-xs text-red-500 dark:text-red-400"
          >{{ cloudTestError }}</p>
        </template>
      </div>
    </template>
  </div>
</template>
