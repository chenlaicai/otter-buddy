---
id: F20260922mbit
title: 机制预算四问迭代项收口（#834）：术语精确化 + 措辞统一 + 承载格式示例
change_type: fix
status: implemented
created: 2026-09-22
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules:
  - .pi/skills/troubleshooting/SKILL.md
  - .pi/skills/requirement-analysis/SKILL.md
  - .pi/skills/adversarial-review/references/review-dimensions.md
intent:
  problem: '#834 检视发现的三个迭代项悬置两周：①「修法排序」标题词易被快速扫描者误读为优劣排序列表；②「加法自带全部未来」在 requirement-analysis 与 review-dimensions 两处措辞细微差异；③四问答案与「设计取舍」表格的承载张力无先例指引，首次执行的獭可能卡在格式'
  expected_effect: '术语改「修法决策树」消除优劣排序误读；两处括号短语字面统一；四问答案承载格式给出可抄先例（F20260907cmpx 自身「本特性自审」段）'
  verify_by:
    type: static_only
    note: 纯措辞订正（prompt 层），无行为变更；lint:skills 绿 + 存量引用兼容（旧称「修法排序」在引用处以「原称」过渡）锁定
summary: '#834 三个迭代项一次收口（docs-config 级微调）：①troubleshooting「修法排序」首次出现处改「修法决策树（原称「修法排序」）」——「排序」易被误读为优劣列表，实际是决策树（默认①，跳④须论证）；②review-dimensions §7 括号短语与 requirement-analysis 四问③统一为同一句话「加法自带全部未来：加 M 意味着同时接受它将要生成的问题类」；③requirement-analysis 四问列表末尾补答案承载格式指引（表格做索引 + 叙述逐条展开，先例 F20260907cmpx）。'
tags: [lint, skills, mechanism-budget, wording]
capability_test: "n/a: 纯措辞订正，lint:skills 门禁锁定"
from: [F20260907cmpx]
---

# F20260922mbit 机制预算四问迭代项收口（#834）

## 问题

#834（F20260907cmpx 首版落地后的检视发现 3/4/5）三个迭代项悬置两周：

1. **「修法排序」术语歧义**（发现 4）：troubleshooting 步骤 2 标题词「排序」可能被快速扫描者误读为优劣排序列表——实际语义是决策树（默认走①，跳④须写论证），不是「按优劣排一排」。
2. **「加法自带全部未来」措辞漂移**（发现 5）：requirement-analysis 四问③写全句「加法自带全部未来：加 M 意味着同时接受它将要生成的问题类」，review-dimensions §7 只写括号短语「加法自带全部未来」——语义等价但字面不一，检索/引用时产生「两处说法是否一致」的认知开销。
3. **四问答案承载格式无先例**（发现 3）：四问答案是叙述性的（尤其③④），与「设计取舍」四列表格存在承载张力；9/20 起已有多个特性文档实际走完判定（srbtn 等的「机制判定」段），但 requirement-analysis 未给出可抄的格式先例，首次执行者可能卡住。

## 修复

1. 「修法排序」→「修法决策树」全仓同步（r1 审视发现 2 纠正：原计划只改首次出现处，但同日新文档仍被旧映射表喂旧称，「自然收敛」预期不实——改为全仓收口）：troubleshooting/SKILL.md :41 改名+原称过渡注释、同文件 :43/:52/:54 同步；worktree-isolation/SKILL.md 映射表 5 行 + :49 声明行；code-implementation/SKILL.md :35；commit-convention.md 8 处。旧称仅在「原称」过渡注释中保留（3 处），历史特性文档不改。
2. review-dimensions.md:143 括号短语补全句，与 requirement-analysis 四问③字面一致。
3. requirement-analysis/SKILL.md 四问列表④后补 💡 承载格式指引一行（表格做索引 + 叙述逐条展开 + 先例指针）。

## 设计取舍

机制识别检查点逐项核对：无新增数据结构、无新触发链、无绕过既有保护、无并行机制——纯措辞订正（prompt 层文本变更），不涉净新增机制，docs-config 级。

取舍（r1 审视修正）：项 1 原计划只改首次出现处（理由：避免扩散到多文件），检视发现同文件 3 行残留是零文件成本未做、「自然收敛」预期不实（同日 6+ 篇新文档仍用旧称，worktree-isolation 映射表是喂给写作者的源头）——接受并改为全仓同步（跨文件旧称残留实测 15 处/3 文件，一次性收口；「原称」过渡注释保留 3 处供历史文档回溯）。

## 验证

- lint:skills 绿（14 skills，13 warnings 全存量，与 main 一致）
- lint-skills 测试 14/14 绿（E1c 门禁对本次改动无触发）
- 负面向：本次变更无旧契约破坏、无既有保护绕过——纯文本措辞订正
- 已过最简检查：三项均为单行级文本变更，无更简形态

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 大獭
