---
id: F20260819prmt
title: PR 审视硬规则 + 检视复核流程 + 小獭 R1 红线约束
summary: 增加三条 prompt 层硬规则：PR 创建后必须走对抗审视（#308）、处置检视意见后必须传检视獭复核（#213）、小獭 systemPrompt 必须包含 R1 红线约束（#307）。
change_type: prompt
status: locked
created_in_conversation: bbcfaa33-f036-4493-94de-3faf1c6df6cf
modules:
  - prompts/identity/BIG_OTTER.md
  - prompts/identity/SMALL_OTTER.md
  - .pi/skills/otter-summon/SKILL.md
tags:
  - prompt
  - workflow
  - R1-redline
  - adversarial-review
from:
  - F20260819prmt
capability_test: "n/a: 纯 prompt 文本改动，无代码行为变化"
---

# PR 审视硬规则 + 检视复核流程 + 小獭 R1 红线约束

## 背景

daily-review 发现三个行为退化问题：
- **#308**：大獭创建 PR 后直接交给用户批准，跳过了对抗审视步骤
- **#213**：大獭处置检视意见后直接宣布完成，没有传回检视獭做 delta 复核
- **#307**：大獭让小獭直接修改主目录文件，违反 R1 红线

## 方案设计

### #308 修复：PR 后的硬规则

在 `BIG_OTTER.md` 增加「PR 后的硬规则」段落：
- PR 创建完成后必须召唤检视獭进行对抗审视（见 code-implementation 步骤 10）
- 审视通过后才可呈搭档终审
- 跳过检视直接交搭档 = 流程违规

### #213 修复：检视后的硬规则

在 `BIG_OTTER.md` 增加「检视后的硬规则」段落：
- 处置完检视意见后，必须把行动权（yield）传回检视獭做 delta 复核
- 直接向搭档宣布「审视完成」= 跳过复核 = 违规
- 只有检视獭确认 delta 通过后，才可呈搭档终审

### #307 修复：小獭 R1 红线约束

1. 在 `SMALL_OTTER.md` 增加「仓库安全红线（R1）」段落：
   - 所有文件修改必须在 worktree 中进行
   - 禁止直接修改主目录文件
   - 违反 R1 红线 = 不可接受

2. 在 `otter-summon/SKILL.md` 步骤 2 增加硬规则：
   - 如果任务涉及代码修改，systemPrompt 必须包含 R1 红线提醒

## 不变量

- 三条硬规则均为 prompt 层约束，不改变代码行为
- R1 红线本身已存在于 SYSTEM.md，本次改动是确保小獭层面有显式声明

## 验证

- 人工验证：创建 PR 后大獭是否自动进入对抗审视流程
- 人工验证：处置检视意见后大獭是否传回检视獭复核
- 人工验证：小獭 systemPrompt 是否包含 R1 红线提醒
