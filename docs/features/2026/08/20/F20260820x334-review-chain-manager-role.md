---
id: F20260820x334
title: "#334 #335 联合修复：审视流程链断点 + 大獭管理者角色"
summary: "三方会诊共识方案：6 项 prompt 层修复，解决多獭编排场景下审视流程链断裂和管理者角色缺失问题。"
status: active
change_type: prompt
created_in_conversation: e81ab209-9173-4836-9d66-7f5e7fd281a0
feature_number: F20260820x334
tags: [prompt, review-chain, manager-role, agent-behavior]
modules: [".pi/SYSTEM.md", "prompts/identity/BIG_OTTER.md", "prompts/identity/SMALL_OTTER.md", ".pi/skills/code-implementation/SKILL.md", ".pi/skills/worktree-isolation/SKILL.md", ".pi/skills/otter-summon/SKILL.md"]
from: ["#334", "#335", "#308", "#294", "#295", "#307"]
capability_test: "n/a: prompt-only 改动，无运行时代码，逻辑验证通过"
---

## 背景

2026-08-19 全量对话审计发现两个结构性缺陷：

- **#334 检视流程链断点**：大獭反复跳过对抗审视流程（提完 PR 直接请终审、处置完检视意见跳过 delta 复核）
- **#335 大獭无管理者角色认知**：多獭编排对话中大獭反复自己上手干（亲自写 PR、修 CI、补文档、处置检视意见）

根因：多獭编排场景下，编排层缺乏明确的"管理者角色"定义。

## 方案设计

三方会诊共识（GLM + MiMo + Kimi），6 项 prompt 层修复：

### 1. SYSTEM.md R2 修复
- 将「PR 创建后触发审视」从高风险确认清单移除
- 新增「流程内置步骤」分类：skill 产出表下一步列指向的、且未显式要求搭档确认或异体参与的编号步骤，自动执行
- 新增 R2 分类总则：防 R2 再次吞噬新流程步骤

### 2. BIG_OTTER.md 身份重定义
- 新增「你的角色：编排者」章节
- 身份锚定：「能执行的编排者」（编排 > 执行）
- 正向穷举 3 条可亲自干的情况，其他默认编排
- 负面信号 3 条（含能力兜底排除条件）

### 3. SMALL_OTTER.md 修正
- 删除「编码工具是只读的」错误描述，如实反映工具权限
- 新增 2 条禁止事项：①不能自审 ②不能自封完成

### 4. code-implementation/SKILL.md 步骤 10 强化
- 步骤 9→10 之间加 ⚠️ 断言：PR 创建 ≠ 交付完成
- 步骤 10 开头加小獭场景说明
- 产出表增加「审视通过 → 呈搭档终审」行

### 5. worktree-isolation/SKILL.md 小改动标准
- 从主观定义改为穷举清单（lockfile/纯配置/文档订正）
- 其他一切改动默认走 code-implementation 全流程

### 6. otter-summon/SKILL.md 判断表修正
- 「1 bug fix 自己干」行补充：完成后必须安排异体检视

## 验证方案

1. 编排对话：搭档给多个 issue → 大獭全部下派，不自己写代码
2. PR 流程：PR 创建后自动触发检视，不问用户
3. 检视处置：检视意见 → 回派开发者 → delta 复核 → 收敛才传 user
4. 小改动：走简化审视（B1-B4），但有异体检视
5. 单任务对话：大獭直接做，不召唤小獭
6. 小獭行为：完成后 yield 回大獭声明待检视

## 不做的事

- 不新增 R6 到 SYSTEM.md（注意力稀释 > 收益）
- 不用对话模式表格（判断条件主观，给绕过留空间）
- 不限制小獭编码工具（"假安全"——自审不需要编码工具；会摧毁并行能力）

## 检视结论

MiMo + Kimi 联合检视，5 项发现：
- 严重 1：B1 CI 失败（已 rebase）
- 严重 2：B2 特性文档缺失（已补充本文档）
- 严重 3：R2 越权条款（已收窄措辞）
- 建议 4：BIG_OTTER.md 负面信号 1 加排除条件（已修复）
- 建议 5：otter-summon 锚点对齐（维护注意事项）
