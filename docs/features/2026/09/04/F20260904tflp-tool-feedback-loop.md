---
id: F20260904tflp
title: 工具使用感受反馈闭环：打通海獭主观评价流入 healing 事件池的入口
summary: 搭档发现 40+ 工具存在冗余/难用/过度设计嫌疑但无从评估——使用者（海獭）没有反馈入口。现状核查：客观调用数据已在 message_events 表存在（7.6 万条），主观感受通道为 0 条。方案：复用 healing_events 表 + speak 内嵌标记协议扩展 category 维度，每日 22:00 self-healing-analysis 定时任务消费，海獭主动自报使用中遇到的问题。
change_type: prompt   # 方案/设计文档：本变更主体是 prompt+协议层（healing 标记协议、提示文本、消费任务指令），无独立代码逻辑设计
created_in_conversation: de5bcf98-7a4b-4e2e-9475-835359da0bd7
tags: [healing, tools, feedback-loop, observability]
intent:
  problem: "海獭使用工具的痛点无反馈入口，工具冗余/难用问题无从被发现"
  verify_by: "golden_gate + 单元测试（协议解析）"
modules: []
created_at: 2026-09-04
---

# 工具使用感受反馈闭环

## 背景

搭档原话（意图锚）：

> 我在思考，是否有 多余的、不用的、错误的、不好用的、过度设计的。但这些我很难去评估，因为我不是使用者，海獭们才是，只有使用了才有评价资格

> 我一开始说的就是 在使用过程中，海獭们自由反馈工具的使用感受

**触发事件**：2026-09-04 工具盘点对话。衍生事故：大獭查错库（otter.db vs otter-buddy.db）输出虚构的"通道零使用"叙事，搭档识破（issue #791），进而提出"证据真实性"专项关切。

## 现状核查（全部基于在用库 data/otter-buddy.db 实查）

### 事实一：客观调用数据已存在，无需新建埋点

`message_events` 表（2026-07-27 起）已记录每次工具调用与结果：

- `assistant_toolcall` 事件：工具名 + 参数（63,845 条）
- `tool_result` 事件：结果 + isError 标记（75,848 条）

近 30 天可聚合出每工具的调用频次与错误率。零/极低频工具实查（生命周期内全量）：`add_terminology`(1)、`resolve_signal`(1)、`halt_otter`(1)、`delete_context`(2)、`unlink_memory`(3)、`get_related`(4)、`search_terminology`(4)、`query_signals`(11)、`get_turn_history`(13)、`query_dispatch_ledger`(12)、`create_scheduled_task`(14)。

> 注意：上述"错误率"粗口径（error 结果数 ÷ call 数）因重试结果配对不精确，个别工具 >100%，正式统计需按 message_id+call_id 配对，本方案不依赖该口径做决策，仅示意数据可用性。

### 事实二：主观感受通道存在但从未被使用

healing 自愈系统（F20260730sbrt）提供 speak 内嵌标记协议（海獭在发言末尾自报问题 → healing_events 表）。截至 2026-09-04 14:25，全库 246 条事件的 **error_type 字段原始分布**：

| error_type | 条数 | 语义 |
|---|---|---|
| guard_intercept | 79 | bash 守卫拦截 |
| degenerate | 65 | 循环退化 |
| rate_limit | 40 | 限流 |
| other | 33 | 杂项（见下拆解） |
| circuit_break | 23 | 熔断 |
| self_restart | 4 | 自重启 |
| performance | 2 | 性能 |

对 other/performance 两类按 **description 内容**二次拆解（口径与前表不同，标注清楚）：other 33 = 探针心跳 24 + 服务重启恢复 9；performance 2 = 定时任务停跑 2。

**海獭主动自报 0 条**——全部 246 条均为系统自动监测产生。

消费端健康：Self-Healing 定时任务每天处理事件（9:00 健康检查 / 22:00 self-healing-analysis 分析），入口端是断点。

### 事实三：协议提示的注意力权重过低

自报协议说明位于 speak 工具 description 末尾一段（工具描述总长数千 token），无例行触发点。F20260904hstr 修复的"吞正文"bug 说明：此前即使有海獭尝试打标记，标记本身还会破坏消息（该 bug 已修复，通道物理通畅）。

## 目标

- T1: 海獭在使用工具过程中遇到「难用/多余/疑似过度设计/参数别扭」等感受时，有低摩擦的主动上报动作
- T2: 上报流入既有 healing_events 事件池，被既有定时任务消费（不新建管线）
- T3: 反馈可定位到具体工具与具体痛点（结构化到工具名级别）
- T4: 客观调用数据（message_events）与主观反馈（healing_events）可在分析时交叉验证

## 非目标

- 不做一次性工具评审会（搭档明确否决：要持续反馈，不要运动式评审）
- 不新建独立反馈管线/表/工具（复用 healing_events，避免第二套台账）
- 不做工具调用埋点（message_events 已覆盖，不重复建设）
- 不做评分系统/李克特量表等重形态（用户是海獭不是人类，自由文本足够）
- 本方案不解决"证据真实性"通用问题（搭档已另行提出，将开专项 issue）

