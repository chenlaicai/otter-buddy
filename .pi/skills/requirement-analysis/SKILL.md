---
name: requirement-analysis
description: >-
  This skill should be used when the user asks to "分析需求", "设计方案", "做技术方案",
  "需求分析", "这个需求怎么做", "帮我看看这个需求", "出个方案", "技术设计",
  or needs to understand requirements, identify ambiguities, define scope,
  or produce a structured technical design document from a user request.
  Provides a structured workflow for turning vague user intent into actionable technical plans.
---

# Requirement Analysis

Transform vague user intent into a clear, executable technical plan.

## Core Principles

- **Anchor to user's words**: Quote the user's original request verbatim. Do not paraphrase — modifiers and constraints get lost in translation.
- **Distinguish known from unknown**: Separate requirements into three buckets — explicit (can execute now), ambiguous (must ask), implicit (may need to surface).
- **Ground in reality**: Every design decision must trace back to existing code, prior decisions, or explicit user direction. No speculative design.
- **Stop at implementation**: If the output describes specific code changes, stop — that belongs in the implementation phase.

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

Output a structured technical plan using the template in `references/output-template.md`.

### 6. 对抗审视

方案/设计文档落盘不等于完成——必须经独立审视：

1. 召唤检视獭（见 `otter-summon` skill），其 systemPrompt 中必须：要求先 read `adversarial-review` skill 再动手；附上方案全文，或方案文件在 worktree 内的绝对路径（小獭 cwd 是主仓，相对路径读不到 worktree 文件）
2. 审视发现的问题逐条处置：纯技术取舍你自行拍板并记录理由；涉及产品方向、资源投入或对外承诺的，呈搭档拍板（修复 / 接受 / 搁置）
3. 按结论修订方案并复审，审视不超过 2 轮；仍有未决问题 → 呈搭档裁决
4. 决策史回写文档——每道题的结论和理由留痕

以上走完，方案才算定稿，才可进入实现阶段。搭档明确表示"跳过审视/不用审"时，记录该决策后放行。

## Behavioral Rules

- Multiple viable approaches → list tradeoffs for each, recommend one
- User says "就这样" or "必须" → execute the decision, do not argue
- Record both supporting and opposing arguments for every design choice, not just conclusions

## Additional Resources

### Reference Files

- **`references/output-template.md`** — Structured output template for technical plans
- **`references/intent-anchor-guide.md`** — How to extract and preserve intent anchors with traceability
