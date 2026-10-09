---
id: F20261009av13
title: "锚点版本纪律：adversarial-review 依赖包内文件锚点必须带版本号（#1372 行号漂移根治）"
summary: "#1372 排查结论：PR #1338 检视獭引用 agent-session.d.ts:208 实际类型在 173 行（35 行偏移）——非编造锚点，是升级期同机多 worktree 版本混位（0.84.4/0.86.x/1.1.0 并存）下 grep 命中真实、行号虚标的机械性误标。修复：adversarial-review SKILL.md 事实验证步补「锚点版本纪律」——node_modules 等依赖包内文件锚点必须注明所读版本号与来源路径，行号无版本信息时降级为「符号名+版本」引用。"
change_type: prompt
capability_test: "n/a: skill 文本单行纪律增补（docs-config 级 prompt 微调），无运行时行为面；验证面 = 文本落位 + 既有套件回归（skill 文件改动有 lint-prompt-anchors 扫描兜底）"
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
causal_links:
  - "F20261008pi11"
modules:
  - .pi/skills/adversarial-review/SKILL.md
tags:
  - prompt
  - review-protocol
  - anchor-discipline
created_at: "2026-10-09T17:42:00+08:00"
---

## 1. 背景与根因（#1372 排查结论）

10/9 体检锚点抽查：检视獭-1338 在 PR #1338（pi SDK 0.86.0→1.1.0 升级）审视报告中断言 `QueuedInputDisposition` 位于 `agent-session.d.ts:208`——实测同版本 1.1.0 该类型在 **173 行**，208 行是 token 统计字段（35 行偏移）。

### 排查证据链（对话 d7377cfd，全部工具实测）

| 断言 | 证据 |
|---|---|
| 类型名/类型值/「未从包根导出」全部真实成立 | 主仓 node_modules @1.1.0 复验：`:173 export type QueuedInputDisposition = "handled" \| "queued"` |
| 「读了老版本 0.86.x」不成立 | 0.84.4（collab-room-v2 worktree 实测）该类型**不存在**（仅 `_steeringMessages`）——低版本说不通 |
| 「diff 行号」不成立 | PR #1338 files 无该 .d.ts（纯包内文件，不在 diff） |
| 版本混位条件成立 | 同机 ≥3 份 node_modules：主仓 1.1.0 / deps-upgrade-1009 1.1.0 / collab-room-v2 0.84.4；升级期 0.86.x 必然在位过 |

**定性**：升级期同机多 worktree 版本混位下，grep 命中真实（对 1.1.0 语义全对）但行号在跨版本/跨路径混读或转写时虚标——机械性误标，非凭空编造。具体拼错环节不可再溯（升级期中间态已被 npm install 覆写）。

## 2. 修复方案

在 adversarial-review SKILL.md 步骤 4（事实验证）补「锚点版本纪律」一段：

- 引用 `node_modules/` 等依赖包内文件的 `file:line` 锚点 → 必须同时注明**所读版本号与来源路径**（npm 包版本不在文件路径内，裸行号在多 worktree/多版本并存时无法定位）
- 行号无版本信息时 → 降级为「符号名 + 版本」引用，行号仅作辅助

## 3. 影响范围

- 单文件单行段增补：`.pi/skills/adversarial-review/SKILL.md`（步骤 4 下）
- 行为面：检视獭引用依赖包文件时的锚点格式约束——成本一行文本，收益是混位期锚点可定位性

## 4. 取舍

- **不选**：加 lint 机械校验（扫描审视报告的 node_modules 锚点是否带版本）——审视报告是 PR 评论/对话文本，非仓内文件，lint 无落点；且 #1372 是低频事件（首次实证），文本纪律的牵引力足够
- **不选**：禁止引用依赖包文件——升级类 PR（如 #1338）的核心审视对象恰恰就是依赖包类型面，禁止引用等于砍掉升级审视的锚点能力

## 5. Verification

- 文本落位：`grep -n "锚点版本纪律" .pi/skills/adversarial-review/SKILL.md` 命中
- 回归：skill 文件纯文本增补，无代码路径变更——CI check（lint-prompt-anchors 等扫描）通过即闭环
- 根因证据链：见 §1 表（排查过程全量工具锚点在对话 d7377cfd 留痕）
