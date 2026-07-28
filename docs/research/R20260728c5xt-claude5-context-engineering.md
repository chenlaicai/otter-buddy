---
id: R20260728c5xt
title: claude5-context-engineering
doc_type: research

# 记忆索引
summary: |
  解读 Anthropic 官方博客《The new rules of context engineering for Claude 5 generation models》
  （2026-07-24，Thariq Shihipar）：Claude Code 为 Opus 5 / Fable 5 删除了 80% 系统提示词，
  上下文工程从"规则约束"转向"信任判断力 + 渐进式披露"。
  对照 Otter 现状：系统层（SYSTEM.md + 身份文件）已符合新范式；
  主要技术债在 code-implementation skill 的 NEVER 条款堆积和 speak 工具描述的重复防御。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260720k7m2   # Skill 注入迁移到 SDK 原生（progressive disclosure）
    - F20260722d3k7   # AI 行为模式强化（NEVER 条款与禁用语黑名单的来源）
    - F20260716szw8   # 记忆渐进式披露

# 元数据
status: draft
exploration_type: technical
tags: [context-engineering, prompt, skills, tools, claude-5, anthropic-blog, insight]
conclusion: Otter 系统层上下文已符合 Claude 5 新范式；应将规则式防御从 skill/工具描述中逐步清理，但对协议关键行为（speak 回合控制）保留显式约束

# 时间
created_at: 2026-07-28
---

# Claude 5 上下文工程新规则 · 洞察报告

## 概述

本文是对 Anthropic 官方博客 **[The new rules of context engineering for Claude 5 generation models](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models)**（2026-07-24，作者 Thariq Shihipar，Claude Code 团队 MTS）的解读，并结合 Otter 项目现状给出落地洞察。

**原文核心事实**：Claude Code 团队为 Claude 5 代模型（Opus 5、Fable 5）**删除了超过 80% 的系统提示词，编码评测无可感知损失**。旧规则是为弱模型防呆积累的"防御性浮渣"（cruft），对强模型而言已从保障变成税负。迁移思路不是"移植规则"，而是"删掉大部分规则"。

---

## 1. 博客核心内容

### 1.1 总体诊断：Unhobbling Claude（给 Claude 松绑）

原文观察到两类问题：

1. **上下文互相冲突**：同一请求中系统提示、skill、用户指令互相打架（如系统提示说 "DO NOT add comments"，skill 说 "leave documentation as appropriate"）。Claude 最终能处理，但必须花费额外思考去裁决冲突信息。
2. **约束已过时**：防呆条款是为旧模型的最坏情况准备的；新模型可以依靠周边上下文和判断力做决策，大量条款可直接删除。

同时工具生态变了：过去 CLAUDE.md 是唯一的记忆/指引载体，现在有 memory、artifacts、skills 等专门的上下文加载与共享机制。

### 1.2 六条新旧规则对照

| # | 旧规则（Then） | 新规则（Now） | 要点 |
|---|---------------|---------------|------|
| 1 | **给 Claude 规则** | **让 Claude 用判断力** | 旧：「默认不写注释，永远不要写多段 docstring」。新：「写读起来像周边代码的代码：匹配它的注释密度、命名和惯例」。硬性规则必然对某些 prompt 是错的，判断力不会 |
| 2 | **给 Claude 示例** | **设计有表达力的接口** | 示例会把模型约束在特定探索空间里。与其给 few-shot 例子，不如把工具/参数设计得自解释——如 Todo 工具用 `pending / in_progress / completed` 枚举值暗示用法 |
| 3 | **全部前置** | **渐进式披露（progressive disclosure）** | 代码审查、验证等不常用但关键的指引从系统提示移到独立 skill，按需加载；部分工具做成延迟加载（deferred loading），Agent 需先用 ToolSearch 搜到完整定义才能用。CLAUDE.md / SKILL.md 同样适用：**用文件树按需加载，而非单一中央仓库** |
| 4 | **重复强调** | **简洁的工具描述** | 旧模型对上下文末尾的指令更敏感，所以系统提示和工具描述里重复写。现在去重：工具用法写进工具描述，系统提示不再复述 |
| 5 | **CLAUDE.md 手动记忆**（`#` 热键） | **自动记忆（auto-memory）** | Claude 自动保存与工作和用户相关的记忆，不再依赖用户手动维护 |
| 6 | **简单规格**（markdown 计划文件） | **富引用（rich references）** | Claude 已能处理复杂引用：HTML artifact、详细测试套件、其他代码库中待移植的函数、rubric（评分准则）——rubric 可配合动态工作流拉起 verifier agent 来验证"品味"类标准（如什么是好的 API 设计）。代码形式的引用优于文字描述：HTML mockup 比设计描述或截图效果更好 |

