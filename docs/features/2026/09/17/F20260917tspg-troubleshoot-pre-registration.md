---
id: F20260917tspg
title: 排查预注册：troubleshooting 第一步冻结预期根因与放弃条件（防 HARKing）
doc_type: feature
summary: |
  「先收集数据再归纳」（#352）管住了「先推测后找数据」，但没管住另一半——看到数据后
  挑一个最好看的故事（HARKing）。排查类任务的根因结论没有事前对照物（issue #1001，
  R20260916rsis 碰撞地图起火点 C4）。本特性在 troubleshooting skill 工作流插入第 1 步
  「预注册」：动手前三行——预期根因方向 X / 验证标准 Y / 若证据指向 Z 则放弃原预期；
  形成结论段同步加「预期 vs 实际对照」。依据：Anthropic AAR mini-paper 预注册纪律。
  成本近乎零；写不出三行说明问题定义还太模糊，先澄清再动手。
change_type: prompt
capability_test: "n/a: 纯 skill 文本规则，golden 行为场景化价值低（预注册是写作纪律非工具轨迹），由 lint:skills + 日审消费"
created_in_conversation: 325ef7b7-8e42-4edc-9abf-eae8f332a2c4
intent:
  problem: "排查结论可以事后编故事（HARKing）——看到数据后挑最好看的解释，没有事前对照物可检验"
  expected_effect: "下一个排查任务的特性文档/汇报中出现预注册段（预期根因/验证标准/放弃条件三行）+ 预期 vs 实际对照"
  verify_by:
    type: human_judge
causal_links:
  from: ["R20260916rsis"]
  supersedes: []
tags: ["prompt", "skill", "troubleshooting", "pre-registration", "anti-harking"]
modules: [".pi/skills/troubleshooting/SKILL.md"]
---

# 排查预注册（#1001）

## 背景与需求

海獭已有「先收集数据再归纳结论」（#352 纪律，daily-health-check.md 分析纪律节），
管住了「先推测后找数据佐证」。但另一半没管住：**看到数据后挑一个最好看的故事**——
HARKing（Hypothesizing After Results are Known）。troubleshooting 的根因结论目前
没有事前对照物，排查者（含大獭）可以无意识地把结论修饰得比实际探索过程更「直达」。

业界依据：Anthropic AAR 的 mini-paper 预注册——在看到实验结果之前冻结预期、方法与
成功标准；R20260916rsis 碰撞地图 C4 将此列为起火点。

## 方案设计

troubleshooting skill 工作流改动（仅两处）：

1. **新第 1 步「预注册」**（原 1/2 顺延为 2/3）：动手前三行——
   预期根因方向 X（一句话可粗）/ 验证标准 Y（什么证据=预期成立）/
   若证据指向 Z 则放弃原预期（最强反例方向）。
   写不出三行 = 问题定义太模糊，先澄清再动手。
2. **形成结论段**（顺延为第 4 步）：结论结构加「预期 vs 实际对照」——
   命中/偏离/反转，偏离时一句话说明哪一步证据改变了方向。

## 设计取舍

| 取舍 | 决策 | 理由 |
|---|---|---|
| 预注册写哪 | 排查结论开头（特性文档/汇报均带），不单建表 | 最小实现：依附既有产出物，零新存储 |
| 强制程度 | skill 步骤级（软约束），不进 lint 硬拦 | 与「修法排序」「机制识别检查点」同形态；三行成本近乎零，靠执行文化而非机械闸 |
| 放弃条件 Z 必填 | 是（三行缺一不合规） | 没有放弃条件的预期不是预注册，是许愿 |

## 机制识别检查点判定

不涉及净新增机制——既有 skill 工作流内插入一个写作步骤（narrow-fix），
无新存储/新任务/新信号/新分支。

## 验证

- lint:skills OK（14 skills 无新警告）
- issue #1001 验证标准：下一个排查任务的特性文档/汇报中出现预注册段；
  长期累积可统计排查命中率（能力度量素材）——待下一个真实排查任务验证

## 负面向条目

无旧契约破坏：原 5 步语义全部保留（编号顺延），产出表不变。
