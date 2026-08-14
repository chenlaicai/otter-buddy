---
id: F20260814mbex
title: memory-recall-proactive-exploration-prompt
doc_type: feature

summary: |
  优化 agent 对记忆召回的使用：search_memory 引导语从"别每次搜"反转为"懂为什么搜"。
  根因是旧引导语为省 token 直接压制了主动背景探索，方向与用户期待相反。
  主机制：隐性历史信号引导 + 关系图拼链 know-how 进工具描述与 core-workflow skill。

causal_links:
  from:
    - F20260813mren
    - F20260721m3r1   # 其"不每次回复前都搜索"触发规则已被本特性反转（见设计决策 D4 映射）

status: development
change_type: prompt
tags: [memory, prompt, agent-behavior]
modules:
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - .pi/skills/core-workflow/SKILL.md
capability_test: tests/capability/memory-recall.capability.test.ts
---

# F20260814mbex: 记忆召回的主动背景探索 prompt 优化

## 背景与需求

### 问题描述

issue #264。排查记忆系统效果时发现：用户期待 agent 每次回答前主动做"背景探索"（找历史对话、拼证据链/因果链/发展链），但实际看不到效果。根因在 prompt 层：`search_memory` 的 tool description 写着"有明确历史信号时**才**检索，**不要每次回复前都搜索**"——本意为省 token / 降延迟，但直接压制了主动探索行为。

### 根因分析

引导语把触发条件收敛到"显性历史信号"（搭档提到"上次"/问历史决策原因/跨会话续接/术语不明）。而真实场景中大量需要背景探索的问题**不带显性信号**——"这个方案可行吗"、"X 该不该改"这类实质问题，其答案依赖本项目的历史决策与教训，但字面上没有"上次"之类的信号。LLM 按 description 字面执行，于是从不主动搜。

### 数据实锤

- 旧引导语原文（tool-factory.ts:208）：`When: 有明确历史信号时（搭档提到'上次'/问历史决策原因/跨会话续接/术语不明）才检索，不要每次回复前都搜索`
- 现有能力测试 memory-recall.capability.test.ts 的提问（"幻影灯塔计划的门禁验证码是什么？"）本身携带显式主题词，无法暴露本问题

## 方案设计

### 技术方案

三处 prompt 改动（覆盖 issue #264 三点需求），全部遵循 `feedback_no_strong_orchestration`：不加自动召回编排层，优化主手段是让 LLM 更懂怎么用工具。

**改动 1：search_memory description 反转引导方向**（issue 点 1）

- 删"不要每次回复前都搜索"
- When 从"显性信号才搜"扩展为"显性信号 + 隐性信号"：收到实质问题先自问"这事在本项目有历史脉络吗"（方案、结论、教训大多沉淀在记忆里），有则先搜再答
- 讲清"搜了能得到什么"（跨会话决策/讨论/F-R 文档/事实）与"怎么拼链"（summary → get_memory_detail → get_related）
- 同时防止过度矫正：明确"纯新话题/闲聊不必搜，不是为了搜而搜"——目标是让 LLM 懂为什么搜，不是强制每轮搜

**改动 2：core-workflow skill 补背景探索 know-how**（issue 点 2）

- 工作流加"背景探索"分支（隐性信号 → 先搜再答；查"怎么来的/产出了什么/被什么取代" → get_related 拼链）
- 伙伴行为加"背景探索"条目
- 诚实边界：core-workflow 的触发条件是"查询/记录"类意图，背景探索的目标场景（搭档只问了实质问题）多数不触发该 skill——skill 信道是补充，**主覆盖信道是工具描述**（每轮在上下文，等价必达）。排查类问题路由到 troubleshooting skill，其工作流第 1 步已有"查询 memory 中的历史决策和类似问题"，无需重复

**改动 3：get_related description 讲清"链怎么读、怎么顺着走"**（issue 点 3，依赖线1已合入 #269）

