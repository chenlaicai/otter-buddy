---
id: F20260902bfgr
title: 'sgp2 S2 前置：backfill 墓碑一次性守卫——防重启吞崩溃窗口真 pending'
doc_type: feature
summary: |
  S1 观察期二轮核查发现墓碑每次重启都重跑（3589→3607），会吞掉崩溃窗口的真 pending
  （R1 场景）。修复：settings CAS（tryInsertIfAbsent 先到先得）+ 存量墓碑行检查
  （老库无守卫期兼容）双防线，墓碑只跑一次；死亡证明不受守卫影响（记账面收尾非迁移）。
status: final
change_type: fix
tags: [signal-protocol, backfill, guard, incident-prevention]
modules: [src/bootstrap/database.ts]
created_in_conversation: 52bfdd91-a61e-4323-b1f7-1fe3daaadc32
capability_test: "n/a: 后端守卫逻辑（A 类），行为由 4 例真实仓储集成测试覆盖（tests/bootstrap/backfill-guard.test.ts）"
causal_links:
  from:
    - F20260902sgp2   # 父特性（S1 铺轨）
    - F20260902hopf   # 同期修复（hop 取源）
---

# F20260902bfgr: backfill 墓碑一次性守卫

## 问题（S1 观察期二轮核查实证）

墓碑的幂等（OR IGNORE）只保证「同一 (message,target) 不重复标」，但**不阻止对新存量重跑**：
每次重启时，「落库于上次重启之后、且链上没被记账」的消息都会被当时的墓碑一刀翻篇。
崩溃窗口场景（R1：用户消息落库后进程死、无人应答，该由补扫点燃）的真 pending，
会在**下次重启时被墓碑误吞**——「重启=翻篇」吃掉「该补扫的账」，直接违背设计 §2 的 R1 承诺。
生产实证：3589→3607（+18 行 backfill 增长），其中混入了应属崩溃窗口的消息。

## 修复（双防线一次性语义）

1. **settings CAS**：`tryInsertIfAbsent('sgp2:backfill-legacy-attempted')` 先到先得——
   同库多进程并发时只有一进程跑墓碑
2. **存量墓碑行检查**：`source='backfill'` 行存在 = 墓碑已执行过（老库在无守卫期已跑过，
   settings 无锁 key 的兼容路径）——直接短路跳过

**死亡证明（markStaleInProgressFailed）不受守卫影响**：它是记账面收尾（进程内不可能有
存活的 in_progress 跨越重启），每次重启照常跑——有测试锁定此区别。

## 测试（4 例，tests/bootstrap/backfill-guard.test.ts，走 postInitDatabase 全链路）

- R1 保护：首次守卫后新增的真 pending 在二次重启后存活（修复前会被吞）
- 老库兼容：存量墓碑行存在时守卫短路，锁 key 不写入
- 多进程并发：CAS 先到先得，后到者不重跑
- 死亡证明不受守卫影响：连续两次重启都照常翻篇

## 验证

- 后端 225 files / 2837 tests 全绿；tsc 干净；eslint 0 error
- 最简实现检查：已过——零新抽象，复用 settings CAS 原语 + 一次 count 查询
