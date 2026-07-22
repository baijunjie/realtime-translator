#!/usr/bin/env bash
# 用 macOS 自带 TTS（say）合成 CER 评测的冒烟用例到 test-audio/eval/。
# TTS 音频干净、语速均匀、无噪声/口音，只能用来冒烟验证评测链路与粗对比，
# 调参结论请以真实录音用例为准（用例格式见 test/eval-cer.ts 头注释）。
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out_dir="$here/../test-audio/eval"
mkdir -p "$out_dir"

# 参考文本的数字表记按各语言模型的实际输出惯例书写（zh/en 经 ITN 输出阿拉伯数字，
# ja 模型输出汉数字），避免把「fifteen percent vs 15%」这类表记差异计为识别错误。
# gen <name> <voice> <lang> <朗读文本（[[slnc N]] 为停顿毫秒，制造 VAD 断句点）> <参考文本>
gen() {
  local name="$1" voice="$2" lang="$3" speak="$4" ref="$5"
  if ! say -v '?' | grep -q "^${voice} "; then
    echo "跳过 ${name}: 缺少语音 ${voice}（系统设置›辅助功能›朗读内容 里下载）" >&2
    return
  fi
  local tmp_aiff="${out_dir}/${name}.tmp.aiff"
  say -v "$voice" -o "$tmp_aiff" "$speak"
  afconvert -f WAVE -d LEI16@16000 -c 1 "$tmp_aiff" "${out_dir}/${name}.wav"
  rm -f "$tmp_aiff"
  printf '%s\n' "$ref" > "${out_dir}/${name}.txt"
  printf '{ "lang": "%s" }\n' "$lang" > "${out_dir}/${name}.json"
  echo "生成 ${name}.wav ($(du -h "${out_dir}/${name}.wav" | cut -f1 | tr -d ' '))"
}

zh_text="大家好，欢迎参加今天的产品评审会议。[[slnc 700]] 我们首先回顾上个季度的销售数据，整体收入增长了百分之十五。[[slnc 700]] 接下来讨论新版本的发布计划，目标是在8月20日之前完成全部测试。[[slnc 700]] 如果大家没有其他问题，会后我会把纪要发到群里。"
zh_ref="大家好，欢迎参加今天的产品评审会议。我们首先回顾上个季度的销售数据，整体收入增长了15%。接下来讨论新版本的发布计划，目标是在8月20日之前完成全部测试。如果大家没有其他问题，会后我会把纪要发到群里。"

ja_text="皆さんこんにちは。本日はお忙しい中お集まりいただきありがとうございます。[[slnc 700]] まず先月の進捗状況を確認します。開発は予定通り進んでおり、テストの完了率は80パーセントです。[[slnc 700]] 次に、今後のスケジュールについて話し合いたいと思います。[[slnc 700]] リリースは9月の第2週を予定しています。"
ja_ref="皆さんこんにちは。本日はお忙しい中お集まりいただきありがとうございます。まず先月の進捗状況を確認します。開発は予定通り進んでおり、テストの完了率は八十パーセントです。次に、今後のスケジュールについて話し合いたいと思います。リリースは九月の第二週を予定しています。"

en_text="Good morning everyone, and welcome to today's product review meeting. [[slnc 700]] First, let's take a look at last quarter's sales numbers, which grew by fifteen percent overall. [[slnc 700]] Next, we will discuss the release plan for the new version. [[slnc 700]] Our goal is to finish all testing before August twentieth."
en_ref="Good morning everyone, and welcome to today's product review meeting. First, let's take a look at last quarter's sales numbers, which grew by 15% overall. Next, we will discuss the release plan for the new version. Our goal is to finish all testing before August 20."

gen "tts-zh-meeting" "Tingting" "zh" "$zh_text" "$zh_ref"
gen "tts-ja-meeting" "Kyoko" "ja" "$ja_text" "$ja_ref"
gen "tts-en-meeting" "Samantha" "en" "$en_text" "$en_ref"

echo "完成。运行评测: pnpm --filter @rt/macos eval-cer"
