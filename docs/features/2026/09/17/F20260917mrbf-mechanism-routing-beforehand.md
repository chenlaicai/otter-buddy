---
id: F20260917mrbf
title: 四问事前化 + 防锚定硬化 + 虚构承诺清除（全局审视整改 PR-B）
summary: |
  全局审视整改第二刀（PR-A=F20260917pagd 锚点 gate 已合入）。四问机制第四次修复的差异化：
  前三轮修「有没有信号/谁来答」，本轮修「什么时候想起」——机制识别判定从 code-implementation
  步骤 7（文档，实现后）上提到步骤 3（预检查，动手前），issue 驱动特性的四问与方案同步成形
  而非补作业。配套：删 3 处「每日验证」虚构承诺（消费者不存在）；writing-skills 5b 补
  「编号不进教训段」显式条款（拔示例教编号的根——示例已于 PR-A 去编号化）；A1 补域边界
  （管对话层不管文件写入）；防锚定规则硬化（载体扩到 systemPrompt+机械化顺序+作者对称义务——
  搭档指出「作者给关注点本身需要被审视」，实证：本对话砺锋三世被锚定但自省兜住）。
change_type: prompt
capability_test: "n/a: skill/SYSTEM.md 文本修订（verify_by=human_judge）；效果观察指标见文档验证节（35-60 天 grep 可测，既有节点消费）"
created_in_conversation: 0cb63991-375d-4c5d-89b6-137aa5afd202
created_at: 2026-09-17
intent:
  problem: "四问判定明文规定在实现后的文档步骤（步骤 7），issue 驱动特性全程无信号直到补作业时刻——「事前用好四问」在流程文本层面不成立；3 处「每日清单/回看验证」承诺指向不存在的消费者；5b 示例曾带编号形成事实教学；A1 域混淆给编号写入提供合规背书；作者焦点建议经 systemPrompt 通道锚定检视獭无规则防御"
  expected_effect: "机制判定在动手前完成（步骤 3 预检查）；虚构承诺清零；教训段写入不再反射性附编号；检视獭对任何载体的作者焦点输入走机械化防锚定顺序"
  verify_by:
    type: human_judge
modules:
  - .pi/skills/code-implementation/SKILL.md
  - .pi/skills/requirement-analysis/SKILL.md
  - .pi/skills/worktree-isolation/SKILL.md
  - .pi/skills/adversarial-review/SKILL.md
  - .pi/skills/writing-skills/SKILL.md
  - .pi/skills/code-implementation/references/commit-convention.md
  - .pi/SYSTEM.md
tags: [prompt, mechanism-budget, anti-anchoring, skill]
---

# 四问事前化 + 防锚定硬化 + 虚构承诺清除

## 背景

搭档 9/17 两连问：①「四问核心是事前用好，只加事后兜底是本末倒置」②「作者给关注点本身需要被审视，很可能关注点就是错的」。核实四问三次修复史（cmpx→fqgp→mbsr）后确认：mbsr 补接了信号路径但没修信号时间点——判定明文规定在步骤 7（文档步骤）= 实现之后。

## 改动

| 位置 | 改动 |
|---|---|
| code-implementation 步骤 3 | 机制识别判定前置（动手前答四问，答案与方案同步成形）；附「为什么前置」说理 |
| code-implementation 步骤 7 | 原下沉段改为核对指针（防双写漂移） |
| requirement-analysis:46 | 删「供每日清单验证」虚构承诺 → 改指对抗审视核对（真实消费者） |
| worktree-isolation:57 | 删「每日全局回看会验证」→ 改指对抗审视核对 |
| commit-convention:28 | 同上 |
| writing-skills 5b | 补「编号不进教训段正文」条款（三要素不含编号；A1 管对话层不管文件写入；lint gate 兜底） |
| SYSTEM.md A1 | 补域边界段（对话层断言 vs 文件写入） |
| adversarial-review 步骤 2 | 防锚定硬化：载体扩到 systemPrompt/口头 + 机械化三步顺序（先独立→再比对→披露锚定感）+ 作者侧对称义务（给焦点必须标盲区声明） |

## 机制预算四问（本特性自审）

本特性不新增机制（修改既有流程文本+删虚构承诺），识别检查点 7 项全未命中——但防锚定的「机械化顺序」新增了一个软约束流程，按偏严原则补答：
①谁需要：检视獭（从软措辞变可执行顺序）；搭档（审视报告可信度上升）
②失败后果：顺序不执行=退回现状（软措辞时代），无新增损害；③后续机制：无新状态；④退役：若披露段连续沦为套话（「无锚定感」模板化），删披露要求保顺序

## 验证

- lint:skills 0 error ✅；lint-prompt-anchors --full 0 命中 ✅
- 观察指标（35-60 天，grep 机械可测，消费走既有节点不新增机制）：①issue 驱动特性文档中机制判定覆盖率 ②判定段相对位置（「设计取舍」前半=事前形态）
- 观察基线声明：mbsr 后首批健康样本（2 天窗口，未排除自指与新鲜度），本特性不声称已证明有效
- Golden Gate: n/a（verify_by=human_judge，无场景可跑）

## 对抗审视记录

（待填）