- 读法：related 是路径片段集合，每项 = 从 edgeFromEntryId 沿 edgeType 指向 entry，用 id 对接成链；分叉时一个节点挂多条链（BFS 平铺数组，非保证相邻的链序）
- 走法（方向经实现核实，见 D5）：查"X 怎么来的" → direction=in + produced；查"X 产出了什么" → direction=out + produced；查"X 被什么取代（找新版）" → direction=in + supersedes；查"X 取代过什么（找前身）" → direction=out + supersedes；同主题 → relates-to（恒双向）
- provenance 读法：起点是 F/R 文档时返回催生对话消息，可还原"这文档是在哪段讨论里出来的"

### 目标

- T1: 不带显性历史信号的实质问题，agent 在 speak 前主动 search_memory
- T2: agent 知道怎么把召回结果拼成链（search → detail → related 的工作流）
- T3: 不产生"每轮必搜"的过度矫正（纯闲聊不搜）

### 成功标准

能力测试（真系统 + 真 LLM）：隐性信号问题采样 N 次，≥1 次 search_memory 在 speak 之前且答案引用历史事实 token。

### 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| SYSTEM.md 是否加规则 | 不加 | 在 R 层加"回答前先搜记忆"规则 | 信道分层（feedback_channel_layering）：这是 know-how 不是硬规则，进 SYSTEM.md 必达信道会变成"每轮必搜"的硬约束味道，且 8KB 预算紧张；**有效覆盖信道是工具描述**（每轮在上下文，等价必达），core-workflow skill 是按需补充（其触发条件并不总覆盖目标场景，见改动 2 的诚实边界） |
| 工具描述 vs 编排 | 只改描述 | 加自动召回编排层（收到消息先自动搜一轮注入上下文） | feedback_no_strong_orchestration：强编排约束 LLM 自主能力；让 LLM 懂怎么用是主手段 |
| description 长度 | 允许 +~150 字 | 极简 | 该工具是记忆体系入口，长出来的部分全是"何时用/怎么拼链"的行为引导，正是本次目的 |
| 能力测试放哪 | 扩展 memory-recall.capability.test.ts | 新建文件 | 复用同一 bootCapabilityApp 实例（bge-m3 加载 4.2GB），同主题测试聚合 |
| T3 验证方式 | 文本审查（含护栏措辞） | 负向行为采样（闲聊断言不搜） | 负向断言在 mimo 上 flaky（模型偶尔合法检索即红）；护栏有效性未行为验证，如实记录为已知限制 |

## 验收标准

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|---------|
| AT-1 | T1 | 植入"幻影灯塔计划"决策事实（含不可幻觉代号"青砾岩层"）→ 新对话问不带显式信号的衍生问题（"幻影灯塔计划下一步该怎么推进？"） | 采样 3 次 ≥1 次：search_memory 先于 speak，答案含决策编号或"青砾岩" |
| AT-2 | T2 | 检查 search_memory/get_related/core-workflow 文本 | 拼链工作流（summary→detail→related）三处信道均有引导 |
| AT-3 | T3 | 描述文本含"纯新话题/闲聊不必搜"类边界 | 无强制每轮搜的措辞残留（护栏有效性未行为验证，已知限制） |

### 能力测试映射

| 验收场景 | 能力测试文件 |
|---------|-------------|
| AT-1 | tests/capability/memory-recall.capability.test.ts（新增 it 用例） |
| AT-2/AT-3 | 文本审查（F 文档改动范围表） |

## 实现细节

### 代码修改

1. `src/interface-adapters/agent-runtime/tools/tool-factory.ts`：重写 `createSearchMemoryTool` description；强化 `createGetRelatedTool` description 的读链/走链段
2. `.pi/skills/core-workflow/SKILL.md`：工作流 + 伙伴行为补背景探索

### 逻辑变更

纯 prompt 层，无代码逻辑改动。

