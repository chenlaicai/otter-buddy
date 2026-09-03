---
id: F20260903lcyc
title: 'sgp2 S2.2：R5 生命周期回放判据——目标「未出生→出生→死亡」全链测试'
doc_type: feature
summary: |
  F20260903damp 阻尼清单第 3 项：以真实仓储回放 09-03 事故的全生命周期
  （L1 未出生非 pending → L2 出生追溯 pending 且点火一轮即止 → L3 死亡 pending 消失
  → L4 全链顺序回放计数轨迹 0→1→0→0）。验证 v2 修复后生命周期各阶段失效模式
  全部落在哑火侧；补充 S1 观察期抓到的 queryOtter.getById 同步/异步契约坑（测试侧）。
status: final
change_type: fix
tags: [signal-protocol, lifecycle, replay-test, incident-hardening]
modules: [tests/usecases/conversation/signal-router-lifecycle.test.ts]
created_in_conversation: 52bfdd91-a61e-4323-b1f7-1fe3daaadc32
capability_test: "n/a: 纯测试补全（A 类），被测对象为 #744/#749/#755 已交付的调度与记账行为"
causal_links:
  from:
    - F20260902sgp2   # 父特性
    - F20260903damp   # 事故根因（本特性落地其阻尼清单第 3 项）
---

# F20260903lcyc: R5 生命周期回放判据（S2.2）

## 背景

F20260903damp 阻尼清单第 3 项：v2 的失效模式分析缺少「目标生命周期」维度的回放判据。
09-03 事故的时间线本质是一条生命周期链：未出生（判据安全）→ 出生（追溯 pending）→
死亡（dissolve 不解除）。#749/#755 修复后各阶段的失效模式应全部落在哑火侧——本组
测试把这条链固化为回归资产。

## 用例（signal-router-lifecycle.test.ts，真实仓储 × 真路由器）

| 用例 | 场景 | 断言 |
|------|------|------|
| L1 未出生 | 点名不存在的獭 | 非 pending，路由零点火（事故第一步天然安全） |
| L2 出生 | 獭诞生 → 追溯 pending | **v2 正确语义**（行动人已在岗，点名即欠账）→ 补扫点火一轮即止（记账闭环） |
| L3 死亡 | dissolve → pending 消失 | 判据排除 + 零点火；已消费历史保持非 pending |
| L4 全链 | 未出生→出生→消费→死亡顺序回放 | pending 计数轨迹 0→1→0→0，全程恰好 1 次点火 |

## 测试侧发现（记录）

`queryOtter.getById` 在 signal-router 中以 `.catch(() => null)` 调用——**要求返回
Promise**。本测试首版用同步 mockImplementation 返回裸值导致 `.catch is not a function`
（被 routeTarget 的 .catch 吞成 null → skipped_inactive 静默路径）。契约已在测试侧
修正为 async；路由器侧的 `.catch` 防御保持（真实 repo 返回 Promise，无实际影响）。

## 验证

- 后端 231 files / **2848 tests** 全绿（新增 4 用例）；tsc/eslint 干净
- R1-R4 既有判据全部保持（无回归）
