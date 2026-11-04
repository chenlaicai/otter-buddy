---
id: F20261104iprec
title: pre-commit 链补 lint:intent 接线（#1755）
change_type: fix
status: implemented
created: 2026-11-04
created_at: 2026-11-04
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules:
  - .githooks/pre-commit
summary: "#1755：pre-commit lint 链 8 gate 唯缺 lint:intent（lint-intent.mjs 头注释自证设计意图为 pre-commit 调用但从未接线）——intent 块违规（如 #1754 缺 intent 块、#1752 capability_tes typo）在 commit 时静默通过，到 CI 才红，反馈晚一轮约 5 分钟。补一行接线（同 lint:docs 的 dist 依赖模式，上方 npm run check 先行构建恒新鲜；633 存量 warnings 不阻断只拦 error）。三关核实：缺口实证 / 方向同款先例 / 代价秒级。"
tags: [ci, pre-commit, intent, feedback-loop]
intent:
  problem: "intent 块违规在 commit 时静默通过到 CI 才红——反馈晚一轮（gate 设计意图是 pre-commit 拦截但未接线）"
  expected_effect: "intent 块违规（缺块/字段非法）commit 时即红，反馈从 CI 轮提前到 commit 时"
  verify_by:
    type: behavior_check
capability_test: "n/a: 单行 shell 接线（gate 调用序变更），行为验证走 commit 钩子实测（见验证节）"
---

# pre-commit 链补 lint:intent 接线（#1755）

## 问题

`.githooks/pre-commit` lint 链 8 gate（docs/capability/tests/skills/tool-manifest/historical-docs/prompt-anchors/date-bombs/criteria）唯缺 lint:intent。`scripts/lint-intent.mjs` 头注释「依赖：pre-commit hook 已跑 npm run check（= build）产出 dist/」自证设计意图是 pre-commit 调用，但从未接线。实证：#1754 缺 intent 块、#1752 capability_tes typo 均 commit 通过到 CI 才红（发现来源：PR #1754 对抗审视）。

## 方案

补一行 `npm run lint:intent`（按既有「每 gate 一行」模式），插在 lint-prompt-anchors 之后。依赖模式与 lint:docs 同款：上方 `npm run check` 先行构建 dist，恒新鲜。存量 633 warnings 不阻断（warnings ≠ error，语义正确——error 级含：字段非法值、feature/prompt 缺块、created_at ≥ 2026-11-03 全域缺块 #1740）。

## 机制识别检查点论证（Modification-Class: narrow-fix 配套）

七项检查点逐项过：①新配置字段/枚举/开关否 ②新状态生命周期否 ③新定时任务否 ④新信号类型否 ⑤新持久化否 ⑥新决策分支否（pre-commit 每次执行临时链，无被记住的状态）⑦新跨模块调用路径——字面擦边：.githooks→scripts 调用，但 lint:intent 是**补挂到既有 gate 调用链**（其他 8 gate 同款「每 gate 一行」模式），不新增任何路径形态，属既有机制（gate 链）语义内补位。故判修法①，不涉净新增机制。

## 三关核实（#1749 定稿纪律，本 issue 实施）

1. **事存在吗**：实证——gate 链 grep 8 项无 intent；两个 PR（#1752/#1754）均 commit 过、CI 红，反馈链缺口真实
2. **方向对吗**：issue 建议方向（补一行接线）与 lint:docs 同款先例完全一致，无替代方案值得评估（自建 gate/改 CI 时序均过度设计）
3. **代价认了吗**：commit 时多一个 gate（node 脚本秒级）；无补登债、无写放大

## 验证

- [x] 红测二（主拦截路径）：临时把本文档 verify_by.type 改为非法值 behavior_chek → commit 被 lint:intent 拦截（exit 1 + `Invalid intent.verify_by.type`，HEAD 未动）；修复后通过。**这正是 #1752 capability_tes typo 事故形态——接线后此类错误 commit 时即拦，不再等到 CI**
- [x] 红测一（边界探明，r1 订正归因）：缺 intent 块对 change_type: fix 且**无 created_at 字段**的文档只出 Recommended warning——真边界是 #1740 全域门（lint-intent.mjs:275-283）：created_at ≥ 2026-11-03 的新文档**不论 change_type 缺块均 error**；红测一被测文档用 `created:`（无 created_at）落入 #1740 已知残余口子（F20261103itald 明示「created_at 缺失文档不在此列」宽容口径），并非「fix 类设计性不拦」。本 PR 不改此口子（收口归 #1295/#1740 后续，含 repo 级 created/created_at 字段漂移稀释覆盖面问题——检视獭1765 r1 职责外观察，留档待评估）
- [x] commit 噪音代价（r1 建议③如实披露）：存量 633 warnings 每 commit 全量打印约 1.3k 行——反馈前移的代价，可接受（不阻断）；噪音治理分两半：Missing 豁免清单部分（约 251 条）归 #839 ratchet 收敛；主体 Recommended 类（约 364 条）不受清单追踪，归 #1295 intent 收口后续
- [x] 全量 commit 钩子链过（本 commit 本身即验证：lint:docs/capability/tests/skills/tool-manifest/historical-docs/prompt-anchors/intent/date-bombs/criteria 九 gate 顺序执行）
- [x] CI：见 checks

## 影响

intent 反馈从 CI 轮（约 5 分钟+一轮人工等待）提前到 commit 时（即时）；与 F20260804dcnv（文档 frontmatter commit-time gate）同族的反馈前移。
