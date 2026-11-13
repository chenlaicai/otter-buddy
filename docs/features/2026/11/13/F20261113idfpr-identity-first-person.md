---
id: F20261113idfpr
title: 宿主注入层段名第一人称化对齐（你的身份→我的身份）
doc_type: feature
change_type: fix
summary: "PR #1754 将 SYSTEM.md / BIG_OTTER.md / SMALL_OTTER.md 全量第一人称化，但宿主注入层 identity-builder.ts 仍硬编码「## 你的身份」「## 你的搭档」「## 你的召唤者」第二人称段名，形成层间混排。本次将三个段名同步为第一人称（「## 我的身份」「## 我的搭档」「## 我的召唤者」），并同步测试 fixture。"
intent:
  problem: "prompt 层已第一人称化（PR #1754），注入层段名仍第二人称，同一身份信息两套人称认知框架混排，弱化第一人称化的意图。"
  why_now: "按时间序处理 open issue，#1756 为第 7 件；纯文案同步，零逻辑风险。"
  expected_effect: "identity-builder.ts 三段段名与 prompt 文件一致使用第一人称，消除层间人称混排。"
  verify_by:
    type: static_only
    note: "纯段名文案替换，无行为语义变更；system-prompt-injection.test.ts 11 例回归通过。"
capability_test: "n/a: 纯文案段名同步，无代码路径可测"
created_at: 2026-11-13
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [prompt, identity-builder, first-person]
modules:
  - src/frameworks/agent/identity-builder.ts
  - tests/frameworks/agent/system-prompt-injection.test.ts
causal_links:
  - F20260810rout
---

# F20261113idfpr: 宿主注入层段名第一人称化对齐

## 问题

PR #1754 将 SYSTEM.md / BIG_OTTER.md / SMALL_OTTER.md 全量第一人称化，但 `identity-builder.ts` 身份注入段的三个标题仍是第二人称硬编码：「你的身份」「你的搭档」「你的召唤者」。同一身份信息在两套人称框架下呈现，层间混排。

## 修复

三个段名同步为第一人称：

- `## 你的身份` → `## 我的身份`
- `## 你的搭档` → `## 我的搭档`
- `## 你的召唤者` → `## 我的召唤者`

测试 fixture（system-prompt-injection.test.ts）同步。

## 验证

- system-prompt-injection.test.ts 11/11 通过。
- 纯文案替换，无行为语义变更。