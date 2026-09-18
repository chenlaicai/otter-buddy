---
id: F20260917htam
title: 锚点抽查异体模型规则：抽查獭与被抽查发言必须不同模型
doc_type: feature
summary: |
  daily-health-check.md 锚点真实性抽查（#981）是「LLM 查 LLM」，但抽查者与被抽查者共享同一模型、
  同一套 prompt 传统——系统性盲区也共享，同模型抽查者可能根本看不出那类编造，
  「同一獭 7 日 ≥2 次编造升 P0」阈值永不触发（issue #1000，R20260916rsis 碰撞地图起火点 C3）。
  本特性在抽查流程插入「异体核对」硬规则（步骤 2）：消息模型经 otter_sessions.model_alias 对照，
  同模型样本改派异体模型獭复核，无条件改派时降级标注「同模型抽查，置信降级」；
  产出段加模型对照行明示。业界依据：Red Queen GM 实测同源评审器对 AI 产出接受率是人类的 1.91 倍。
change_type: prompt
capability_test: tests/usecases/scheduler/daily-health-check-prompt-discipline.test.ts
created_in_conversation: 325ef7b7-8e42-4edc-9abf-eae8f332a2c4
intent:
  problem: "锚点抽查的抽查者与被抽查者同模型时，共享系统性盲区——编造锚点可能永不被发现，P0 升级阈值形同虚设"
  expected_effect: "日报锚点抽查段产出中出现模型对照行（抽查模型 X vs 样本模型分布）；同模型样本有改派异体复核或降级声明"
  verify_by:
    type: behavior_check
causal_links:
  from: ["F20260916evan", "R20260916rsis"]
  supersedes: []
tags: ["prompt", "daily-review", "evidence-anchor", "heterogeneous-model", "trust"]
modules: ["prompts/scheduled/daily-health-check.md", "tests/usecases/scheduler/daily-health-check-prompt-discipline.test.ts"]
---

# 锚点抽查异体模型规则（#1000）

## 背景与需求

锚点真实性抽查（#981，F20260916evan 的外部强制层）解决了「规则靠 LLM 自觉」的问题，
但留下结构性盲区：抽查者与被抽查者共享同一模型与 prompt 传统。若某类编造锚点恰是该模型的
系统性盲区（如特定格式的假 file:line 它看着就「像真的」），抽查形同虚设——规则写着
「7 日 ≥2 次升 P0」，但抽查者看不出该类编造时，这个阈值永远不会触发。

业界依据（R20260916rsis）：剑桥 Red Queen GM 实测——最强 baseline 评审器对 AI 生成论文的
接受率是人类的 1.91 倍，评审者与生产者同源时评审不可信；AWS Who Grades the Grader 的
位置交换协议件同思路（独立评审实例分别判）。

## 方案设计

daily-health-check.md 锚点抽查段插入新步骤 2「异体核对」（原 2/3/4 顺延为 3/4/5）：

1. **模型对照**：消息模型经 otter_sessions.model_alias 解析（sender → session → model_alias）；
   查不到模型的发言跳过不计入样本
2. **同模型样本改派**：样本与抽查执行者同模型 → 改派异体模型獭复核该条；
   无条件改派（单一模型可用）→ 降级标注「同模型抽查，置信降级」并明示
3. **产出明示**：日报锚点抽查段加「模型对照行」——抽查模型 X / 样本模型分布 / 同模型样本处置方式

checklist 第 9 项同步加模型对照行要求。prompt 纪律锁测试新增断言锁住本节关键词
（异体核对 / 必须不同模型 / model_alias / 置信降级 / 模型对照行），防后续模板编辑误删。

## 设计取舍

| 取舍 | 决策 | 理由 |
|---|---|---|
| 改派执行方式 | prompt 层规则（daily-review 执行獭自行改派小獭），不动调度器代码 | 最小实现阶梯：prompt 约束够用就不写代码；daily-review 本就有召唤能力 |
| 查不到模型的样本 | 跳过不计入，不强行核对 | 无法确定同源性的样本，核对了也无法声明置信度——跳过比假装可靠诚实 |
| 单模型可用时 | 降级标注而非阻断抽查 | 抽查降级价值仍大于不抽查；标注让「今日抽查置信度低」可见 |

## 机制识别检查点判定

不涉及净新增机制——抽查流程既有（#981），本次在既有流程内插入一个核对约束条件
（narrow-fix：既有语义内修），无新任务、无新调度、无新数据表。

## 验证

- prompt 纪律锁测试 4/4 通过（新增异体规则断言）
- 运行时副本同步：合入后需跑 `node scripts/update-scheduled-task-body.mjs --name "每日对话健康检查"`
  将模板同步至 DB（git 是真相源，DB 是运行时副本）
- issue #1000 验证标准：抽查段产出出现「本次抽查用模型 X，被抽查发言模型 Y」明示行；
  同模型情形有降级声明——待次日 daily-review 实际产出验证

## 负面向条目

无旧契约破坏：抽查段原 4 步语义全部保留（仅编号顺延），checklist 第 9 项是追加要求非替换。
