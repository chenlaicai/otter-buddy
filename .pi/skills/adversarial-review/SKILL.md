---
name: adversarial-review
description: >-
  This skill should be used when the user asks to "审查代码", "review PR", "代码检视",
  "帮我看看这个 PR", "做 code review", "审查一下", "检查代码质量",
  or needs to perform adversarial code review, identify issues in code changes,
  or produce a structured review report. Covers multi-dimensional checking,
  independent verification, and structured problem reporting.
---

# Adversarial Review

Find real problems in code changes. This is not a rubber stamp.

## Core Principles

- **Reference actual code**: Every judgment must cite a specific file and line number. No impression-based reviews.
- **Every issue needs a disposition**: "Not blocking" and "optimize later" are not valid dispositions.
- **No vague conclusions**: "Looks fine" and "can merge" without specifics are forbidden.
- **Verify independently**: Run tests and builds directly. Do not just check the developer's results.
- **Do not modify code**: Only report findings. The developer fixes, the reviewer identifies.

## Workflow

### 1. Understand the Change Scope

Read the PR description and changed file list:

- What problem does this PR solve?
- What is the design intent?
- Which files changed? What is the blast radius?

If the PR direction deviates from the design document, flag it — this may need to go back to design, not just code fixes.

### 2. Check Each Dimension

Review changes across all 6 dimensions. Do not skip any. If a dimension has no issues, explicitly note "无发现" in the report — this confirms the dimension was actually checked.

See `references/review-dimensions.md` for detailed guidance on each dimension.

| # | Dimension | Question |
|---|-----------|----------|
| 1 | Correctness | Does the implementation match the design intent? Any logic gaps? |
| 2 | Edge Cases | Nulls, exceptions, concurrency, large data — are boundary scenarios handled? |
| 3 | Security | Injection, privilege escalation, sensitive data exposure? |
| 4 | Architecture Compliance | Does it follow project layer constraints and conventions? |
| 5 | Test Coverage | Are core behaviors tested? Do tests verify external behavior? |
| 6 | Maintainability | Clear naming? Comments on complex logic? Unnecessary duplication? |

### 3. Verify Independently

Execute verification commands directly:

- Run the test suite
- Check build passes
- Verify key behaviors match expectations

Do not rely on the developer's reported results.

### 4. Output Report

Produce a structured review report using the template in `references/report-template.md`.

## Behavioral Rules

- Every issue must have a disposition: "在当前 PR 修复" or "开发者回应（审查者认可）"
- Any unresolved issue → conclusion MUST be "需要修改"
- Developer gives a reasonable explanation → can acknowledge, but must record the reasoning
- Forbidden escape phrases: "低风险", "可忽略", "不重要", "后续优化", "不阻塞"

### 审查者 vs 决策者

审查者和决策者是不同角色。当两者冲突时：

- **审查者的责任**：诚实报告问题，结论保持"需要修改"
- **决策者的权力**：可以决定合入未修复的问题
- **处理方式**：当决策者要求合入未修复的问题时，记录"决策者选择合入"作为处置，审查者不改为"可以合入"

审查者的结论反映问题的存在，不反映决策者的选择。

## Additional Resources

### Reference Files

- **`references/review-dimensions.md`** — Detailed guidance for each of the 6 review dimensions
- **`references/report-template.md`** — Structured review report format
- **`references/anti-patterns.md`** — Common review anti-patterns and how to avoid them
