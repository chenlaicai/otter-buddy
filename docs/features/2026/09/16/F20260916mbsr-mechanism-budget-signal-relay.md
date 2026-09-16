---
id: F20260916mbsr
doc_type: feature
change_type: prompt
capability_test: "n/a: 纯 skill 提示词文本修订（3 处指向句），无代码路径；行为变化对象是 LLM 执行者，验证由每日补丁清单回看机制（欠账率观察）承担，lint:skills 已过"
title: "机制预算信号接力：四问触发器从上游 skill 补接到实现路径"
summary: "9/15 四问欠账根因排查（troubleshooting）结论：触发器（机制识别检查点）只写在 RA/troubleshooting 两个上游 skill，issue 驱动直接进 code-implementation 的特性全程接触不到四问义务——非拒绝执行，是信号未送达。修复为 3 处 prompt 文本补接：commit-convention 的 mechanism-addition/narrow-fix 条目补承诺与论证指向，code-implementation 步骤 7 补机制判定下沉段。零新闸门、零强制升级，软硬分级维持 cmpx 原设计。"
feature_id: F20260916mbsr
created_in_conversation: a344e752-8e89-469a-ad04-5a5108867fa0
created_at: 2026-09-16
intent:
  problem: "机制预算四问触发器只写在 RA/troubleshooting 上游 skill，issue 驱动直接实现的特性（9/15 实证 rptx/dabm/iext/cnms 四单）全程接触不到四问义务，适用场景下也未触发执行"
  expected_effect: "实现路径 skill（commit-convention + code-implementation 步骤 7）携带四问触发信号后，issue 驱动特性的检查点判定率上升，每日清单四问欠账条目趋零"
  verify_by:
    type: behavior_check
modules:
  - skills
tags:
  - mechanism-budget
  - prompt
  - signal-relay
  - skill-text
from:
  - F20260907cmpx
  - F20260908pgrd
---

## 背景

搭档 2026-09-16 原话（意图锚）：

> 「我觉得不对，你不能说 海獭们实际不执行，所以你就要把 可选行为 强制上升到 必须行为，这个因果关系不成立。这个四问本来就是有适用范围的，你要做的，应该是深入分析，当前的系统提示词/skill是否描述不恰当而导致海獭即使在 适用场景 也不触发执行」

> 「ok，你开工，你看，要基于真实证据来分析，不要自己瞎猜」

前序：9/16 每日补丁清单（Day8）发现 9/15 多单四问欠账，初版修复方案（commit-time 机械闸 + 检视升硬）被搭档否决，按指正重做基于证据的根因分析。

## 根因（troubleshooting 结论，证据驱动）

9/15 欠账单逐单取证（commit 声明 × 特性文档 grep）：

| PR | commit 声明 | 特性文档 | 性质 |
|---|---|---|---|
| rptx / dabm / iext / cnms | mechanism-addition | 零检查点零四问 | **真欠账 ×4** |
| desc | narrow-fix | 有设计取舍节，但全文零检查点/四问 | 更可能是检查点未触发（扩展已有表的灰色地带，检视-968 独立核实修正），非「触发后漏论证」 |
| n84u / ushm / rgte | 无声明 | 零检查点 | commit-convention 亦被跳过 |
| cfgt（对照组） | mechanism-addition | 检查点逐项 + 四问 + 重对抗门 | 全链执行 ✅ |

关键对照：cfgt 与 4 个欠账户**同一作者（大獭）、同一天、同一份 skill 文本**——唯一差别是 cfgt 走了完整 RA 流程（有方案审视），欠账户全是 issue 驱动直接进 code-implementation。

**根因**：四问触发器（机制识别检查点）只写在 RA/troubleshooting 两个上游 skill；实现路径（code-implementation / worktree-isolation / commit-convention）grep 零命中。义务链从起点断开——执行者到 commit 时照 commit-convention:25 抄分类标签，不知道自己欠四问。**不是适用场景下拒绝执行，是信号未送达实现路径**（非「可选/必须」问题，软硬分级不动）。

修法排序：①既有机制语义内修——补信号接力，不改四问机制语义、不新增机制。**Modification-Class: narrow-fix**。

## 改动（3 处 prompt 文本）

1. **commit-convention.md** `mechanism-addition` 条目：补「声明此类 = 承诺特性文档『设计取舍』段已含检查点判定+四问；没判过先补再提交」——唯一定期被读到的文本（commit 模板）把信号接力到终点
2. **commit-convention.md** `narrow-fix` 条目：补「检查点命中仍判①②③须写一句论证」指向（覆盖「检查点命中判①②③须写论证」与「灰色地带未触发检查点」两类缺口——后者正是 desc 实况，指向句让执行者先过检查点再分类，两类都被接住）
3. **code-implementation SKILL.md 步骤 7**：补「机制判定下沉」段——未经 RA 的特性，文档「设计取舍」段必须含检查点判定（命中 → 四问当场作答）

## 不做什么

- adversarial-review:69 维持「软维度」——cmpx 原始设计先软后硬，信号链修好后由每日清单观察欠账率再评估升级
- 存量欠账（rptx/dabm/iext/cnms）不补评论（搭档裁决：没人看）
- 零脚本、零 commit-time 新闸（初版方案已被否决）

## 验证

- `npm run lint:skills` OK（13 warnings 全存量）
- 效果验证：每日补丁清单回看继续统计四问欠账条目，预期趋零——若欠账率不降，说明信号仍断，届时再评估硬化（先软后硬路径与 cmpx 一致）

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| .pi/skills/code-implementation/references/commit-convention.md | M | mechanism-addition / narrow-fix 两条目补指向 |
| .pi/skills/code-implementation/SKILL.md | M | 步骤 7 补机制判定下沉段 |
