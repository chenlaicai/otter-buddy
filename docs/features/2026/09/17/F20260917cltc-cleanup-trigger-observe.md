---
id: F20260917cltc
title: post-merge-cleanup 触发条件扩写：搭档口令 → 观察到合入即触发
doc_type: feature

summary: |
  9/17 分支/worktree 盘点发现 23 个僵尸分支 + 9 个僵尸 worktree + 4 个远程残骸。
  根因：post-merge-cleanup skill 的触发条件只有「搭档说已合入」等口令，
  但搭档经常在 GitHub 上直接点 merge 不通知，skill 永不触发（「前提不死」活例证）。
  本特性将触发条件扩写为事件驱动：观察到合入即触发（gh 返回 MERGED /
  fetch --prune 后远程分支消失 / 开新 worktree 前碰到僵尸），搭档口令路径保留。
  设计原则：出口焊在入口旁边，不需要定时巡检兜底（搭档 9/17 否决了定时巡检方案）。

causal_links:
  from:
    - F20260908pgrd   # 补丁抵抗双层机制（本特性的「前提不死」诊断框架来源）

change_type: prompt
tags: [skills, post-merge-cleanup, worktree, event-driven, cleanup]
modules:
  - .pi/skills/post-merge-cleanup/SKILL.md
capability_test: "n/a: skill 触发条件措辞变更；效果由后续 PR 合入后是否再出现僵尸分支/worktree 验证"
intent:
  problem: "post-merge-cleanup 触发条件仅覆盖搭档口令，搭档在 GitHub 静默合入时机制永不触发，僵尸分支/worktree 持续堆积（9/2-9/17 实证 23+9 个）"
  expected_effect: "任何獭在 git/gh 操作中观察到合入事件即触发清理，不再依赖搭档开口；远程侧由 GitHub delete_branch_on_merge（已开启）自动覆盖"
  verify_by:
    type: behavior_check
    reason: "观察未来 2-4 周是否再出现「PR 已合入但本地分支/worktree 残留超过 48h」的 case；每日补丁清单的负空间信号可辅助观测"
created_in_conversation: a344e752-8e89-469a-ad04-5a5108867fa0
---

# post-merge-cleanup 触发条件扩写

## 背景与问题

2026-09-17 搭档提出盘点诉求：「本地和 GitHub 上的分支、worktree 都是多少，
分析看看咱们海獭系统是否在系统性做事」。

盘点结果（全部逐条经 `git cherry` / `gh pr` 状态核验）：

| 维度 | 总数 | 健康 | 僵尸 |
|---|---|---|---|
| 本地分支 | 29 | 4 | 23 |
| worktree | 14 | 4 | 9（+1 个 sched-task-description 后确认为 squash 误报） |
| 远程分支 | 11（除 main） | 3 | 8 |

**结论：开工侧纪律 100%（worktree 隔离、PR-only 无例外），断链在出口侧。**

## 根因

post-merge-cleanup skill 的触发条件是搭档口令（"已合入"/"合了"/"收拾一下"）。
但搭档经常在 GitHub 网页直接点 merge、不回对话通知——skill 永不触发，僵尸持续堆积。

这是「前提不死」的同构问题：机制存在，但触发依赖人肉，人不在场就失效。

## 方案

触发条件从「搭档口令」扩为「事件驱动 + 搭档口令」双通道：

1. **观察到合入即触发**（新增，主通道）：
   - `gh pr view/list` 显示自己负责的 PR 已 MERGED → 当场清理该 PR 的 worktree+分支
   - `git fetch --prune` 后远程分支消失（GitHub 自动删分支）且本地残留 → 顺手清理
   - 开新 worktree 前例行检查碰到僵尸 → 顺手清理
2. **搭档口令**（保留，原路径不变）

远程侧根治：GitHub `delete_branch_on_merge` 开关已确认开启（9/17 经 `gh api` 核实），
合入瞬间自动删远程分支，零机制零维护。

**明确否决项**：每日定时巡检扫描僵尸——搭档 9/17 否决：「不要每日巡检，
这件事不值得占用一个定时任务。只要做好了，本来就不需要定时任务来兜底」。

## 机制预算四问

① **谁需要**：系统自身——僵尸分支/worktree 堆积污染 `git branch` / `git worktree list`
   的信噪比，且误导后续盘点类判断
② **失败后果**：不做 = 僵尸继续堆积（已实证）；做了失败 = 触发面变宽多跑几次清理，
   无新伤害（清理动作本身有 git cherry / PR 状态核验兜底）
③ **后续机制**：无——复用既有清理流程，仅扩触发条件；远程侧 GitHub 原生开关已就位
④ **退役条件**：若「观察到合入」误触发清理未合入分支（核验失灵），回退措辞

## 对抗审视记录

- 2026-09-17 搭档口头挑战：「就一个 skill 更新，不写特性文档的理由是什么」
  → **挑战成立**。自查确认违规：B2（特性文档缺失 = 严重发现，无论变更类型）+
  B6（skill 层变更需 intent 块）。本文档为补交。
  **教训记录**：执行獭自行判断「改动小可豁免」正是 F20260908pgrd 要抵抗的模式——
  大獭本人 9/16 刚修完「海獭不执行四问」（PR #968），9/17 即在相邻义务上犯同构错误。
  规范的豁免权不在执行者，在明文条款。
- 2026-09-17 搭档二次挑战：「你好像没找过检视獭」→ **成立**。补文档后直接呈终审，
  跳过对抗审视环节。检视-1019（mimo，异模型）补位审视：0 严重 + 3 建议。
- 检视-1019 建议处置（全部接受，当场修）：
  1. 「事件驱动」措辞 → 限定为「机会性被动触发」，并显式写明本地侧无 webhook/hook、
     可靠性来自 git 操作频率而非机制自动性；GitHub delete_branch_on_merge 才是事件驱动
  2. description 补第三触发点「开新 worktree 前发现僵尸分支」
     （LLM 仅读 description 场景不漏场景）
  3. 「顺手清理」→「当场按本 skill 工作流清理（完整流程，非轻量顺手动作）」——
     清理是 11 步流程，措辞不得暗示轻量

Modification-Class: docs-config
