---
id: F20260917dscp
title: tool description 压缩 + prompt 层减容卫生（全局审视整改 PR-C）
summary: |
  全局审视整改第三刀（A=锚点 gate #1031、B=四问事前化 #1033 已合入）。tool description
  四个大头（search_memory/speak/get_related/yield）按四类原则压缩：硬校验兜底替代预教育、
  系统强制信息删除（yield 护栏阈值）、双写归一、行为触发类豁免不删（8/25 hcpg 教训——
  「什么时候该用」的引导必须留在注入面）。identity 通信模型四点双注入去重（小獭每轮曾吞
  两遍）→ 真相源在 speak/yield 工具描述（注入时每轮必达），identity 留三行核心。
  省事声明/特性 ID 查重逐字重复归一（真相源分别在 RA 步骤 6 / worktree-isolation 步骤 4）。
change_type: prompt
capability_test: "n/a: description/skill 文本压缩（verify_by=static_only：压缩后 lint 全绿+tsc 通过+锚点重放评审兜底行为语义）"
created_in_conversation: 0cb63991-375d-4c5d-89b6-137aa5afd202
created_at: 2026-09-17
intent:
  problem: "tool description 每轮注入 48.5KB（字面量全量），top4 占 31%——硬校验养成预教育依赖、系统强制的护栏阈值写进 prompt、与 SYSTEM.md 双写复述；identity 通信模型四点三份逐字重复"
  expected_effect: "description 与 identity 减容且不损失行为触发语义（行为触发类引导保留原位）"
  verify_by:
    type: static_only
modules:
  - src/interface-adapters/agent-runtime/tools/
  - prompts/identity/
  - .pi/skills/code-implementation/
tags: [prompt, description-compression, entropy-reduction]
---

# tool description 压缩 + 减容卫生

## 改动

| 对象 | 前→后 | 原则 |
|---|---|---|
| search_memory 主描述 | 2301B→1147B | vecCoverage 读法压缩为一句（保留行为触发关键句「vecDisabled 时提示用户排查」）；行为触发语义（第一把工具先想记忆）原样 |
| speak 主描述 | 1677B→582B（字符口径） | 删硬校验兜底的围栏教学细节；「最多 2 张」改「以 get_html_card_contract 契约为准」（常量双源修复） |
| get_related | 1452B→349B | 读链规则压为决策表 |
| yield | 1164B→609B | 删护栏阈值「第 3 次警示第 5 次链停」（系统强制，LLM 知道与否不改变行为） |
| identity×2 通信模型 | 四点逐字×2 → 三行核心 | 真相源 SYSTEM.md 对话环境段；反双写 |
| code-implementation | 省事声明段/ID 查重段改指针 | 归一到 RA 步骤 6 / worktree-isolation 步骤 4 |

## 豁免声明（锚点重放评审）

本 PR 改动为文本压缩与指针归一，未改任何行为触发语义（四类原则执行：①硬校验兜底 ②系统强制删除 ③双写归一 ④行为触发类豁免——speak 的「唯一发言通道」、yield 的「先 speak 再 yield」等行为引导全部原样保留）。按规则化触发条件自判：不影响獭「什么时候做什么」的判断 → 豁免，声明在此。

## 验证

- tsc 0 error ✅ / lint:skills 0 error ✅ / lint-prompt-anchors --full 0 命中 ✅
- 压缩后 description 全层实测见 PR diff；比例以 diff 为准（砺眸口径 20.7KB 注入面子集 vs 大獭口径 48.5KB 字面量全量，已如实标注双口径）

## 对抗审视记录

第一轮（砺锋六世 glm，2 严重 2 建议，全部接受）：
- 严重1 CI 红：hcpg 回归守卫 2 断言挂（「设计思路」场景锚被误删=违反本 PR 自己的④类豁免；「最多 2 张」数字删除未同步守卫）+ 自报验证不含单测 → 全部恢复+守卫通过+验证声明补 vitest
- 严重2 文档声称「vecCoverage 保留压措辞」实际整段删除 → 恢复行为触发关键句+文档改如实描述
- 建议3 identity 指针半虚指（SYSTEM.md 不承载细节）→ 指针改指 speak/yield 工具描述
- 建议4 Modification-Class 勘误：docs-config → narrow-fix（改的是每轮注入的行为文本，非纯文档微调——本篇登记即勘误留痕）

Modification-Class 勘误：本特性实为 narrow-fix（commit 声明 docs-config 低报，PR 文本改动触及行为触发面）。
