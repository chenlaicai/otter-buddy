---
id: F20260917hcs2
title: healing 事件二维分账：环境/系统失败与獭能力失败分离统计
doc_type: feature
summary: |
  healing_events 的 errorType 若把「系统/环境原因」（工具超时、429、守卫拦截）与「獭能力原因」
  （检索缺失、格式异常、行为退化）混着统计，daily-review 会把工具故障误读成獭不行、把獭不行误读成
  工具故障——两种误判的处置方向完全相反（issue #998，R20260916rsis 碰撞地图起火点 C1；
  业界依据：Qwen-UI-Agent 把环境抖动从「模型的错」里单列）。本特性三处落地：①实体层
  classifyHealingErrorType 映射函数（13 枚举全覆，other 归能力=保守不粉饰系统）；②self-healing-analysis
  动态 prompt 加二维分账行；③daily-health-check.md 数据源 4 加分列口径要求。不加 DB 字段、
  不写历史回标脚本（分类是纯映射，任何时刻可对存量重算——DB 字段是冗余真相源）。
change_type: feature
capability_test: tests/entities/healing/healing-event-classify.test.ts
created_in_conversation: 325ef7b7-8e42-4edc-9abf-eae8f332a2c4
intent:
  problem: "healing 统计把环境失败与獭能力失败混排，daily-review 误判处置方向（修獭 vs 修工具）"
  expected_effect: "self-healing-analysis prompt 与 daily-review 日报中两类失败分列呈现，不再混排"
  verify_by:
    type: behavior_check
causal_links:
  from: ["R20260916rsis"]
  supersedes: []
tags: ["healing", "observability", "error-classification", "self-optimization"]
modules: ["src/entities/healing/healing-event.ts", "src/usecases/scheduler/scheduler-service.ts", "prompts/scheduled/daily-health-check.md", "tests/entities/healing/healing-event-classify.test.ts"]
---

# healing 事件二维分账（#998）

## 背景与需求

healing_events 的 errorType 混排「环境/系统」与「獭能力」两类失败。业界依据
（Qwen-UI-Agent 技术报告）：环境抖动（沙箱挂、网络抖）若不从「模型的错」里单列，
是小团队 RL 不收敛误判的主因。映射到海獭：daily-review 看到「tool_failure 5 条 +
missing_context 3 条」合计 8 条，若不分账，「獭最近老出错」和「工具最近不稳」
两种相反结论都可能被讲出来。

## 方案设计

1. **实体层**（healing-event.ts）：`classifyHealingErrorType` 纯映射——
   环境：tool_failure / rate_limit / circuit_break / self_restart；
   能力：missing_context / wrong_tool / format_violation / knowledge_gap / performance /
   degenerate / guard_intercept（检视修正：被拦的是獭的危险动作，守卫工作正常，
   且生产库实证 guard_intercept 占全库 37% 第一大类，归环境会放大粉饰 145 倍）；
   tool_use_feedback 不入分账（主动反馈信号独立列，计入分母复刻混读——检视修正）；
   other 归能力（保守归因）
2. **消费层**（scheduler-service.ts）：buildHealingAnalysisBody 概况加二维分账行
   （含口径明示，防读者误读）
3. **规范层**（daily-health-check.md 数据源 4）：统计呈报必须按两列分列 + 口径写明

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 分账实现 | 纯映射函数 | 加 DB 维度字段 + 历史回标脚本（issue 原方案②） | 分类是纯函数，任何时刻可对存量重算；DB 字段 = 冗余真相源，会漂移（最简检查） |
| other 归属 | capability | environment / 单列 unknown | 保守原则：未知失败先算獭的，逼系统改进可观测性；归环境会粉饰 |
| 历史数据 | 不回标 | 脚本扫 description 关键词 | 映射函数对存量即时生效，回标是伪需求 |
| 口径演进代价 | 接受漂移，显式记录 | DB 快照每版口径 | 纯映射的代价：分类口径一调整，历史统计全量重算、跨期对比无锚（本 PR 的检视修正就是第一次口径调整现场——以此 commit 为 epoch v1 锚点，后续口径调整在本文档追加 epoch 行） |

## 机制识别检查点判定

逐项打勾：新增配置字段 ❌ / 状态生命周期 ❌ / 定时任务 ❌ / 信号类型 ❌ /
持久化存储 ❌ / 决策分支（结果被记住影响后续）❌（映射在每次消费时实时计算）/
跨模块调用 ❌（scheduler 已 import healing 实体）。**不涉及净新增机制**。

## 验证

- classifyHealingErrorType 测试 4 条（环境类/能力类/other 归属/全枚举覆盖）
- healing-analysis-template 测试 11 条全过（二维行不破坏既有断言）
- daily-health-check 纪律锁 5/5 过
- issue 验证标准「拉一周数据两类比例可分离呈现」待运行积累

## 负面向条目

无旧契约破坏：byType 分布行保留（二维行是追加非替换）；errorType 枚举未动；
存量的 issue/日报口径不受影响（分列只管新产出）。
