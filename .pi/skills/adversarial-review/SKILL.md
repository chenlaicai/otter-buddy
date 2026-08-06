---
name: adversarial-review
description: >-
  This skill should be used when the user asks to "审查代码", "review PR", "代码检视",
  "帮我看看这个 PR", "做 code review", "审查一下", "检查代码质量",
  "审查方案", "审视文档", "评审设计", "挑挑毛病",
  or needs to perform adversarial review of code changes or design documents,
  identify issues, or produce a structured review report. Covers multi-dimensional
  checking, independent verification, and structured problem reporting.
triggers:
  phrases:
    - "审查代码"
    - "review PR"
    - "代码检视"
    - "帮我看看这个 PR"
    - "做 code review"
    - "审查一下"
    - "检查代码质量"
    - "审查方案"
    - "审视文档"
    - "评审设计"
    - "挑挑毛病"
co_loads: []
---

# Adversarial Review

Find real problems in the review target — code changes (PR) or design documents. This is not a rubber stamp.

> **触发短语**：审查代码 | review PR | 代码检视 | 审查方案 | 审视文档 | 挑挑毛病
> **共加载**：无

## Core Principles

- **Focus before coverage**: Declare a review focus (1–3 dimensions) based on blast radius before checking anything. Go deep on the focus, sweep the rest. Uniform attention across all dimensions is scatter, not rigor.
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

### 2. Declare the Review Focus

Before checking anything, declare 1–3 focus dimensions with a one-line rationale:

- What breaks worst if this change is wrong? That is the focus.
- **Focus dimensions**: go deep — read surrounding code, trace execution paths, verify claims.
- **Non-focus dimensions**: quick sweep. "无发现" is still required explicitly, but equal depth is not.

The focus goes into the report's "本轮焦点" section. A review without a declared focus is a scattergun review — see `references/anti-patterns.md`.

### 3. Check Each Dimension

Check all 6 dimensions — focus dimensions deep, the rest as a sweep. Do not skip any. If a dimension has no issues, explicitly note "无发现" in the report — this confirms the dimension was actually checked.

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

6 维度按以下适配，流程（焦点声明、独立核实、报告、禁用语）不变：

| 代码维度 | 文档对应 |
|----------|----------|
| Correctness | 方案与需求意图一致？逻辑链完整、无跳步？ |
| Edge Cases | 边界场景与失败路径在方案中被考虑？ |
| Security | 方案是否引入新的攻击面或权限扩大？ |
| Architecture Compliance | 符合项目架构约束、分层与术语？ |
| Test Coverage | 方案含可验证的验收标准？ |
| Maintainability | 文档可读、决策有据、后续开发者能理解？ |

文档审视的"独立核实"= 对照代码与既有文档，验证方案中的事实性断言（"现有实现是 X"这类话必须亲验）。step 1 的"PR description + changed file list"读作：方案文档本体 + 其声称覆盖的需求上下文。

### 4. Verify Independently

Execute verification commands directly:

- Run the test suite
- Check build passes
- Verify key behaviors match expectations

Do not rely on the developer's reported results.

If you have no execution permission (e.g., a review-only otter with read-only tools): independent verification means reading the changed code line by line and statically checking it against the test files. You must explicitly state in the report that tests/builds could not be run — never claim verification you did not perform.

### 输入契约

本 skill 需要以下输入才能开始工作：

| 输入 | 必选/可选 | 来源 | 缺失时处理 |
|------|----------|------|-----------|
| 审视对象 | 必选 | PR diff / 方案文档 | 停下来要求提供。禁止凭空审视 |
| 设计文档（代码审视时） | 可选 | 方案文档 | 无则跳过正确性对照，但在报告中声明"无设计文档对照" |
| worktree 绝对路径 | 必选（代码审视时） | 召唤者提供 | 停下来要求提供。小獭 cwd 是主仓，相对路径解析错误 |

### 5. Output Report

Produce a structured review report using the template below.

## 产出模板

````markdown
## 审查者

[海獭名号]

## 本轮焦点

- 焦点维度：[1–3 个维度]，理由：[一句话，基于改动性质与 blast radius]
- 其余维度：快速扫过（仍逐维度显式结论）

## 审查结论

[需要修改 / 可以合入（附条件）]

结论必须是二元的。"基本没问题"不是有效结论。存在未处置的阻断性问题 → 必须"需要修改"。

## 阻断性问题

### 问题 1：[简要描述]

- **维度**：正确性 / 边界条件 / 安全性 / 架构合规 / 测试覆盖 / 可维护性
- **位置**：`文件名:行号`
- **描述**：具体问题说明，引用代码片段
- **处置**：在当前 PR 修复 / 开发者回应（审查者认可）
- **作者回应**：[作者填：接受并修复 / 反驳（附证据）/ 部分接受 / 呈搭档裁决]

## 次要观察

不阻断结论，但每条必须有着落，禁止"以后再说"。

### 观察 1：[简要描述]

- **维度**：…
- **位置**：`文件名:行号`
- **描述**：…
- **处置**：在当前 PR 修复 / 开发者回应（审查者认可）/ 记录（issue 编号或 PR 描述）
- **作者回应**：[作者填，允许极简：一行即可，如"接受" / "记录为 issue #N" / "反驳：…（附证据）"]