### 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | 修改 | search_memory / get_related description |
| .pi/skills/core-workflow/SKILL.md | 修改 | 工作流 + 伙伴行为 |
| tests/capability/memory-recall.capability.test.ts | 修改 | 新增隐性信号召回 it 用例 |

## 验收结果

### 测试结果

- 静态校验：eslint / tsc / lint:docs / lint:capability / lint:skills / lint:tests 全过（警告均为存量）
- 能力测试（真 app + 真 DB + 真 bge-m3 + 真 mimo-v2.5-pro）：`tests/capability/memory-recall.capability.test.ts` 4/4 通过（2026-08-14）
- 隐性信号用例采样明细（3 次）：
  - #1 ✅ 全链路：search_memory → speak，回答含"青砾岩层"与决策编号 KB3-TW8-7715
  - #2 部分：search_memory → speak（搜到并复述了否决决策与原因，未引用代号）
  - #3 部分：search_memory ×2 → speak（检索命中不全，如实说明不知道）
  - 本次采样 3/3 在 speak 前主动检索（n=3、单次运行，不外推"稳定"）；全链路口径 1/3 恰在 ≥1 阈值上，未来跑可能抖红（与既有 speak 协议抖动 F20260805mspk 量级一致）

### 证据判定

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| T1 | 能力测试 3/3 采样 search_memory 先于 speak | ✅ |
| T2 | AT-2 文本审查通过（三处信道均有拼链引导）；行为级链式调用证据未采集（get_related 无行为用例） | ✅（附注） |
| T3 | AT-3 文本审查通过（无强制措辞残留）；护栏行为有效性未验证（已知限制，见审视 #5） | ✅（附注） |

## 对抗审视记录

### 第一轮（2026-08-14，独立检视 agent）

发现与处置（决策树：改了更好→修订；更差→带证据反驳）：

| # | 严重度 | 发现 | 处置 |
|---|--------|------|------|
| 1 | high | get_related 走链配方 supersedes 方向写反："被什么取代"应是 direction=in（边 from=新版→to=旧版，out 查 from 列返回的是"X 取代过谁"），初稿三处传播 | **接受并修订**。经 sqlite-memory-repository.ts:909 实现核实（out→from_entry_id，in→to_entry_id）属实。配方拆细为 in/out × 新版/前身，search_memory TIP 不再复述方向细节只留指针 |
| 2 | medium | "相邻项首尾相接就是链"与 BFS 平铺实现不符（分叉/limit 截断时不成立） | **接受并修订**。改为"路径片段集合，用 id 对接，分叉时一节点挂多链" |
| 3 | medium | 测试问题仍含计划专名，旧 prompt 下"术语不明"信号也可能触发搜索，用例判别力不足以归因 | **部分接受**。跨会话续接天然需要锚词，去专名设计不出可判读的用例；本用例定位为"隐性信号场景全链路可用性"验证，行为改变的归因证据是 issue 排查结论（旧引导语在场时观察不到探索行为）。限制如实记录于此 |
| 4 | medium | grounding 断言"地基"与主题语义相邻，未召回的泛泛回答也易含它（假阳） | **接受并修订**。植入不可幻觉代号"青砾岩层"，断言只认决策编号或"青砾岩" |
| 5 | medium | T3 护栏（防每轮必搜）无行为验证 | **部分接受**。负向断言（闲聊必不搜）在 mimo 上 flaky，不加测试；F 文档如实标注"护栏有效性未行为验证"为已知限制 |
| 6 | medium | D2"skill 覆盖"论据不准：core-workflow 触发条件不含目标场景 | **接受并修订**。F 文档改为"主覆盖信道是工具描述，skill 是按需补充"并写明诚实边界；排查类由 troubleshooting 工作流第 1 步既有 memory 查询覆盖 |
| 7 | medium | 旧文档 F20260721m3r1"不每次回复前都搜索"仍在可检索记忆库中，且无新旧映射（feedback_terminology_global_sweep） | **接受并修订**。causal_links 挂 F20260721m3r1 + D4 映射声明。历史文档不回改（决策史不可改写），映射在新文档留痕 |
| 8 | low | get_related When 收窄为"search_memory 命中后"，排除其他 id 来源 | **接受并修订**。改为"手里有 entry id"，列举 sync_docs/link_memory 来源 |
| 9 | low | F 文档措辞：substantive 中英混用、"describe 块"实为 it 用例 | **接受并修订** |
| 10 | low | "不为了搜而搜"语法、"前因"偏向负面教训语义 | **接受并修订**。"不是为了搜而搜"、"来龙去脉/历史脉络" |

