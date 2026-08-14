---
id: F20260814drev
title: review-loop-baseline-enforcement
doc_type: feature

summary: |
  修复检视闭环两个结构性偏差：(1) 大獭修复完检视发现后跳过 delta 复核直接传 user 终审——"修复≠签收"
  规则住在了检视獭的文档里，大獭路由决策时刻读不到；(2) 检视频繁漏检 CI/文档/特性编号——检视獭有
  bash/read 工具却把 B1-B3 当勾选框填"通过"不实际验证，且特性编号根本不在检视维度里。全部是 prompt/skill
  文档变更，无代码改动。Part 1: collaboration-patterns 加修复后路由铁律；Part 2: review-dimensions 加证据强制 + B4。

causal_links:
  from:
    - F20260811csgr   # 检视模板再设计：决策树驱动的强制对抗处置
    - F20260811brd2   # 检视维度增加基础维度（CI状态、文档完整性、全链路验证）
    - F20260813actk   # 大獭召唤派工缺口修复：发言石→行动权 reframe

status: development
change_type: prompt
tags: [agent-architecture, review-loop, prompt-engineering, baseline-dimensions]
modules:
  - .pi/skills/otter-summon/references/collaboration-patterns.md
  - .pi/skills/adversarial-review/references/review-dimensions.md
  - .pi/skills/adversarial-review/SKILL.md
capability_test: "n/a: 纯 prompt/skill 文本改动（B 类行为）。验证方式为隔离实例制造 CI 失败+编号不一致 PR，召唤检视獭验证 B1 附实际命令输出、B4 报出编号不一致；制造检视→修复场景验证大獭传回检视獭而非直接传 user"
---

# F20260814drev: 检视闭环两个结构性偏差修复

## 背景

用户从最近两次真实对话中发现了两个反复出现的问题，要求基于真实对话作为证据深入分析根因。

### 问题一：大獭修复后跳过 delta 复核

大獭处理完检视发现后，老是直接传 `'user'` 让搭档终审。用户的认知是：别人提出问题，我修复问题，修复完应该让提出问题的人复核确认没问题，而不是自己改完就认为修好了。

### 问题二：检视漏检 CI/文档/编号

用户频繁介入指出 CI 问题、特性文档问题、特性编号问题——这些检视獭应该查出来却没有。

## 根因分析

两个问题指向同一个模式：**设计文档描述了理想工作流，但关键约束住在了执行 agent 在决策/执行时刻读不到或读不进去的位置。**

### Problem 1 根因：规则在错误的 agent 的文档里

"修复≠签收"规则写在 `adversarial-review/SKILL.md:255-259`——这是**检视獭读的 skill**。大獭在"修复完→决定路由给谁"这个时刻，它作为编排者读的是 `otter-summon/references/collaboration-patterns.md`。那里只有一句跨文档引用：

> 循环的继续与终止按收敛判据运转（定义见 adversarial-review/references/review-loop.md）

"修复≠签收"被埋在了被引用的文档里，大獭在决策时刻看不到。

同时 `collaboration-patterns.md:13` 说"最终结论整合后，你向搭档汇报"——大獭把"我修完了"理解成了"最终结论"，直接传 `'user'`。

还有一层角色冲突：大獭既是实现者又是编排者。实现者角色说"我改完了"，编排者角色本该说"传回检视獭复核"——同一个 agent 内部，实现者的"我改完了"赢了。

### Problem 2 根因：有工具不用 + 设计盲区

表面看是检视獭不仔细。但读工具实现发现：**小獭已经有 `bash`/`read`/`write`/`edit` 编码工具**（`session-helpers.ts:15-18`，注释明确写"small otter 需要写代码、评论 PR、执行构建命令等实际工作"）。

所以问题不是工具缺口——检视獭有能力跑 `gh run list`、读 worktree 文件、跑测试。问题是**有工具不用**：把 B1/B2/B3 当勾选框填"通过"，而不是实际运行检查。报告模板有"证据"列，但填"通过"和实际查过在报告上看起来一模一样，无法区分。