### 1.3 各类上下文的组装建议

| 层 | 建议 |
|----|------|
| **System Prompt** | 与产品语境强绑定，告诉 Claude 它在什么产品里、做什么。自建 agent harness 时这里最值得投入 |
| **CLAUDE.md** | 保持轻量：简述仓库用途，token 主要花在代码库的"坑"（gotchas）上。避免写"显然的事"（看文件系统就能知道的）。大量使用渐进式披露（如验证流程做成 skill，CLAUDE.md 只留引用） |
| **Skills** | 定位为"轻量导航"，让 Claude 需要时能找到信息。除极少数关键领域外不要过度约束。长 skill 拆成多文件。skill 最适合编码团队/产品特有的观点、知识和最佳实践 |
| **References** | `@` 引用文件提供计划所需的深度信息：spec、mockup、甚至整个代码库。优先用代码形式的文件（高保真、Claude 最熟悉的语言） |

### 1.4 配套工具

Anthropic 发布 `claude doctor`（Claude Code 内 `/doctor`），自动审计 skill、CLAUDE.md、settings 并给出精简建议，帮助 Claude 4 时代的配置适配新模型。

---

## 2. Otter 现状对照

调研了本仓库的上下文工程各层，对照六条新规则评估如下。

### 2.1 已符合新范式的部分 ✅

| 层 | 现状 | 对照 |
|----|------|------|
| **系统提示** `.pi/SYSTEM.md` | 仅 17 行，原则式写法（「事实优先」「优先级：事实 > 搭档判断 > AI 偏好」），几乎无禁令 | 符合规则 1（信任判断力），是新式写法的范本 |
| **身份文件** `prompts/identity/*.md` | BIG_OTTER 16 行 / SMALL_OTTER 21 行，只定义身份与语气，frontmatter 明确分工「通用行为边界见 .pi/SYSTEM.md」 | 符合规则 4（不重复），职责单一 |
| **Skill 加载** | 已迁移到 SDK 原生机制（F20260720k7m2）：系统提示只注入 skill 的 name/description，Agent 按需 `read` 全文 | 符合规则 3（渐进式披露），且是 SDK 级实现 |
| **记忆体系** | 消息/文档自动索引入库（send-message.ts、sync-documents.ts），检索端 `search_memory` 三档 detail_level + `get_memory_detail` 批量深入（F20260716szw8） | 符合规则 5（auto-memory）+ 规则 3（检索端渐进披露），甚至先于博客发布 |
| **多数工具描述** | 19 个工具中多数是一句话判断式描述（如 `invite_participant`「邀请指定 Otter 加入当前对话」）；`search_memory` 描述解释 when/why 而非纯禁令 | 符合规则 4 |

### 2.2 与新范式冲突的部分 ⚠️

**冲突 1：code-implementation skill 的防御性条款堆积（违反规则 1、4）**

`.pi/skills/code-implementation/SKILL.md` 中：

- 同一规则重复写两遍：L79-80（流程内）与 L89-91（Behavioral Rules）都写了 `NEVER merge your own PR` / `NEVER push directly to main`
- 预判式堵漏洞：L33 `NEVER skip worktree — even for "small" changes, docs-only changes, or "quick fixes"`——预枚举借口清单是典型旧式防御写法
- 禁用语黑名单：L88 `Forbidden escape phrases: "低风险", "可忽略", "不重要", "后续优化", "不阻塞", "Minor 问题", "不影响功能正确性"`

**冲突 2：speak 工具描述的重复防御（违反规则 4）**

`src/interface-adapters/agent-runtime/tools/tool-factory.ts`：

- L37 工具描述：「调用成功后：不再调用任何工具，也不输出任何文字（确认语、总结、解释全部禁止），直接结束回合。每次回复只调用一次」
- L83 工具返回文案又重复一遍「不要输出任何文字（确认语、总结、解释均禁止），不要再调用任何工具」

同一禁令在描述与返回值双重重申，属于博客点名的「system prompt 与 tool description 重复」的运行时变体。

### 2.3 冲突的来历与特殊性

这些条款**不是凭空写的，而是线上事故后逐条追加的**（F20260722d3k7 明确记录了每条规则的 UA 来源）。这带来一个博客没有覆盖的区分：