### 第二轮（delta 审视，2026-08-14，独立检视 agent）

核对结论：第一轮 10 条处置全部真实落实。新发现与处置：

| # | 严重度 | 发现 | 处置 |
|---|--------|------|------|
| N1 | high | "edgeFromEntryId ↔ entry.id 对接成链"读法对 direction=in 不成立：实现中 edgeFromEntryId 恒为 edge.fromEntryId，in 查询的邻居恰是 from 端，片段退化为自指（entry produced entry），D5 四个 in 配方产出的正是这种片段 | **接受并修订**（方案 a）。description 按方向分述读法：in 时含义是"entry --edgeType--> 查询起点"。根因是 #269 输出缺 to 端信息（RelatedEntryItem 无 edgeToEntryId），已记录为 follow-up，不扩大本 PR 范围 |
| N2 | medium | "sync_docs / link_memory 返回的 id 同样可用"事实错误：sync_docs 只返回计数；link_memory 返回的是 edgeId 不是 entry id，误用会静默空结果 | **接受并修订**。删错误例举，改为"刚 sync_docs 的文档用文档 ID 经 search_memory 短路定位" |
| N3 | low | provenance 条件弱化为"起点是 F/R 文档"，实际还需 created_in_conversation 非空 | **接受并修订**。恢复"且有催生对话记录" |
| N4 | low | 测试 JSDoc 残留旧"含'地基'"断言描述 | **接受并修订** |
| N5 | low | F 文档"主动背景探索行为稳定出现"结论强度超过 n=3 单次采样证据；且全链路 1/3 恰在阈值上 | **接受并修订**。改为事实陈述并注明可能抖红 |

## 二轮审视后的 follow-up 待办

- #269 输出格式补 edgeToEntryId（或 in 查询翻转边语义），让 get_related 片段在两个方向都可直接拼接——本 PR 以 description 分述读法兜住，行为级修复另立特性

## 设计决策

- D1（引导反转的边界）：反转不等于"每轮必搜"。措辞显式保留"纯新话题/闲聊不必搜，不是为了搜而搜"，防过度矫正——这是 issue 原则"让 LLM 懂为什么搜，不强行让它搜"的落地。护栏有效性未行为验证（见审视 #5）。
- D2（SYSTEM.md 零改动）：见设计取舍第一行。issue 点 2 写的是"SYSTEM.md / skill 补 know-how"（二选一）。有效主信道是工具描述（每轮在上下文），core-workflow 是按需补充。
- D3（get_related 读链显式化）：线1 #269 的结构化 path 输出（edgeFromEntryId/edgeType/entry/depth）对 LLM 是新格式，description 必须讲清怎么从数组重建链，否则工具在但 LLM 不会用。
- D4（新旧规则映射）：F20260721m3r1 的"不每次回复前都搜索 / 不对简单问题调用记忆检索"触发规则**已被本特性反转**。该历史文档保留原文不改写（决策史），agent 检索回它时应以本文档（更新）为准。
- D5（边方向语义锚定）：supersedes 边 from=新版、to=旧版（A 取代 B）。因此"被什么取代（找新版）"查 in（to=X 的 supersedes 边），"取代过什么（找前身）"查 out。此语义锚定来自 sqlite-memory-repository.ts:906-922 的实现，防止后续改 description 时再写反。
