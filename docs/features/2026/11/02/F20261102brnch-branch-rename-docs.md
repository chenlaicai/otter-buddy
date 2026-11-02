---
id: F20261102brnch
title: 分支改名流程文档化——三步顺序 + 删分支预检（#1455）
change_type: prompt
created: 2026-11-02
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules:
  - .pi/skills/worktree-isolation/SKILL.md
  - .pi/skills/post-merge-cleanup/SKILL.md
summary: "#1455：PR #1446 事故沉淀——「删旧分支+新建同内容分支」式改名会让 GitHub 自动 close 以旧分支为 head 的 open PR 且不可 reopen（平台拒绝分支重建后的 state 变更）。本次把正确流程文档化：①worktree-isolation 步骤 5 补「分支改名」小节（禁止删旧建新；正确顺序 = push 新名 → 新分支开新 PR 承接审查链 + 旧 PR 留指路 → 确认新 PR 正常后删旧分支）；②post-merge-cleanup 步骤 5 删远程分支前补 open PR head 预检。核验事实：gh pr edit 无 --head 参数，GitHub 平台层 PR head 不可变，issue 原方案的「切 PR 头」步骤不存在，落地口径以 plan B 为准。"
tags: [process, skill, git, branch-management]
intent:
  problem: "分支改名用「删旧+新建」方式会让 open PR 被平台自动 close 且不可恢复，该事故流程教训此前只存在于 issue 正文，未沉淀进操作面 skill，下次改名仍可能重踩"
  expected_effect: "獭在需要给已推送分支改名时，按 skill 三步顺序执行（push 新名→新 PR 承接+旧 PR 指路→确认后删旧），不再出现删旧分支先于审查链迁移的操作"
  verify_by:
    type: human_judge
capability_test: "n/a: 流程知识文档化，无 LLM 行为回归场景可跑 golden（锚点重放评审已跑，见 PR Verification）。verify_by 从 behavior_check 改为 human_judge 的理由：软代码四选一（capability_test / golden_replay / human_judge / static_only，F20260825evgl）不含 behavior_check，人工语义类验证里 human_judge 是标准形态，B7 豁免链闭合；behavior_check 属 lint 六值合法但游离在软代码四选一外的断环根因见 PR 审视 r1 发现 4。"
---

# 分支改名流程文档化（#1455）

## 问题

2026-10-13 特性改名手术（F20261012orcl → F20261013crit）中，用「删旧分支 + 新建同内容分支」给已推送分支改名：

1. 删旧分支瞬间（03:27:05Z），GitHub 自动 close 了以它为 head 的 PR #1446（承载 6 轮审查链）
2. 新分支重建后尝试 reopen，REST API 明确拒绝：`state cannot be changed. The branch was force-pushed or recreated`——不可恢复
3. 损失：1 个 PR + 6 轮审查链迁移成本（plan B 开 #1452 承接，多花一轮修复 delta + 终审流程）

事故复盘只存在于 issue #1455 正文，操作面 skill（worktree-isolation / post-merge-cleanup）无对应约束——下次需要分支改名时，执行者仍然只有「删旧建新」这个直觉路径。

## 方案

**issue 原方案的「切 PR 头」步骤不可行**（开工前实测核验）：`gh pr edit --help` 无 `--head` 参数；GitHub REST API `PATCH /pulls/{id}` 对 head 字段不可变（跨 fork 改 base 有专门接口，同仓改名无路径）。issue 自身已预留 plan B 口径，本次落地以 plan B 为主路径。

### 改动一：worktree-isolation 步骤 5 补「分支改名」小节

- **禁止**：「删旧分支 + 新建同内容分支」式改名（head 消失 → PR 自动 close + 重建后不可 reopen）
- **正确顺序三步**：
  1. 先 push 新名分支（同内容）
  2. 新分支开新 PR，body 承接旧 PR 审查链与讨论摘要，旧 PR 留评论指路
  3. 确认新 PR 绑定正常（commits 齐全、CI 已触发）后，最后才删旧分支——此时旧 PR 因 head 消失自动 close 是预期行为，链已迁移无损失
- **边界说明**：旧 PR 的评论不会因 close 消失；迁移的是「活跃审查状态」不是历史记录

### 改动二：post-merge-cleanup 步骤 5 删远程分支前补预检

- `gh pr list --head <branch> --state open` 确认无 open PR 以该分支为 head，有则停手报告
- 预检拦的是「顺手删了别人活跃 PR 的 head」；本流程清理的合入 PR 自身已 MERGED 不受影响

## 设计取舍

- **机制识别检查点判定：零命中**——无新增代码机制/hook/lint，纯流程知识文档化（skill 文本）。Modification-Class 声明：`docs-config`。
- **不写 lint 守卫**：分支改名是低频操作（首次实证触发即本事故），机械闸维护成本 > 收益；skill 文本约束 + 事故案例的威慑力足够。若未来改名操作频次上升可再议。
- **「切 PR 头」写死为不存在**：防止后续执行者再去 GitHub 文档里找「改 head」路径浪费时间——平台层不可变是实测结论（gh CLI + REST API 双重核验）。

## 验证

- [x] 两处 SKILL.md 补丁落位，grep 确认关键词（分支改名 / 删前预检）可检索
- [x] lint-prompt-anchors 闸：补丁文本零 F 编号 / issue 编号（事故日期「2026-10-13」非锚点形态，合规）
- [x] 锚点重放评审（软代码改动必跑）：8/8 锚点 YES，FINAL PASS（异体 glm-flash 评审獭，坏锚点 A6/B2/B5/D1/D4 同类错不再现、好锚点 A4/E1/E2 标准在改动文本中直接体现）；附注建议「plan B」措辞自包含化已采纳（→「上述三步路径」）
- [x] 审视 r1 五发现全采纳：①严重（commit body 补 Modification-Class: docs-config，amend）②预检 fail-closed 语义③三步③不可逆点+回退语义（gate 从「CI 已触发」加严为「CI 通过」）④Golden Gate 豁免形态对齐（PR body 补标准行 + verify_by 改 human_judge 并留理由）⑤证据分层两行归桶
- [x] 已过最简检查：纯文档改动，两 skill 各一小节，无更简形态（少一处 = 改名或预检约束缺失一个）

## 影响

- 改名场景从「直觉删旧建新」变为「三步迁移」——多花一次 push + 开新 PR 的操作成本，换取审查链不损失
- 删远程分支多一步预检命令——成本可忽略