## 方案设计

### 核心思路：三处小改，全部复用既有机制

**1. 协议扩展：healing 标记新增 tool_use_feedback 类型**

现有七类 error_type（tool_failure 等）面向"系统故障"。新增：

- error_type 白名单增加 `tool_use_feedback`（工具使用感受）
- 工具标识落点**收口为 description 前缀**：`[tool:get_related] ……`（不新增 schema 字段、不依赖 context——manage_healing_events 查询返回的 context 可见性未核实，description 前缀零风险可见且聚合 SQL 可 LIKE）
- description 自由文本写痛点（"参数 description 抽取正则吞了正文"这种粒度）

协议示例（写入 speak 工具 description 的自愈段，替换现有格式说明）：

```
<healing>[issues]
type: tool_use_feedback
severity: low
description: [tool:get_related] direction 参数 in/out 语义反直觉，查"谁催生了X"要 in 不是 out，每次都要试错
suggestion: 交换默认值或在 description 里加对照示例
</healing>
```

改动点：`src/usecases/healing/healing-report-parser.ts` VALID_TYPES 增加 `tool_use_feedback`。无 schema 变更，无字段悬置。

**2. 提示位置强化：SYSTEM.md R5 一句 + speak description 自愈段重写 + 工具错误返回提示**

三层提示，各就其位（token 预算见取舍表）：

- SYSTEM.md R5 只补一句（约 +30 token）："工具使用感受（难用/多余/过度设计/参数反直觉）也属可报项，type 用 tool_use_feedback，description 以 [tool:工具名] 开头"——纪律层只需知道"可报"，细节在操作层
- speak 工具 description 自愈段重写（约 +120 token，替换现有约 70 token 的格式说明，净增约 +50）：

```
【系统自愈】发言遇系统问题时在 body 末尾附 healing 块（格式见 manage_healing_events 工具描述）。顺利时附 no_issue 块。
工具难用也可报：type: tool_use_feedback，description 以 [tool:工具名] 开头，写清痛点与建议。
该报的时机：调用失败且自行绕路解决 / 同一意图连试多个工具 / 参数语义反直觉 / 疑似与相邻工具职责重叠。
```

- **工具错误返回提示（审视发现 3 采纳，进 Phase 1）**：tool-factory 统一 execute 错误路径的返回文本尾部追加一行：`（工具报错？若属难用/参数设计问题，可在下次 speak 末尾用 tool_use_feedback 标记反馈）`。摩擦发生的精确时刻提示，一处改动覆盖所有工具，仅 isError 时出现无噪音

**3. 消费端：self-healing-analysis 定时任务 prompt 增加分类处理指令**

22:00 分析任务已遍历 healing_events，prompt 增加指令：`tool_use_feedback` 类型事件 → 按 description 的 `[tool:<name>]` 前缀聚合 → **独立反馈 ≥2 自动建 GitHub issue（标签 tool-feedback）**。

**独立定义（审视发现 4 采纳）**：不同 otter_id 的反馈视为独立（同 otter 的重复反馈可能是同一认知偏差）；同一 otter 对同一工具的多条反馈取最新一条参与判定。

改动点：`prompts/scheduled/self-healing-analysis.md` 增加处理分支。

### 数据流

```
海獭使用中遇到痛点
  → speak 末尾打 <healing> 标记（type: tool_use_feedback + description 以 [tool:XXX] 前缀标识工具）
  → healing-report-parser 解析入库 healing_events
  → 22:00 self-healing-analysis 聚合
  → 高频痛点建 issue（tool-feedback 标签）
  → 每日 issue 处理任务（10:30）消费 → 修复/驳回
  → message_events 客观数据交叉验证（修复前后错误率/频次变化）
```

## 影响范围

| 模块 | 影响 |
|---|---|
| src/usecases/healing/healing-report-parser.ts | VALID_TYPES +1，category 字段解析 |
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | speak description 自愈段重写 |
| SYSTEM.md | R5 补工具反馈可报项 |
| prompts/scheduled/self-healing-analysis.md | 增 tool_use_feedback 处理分支 |
| 无 schema 变更 | 复用 healing_events 表，工具标识为 description 前缀 [tool:<name>] |

## 风险与约束

- **上报量可能仍为零**：缓解不限于被动观察——三层提示（SYSTEM.md 纪律层 / speak 操作层 / 错误返回触发层）覆盖"想到时报、报时报得对、摩擦时被提醒"三个时刻，错误返回提示在摩擦精确时刻出现，是比纯 prompt 强化高一个数量级的触发。上线 2 周后若 tool_use_feedback 仍为 0，升级为结构化触发（工具连续报错 3 次主动弹问询）——Phase 2
- **噪音**：低质量反馈（如把任务失败归咎工具）混入。缓解：severity 由海獭自评 + 消费端聚合阈值 ≥2 独立反馈才建 issue + 22:00 任务对 tool_use_feedback 有驳回权（dismiss）
- **prompt 变更属软代码**：需走 golden gate 验证（capability_test 声明）

