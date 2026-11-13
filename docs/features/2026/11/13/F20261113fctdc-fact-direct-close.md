---
id: F20261113fctdc
title: 待办闭环口径分类前置：fact 直关指引（closure_kind 缺省 decision 的提示词侧修复）
doc_type: feature
summary: |
  在大獭身份提示词「待办裁决纪律」后增补「闭环口径分类前置」纪律：结论机器可验证的待办
  一律 fact 自行闭环不呈搭档，批量处置总结按 fact 收口不走审批门——修 closure_kind 缺省
  decision 导致的反复打扰搭档问题。
change_type: prompt
tags: [matter, closure-kind, prompt-discipline, attention]
modules:
  - prompts/identity/BIG_OTTER.md
capability_test: "n/a: 纯纪律规则静态增补——fact 直关行为依赖板上已有存量 matter，fresh 会话无触发面，无可独立运行的生成式场景"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: 2026-11-13
intent:
  problem: "大獭对「结论已机器可验证」的待办反复要求搭档确认闭环：matter 闭环口径 closure_kind 缺省 decision，把 fact 型事项锁死在「必须搭档确认」；提示词既没有要求呈拍板前先做闭环口径分类，也没有区分「总结报告」与「审批门」，导致批量处置总结被当成新决策二次打扰搭档。"
  expected_effect: "大獭闭环一件事前先判结论是否机器可验证（PR MERGED/CLOSED、issue 创建、清理完成、commit/文件存在等）：是则 transition_matter(closure_kind='fact', resolution=机器证据) 自行闭环；批量处置总结按 fact 收口，不再重复走审批门请求确认。"
  verify_by:
    type: static_only
---

# F20261113fctdc：待办闭环口径分类前置（fact 直关）

## 背景

大獭对「结论已完全确定、机器可验证」的待办，反复要求搭档确认闭环，占用搭档注意力。最典型的
一次：12 个 PR 批处置（7 MERGED / 3 CLOSED / 2 draft 有主不动），每个 PR 合入/关闭本已单独授权，
「12 个全部处置完」这个**总结事实**却又被当成 L2 决策挂了待确认，催了搭档两轮。搭档反馈（原话）：
「代办这个你自行评估啊、为啥要我来确认啊，你不都梳理清楚了吗……明明各项代办都有结论了、你还非得
让我确认！」——且此问题不止一次出现。

## 根因

matter 闭环口径分两型：**fact**（结论机器可验证，owner 可携机器证据直接闭环）与
**decision**（缺省值，需搭档确认）。三条叠加：

1. **直接根因**：`register_matter` / yield 打标登记不写 closure_kind → 全部落到 decision 缺省，
   迁移守卫「decision 型必须搭档确认」把本可 fact 直关的事项锁死在待确认态。
2. **触发根因**：提示词没有任何一条要求「呈拍板之前先做闭环口径分类」，我默认按 decision 走。
3. **规则缺陷**：提示词「待办裁决纪律」只讲了「识别搭档回复的裁决 + 代执行迁移」，没讲 owner
   自己何时该直接 fact 闭环；且把「PR 合入需单独授权」的审批门错误泛化到「处置完毕的总结报告」。

**结论：提示词缺失 + 缺省值偏向确认，不是「必须确认」的正确语义。**

## 修复

在 `prompts/identity/BIG_OTTER.md`「待办裁决纪律」与「呈搭档拍板的硬规则」之间增补
「闭环口径分类前置（fact 直关，先于一切确认请求）」一节：

- **闭环口径分类前置**：闭环一件事前先判「结论是否机器可验证」——PR MERGED/CLOSED、issue 创建、
  分支/文件/工作区清理完成、commit 或文件存在、脚本跑通，都算机器事实。
- **机器可验证 → 自行 fact 闭环，不呈搭档**：`transition_matter(closure_kind='fact',
  resolution=机器证据)`（登记时也可 `register_matter(closure_kind='fact')`）。机器证据必带
  #PR号 或 commit sha（「merged」关键词单独不算）。
- **总结≠审批**：批量处置时每个动作已单独授权，「处置完毕」的总结是事实报告，按 fact 闭环，
  不重复走审批门。
- **只有结论依赖搭档判断**（产品方向/资源投入/对外承诺/验收口径）才走 decision 呈拍板。
- **对不上机器可验证标准又拿不准的**，宁可 decision 呈拍板——fact 直关省的是搭档注意力，
  不是省掉该有的方向拍板。

机制侧不改动：closure_kind 缺省仍为 decision（安全默认），只补提示词纪律，不做自动推断。

## 验证

- `npm run lint:prompt-anchors`：注入面文件无 F 编号/issue 号锚点（staged 模式通过）。
- `npm run lint:prompt-size`：9 个模板 0 超预算。
- 文本存在性：`grep "闭环口径分类前置" prompts/identity/BIG_OTTER.md` 命中。
- 完整 `npm run check` 见 PR（md 改动不触 build，跑全量确认无副作用）。

## Rollback

`git revert` 本 PR 即回滚：仅增补一段提示词纪律，无代码路径变更；回退后行为恢复为
「待办一律按 decision 缺省走确认」。

## 到期回查

2026-12-11 起观察：matter 板上不再出现「结论已机器可验证却挂 WAITING_PARTNER 等搭档确认」
的 fact 型事项；搭档侧「又让我确认」类反馈不再复现。
