---
id: F20260923htax
title: Harness Tax 量化观测：invoke 数据成本聚合分析
change_type: feature
created_in_conversation: 98bd9fdd-8e28-4de8-b782-b59f46e733dd
intent:
  who: 搭档 chen + 大獭（系统运营成本的关注者）
  problem: 海獭系统的 prompt/工具面是否在收「隐形税」（HarnessTax 揭示的现象：harness 差异可致 5 倍成本差），目前无量化答案
  trigger: "量化观测这点，我觉得可以思考下，能不能来加强优化下咱们这边的观测/评估/测评/测试机制"
  expected_effect: "一条命令跑出「模型×任务类型」的 token/成本分布表，定位最收税的任务格子（首跑实测：kimi 审视 $2.43/次最贵、mimo 定时任务 ctx 151K 最高），为 prompt 瘦身/模型调度提供数据依据"
verify_by: command
summary: "HarnessTax（Arena/Berkeley）揭示 harness 差异可致 5 倍成本差、Unreal Agent 异步 harness 再榨 40%——海獭已对齐「初始 context 压缩」（toolresult-externalizer），但「咱们自己的税分布在哪」无数据。本特性落地一个只读聚合脚本 scripts/harness-tax-report.mjs：从既有 invokes 表（2766 条/1809 条含 ctx_window_used）按「模型×任务类型」分组输出 token 统计（均值/中位数/P90）与成本估算，零侵入零新表。实测首跑即出洞察：kimi 审视任务最贵、mimo 定时任务 ctx 最高但单价低。"
tags: [observability, cost, harness-tax, token-metrics]
capability_test: "n/a: 纯只读查询脚本，无运行时行为变更；验证方式=真实 DB 执行+手工 SQL 抽查复算一致（详见文档验证节）"
causal_links:
  from:
    - F20260914rtsp
---

# Harness Tax 量化观测：invoke 数据成本聚合分析

## 背景

搭档原话（意图锚）：

> 「量化观测这点，我觉得可以思考下，能不能来加强优化下咱们这边的观测/评估/测评/测试机制」

上游脉络：AI 雷达洞察 Unreal Agent（异步 harness 省 40% 成本）→ 深挖 HarnessTax 研究（Arena/Berkeley：同模型跨 harness 成本差最高 5 倍，成功率差异 ±2-5%）→ 结合分析确认海獭已对齐「初始 context 压缩」（toolresult-externalizer），但「咱们自己的税有多少」无数据 → 搭档点名量化观测方向。

数据基础已探明（本对话实测）：
- `invokes` 表（schema.ts:866-902）：2766 条记录，1809 条含 `ctx_window_used`（65% 覆盖率，token_usage_input/output/ctx_window_used/tool_call_count/started_at/ended_at 齐全）
- `invokes.metadata` JSON 含 `model` 字段（实测：`{"model":"kimi"}`）
- 任务类型推断：对话标题关键词粗分。**invoke 级定时/手动触发源不可判**——`trigger_entry_id` 实测恒 NULL（schema.ts:907 注释预告「scheduled 任务来源 trigger_entry_id 为 NULL」），entries 特征匹配只能到对话级（同对话手动/定时混杂无法拆分），本 PR 不新增此维度，根治需写入侧补 trigger 记录（未决问题）

## 目标

T1: 一个可重复执行的成本聚合脚本，按「模型 × 任务类型」分组输出 token 消耗统计（均值/中位数/P90/样本数），回答「哪类任务、哪个模型在收税」
T2: 输出含成本估算（按当前模型定价表换算美元），对齐 HarnessTax 的分析口径
T3: 零侵入——纯只读查询，不改任何现有表结构/写入路径

## 非目标

- 不建实时观测面板（web UI）——先用脚本+终端输出验证价值，数据有洞察再考虑可视化
- 不做 HarnessTax 式 A/B 实验（换 harness 跑基准）——咱们只有一个 harness，无对照组
- 不做自动优化建议——本期只出数据，优化决策由人做
- 不新建定时任务——脚本手动跑或搭搭档一句话触发，周报自动化等验证有价值后再议

## 未决问题

- 任务类型的分组粒度：首版按对话标题关键词粗分（雷达/体检/洞察/审视/运维/其他），粗分不够再细化
- invoke 级定时/手动拆分：需写入侧补 trigger_entry_id 记录（运行时改动）——已立 issue #1150
- cacheRead/cacheWrite 成本：未落库（sqlite-invoke-repository 只存 input/output），脚本成本口径为方向性低估；补齐落库——已立 issue #1149
- 定价表维护：模型价格硬编码在脚本里（首版），后续看是否需要抽配置

## 方案设计

