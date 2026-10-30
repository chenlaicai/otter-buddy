---
id: F20261030sigtk
title: "signal 对账段处置 token 存在性断言：criteria registry 增 6 条防线（#1342）"
summary: "daily-health-check.md 的 signal 对账段是纯文本 prompt，处置动作 token（提 issue/query_signals）在 rebase/出清/冲突中可被静默删减而无人拦截（PR #1289 检视 r3 实证两处提 issue 动作静默丢失）。用 F20261012acpt 已就位的 criteria registry 机制补 6 条存在性断言（4 处置子句 + 2 查询入口），删任一 token 即 lint 红；不另立 lint:prompt-actions 新机制。"
change_type: feature
capability_test: "tests/criteria/check-criteria.test.ts"
intent:
  goal: "signal 对账段的关键处置 token 丢失即红——把「处置动作是否还在 prompt 里」从人眼抽查升级为机械断言。"
  non_goal: ["不检查 prompt 执行质量（只管 token 在位）", "不新建独立 lint 脚本（registry 机制已覆盖，机制统一优先）", "不改 signal 对账段的业务语义"]
  solution: "criteria/invariants.json 增 6 条 invariant（dhc-signal-unruled-24h / dismiss-recurrence / resolution-audit / halt-audit / query-pending / query-halt），pattern 为段内唯一子串（query_signals(status=pending) 在文件出现 2 处，用「…]` 逐项」后缀锚定对账段那处）；tests/criteria/check-criteria.test.ts 增 7 用例（6 逐条 + 1 整段）；lock --update-lock 重生成（diff 显形走评审）。"
  expected_effect: "删掉任一「提 issue」/query_signals token 后 check-criteria FAIL（exit 1）且点名条目 id；rebase/出清误删对账段整段时 6 条全红。"
  verify_by:
    - "断言：signal 对账段删掉任一「提 issue」token 后 lint 红（验收断言原文）——红测 6 用例逐条覆盖"
    - "断言：完整文件 PASS（exit 0）基线不破——既有绿用例 + check-criteria 实跑 18/18 条在位"
    - "到期：2026-11-07（issue #1342 验证断言原定）"
---

# signal 对账段处置 token 存在性断言（#1342）

## 背景

- issue #1342（PR #1289 检视 r3 建议 1）：daily-health-check.md 的 signal 对账段是纯文本 prompt，
  无回归防线——rebase/出清/合并冲突时处置动作（提 issue、batch_bind、triage_signal 等 token）
  可能被静默删减，只能靠检视獭肉眼发现（PR #1289 r3 就是这么抓到的：两处「提 issue」处置动作
  在 D3 rebase 冲突解决中静默丢失，无人拦截）。
- 机制现状（F20261012acpt，2026-10-12）：criteria registry + check-criteria.mjs + lock/waiver
  已上线，种子条目里 dhc-no-bare-numbers 等 4 条就是对 daily-health-check.md 的存在性断言——
  #1342 设想的「独立 lint:prompt-actions」在 registry 诞生前写的，本实现改走 registry 增条目：
  机制统一（一个闸管所有存在性断言）、零新机制面（R8.5 准入三问：决策者不变/机械守卫/深潜成本
  不增），红测断言照 issue 验收原文做。

## 修法

1. **registry 增 6 条**（criteria/invariants.json）——signal 对账段 4 个处置子句 + 2 个查询入口：

   | id | pattern（段内唯一子串） | 锁的语义 |
   |---|---|---|
   | dhc-signal-unruled-24h | `objection/blocked 超 24h 未裁决 → 提 issue` | pending 超 24h 未裁决必须提 issue |
   | dhc-signal-dismiss-recurrence | `连续两日提 issue` | dismissed 异常聚集暴露通道 |
   | dhc-signal-resolution-audit | `不成立提 issue` | 已裁决抽核不成立暴露通道 |
   | dhc-signal-halt-audit | `无理由 halt 提 issue` | 停手滥用暴露通道 |
   | dhc-signal-query-pending | `` query_signals(status=pending)` 逐项 `` | 悬置消费入口（同串在检查清单另有 1 处，用后缀锚定对账段） |
   | dhc-signal-query-halt | `query_signals(type=halt) 核` | 停手审计入口 |

2. **红测**（tests/criteria/check-criteria.test.ts）：6 token 逐条删除 → FAIL 且点名对应 id
   （it.each，fixture 前提守卫防上游文件漂移）；signal 对账段整段删除（rebase 冲突形态）→
   6 条全部点名。绿基线沿用既有「完整文件 PASS」用例。

3. **lock 重生成**：registry 变更 → `--update-lock`（diff 显形，本 PR 评审过目；checker/waivers
   未动，lock diff 仅 invariants.json hash + combined 两行）。

## 影响范围

criteria/invariants.json（+6 条）、criteria/lock.json（hash 重生成）、
tests/criteria/check-criteria.test.ts（+7 用例）——无生产代码变更，无 prompt 语义变更
（daily-health-check.md 本体零改动，不碰 10499/10500B 体积顶格红线）。

## Verification（证据链）

1. **红测**（本次执行）：`npx vitest run tests/criteria/check-criteria.test.ts` → 23 passed
   （16 存量 + 7 新增）——覆盖验收断言「删任一『提 issue』token 后 lint 红」逐条形态 + 整段形态。
2. **闸实跑**：`node scripts/check-criteria.mjs` → PASS（18/18 条在位，lock OK）。
3. **断言到期**：2026-11-07（issue #1342 验证断言原定到期日）。
