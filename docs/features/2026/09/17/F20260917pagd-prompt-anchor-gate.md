---
id: F20260917pagd
title: prompt 锚点 gate：注入面 F/issue 编号 lint 拦截 + 168 处存量清理
summary: |
  搭档第三次发现「认可移除编号污染却持续复发」（9/9 熵减清零后 8 天回潮 46+112+10 处）。
  三獭架构审视（glm×2/glm-flash）+ 大獭复核收敛唯一结构性解法：修订时刻判据无法约束写入时刻，
  必须机械 gate。本特性：①lint-prompt-anchors.mjs 扫注入面（SYSTEM.md/prompts/**/.pi/skills/**/
  tools description 字面量）pre-commit 拦截，白名单 ≤10 硬上限；②存量锚点全量剥除（剥编号留语义，
  教训现场三要素不需要编号 token）；③5 处「全局约定」死指针修复（指向 worktree-isolation 内联段）；
  ④SYSTEM.md R2 daily-review 命名归一为 daily-health-check。daily-review 本体删除由在途
  PR #1017（三省吾身整合）承载，本 PR 不重复。TS 扫描剥注释保字符串——注释是决策史合法归位。
change_type: prompt
capability_test: "n/a: 纯 prompt/lint 脚本改动，无 capability 场景可跑；验证走 gate 反向测试（注入锚点 exit=1/清除 exit=0，已跑通）+ lint:skills 0 error + 落地后存量 grep 清零"
created_in_conversation: 0cb63991-375d-4c5d-89b6-137aa5afd202
created_at: 2026-09-17
intent:
  problem: "F 编号/issue 锚点持续写入 prompt/skill/tool 注入面（9/9 清零后 8 天回潮 168 处），修订时刻的熵减判据约束不了写入时刻——无机械 gate 时陈述性原则永远输给写入时刻的程序性压力"
  expected_effect: "pre-commit 注入锚点拦截（exit=1 附处置指引）；存量清零；后续注入锚点合入即被拦，白名单超限（>10）被拦"
  verify_by:
    type: behavior_check
modules:
  - scripts/
  - .pi/
  - prompts/
  - src/interface-adapters/agent-runtime/tools/
tags: [prompt, entropy-reduction, lint-gate, anchor-pollution]
---

# prompt 锚点 gate

## 背景

搭档原话（2026-09-17）：「我以前让你们整改过一次特性编号及链接都写入到 prompt/skill/tool 这里的描述里面，简直都污染上下文。然后我这今天又发现，你们调整时又在干这件事，我很疑惑，明明你们也认可我说要移除这些污染信息，但为什么你们又还在这么干」。

## 根因（三獭审视收敛，审视报告见对话工作区 reports/）

陈述性知识（原则）输给程序性压力（写入时刻拉力），因为裁判缺席：
1. 示例教编号——5b 规则文本中立但范本+判定示例全带编号，LLM 从范例习得
2. A1 证据锚点规则域混淆——对话层规则被带进文件写入时刻
3. 风险不对称——删错有案底（8/25 hcpg 失传事故）、塞错无计费

## 方案

机械 gate + 存量清理 + 死指针修复 + 命名归一。机制预算四问（方案期作答）：
①谁需要：写 prompt 的獭（写入时刻即时反馈）+ 搭档（不再人肉盯复发）
②失败模式：误拦→绕过 hook（缓解：首批白名单搭档过目+拦截消息给豁免路径）；白名单垃圾场（缓解：≤10 硬上限）；误伤合法内容（缓解：逐案评审留痕）
③后续机制：白名单治理（可能只加不审——上限+每次 PR 检视 B2 顺带数条目）
④退役：不设「降级 warning」（warning 即纵容）；终态=永久 gate 或整体删除（触发：连续 90 天零白名单新增且存量保持 0，搭档一句话决定）

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| scripts/lint-prompt-anchors.mjs | A | gate 本体（剥注释保字符串，md 全文扫，TS 只扫字符串字面量） |
| scripts/prompt-anchor-whitelist.txt | A | 首批白名单 2 条（依赖升级自动化 PR #419 两处，搭档过目） |
| .githooks/pre-commit | M | 挂载 gate |
| package.json | M | lint:prompt-anchors script |
| .pi/SYSTEM.md + .pi/skills/**（25 件） | M | 剥锚点留语义 + 死指针修复 + R2 命名归一 |
| prompts/identity/*.md + scheduled/*.md（6 件） | M | 剥锚点留语义 |
| src/**/tools/*.ts（5 件） | M | description/运行时消息字符串剥锚点（注释保留=决策史合法归位） |

## 明确不做

- daily-review.md 本体删除：由在途 PR #1017 承载，本 PR 不重复不撞车
- tool description 压缩（-37%）：PR-C 范围
- 四问事前化 / 5b 去编号 / 防锚定硬化：PR-B 范围
- 锚点重放评审触发条件规则化（枚举→规则）：随本 PR 同理念但落 code-implementation:120 修订——本 PR 已含 code-implementation 修改，该条并入本 PR 一起改（见 code-implementation SKILL.md diff）

## 验证

- gate 反向测试：注入锚点 exit=1（附处置指引）、清除后 exit=0 ✅
- 存量清零：.pi/ + prompts/（除白名单 2 条 + 占位符 #N/#NNN）+ 注入面 description grep 0 命中 ✅
- lint:skills 0 error ✅
