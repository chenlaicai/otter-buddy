---
id: F20260827iddd
title: skill 层特性 ID 生成前查重，防跨 worktree 文档撞车（#524）
summary: |
  修复流程层缺陷：LLM 自编号特性 ID 时无查重机制，同一文档跨 worktree 演进时生成新 ID，
  旧 ID 的 chunk 残留 memory 库形成重复污染（#524）。根因不在代码层——replaceEntriesBySource
  原子替换本身无 bug，但对「同内容不同 source_id」免疫。修复：在 skill 流程三层落点
  （worktree-isolation 主入口 / code-implementation / commit-convention 模板）加入
  「生成新 ID 前必须 grep docs/features/ 查重，存在同 title/语义相同文档则复用原 ID」规则。
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc

causal_links:
  from:
    - F20260827mpcg

status: development
change_type: fix
tags: [skills, memory, hygiene, process]
modules:
  - .pi/skills/worktree-isolation/SKILL.md
  - .pi/skills/code-implementation/SKILL.md
  - .pi/skills/code-implementation/references/commit-convention.md

test_plan: skill lint（lint-skills.mjs）通过即视为验证——本改动为纯 prompt/文档层，无代码路径。
verification: lint 0 error（7 条均为存量警告，与本次改动无关）。

review_evidence: PR review comment（对抗审视留痕）。
---
