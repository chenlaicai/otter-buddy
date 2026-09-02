---
id: F20260902hopf
title: 'sgp2 S1 修正：hop 取源修复——链级多源记账，消灭 hop 2+ 漏记'
doc_type: feature
summary: |
  S1 观察期首轮核查（重启后 1 小时生产数据）发现的记账 bug 修复：
  hopSourceMessageIds 是 executeOneHop 局部变量，settle 回填出方法即丢——
  hop 2+ 的记账全部静默跳过，9 条 pending 中 3 条假阳性源于此。
  修复：Map 提升为链级 chainSourceMessageIds（target → 触发消息列表），
  回填按 aggregatedTargets 落位（yield 给谁就记在谁名下），多源覆盖
  （A、B 同 hop yield C 时 C 对两条触发消息各记一条 attempt）。
status: final
change_type: fix
tags: [signal-protocol, dispatch-ledger, hop-source, bugfix]
modules: [src/usecases/conversation/dispatch-chain-engine.ts]
created_in_conversation: 52bfdd91-a61e-4323-b1f7-1fe3daaadc32
capability_test: "n/a: 记账面修正（A 类），行为由 3 新增单元用例覆盖（hop 2+ 记账/多源覆盖/无 repo 零行为变化）"
causal_links:
  from:
    - F20260902sgp2   # 父特性（S1 铺轨）
---

# F20260902hopf: hop 取源修复

## 问题（生产观察实证，2026-09-02 15:00 核查）

重启后 1 小时生产数据：3589 墓碑 ✅ / 16 completed + 3 in_progress ✅ / 无僵尸 ✅，
但 9 条 pending 中 3 条呈重复模式：同会话同獭「消息 M 点名獭 T → T 的链上后一跳无记账」。
根因（读码确认）：`hopSourceMessageIds` 声明在 `executeOneHop` 内（hop 局部），
settle 的回填 `hopSourceMessageIds.set(target, messageId)` 出了方法作用域就丢——
下一 hop 重新 new 空 Map，`get(target)` 永远 undefined → **hop 2+ 起跑记账静默跳过**。

## 修复

1. **Map 提升为链级**：`executeChainInner` 声明 `chainSourceMessageIds: Map<string, string[]>`，
   随 params 传入每个 hop（链级生命周期）
2. **值类型 string → string[]**（多源）：A、B 同 hop 都 yield 给 C 时，C 的消费义务是
   两条触发消息各销一条账——起跑/settle 都按列表逐条记
3. **回填按 aggregatedTargets 落位**（第二处修正，debug 用例逼出）：产出消息记在
   「yield 给的下一跳目标」名下，不是记在自己名下——例：worker 产出 m-work 并 yield
   owner，m-work 应进 chainSource[owner]，下 hop owner 起跑记 (m-work, owner)
4. **防膨胀**：同目标重复 yield 去重（同 produced 只留一份）+ 截尾 8 条
5. user 目标照 #474 语义滤除（人类不参与链调度，不记账）

## 测试（3 新增，tests/usecases/conversation/dispatch-chain-engine.test.ts）

- hop 2+ 记账不再跳过：worker yield owner，owner 被记 (m-work, owner) completed
- 多源覆盖：A、B 都 yield C，C 记 (m-a, C) 和 (m-b, C) 两条
- 无 repo 时不记账不抛（可选依赖零行为变化回归锁）

## 验证

- 后端 223 files / 2818 tests 全绿；tsc 干净；eslint 0 error（complexity 17 用
  disable + 注释锚定理由：多源双层循环 + 逐源兜底，拆分损可读性）
- 最简实现检查：已过——复用既有 recordAttemptStart/Settle 结构，仅参数类型
  string → string[] 与回填落位点修正，无新抽象

## 影响

- S1 观察期判据「pending 只随真实未答增长」恢复成立（消灭假阳性来源）
- S2 前置条件（mimo 审视焦点 3 边界标注）同步满足：hop 2+ 记账完整后，
  pending 判据对链内目标全覆盖
