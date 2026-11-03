---
id: F20261103bsrmx
title: 检视 B5 撞车维度降为提醒级（只提醒不仲裁）
summary: |
  adversarial-review skill 的 B5 撞车检查从「命中=严重发现，立即通知大獭仲裁」
  降为「提醒级发现」：写入报告即可，不进严重项、不升级仲裁、不影响处置决策。
  依据是搭档 2026-10-27 定调（colink 仓库两次纠偏后固化）：「在途 pr 冲突只做
  提醒，不要影响 pr 实现，特性开发只看当前最新 main，不要去思考别的 pr 在干
  嘛」。后合入方 rebase 重验是唯一规则。
causal_links:
  relates:
    - "PR #1660"
change_type: fix
tags: [adversarial-review, skill, b5, collision-check, reminder-level]
modules:
  - .pi/skills/adversarial-review/SKILL.md
created_at: 2026-11-03
created_in_conversation: 12967086-9ce5-4cf8-8343-ce4b0fd31519
capability_test: "n/a: skill 文案改动，效果为未来检视獭行为约束，无直接可跑用例"
intent:
  problem: "检视獭机械照 B5 原文把三个 open PR 撞车升级为「需搭档仲裁」，被搭档三次纠正——skill 文案不改，下一只检视獭会复犯"
  expected_effect: "B5 命中写入报告提醒级，不进严重项、不升级仲裁、不影响处置决策；特性开发只看当前最新 main"
  verify_by:
    type: human_judge
---

# 检视 B5 撞车维度降为提醒级（只提醒不仲裁）

## 背景

搭档 2026-10-27 定调（colink 仓库，两次纠偏后固化，原话）：

> 「在途 pr 冲突只做提醒，不要影响 pr 实现，特性开发只看当前最新 main，
> 不要去思考别的 pr 在干吗」

触发场景：检视獭机械照 B5 原文（「命中 = 严重发现，立即通知大獭仲裁」）把
三个 open PR 撞车升级成「需搭档仲裁」，被搭档第三次纠正。检视獭复盘时自述：
它机械照 skill 原文办事，文案不改它没错。

## 变更

`.pi/skills/adversarial-review/SKILL.md` B5 行改为提醒级，并把搭档定调内联
进规则（防止下一只检视獭读到旧语义残留）：

- 命中 = 提醒级发现（写入报告即可）
- 不进严重项、不升级仲裁、不影响处置决策
- 后合入方 rebase 重验是唯一规则

## 设计取舍

- **降级代价**：真正恶意的双头推进（同一 issue 两线同时开工）不再自动升级
  仲裁，只剩报告里的提醒行。这是搭档显式决策的取舍——撞车误报的打扰成本
  （搭档被叫来仲裁三次都是误报）高于漏报风险（rebase 重验兜底）。
- **时间序信息保留**：worktree-isolation 步骤 2 的认领协议仍管开工侧撞车；
  B5 只管检视侧呈现，降级不影响认领协议的仲裁规则。
- **规则来源内联**：把搭档定调原文浓缩进 B5 行内，规则自带依据，不依赖
  检视獭另行检索记忆。

## 接管记录

- 2026-10-27 由原对话创建 PR #1660（commit F20261027b5rm，4 字母旧编号），
  后停滞：CI 因分支落后 main 变红，审视未走，特性文档未建。
- 2026-11-03 大獭经搭档授权接管（「你来接手下pr1660」）：rebase 到最新
  main、定稿编号顺延合入日 F20261103bsrmx（原建 F20261028bsrmx，F20260914prdb 规则：定稿改名合入日）、补建
  本特性文档、走完对抗审视后呈终审。

## Verification

- 变更内容：SKILL.md 单行文案改动 + 本特性文档新增，共 2 文件（初版 80093f2c → 订正 a6848068，后续以 PR #1660 head 为准——分支为单链修订，`git log --oneline origin/main..fix/b5-reminder-level` 可复验，无其他文件被触及）。
- CI：合入前置以 PR #1660 checks 页 head 最新 run 四绿为准；历史记录：run 41568709558 全绿（head=80093f2c 时点）。初跑 run 41568344858 的 check 失败系 PR body 缺测试改动声明段（守卫 scripts/check-pr-tests.mjs），补声明后 edited 重跑转绿。
- Golden Gate: n/a（verify_by=human_judge——「检视獭不再把撞车升级仲裁」
  需实际检视行为观察，无 static 场景可跑）。
- bugfix 证据链豁免说明：本改动是规则文案降级，无失败用例可复现（原行为
  「升级仲裁」不是代码 bug 而是规则设计错误），失败证据即搭档三次纠正的
  对话记录（见背景节引文）。