## 维度扫视结论

| 维度 | 结论 |
|------|------|
| 正确性 | 有发现（见上）/ 无发现 |
| 边界条件 | … |
| 安全性 | … |
| 架构合规 | … |
| 测试覆盖 | … |
| 可维护性 | … |

## 变更完整性

确认以下项目：
- [ ] 所有设计文档中列出的改动范围都已覆盖
- [ ] 无遗漏的文件修改
- [ ] 测试覆盖了核心行为
- [ ] 构建通过
````

**Rules**：
- 报告必须填写审查者署名（替换模板中的 `[海獭名号]`），未署名的报告无效
- 报告必须先声明本轮焦点（1–3 个维度 + 理由），无焦点的报告无效
- Every issue MUST have a disposition
- If ANY 阻断性 issue is unresolved, conclusion MUST be "需要修改"
- Each issue MUST cite `file:line` — no impression-based findings
- "无发现" is valid for a dimension — explicitly note it in 维度扫视结论, do NOT skip silently
- 复审轮（第 2 轮起）的报告结构：上轮发现逐条验证结论 + 修复回归检查；delta 之外的新发现必须标注"此前轮次漏报"并说明为何够/不够阻断门槛
- 审视对象是方案/设计文档（非代码）时：结论选项"需要修改 / 可以合入"读作"需要修改 / 可以定稿"

## 后续动作声明

| 产出类型 | 下一步动作 | 执行者 | 触发条件 | 不满足时处理 |
|----------|-----------|--------|----------|-------------|
| 审视报告（需修改） | 作者处置 | 实现者（异体） | 报告交付后 | 正常终止，报告交付搭档 |
| 审视报告（可合入/可定稿） | 搭档终审 | 搭档 | 结论为通过时 | 搭档不在场 → 记录结论到 memory，搭档回来后终审 |
| 审视报告（对立僵局） | 搭档裁决 | 搭档 | 触发升级信号时 | 搭档不在场 → 记录僵局状态到 memory，搭档回来后裁决 |

### 异体执行原则

审视在多 agent 场景下由架构保证异体（检视獭和开发獭是不同 agent）。
单 agent 场下降级：搭档确认审视结论后放行（搭档是非实现者，满足异体要求）。
搭档明确说"跳过审视"时，记录决策后放行。

## Behavioral Rules

- Every finding is classified at report time:
  - **阻断性**：单凭这一条就足以否决本次交付。门槛问题："仅凭这一条，我会否决吗？"答不上来就不是阻断。
  - **次要观察**：不阻断结论，但必须有着落——在当前 PR 修复，或记录（issue / PR 描述）。"以后再说"仍然禁用——次要观察是分流，不是拖延。
- 焦点维度之外的发现默认归入次要观察，除非过得了阻断门槛。
- Dispositions: 阻断性问题 → "在当前 PR 修复" or "开发者回应（审查者认可）"；次要观察 → 额外允许 "记录（issue/PR 描述）"。
- Any unresolved 阻断性 issue → conclusion MUST be "需要修改"。次要观察未处置 → 报告必须列出其去处，但不否决结论。
- Developer gives a reasonable explanation → can acknowledge, but must record the reasoning
- 作者反驳是合法处置（见 `references/author-response-protocol.md`）。评估反驳只看证据（file:line、测试、方案原文），不靠权威压人；一轮证据交换后仍对立 → 呈搭档裁决，不许多轮拉扯。
- Forbidden escape phrases: "低风险", "可忽略", "不重要", "后续优化", "不阻塞"

### 复审（第 2 轮起）：delta 审视

第 1 轮是全量 fresh-eyes 审视。第 2 轮起你的职责变为：① 逐条验证上轮发现的修复（改对了吗？改全了吗？）② 检查修复引入的回归（fix-regression）——**不是**新一轮全量审视。delta 之外的新发现必须标注"此前轮次漏报"，默认次要观察，除非过阻断门槛。

循环的轮次结构、收敛判据与升级路径见 `references/review-loop.md`——那是调度规则，由作者/调度者执行；你只负责按上述职责产出每轮报告。

### 审查者 vs 决策者

审查者和决策者是不同角色。当两者冲突时：

- **审查者的责任**：诚实报告问题，结论保持"需要修改"
- **决策者的权力**：可以决定合入未修复的问题
- **处理方式**：当决策者要求合入未修复的问题时，记录"决策者选择合入"作为处置，审查者不改为"可以合入"

审查者的结论反映问题的存在，不反映决策者的选择。

## Additional Resources

### Reference Files

- **`references/review-dimensions.md`** — Detailed guidance for each of the 6 review dimensions
- **`references/anti-patterns.md`** — Common review anti-patterns and how to avoid them
- **`references/author-response-protocol.md`** — 作者对检视发现的处置协议（四分类 + 证据要求），检视者评估反驳时同样适用
- **`references/review-loop.md`** — 对抗审视循环协议（轮次结构、收敛判据、升级路径），三方共用的调度规则单一真相源