- **品味/风格类约束**（注释密度、文档习惯）→ 可以放心交给判断力，对应博客规则 1
- **协议/流程关键约束**（speak 回合控制、PR-only 交付、worktree 隔离）→ 是产品机制的一部分，失败成本不对称（一次违规 = 对话流中断或主分支污染），即使强模型也值得保留显式约束

博客的建议建立在 Anthropic 自家评测上，且 Claude Code 的失误成本由用户当场承担；Otter 是多 Agent 接力发言系统，`speak` 是回合协议的唯一收口，属于「highly important areas」——博客自己也允许这类例外（"Avoid making them overconstrained, **except in highly important areas**"）。

---

## 3. 洞察与建议

### 3.1 核心洞察

1. **Otter 的上下文架构方向是对的，且部分领先**。系统层不到 60 行的原则式写法、SDK 原生 skill 渐进披露、记忆自动索引 + 三档检索，都与 Anthropic 三个月后才公开的最佳实践一致。F20260720k7m2 和 F20260716szw8 的决策被官方背书。

2. **技术债集中在「事故驱动的规则堆积」**。code-implementation skill 的 NEVER 条款是典型模式：每次事故 → 追加一条禁令 → 规则间开始重复、互相稀释。博客指出这类冲突文本会消耗模型的裁决精力——条款越多，每条被认真对待的概率越低。

3. **「信任判断力」在 Otter 要分层应用**。Otter 的特殊性在于它既是 coding agent（适用博客全部建议）又是多 Agent 对话协议系统（协议关键处保留显式约束）。清理标准应是「失败成本是否对称」，而非一刀切。

4. **规则 2（接口设计 > 示例）对 Otter 有直接启发**。`speak` 的问题也许不该靠更长的描述解决，而是靠接口设计解决——例如让工具在协议上无法被二次调用、或把「下一位发言者」做成枚举参数暗示用法，把行为约束从文案层下沉到机制层。

### 3.2 行动建议（按优先级）

| 优先级 | 行动 | 依据 |
|--------|------|------|
| P1 | **去重**：code-implementation SKILL.md 中重复的 NEVER 条款合并为一处；speak 工具描述与返回文案的重复禁令合并 | 规则 4，零风险纯收益 |
| P2 | **规则改写**：把 skill 中的 NEVER 条款从「禁令 + 借口黑名单」改写为「原则 + 失败后果」（如 worktree 条款改为说明隔离的目的，让模型能外推到未枚举的场景） | 规则 1；借口黑名单永远枚举不完 |
| P2 | **speak 约束机制化**：评估能否把「speak 后不再输出」从文案约束改为运行时约束（如 harness 层丢弃 speak 后的输出），文案只留一句协议说明 | 规则 2；机制比描述可靠 |
| P3 | **禁用语黑名单重审**：L88 的 forbidden phrases 是事故补丁，评估能否改写为正向表述（「给出结论时必须附失败成本评估」） | 规则 1；黑名单防字面不防意图 |
| P3 | **rubric 机制关注**：检视獭（adversarial-review）的审查标准当前是文字规则，博客的 rubric + verifier agent 模式是潜在演进方向 | 规则 6 |
| —    | **明确保留**：speak 回合收口、PR-only、worktree 隔离三条协议级约束保留显式写法，但精简到各一句 | 失败成本不对称，属博客允许的例外 |

### 3.3 对博客本身的批判性评估

- 80% 是 Anthropic 在自家编码评测上的数字，缺乏外部复现；HN 社区有反馈称 `/doctor` 的自审计并不总是可靠（有团队 `/doctor` 无建议但评测显示 skill 仍需修改）。
- 「信任模型判断力」的建议在受监管/高合规场景的适用性存疑——Otter 若未来进入此类场景，规则 1 的适用边界需重新评估。
- 博客未讨论多 Agent 系统的上下文工程（发言协议、身份注入、跨 Agent 记忆），Otter 在这方面的实践（如身份注入用首条 user message 而非 system prompt）属于官方指南的空白区，需自行验证。

---

## 4. 参考资料

- [The new rules of context engineering for Claude 5 generation models](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models) — Anthropic 官方博客，2026-07-24
- [HN 讨论](https://news.ycombinator.com/item?id=49051361) — 社区反馈与质疑
- 本仓库：`.pi/SYSTEM.md`、`.pi/skills/code-implementation/SKILL.md`、`src/interface-adapters/agent-runtime/tools/tool-factory.ts`、`docs/features/2026/07/22/F20260722d3k7-agent-behavior-pattern.md`