### 核心：一个聚合分析脚本

`scripts/harness-tax-report.mjs`（Node，better-sqlite3 只读连接）：

```
查询：invokes JOIN conversations JOIN otters
维度：
  - model（从 invokes.metadata JSON 提取）
  - 任务类型（推断规则）：
      scheduler 触发（trigger_entry_id IS NULL 或指向 system entry）→ 按 conversation title 匹配「雷达」等关键词
      非 scheduler → 按 conversation title 关键词粗分（开发/审视/闲聊/其他）
指标（按 model × 任务类型分组）：
  - 样本数、ctx_window_used 均值/中位数/P90
  - token_usage_input/output 均值
  - tool_call_count 均值
  - 平均耗时（ended_at - started_at）
  - 估算成本（model 定价表硬编码：input/output per M token）
输出：终端表格 + 可选 JSON 导出（--json 落工作区，供后续分析）
```

### 首版定价表（硬编码，来源：各厂商公开定价，执行时核实）

| 模型 | input $/M | output $/M |
|---|---|---|
| kimi (k3) | 待查 | 待查 |
| glm | 待查 | 待查 |
| 其他出现的模型 | 待查 | 待查 |

（定价在脚本顶部常量区，改价格改一处；查不到的模型标注「价格未知，只报 token 量」）

### 涉及模块

| 模块 | 改动 |
|---|---|
| `scripts/harness-tax-report.mjs` | 新增（唯一新增文件） |
| 特性文档 | 新增（本文档） |

### 关键设计点

1. **只读**：脚本对 DB 只读查询，零写入风险
2. **幂等**：每次跑全量重算，无状态
3. **渐进式**：首版终端表格够看就行；--json 导出留给后续深挖
4. **任务类型推断宁可粗不可错**：匹配不到关键词的归「其他」，不强行归类
5. **口径声明上头**（审视修正）：输出头部三行口径声明——定价口径（公开 API 量级）、成本口径（不含 cache 读写，方向性低估）、分组口径（标题粗分，定时/手动不可拆）。不给读者「假装精确」的数字

## 影响范围

- 新增一个 scripts/ 下的独立脚本，不影响任何运行时路径
- 对 DB 只读，无并发/锁风险

## 风险与约束

- **metadata.model 覆盖率**：2766 条中 metadata 含 model 的比例未全量验证（抽样 2 条都有）——脚本对缺 model 的记录归入「unknown」组，不丢弃
- **ctx_window_used 覆盖率 65%**：早期 invoke 无此字段（F20260914rtsp 之前），分析结论仅覆盖近期数据——脚本输出标注覆盖率
- **定价时效**：模型价格可能变动，脚本输出的成本估算标注定价日期

## 不兼容更新

无。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 载体 | 独立脚本手动跑 | 定时任务自动周报 | 搭档定调「先验证价值再自动化」；手动跑 3 次有洞察再立项自动化 |
| 数据源 | 既有 invokes 表 | 新建观测表/metrics 管道 | 数据已落库 1809 条，零新增写入路径 |
| 分析深度 | 分组统计+成本估算 | HarnessTax 式 bootstrap 置信区间 | 首版回答「有没有税」即可；统计显著性等样本量上来再加 |
| 机制识别 | 不涉及净新增机制 | — | 纯只读查询脚本，无新决策分支/调用路径/信号类型，免四问 |

## 验证

Golden Gate: n/a（纯查询脚本，无 prompt/skill 层改动）

1. ✅ 脚本在真实 data/otter-buddy.db 上执行成功，输出 26 个分组的完整表格（近 30 天 1913 次 invoke、89% ctx 覆盖率）
2. ✅ 抽查校验：手工 SQL 复算「kimi×审视」分组均值（141064/418127/47548/22 条）与脚本输出完全一致
3. ✅ 边界：--db 指向不存在路径报清晰错误 exit 1；--days 0 空结果正常输出不报错
4. ~~定时/对话分组~~ **已修正**：首版 trigger_entry_id 判定全落空（实测恒 NULL），二版 entries 特征匹配被判对话级误标（审视严重 1：同对话手动轮次全被误标「定时·」，「29+14 正确拆分」声称被证伪）——最终版去掉定时/对话维度，任务类型只按标题关键词粗分，不可判性在输出头部声明
5. 最简检查：单文件脚本、零新依赖（better-sqlite3 为既有依赖）、无状态幂等——已过最简检查
6. ✅ --days 参数校验（非正数清晰报错 exit 1）

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| `scripts/harness-tax-report.mjs` | 新增 | 聚合分析脚本 |
| `docs/features/2026/09/23/F20260923htax-*.md` | 新增 | 本文档 |
