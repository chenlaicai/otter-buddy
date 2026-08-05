---
name: adversarial-review
description: >-
  This skill should be used when the user asks to "审查代码", "review PR", "代码检视",
  "帮我看看这个 PR", "做 code review", "审查一下", "检查代码质量",
  "审查方案", "审视文档", "评审设计", "挑挑毛病",
  or needs to perform adversarial review of code changes or design documents,
  identify issues, or produce a structured review report. Covers multi-dimensional
  checking, independent verification, and structured problem reporting.
---

# Adversarial Review

Find real problems in the review target — code changes (PR) or design documents. This is not a rubber stamp.

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

#### 审视对象是方案 / 设计文档时

6 维度按以下适配，流程（独立核实、报告、禁用语）不变：

| 代码维度 | 文档对应 |
|----------|----------|
| Correctness | 方案与需求意图一致？逻辑链完整、无跳步？ |
| Edge Cases | 边界场景与失败路径在方案中被考虑？ |
| Security | 方案是否引入新的攻击面或权限扩大？ |
| Architecture Compliance | 符合项目架构约束、分层与术语？ |
| Test Coverage | 方案含可验证的验收标准？ |
| Maintainability | 文档可读、决策有据、后续开发者能理解？ |

文档审视的"独立核实"= 对照代码与既有文档，验证方案中的事实性断言（"现有实现是 X"这类话必须亲验）。

### 3. Verify Independently

Execute verification commands directly:

- Run the test suite
- Check build passes
- Verify key behaviors match expectations

Do not rely on the developer's reported results.

If you have no execution permission (e.g., a review-only otter with read-only tools): independent verification means reading the changed code line by line and statically checking it against the test files. You must explicitly state in the report that tests/builds could not be run — never claim verification you did not perform.

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
