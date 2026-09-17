---
id: F20260917lssc
title: 教训沉淀验收条：每条教训必须含「不这么做的现场」三要素
doc_type: feature
summary: |
  教训沉淀质量不齐（完整因果链 64.8% 形态 vs 仅结论 3.8% 形态，EPD 对照）却无验收标准
  （issue #1003，R20260916rsis C5）。本特性：writing-skills 加 5b 验收条——新增/修订教训段
  必须含「不这么做的现场」三要素（错误现象/后果/定位过程），无现场 = 半成品审视打回；
  存量基线 23 处提及仅 6 处含现场（26%），不回改管新增。检视后扩充（PR #1023）：
  ①5b 补判定示例与触达说明；②review-dimensions.md 加教训段三要素核查项（执行闸）；
  ③修正 B7 口径——static_only/human_judge 豁免跑 gate 但须 PR 写豁免声明。
change_type: prompt
capability_test: "n/a: 写作验收规则（审视时人/獭判定），无工具轨迹可自动断言；存量基线已用脚本抽查记入本文档"
created_in_conversation: 325ef7b7-8e42-4edc-9abf-eae8f332a2c4
intent:
  problem: "教训沉淀只有结论没有现场（3.8% 形态），后来的獭读到规则却不知为何存在，违反时无体感、绕过时不自知"
  expected_effect: "新增/修订教训段 100% 含现场三要素（现象/后果/定位过程）；审视时无现场的教训段被打回"
  verify_by:
    type: human_judge
causal_links:
  from: ["R20260916rsis"]
  supersedes: []
tags: ["prompt", "skill", "lesson-distillation", "writing-skills", "epd"]
modules: [".pi/skills/writing-skills/SKILL.md", ".pi/skills/adversarial-review/references/review-dimensions.md", ".pi/skills/adversarial-review/SKILL.md", ".pi/skills/code-implementation/SKILL.md"]
---

# 教训沉淀验收条（#1003）

## 背景与需求

教训段是海獭系统的「经验蒸馏」产物——但蒸馏质量不齐。字节 EPD 实测给了量化对照：
直接把经验轨迹 SFT 只保住 3.8% 收益，让无经验学生拟合有经验教师的单步决策保住 64.8%。
映射到文本沉淀：**写清「不这么做的现场」（当时怎么错的、后果是什么、怎么定位到的）的教训
是 64.8% 形态；只写结论的是 3.8% 形态。**此前没有验收标准区分两者。

正范本：code-implementation 的「废弃资源清理（#791 教训）」段——错查孤儿库 otter.db（现象）
→ 「零事件」假象误导核查、错误数据险胜搭档正确记忆（后果）→ 残留 6 天才发现（定位过程）。

## 存量基线（issue 验证标准要求）

脚本抽查 .pi/skills/、prompts/scheduled/、SYSTEM.md 共 23 处「#xxx 教训/现场」提及：
含现场要素 6 处（26%），仅结论形态 17 处（74%）。粗判口径：同行内同时含现象词
（错/误/bug/失败/残留/假象）与后果词（导致/差点/误导/返工/险）。
注意：部分「仅结论」行的完整现场在同段后续行内（多行段落），基线偏保守——真实完整率高于 26%，
但「结论先行、现场在后」的结构仍不利于快速阅读，新增段按三要素就近书写。

## 方案设计

writing-skills skill 工作流加 5b 节（长度预算之后）：

5b 节全文含验收条 + 判定示例（过/不过/流水账≠现场/多行分布规则）+ 触达说明（写法真相源
在 writing-skills，执行闸在 adversarial-review review-dimensions.md 的教训段三要素核查项）——
检视发现（PR #1023）单一落点触达不到 SYSTEM.md/prompts 的教训段写作者，审视侧核查项是兜底。
另修正 Golden Gate B7 口径矛盾（检视严重发现 1）：verify_by 为 static_only/human_judge 时
生产方豁免跑 gate（code-implementation Golden Gate 节），但必须将豁免声明写入 PR Verification 节，
B7 核验「无记录且无豁免声明 = 严重」（adversarial-review SKILL.md 同步）。

## 设计取舍

| 取舍 | 决策 | 理由 |
|---|---|---|
| 落点 | writing-skills（skill 写法的元规范），非每个 skill 各写一遍 | 单一真相源；教训段的写入场景大多经过 skill/prompt 的编辑动作 |
| 存量处理 | 不回改，只管新增/修订 | 回改 17 处成本高收益低；教训段在被触发阅读时若显半成品可顺手补现场 |
| 强制程度 | 审视打回（软），不进 lint | 三要素是语义判断，正则锁不住「现场是否真的写清了」——与锚点抽查同定位（LLM+人软强制） |

## 机制识别检查点判定

不涉及净新增机制——writing-skills 工作流内加一条验收约定（narrow-fix），无新存储/任务/信号。

## 验证

- 存量基线已抽查（26%，记入上文）——issue 验证标准①达成
- 标准②「新增教训 100% 含现场」待下一个新增教训段的 PR 由检视執行打回权验证
- lint:skills / lint:docs / lint:intent 全过

## 负面向条目

无旧契约破坏：writing-skills 原 7 步不变（5b 为插入子节），产出表不变。
