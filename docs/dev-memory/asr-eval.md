---
name: asr-eval
description: ASR 识别准确率 CER 评测基建的用法、用例格式、指标解读与首批发现
metadata:
  node_type: memory
  type: project
  originSessionId: ba69b4a0-aadb-4514-8a44-a9107afccc29
---

# ASR CER 评测基建（2026-07-22 建成）

[project-direction](project-direction.md) 中「调参先建 CER 评测脚本」的 backlog 已落地。
入口：`pnpm --filter @rt/macos eval-cer`（脚本 `apps/macos/test/eval-cer.ts`，沿用
`build-test.mjs` 冒烟脚本体系；模型需先在 App 内下载）。

## 设计

- **两个 CER 对照**：`pipeline`（产品同款实时管线：流式喂入 + 滑动窗口提交，即用户实际
  看到的准确率）与 `offline`（同一模型对 VAD 切段做一次性离线解码 = 非流式上限），
  **两者之差≈实时管线自身引入的损耗**——把「模型不行」与「管线搞坏了」分开归因。
- **LID 误判列**：senseVoice + auto + 用例声明语种时，统计定稿段语种≠声明语种的段数，
  量化 auto 模式语种误判（project-direction 定性的「准确率第一杠杆」自此可量化）。
- 参数：`--models a,b` / `--language auto|zh|en|ja|ko`（量化「锁定语言 vs auto」）/
  `--cases <dir>` / `--dump`（打印 REF/PIPE/OFF 全文人工核对）。
- 用例 = `<name>.wav`（16kHz 单声道）+ `<name>.txt`（参考全文）+ 可选 `<name>.json`
  （`{ "lang": "ja" }`）。模型不支持用例声明语种时自动跳过（避免垃圾行污染合计）。
- CER 归一化：NFKC + 小写 + 去空白/标点/符号；zh 用例另做简体归一化（sify）。
  编辑距离按码点计，汇总行 = 总编辑距离/总参考字数（加权）。
- VAD/模型配置与产品同源：复用 `apps/macos/src/main/pipeline.ts` 导出的
  `buildVadConfig` / `buildModelConfig`（参数单源，评测即评产品）。

## 用例与注意事项

- `apps/macos/scripts/gen-eval-audio.sh` 用 macOS `say` 合成 zh/ja/en 三个冒烟用例到
  `apps/macos/test-audio/eval/`。**TTS 音频干净、语速均匀，只能冒烟验证链路与粗对比，
  调参结论必须以真实录音用例为准**（往同目录扔 wav+txt 即可扩充）。
- 参考文本的数字表记按模型输出惯例书写（zh/en 经 ITN 出阿拉伯数字、ja 出汉数字），
  否则「fifteen percent vs 15%」这类表记差被计成识别错误。パーセント/％ 之类的
  单位表记差异仍无法两全（％ 被归一化剥掉），跨模型对比时留意。
- `pipeline` 列有轻微的运行间波动（解码 tick 节奏依赖 wall-clock 的自适应间隔），
  对比调参效果时建议跑两遍确认稳定；`offline` 列在同一配置下确定。
- 自回归 transducer（reazon/parakeet）对过长段会整块坍缩（见 project-direction
  2026-07-04 条），其 `offline` 列只在 VAD 段长可控时才是可信上限。

## 首批发现（TTS 冒烟用例）与修复（2026-07-22，见 [pipeline-recant](pipeline-recant.md)）

- **ja 用例曾暴露管线灾难性损耗（已修复）**：sense-voice `pipeline` CER 47~49% vs
  `offline` 0.8%（zh/en 用例损耗仅 ±2pt），锁定 `--language ja` 依旧 → 与 LID 无关。
  探针定位为「模型翻供 × 前缀单调假设」的三个叠加缺陷，修复后 `pipeline` 10.6%
  （加权合计 20.2%→5.0%），残余主要是数字表记噪声（`80%` vs `八十パーセント`）与
  模型自身读法怪癖，细节见 [pipeline-recant](pipeline-recant.md)。
- reazon（chunk 提交）ja 用例 `pipeline` 22.8% = `offline` 22.8%，chunk 策略本身
  零管线损耗；其绝对 CER 偏高是模型对 TTS 音色的适配问题。
- sense-voice auto 模式在干净 TTS 音频上仍有 1/5 段语种误判，印证「锁语言」杠杆。

**Why:** 此前调参全靠人工 A/B 与主观感受（project-direction 2026-07-03 明确记录），
无法量化跟踪准确率变化；评测基建是后续一切识别调参/换模型讨论的前置。
**How to apply:** 动任何识别参数、换模型、改提交策略前先跑 `eval-cer` 留基线，改完对照；
新增真实录音用例往 `test-audio/eval/` 扔 wav+txt+json 即可。