同时，**特性编号根本不在检视维度里**。它是 `code-implementation` 的输入要求（`SKILL.md:26`），不是检视 checklist 的检查项。检视獭不检查编号不是疏忽——是设计上的盲区。

## 改动

### Part 1：修复后路由铁律（Problem 1）

**文件**：`.pi/skills/otter-summon/references/collaboration-patterns.md`

在"开发↔检视循环"步骤 4（收敛判据）之后、步骤 5（最终结论整合）之前，插入一条本地驻留的硬规则：

> **修复后路由铁律**：开发獭（或你大獭自己）修完检视发现后，下一步是把行动权传回检视獭做 delta 复核。检视獭说"通过"才叫通过——你不能自己签收。传 `'user'` 只发生在检视獭 delta 复核通过之后。
>
> 大白话：**改完 ≠ 过了。谁提的问题，谁确认问题解决了。**

**设计理由**：
- 不靠跨文档引用——规则住在大獭实际读到的地方
- 用"大白话"翻译降低 LLM 误读概率
- 与 `adversarial-review/SKILL.md:255-259` 的行动权路由表形成双保险（一处给检视獭读、一处给大獭读）

**不做机制守卫的理由**：speak 工具内联软守卫（类比 C9 pendingDispatches）可行但脆弱——`role.name` 是 LLM 自由命名的自由文本，pattern match 误报风险高。遵循"机制约束优先让 LLM 理解"——先 prompt 修复，观察效果后再决定是否加机制。

### Part 2：基础维度证据强制 + B4 变更标识一致性（Problem 2）

**文件**：`.pi/skills/adversarial-review/references/review-dimensions.md`

#### 改动 A：B1-B3 强制附验证证据

在"基础维度失败 → 严重发现"段之后新增证据强制段，每项给出具体命令（B1→`gh run list`、B2→`list_artifacts`+read、B3→实际运行测试/构建）。核心约束：**无证据填"通过" = 虚假签收，等同漏报**。

**文件**：`.pi/skills/adversarial-review/SKILL.md` 步骤 3 对应位置同步加引用指针。

#### 改动 B：新增 B4 变更标识一致性

在 B3 之后新增 B4，检查特性编号在 commit message / PR title / PR 描述 / 特性文档 frontmatter 间的一致性。放在基础维度层（每次必查，不占焦点名额）。

**文件**：`.pi/skills/adversarial-review/SKILL.md` 同步更新：
- 步骤 3 基础维度表格加 B4 行
- "基础维度失败"段 B1/B2/B3 → B1/B2/B3/B4
- 新增"基础维度必须附验证证据"引用指针
- PR Review Comment 模板基础维度表格加 B4 行
- 完整报告模板基础维度表格加 B4 行
- 维度扫视结论表格加 B4 行

## Acceptance Test

| 场景 | 验证方法 | 预期结果 |
|------|---------|---------|
| 大獭修复后路由 | 隔离实例制造检视→修复场景 | 大獭传回检视獭做 delta 复核，不直接传 user |
| B1 CI 证据 | 制造 CI 失败的 PR，召唤检视獭 | 报告 B1 附 `gh run list` 实际输出，不是凭空填"通过" |
| B4 编号一致性 | 制造 commit/PR 编号不一致的 PR | 报告 B4 报出严重发现 |
| B1-B3 无证据打回 | 检视报告 B1-B3 填"通过"但无证据 | 报告合规门禁打回 |

## 不做的事

- **不加 `check_ci_status` 新工具**——小獭已有 bash，能跑 `gh run list`，问题不在工具缺口
- **不加 speak 软守卫检测 delta 复核**——角色名 pattern match 太脆弱，先靠 prompt
- **不改 code-implementation step 9**——步骤 9 已提到"修复后更新 PR，重新审视"
- **不动 BIG_OTTER.md**——身份 prompt 不适合放具体流程规则