## 不兼容更新

无。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 新增反馈类型 vs 复用 other | 新增 tool_use_feedback 类型 | 用 other + 约定前缀 | 消费端可机器聚合，不用解析自由文本猜类型 |
| category 落点（审视后收口） | description 前缀 `[tool:<name>]` | context JSON 字段；独立 schema 列 | context 在 manage_healing_events 返回路径的可见性未核实，description 前缀零风险可见且 SQL LIKE 可聚合；独立列需 schema 迁移无必要 |
| 提示位置（三层） | SYSTEM.md 一句 + speak description + 错误返回触发 | 只改 speak description | 纪律层/操作层/触发层各司其职；错误返回提示在摩擦时刻出现，解决"根本想不起来报" |
| 消费时机 | 复用 22:00 任务 | 新建专项定时任务 | 不加任务数量；22:00 任务已是事件池的标准消费者 |
| 客观数据呈现 | 分析时按需 SQL 聚合 message_events | 预聚合物化视图 | 按需查询零维护；数据量（月 7 万条）远未到需物化的量级 |
| token 预算 | SYSTEM.md +30 / speak 净增 +50 | 详情全放 SYSTEM.md | SYSTEM.md 当前 8KB，阈值 15KB，全局 SDK base 膨胀需克制；详情下沉到操作层 |

## 对抗审视记录

首轮（2026-09-04，检视獭审视tflp/mimo，2 严重 + 4 建议）处置：

- 严重 1（数据口径混排失真）：接受。事实二重写为双口径分列（error_type 原始分布 + other/performance 按 description 内容拆解），标注查询时间。根因：写方案时将两次查询结果拼表未标口径——呈现失真即数据不实，本项目正处于"证据真实性"信任修复期，从严认定
- 严重 2（schema 矛盾悬置）：接受。category 落点收口为 description 前缀，理由见取舍表；"无 schema 变更"声明与落点已一致
- 建议 3（被动等待）：部分接受。采纳"错误返回提示"进 Phase 1（落点从检视建议的 speak 返回改为 tool-factory 统一错误路径，更精准）；"连续报错 3 次弹问询"仍留 Phase 2
- 建议 4（独立定义）：接受。不同 otter_id 为独立；同 otter 取最新一条
- 建议 5（SYSTEM.md token 预算）：接受。预算评估入取舍表
- 建议 6（speak description 预览）：接受。预览文本 + token 增量已补

## 验证

- 单元：healing-report-parser 解析 tool_use_feedback 类型的用例
- capability/golden gate：prompt 变更后海獭在模拟"工具难用"场景下能打出正确标记（软代码验证）
- 运行验证（上线 2 周后）：healing_events 出现 tool_use_feedback 条目；若有 ≥2 独立反馈工具被建 issue
- 零反馈兜底判定：2 周零反馈 → 触发 Phase 2 评估（结构化触发）

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/usecases/healing/healing-report-parser.ts | 修改 | VALID_TYPES + tool_use_feedback |
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | 修改 | speak 自愈段重写 + 统一错误路径尾部提示 |
| SYSTEM.md | 修改 | R5 补一句可报项（约 +30 token） |
| prompts/scheduled/self-healing-analysis.md | 修改 | tool_use_feedback 聚合建 issue 指令（含独立定义） |
| tests/usecases/healing/healing-report-parser.test.ts | 修改 | 新类型解析用例 |
| docs/features/2026/09/04/F20260904tflp-*.md | 新建 | 本方案文档 |

## 实现（2026-09-04 补充，PR #796）

方案终审通过后同 PR 补全实现：

| 文件 | 改动 |
|---|---|
| src/entities/healing/healing-event.ts | HealingErrorType 联合类型 + 'tool_use_feedback' |
| src/usecases/healing/healing-report-parser.ts | VALID_TYPES + tool_use_feedback（未知值本就回退 other，白名单使其合法解析） |
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | speak 自愈段重写（工具可报项 + 四触发时机，净增约 +50 token） |
| src/frameworks/agent/tool-builder.ts | 统一错误出口：isError 结果尾部追加 tool_use_feedback 引导提示（speak 豁免，避免循环暗示） |
| .pi/SYSTEM.md | R5 补一句工具感受可报项（约 +30 token） |
| prompts/scheduled/self-healing-analysis.md | tool_use_feedback 处理规则（独立判定 + ≥2 建 issue + 驳回权） |
| tests/usecases/healing/healing-report-parser.test.ts | +1 用例：tool_use_feedback 解析含 [tool:name] 前缀 |
| tests/frameworks/agent/tool-error-feedback-hint.test.ts | +3 用例：isError 追加提示/非错误无噪音/speak 豁免 |

**验证**：parser+builder 单测 31 passed；agent+healing+speak 全量 26 文件 420 passed；golden gate（软代码）运行中，结果见 PR。
