---
id: F20260917osnr
title: 观测器信噪比自监控：daily-review 统计自身的误报率与低价值率
doc_type: feature
summary: |
  告警的终点站是搭档的注意力（全系统最贵的告警预算），但没有任何机制统计观测器自身的
  信噪比——healing dismiss 率（误报率）、RHI 不处置率（低价值率）无人统计，观测器自己
  不在被观测（issue #999，R20260916rsis 碰撞地图起火点 C2，三真缺口的最后一个）。
  本特性在 daily-health-check.md 加「观测器信噪比自监控」段：昨日信噪统计
  （healing 处置分布 / RHI 处置分布 / 产给搭档的物件数）+ 7 日趋势对比 +
  降级建议触发线（连续两周 dismiss 率或不处置率 > 50% → 日报给降级/关停建议行）。
  依据：HackProbe 检测器 FPR 0.43 的教训（误报率比检出率更决定告警系统生死）+
  Google SRE（不可行动的告警是噪音）。
change_type: prompt
capability_test: tests/usecases/scheduler/daily-health-check-prompt-discipline.test.ts
created_in_conversation: 325ef7b7-8e42-4edc-9abf-eae8f332a2c4
intent:
  problem: "观测器（healing/RHI 信号源）的误报率与低价值率无人统计——观测器自己不在被观测，告警噪音侵蚀搭档注意力预算"
  expected_effect: "日报末尾出现信噪比固定段（dismiss 率 / 不处置率 / 物件数）；任一信号源连续两周误报超 50% 时日报给出降级建议行"
  verify_by:
    type: behavior_check
causal_links:
  from: ["R20260916rsis"]
  supersedes: []
tags: ["observability", "daily-review", "signal-noise-ratio", "self-monitoring"]
modules: ["prompts/scheduled/daily-health-check.md", "tests/usecases/scheduler/daily-health-check-prompt-discipline.test.ts"]
---

# 观测器信噪比自监控（#999）

## 背景与需求

三真缺口的最后一个（前两个：#1002 语义组件质量闭环 ✅、#1004 修复回归验证 ✅）。
观测器/指标自身要随使用调整——可操作形态不是「观测器自动改自己」，而是
「观测器的误报率被观测，人被请来重新校准它」。

## 方案设计

daily-health-check.md 加「观测器信噪比自监控」段（RHI 处置段之后）+ checklist 第 10 项：

1. **昨日信噪统计**（日报末尾固定段）：healing dismiss 率（误报率近似）/
   RHI 不处置率（低价值率近似）/ 产给搭档的物件数（日报+issue+告警）
2. **趋势对比**：与近 7 日均值比，突增标注「信号源可能在劣化」
3. **降级建议触发线**：任一信号源连续两周误报/不处置率 > 50% → 日报显式给
   「建议降级/关停该观测器或调阈值」行（含数据锚点）

## 设计取舍

| 取舍 | 决策 | 理由 |
|---|---|---|
| 阈值 50% | 拍脑袋起步值，首月试运行后校准 | 特性文档与 prompt 均写明「可按实际分布校准」——诚实标注这是初值不是科学 |
| 降级建议 vs 自动降级 | 只建议（LLM 软判断呈搭档） | 观测器关停不可逆性高，建议权给机器、决策权留人（AAR 式人类终审） |
| 落点 | 日报固定段 + checklist，不加新定时任务 | 复用既有 daily-review 通道（最小实现阶梯），零新代码 |

## 机制识别检查点判定

逐项打勾：配置 ❌ / 状态生命周期 ❌ / 定时任务 ❌（复用既有 daily-health-check）/
信号类型 ❌ / 持久化 ❌ / 决策分支 ❌ / 跨模块调用 ❌。**不涉及净新增机制**。

## 验证

- 纪律锁测试 6/6（新增信噪段断言）
- issue 验证标准「两周后能看到信噪比排名 + 高误报源自动给降级建议」待运行积累
- 合入后需跑 update-scheduled-task-body.mjs 同步 DB 副本

## 负面向条目

无旧契约破坏：RHI 处置段/抽查段原样保留（新段插入其后），checklist 追加第 10 项非替换。
