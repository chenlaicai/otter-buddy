---
id: F20260914ectx
title: bash 守卫内嵌文本脱敏：引号内数据文本不再误拦 + 审视 skill 模板 body-file 化
summary: 解决 #858——守卫对「文本提及」与「执行意图」不区分，gh --body 引 review 文本/heredoc 写 issue 正文/测试字符串全被拦（13 起实证，对抗审视流程在守卫层断裂）。两层修复：守卫层引号内数据段脱敏（危险通道整体跳过）+ skill 层审视模板改 body-file 路径。
change_type: feature
capability_test: "n/a: 守卫运行时防护层，行为由新单测锁定（现场 13 起形态回归 + 真实危险维持拦截）；skill 模板为静态文档变更"
created_in_conversation: c2f347c6-7e59-4e2e-ab48-10f64a5a1258
created_at: 2026-09-14
intent:
  problem: "bash 守卫把引号内文本提及的进程终止族词元当执行意图误拦，检视/issue/测试三类生态操作被阻断（13 起实证）"
  expected_effect: "gh --body 引文本/heredoc 正文/测试字符串类纯数据操作零误拦；真实危险（引号外命令位/双引号内命令替换/shell 载荷通道）维持拦截"
  verify_by:
    type: behavior_check
tags: [bash-guard, security, false-positive, review-protocol, daily-review]
modules:
  - src/frameworks/agent/quoted-text-sanitizer.ts
  - src/frameworks/agent/bash-safety-guard.ts
  - .pi/skills/adversarial-review/SKILL.md
  - tests/frameworks/agent/quoted-text-sanitizer.test.ts
---

# bash 守卫内嵌文本脱敏（#858）

## 背景

守卫按词元扫描拦截，但「文本提及」与「执行意图」不区分：检视獭按 adversarial-review 模板执行 `gh pr review --body '...'`，body 里被审查的守卫源码文本含进程终止族词元 → 整条命令被拦（13 起实证，含 2 个 conversation 的审视流程熔断）；heredoc 写 issue 正文被拦；本特性开发过程中实现者自己又被拦 2 次（调试命令内联测试字符串）——守卫对自身生态文本不免疫是持续放血的信任侵蚀源。

## 方案

### 守卫层：引号内数据段脱敏（quoted-text-sanitizer.ts）

- **判定**（shouldSanitizeForScan，全过才脱敏）：① 引号内「多词文本」存在（QUOTED_TEXT 要求含非词字符，排除 `'kill'` 单词全引号——那是 #850 归一化领地）② 其中含敏感词元 ③ 无危险通道（bash -c / pipe-to-shell / 脚本 one-liner / heredoc——这些通道的引号内是执行内容，整体跳过脱敏保守处理）；
- **脱敏**（sanitizeQuotedText）：只把引号内文本段的敏感词元等长替换为 X（位置/长度稳定），引号外零触碰——真实命令位词元不受影响；
- **接入点**（checkBashCommandSafety）：脱敏判定先跑，脱敏后干净 → 放行；仍命中（引号外有真实命令）→ 落回原文本路径（诊断信息扫原文，回显真实命中点）；
- **假引号边界防御**（开发中实测回归修复）：判定与脱敏前先剥空引号对（`''`/`""`，与守卫 normalizeForDetection 同语义）——`p''kill -f "xxx/ma''in.js"` 的空引号对会制造假引号边界，QUOTED_TEXT 跨界误判会把命令位词元吞进「数据段」造成漏拦。

### skill 层：审视模板 body-file 化（adversarial-review/SKILL.md 步骤 6a）

模板从 `gh pr review --body "…内联正文…"` 改为「write 工具落文件 → `--body-file` 引用」——命令行不含报告正文，天然避开词元扫描，同时解决 shell 转义问题。报告内容模板保留（markdown 代码块形态）。

### 观察层

守卫误拦率统计已在跑（guard_intercept healing 聚类 + #844 升级机制），无需新增机制。

## 验证

- 新增 15 单测：shouldSanitizeForScan 判定 5 + sanitizeQuotedText 替换 3 + 守卫集成 7（现场 13 起的形态回归：gh --body 引 review 文本/issue 正文/测试字符串放行；真实危险维持：引号外命令位主进程 PID/bash -c/pipe-to-shell/混合形态/#850 单词全引号语义）；
- 全量 2943/2943 pass（含 #844 全部用例、#850 全部 89 用例、#858 假边界回归），tsc 0 error，eslint 0 error；
- 最简实现检查：已过——脱敏是独立纯函数模块（~90 行），接入点单一（checkBashCommandSafety 入口 5 行），未引入依赖。

## 边界与已知限制

- heredoc 跨行正文不在守卫层覆盖（<<< 起始符存在即整体跳过脱敏）——skill 层 body-file 是正道，已在模板写明；
- 脱敏只豁免「引号内数据文本」，#844 的端口白名单放行、#850 的位置感知白名单、铁拦三件全部原语义不变；
- SKILL.md 是 git 追踪文件，本 PR 一并提交（skill 层与守卫层同 PR 交付，避免两层不同步窗口）。

## 关联

- closes #858
- 地基：#777/#850（位置感知白名单）、#844（端口白名单，同日合入）
