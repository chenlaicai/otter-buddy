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

## Behavioral Rules

- Multiple viable approaches → list tradeoffs for each, recommend one
- User says "就这样" or "必须" → execute the decision, do not argue
- Record both supporting and opposing arguments for every design choice, not just conclusions

## Additional Resources

### Reference Files

- **`references/output-template.md`** — Structured output template for technical plans
- **`references/intent-anchor-guide.md`** — How to extract and preserve intent anchors with traceability
