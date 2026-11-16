---
id: F20261113idfpr
title: 宿主注入层身份文案第一人称化对齐（你的身份→我的身份）
doc_type: feature
change_type: fix
summary: "PR #1754 将 SYSTEM.md / BIG_OTTER.md / SMALL_OTTER.md 全量第一人称化，但宿主注入层 identity-builder.ts 的身份文案仍残留第二人称——五个段名（你的身份/你的搭档/你的召唤者/你所在的对话/你的运行时模型）及段内文案（你的署名行/你可以用名字称呼 ta/你正身处这个对话中/你与对方使用不同模型/你的优势维度/召唤你的海獭），层间多人称混排。本次将 identity-builder.ts 注入文案全量第一人称化，同步测试 fixture，并同步 BIG_OTTER.md 与 signature-convention skill 中对「你的身份」段名的引用。"
intent:
  problem: "prompt 层已第一人称化（PR #1754），注入层身份文案（段名+段内）仍第二人称，同一身份信息两套人称认知框架混排，弱化第一人称化的意图。搭档 2026-11-16 定调：非堵塞/非缺陷的可完善项也必须做完整——不做「只改段名、留段内尾巴」的半成品。"
  why_now: "按时间序处理 open issue，#1756 为第 7 件；纯文案同步，零逻辑风险。"
  expected_effect: "identity-builder.ts 注入文案全量第一人称，与 prompt 三文件一致，层间人称混排消除。"
  verify_by:
    type: static_only
    note: "纯文案替换，无行为语义变更；grep 校验 identity-builder.ts 注入文案零「你」残留；system-prompt-injection.test.ts 11 例回归通过。"
capability_test: "n/a: 纯文案第一人称同步，无代码路径可测"
created_at: 2026-11-13
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [prompt, identity-builder, first-person]
modules:
  - src/frameworks/agent/identity-builder.ts
  - tests/frameworks/agent/system-prompt-injection.test.ts
  - prompts/identity/BIG_OTTER.md
  - .pi/skills/signature-convention/SKILL.md
causal_links:
  - F20260810rout
  - F20261103fpidt
---

# F20261113idfpr: 宿主注入层身份文案第一人称化对齐

## 问题

PR #1754 将 SYSTEM.md / BIG_OTTER.md / SMALL_OTTER.md 全量第一人称化，但 `identity-builder.ts` 身份注入层的文案仍残留第二人称——不止三个段名，还有段内文案与另外两个段名。同一身份信息在多套人称框架下呈现，层间混排。

## 修复

五个段名同步第一人称：

- `## 你的身份` → `## 我的身份`
- `## 你的搭档` → `## 我的搭档`
- `## 你的召唤者` → `## 我的召唤者`
- `## 你所在的对话` → `## 我所在的对话`
- `## 你的运行时模型` → `## 我的运行时模型`

段内文案同步第一人称：

- `你的署名行` → `我的署名行`
- `你可以用名字称呼 ta` → `我可以用名字称呼 ta`
- `你正身处这个对话中` → `我正身处这个对话中`
- `你与对方使用不同模型` → `我与对方使用不同模型`
- `优先从你的优势维度切入` → `优先从我的优势维度切入`
- `召唤你的海獭` → `召唤我的海獭`

引用同步（此前引用「你的身份」段名的位置，随段名一起改）：

- `prompts/identity/BIG_OTTER.md`「见『你的身份』段」→「见『我的身份』段」
- `.pi/skills/signature-convention/SKILL.md`「『你的身份』段」→「『我的身份』段」

测试 fixture（system-prompt-injection.test.ts）同步。

## 验证

- system-prompt-injection.test.ts 11/11 通过。
- grep 校验 identity-builder.ts 注入文案零「你」残留（仅存代码注释「我用的是唯一模型」已同步）。
- 纯文案替换，无行为语义变更。