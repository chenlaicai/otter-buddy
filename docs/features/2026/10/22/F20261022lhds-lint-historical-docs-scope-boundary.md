---
id: F20261022lhds
title: lint-historical-docs 文案边界修正——单仓机制声明 + 缺 hook 仓以异体审视兜底（issue #1612）
summary: worktree-isolation / code-implementation / SKILL-TEMPLATE 三处将 lint-historical-docs 无条件表述改为条件化：声明其为 otter-buddy 单仓 pre-commit hook 机制（.githooks 域），其他仓零机械校验时铁律靠执行者自查 + 异体审视兜底。
change_type: prompt
capability_test: "n/a: 纯 skill 文本改动，无代码路径；验收靠 lint:skills + 检视獭 delta 复核"
intent:
  problem: "三处 skill 文案（worktree-isolation:68、code-implementation:73、SKILL-TEMPLATE:155）将 lint-historical-docs 无条件表述为机械拦截兜底——但它是 otter-buddy 单仓的 .githooks/pre-commit 机制，其他仓（如 EchoAgent）无该 hook。执行者会误信『历史文档不可变』有机械拦截而放松自查，实际零机械校验，可能无告警地 M/D 已进 main 的历史文档，违反铁律。"
  expected_effect: "文案条件化后，执行者在任何仓都清楚拦截边界：本仓有 pre-commit 机械拦截；其他仓铁律靠自查 + 异体审视兜底。误导性依赖被移除。"
  verify_by:
    type: static_only
    detail: "skill 文本语义核验（3 处条件化表述逐条对照 issue #1612 锚点）+ lint:skills 通过 + 检视獭 delta 复核"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
causal_links:
  - F20261009hcig（lint-historical-docs CI gate 机制的建立——本文档修正其在 skill 文案中的作用域表述）
tags: [skill, lint-historical-docs, writing-skills, tech-debt]
modules: [skill]
---

# lint-historical-docs 文案边界修正（issue #1612）

## 1. 来源

issue #1612（P2 tech-debt，2026-10-22 立案）：对话待办 M-d781032a（2026-10-20 登记，writing-skills 域）经搭档指示从待办板撤下改走 issue（「待办是给我看的啊，你这个提个海獭仓库的issue」）。

## 2. 病灶与机制事实

- **机制事实**（锚点：`.githooks/pre-commit:27` 调 `node scripts/lint-historical-docs.mjs`）：lint-historical-docs 是 otter-buddy 单仓的 pre-commit hook 机制，属 .githooks 域，不随 skill 文本分发到其他仓。
- **病灶**：三处文案无条件表述「机械拦截」，在缺 hook 的仓构成误导——执行者放松自查，铁律裸奔。

## 3. 处置表

| # | 文件 | 原表述 | 条件化后 |
|---|------|--------|----------|
| 1 | `.pi/skills/worktree-isolation/SKILL.md`（历史文档不可变段） | 「pre-commit 的 lint-historical-docs 机械拦截」 | 「**机械拦截边界**：lint-historical-docs 是 otter-buddy 单仓机制（.githooks/pre-commit 调 scripts/lint-historical-docs.mjs）——本仓有 pre-commit 机械拦截；**其他仓无该 hook、零机械校验，铁律靠执行者自查 + 异体审视兜底**（检视核对未触碰历史文档）」 |
| 2 | 同上（.doc-fix 开口段） | 「（lint 机械校验，正文修改即使配 .doc-fix 也会被拒）」 | 「（本仓 lint 机械校验……；其他仓同样以审视核对兜底）」 |
| 3 | `.pi/skills/code-implementation/SKILL.md`（步骤 7 文档段） | 「pre-commit 的 lint-historical-docs 会机械拦截」 | 「lint-historical-docs 机械拦截是 otter-buddy 单仓 pre-commit hook，其他仓缺 hook 时以异体审视兜底」 |
| 4 | `.pi/skills/writing-skills/references/SKILL-TEMPLATE.md`（历史文档不可变段） | 「机械拦截：pre-commit 的 scripts/lint-historical-docs.mjs」 | 「机械拦截：otter-buddy 单仓 pre-commit 的 scripts/lint-historical-docs.mjs（.githooks 域）；其他仓缺该 hook，铁律以异体审视兜底」 |

**范围说明**：issue 预估「改动 1-2 处表述」，实际同病灶误导表述有 3 个文件共 4 处（含 .doc-fix 括号句）——留一处即误导残留，故同质修全。仍属修法决策树①（既有语义内修，narrow-fix）：不新增机制、不改拦截行为，纯文案条件化。

## 4. 边界与在途提示

- 与 **F20261021cpex**（对话 ecd9d9b3，worktree fix-claim-protocol-exit，staged 未提交）同文件不同段落：cpex 改 frontmatter/触发段/认领协议/小改动段，本改动只触「历史文档不可变」bullet 与 code-implementation/SKILL-TEMPLATE 文案，diff hunk 零重叠。后合入方 rebase 即可。
- 不改 lint-historical-docs 的拦截行为与 .doc-fix 机制本身（那是 F20261009hcig 域）。

## 5. 验证

- `npm run lint:skills`：通过（见 PR CI）
- 文案语义核验：4 处条件化表述逐条对照 issue #1612 修复方案的两个要素（单仓机制声明 + 缺 hook 仓审视兜底），均落实
