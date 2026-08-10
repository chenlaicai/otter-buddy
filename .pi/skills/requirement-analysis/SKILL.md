---
name: requirement-analysis
description: >-
  This skill should be used when the user asks to "分析需求", "设计方案", "做技术方案",
  "需求分析", "这个需求怎么做", "帮我看看这个需求", "出个方案", "技术设计",
  or needs to understand requirements, identify ambiguities, define scope,
  or produce a structured technical design document from a user request.
  Provides a structured workflow for turning vague user intent into actionable technical plans.
triggers:
  phrases:
    - "分析需求"
    - "设计方案"
    - "做技术方案"
    - "需求分析"
    - "这个需求怎么做"
    - "帮我看看这个需求"
    - "出个方案"
    - "技术设计"
co_loads: []
---

# Requirement Analysis

Transform vague user intent into a clear, executable technical plan.

> **触发短语**：分析需求 | 设计方案 | 做技术方案 | 需求分析 | 出个方案 | 技术设计
> **共加载**：无

## Core Principles

- **Anchor to user's words**: Quote the user's original request verbatim. Do not paraphrase — modifiers and constraints get lost in translation.
- **Distinguish known from unknown**: Separate requirements into three buckets — explicit (can execute now), ambiguous (must ask), implicit (may need to surface).
- **Ground in reality**: Every design decision must trace back to existing code, prior decisions, or explicit user direction. No speculative design.
- **Stop at implementation**: If the output describes specific code changes, stop — that belongs in the implementation phase.

## 输入契约

本 skill 需要以下输入才能开始工作：

| 输入 | 必选/可选 | 来源 | 缺失时处理 |
|------|----------|------|-----------|
| 需求描述 | 必选 | 搭档 | 停下来问搭档 |
| 业务上下文 | 可选 | 搭档或对话历史 | 用 search_memory 补充 |
| 技术约束 | 可选 | 搭档或既有文档 | 从代码库推断，但标注为假设 |

## Workflow

### 1. Parse the Request

Read the requirement description. Categorize each element:

| Category | Action |
|----------|--------|
| Explicit | Mark as ready to execute |
| Ambiguous | Flag for user clarification — do NOT assume |
| Implicit | Surface proactively, ask if needed |

### 2. Retrieve Context

- Use `search_memory` to find prior decisions related to this area
- Use `search_terminology` to confirm terminology alignment between user language and codebase
- Identify existing constraints that bound the solution space

### 3. Analyze Current State

Read relevant code and documentation:

- How does the system handle this today?
- Which modules/files are involved?
- What known limitations or constraints exist?

### 4. Assess Risks

- What existing functionality is affected?
- Are there breaking changes?
- What edge cases might be overlooked?

### 5. Produce the Plan

Output a structured technical plan using the template below.

### 6. 对抗审视

按 `_shared/review-protocol.md` 中的"方案审视协议"执行。

## Behavioral Rules

- Multiple viable approaches → list tradeoffs for each, recommend one
- User says "就这样" or "必须" → execute the decision, do not argue
- Record both supporting and opposing arguments for every design choice, not just conclusions

## 产出模板

```markdown
## 背景

为什么要做这件事。引用搭档的原始需求（意图锚）。

## 目标

要达成什么效果。列出具体、可验证的目标（T1, T2, ...）。

## 非目标

明确排除的内容。防止范围蔓延。

## 方案设计

具体的技术方案，包括：
- 涉及哪些模块/文件
- 核心逻辑设计
- 数据模型变更（如有）
- 关键接口定义（如有）

## 影响范围

这个方案会影响哪些已有功能。

## 风险与约束

已知风险点和需要注意的约束。

## 不兼容更新

如有破坏性变更，在此列出。标注 [Incompatible]。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| ... | ... | ... | ... |

## 验证

验收标准和测试设计。

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| ... | 新增/修改/删除 | ... |
```

**Writing Rules**：
- 背景 must cite the user's original words (intent anchor), not a paraphrase
- 目标 uses numbered items (T1, T2, ...) for traceability
- 非目标 is mandatory — always explicitly state what is out of scope
- 设计取舍 records tradeoffs with alternatives and reasoning, not just the decision
- 改动范围 lists every file that will be touched

## 后续动作声明

| 产出类型 | 下一步动作 | 执行者 | 触发条件 | 不满足时处理 |
|----------|-----------|--------|----------|-------------|
| 技术方案文档 | 对抗审视 | 检视獭（异体） | 方案落盘后 | 搭档不在场 → 记录方案到 memory，搭档回来后决定是否审视 |
| 需求澄清问题 | 等待搭档回答 | 搭档 | 存在未解答的澄清问题时 | 正常终止，不阻塞 |

### 异体执行原则

方案审视在多 agent 场景下由架构保证异体（大獭召唤检视獭）。
单 agent 场下降级：大獭做方案后，至少等待搭档确认方案后方可进入实现阶段。
搭档明确说"跳过审视"时，记录决策后放行，进入实现阶段。

### 弹性完成规则

当搭档明确表示满意（"行了"、"够了"、"就这样"）时，即使流程步骤未走完，也可以终止。但必须在终止前：
1. 确认搭档是否了解未走完的步骤可能带来的风险（如：方案未经审视）
2. 搭档知情后仍选择跳过 → 记录决策后放行

注意：这不适用于搭档不在场的情况——搭档不在时按正常流程走。

## Additional Resources

### Reference Files

- **`references/intent-anchor-guide.md`** — How to extract and preserve intent anchors with traceability
- **`_shared/review-protocol.md`** — 对抗审视协议（方案审视）
