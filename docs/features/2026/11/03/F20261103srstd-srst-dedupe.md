---
id: F20261103srstd
title: 自重启防循环双定义收敛：窗口常量单点导出 + tool 层复用共享介入判据
summary: |
  #1288 tech-debt 偿还：自重启防循环的 tool 层（tool-factory isSelfRestartLoop）
  与 invoker 层（circuit-break-support isSessionSelfRestartCreated）此前是两份
  独立实现——窗口常量 SELF_RESTART_LOOP_WINDOW_MS 双定义、重试循环两份、降级
  落账两份。本 PR 收敛到单点：窗口常量在 circuit-break-support 导出为唯一真相
  源，tool 层删除本地副本改为 import；介入判据 tool 层复用共享
  hasUserMessageSince（async wrapper 适配），重试/降级语义同源。行为等价重构，
  双侧 26 用例（tool 8 + invoker 13 + pending 路径 5）零回退。
causal_links:
  relates:
    - "F20261005srst"
    - "F20260906srst"
    - "F20260824srst"
    - "#1288"
    - "#1284"
change_type: fix
capability_test: "n/a: 行为等价重构，验证走既有单测双侧 26 用例零回退（tests/interface-adapters/agent-runtime/ 两文件）"
tags: [self-restart, loop-protection, tech-debt, dedup, circuit-break]
modules:
  - src/interface-adapters/agent-runtime/circuit-break-support.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
created_at: 2026-11-03
created_in_conversation: 12967086-9ce5-4cf8-8343-ce4b0fd31519
intent:
  problem: "自重启防循环两道防线（tool 层/invoker 层）窗口常量与重试逻辑双定义——同语义两处维护，改一处漏一处埋 bug（#1284 检视确认的结构债）"
  expected_effect: "窗口常量单点导出（grep 全仓定义处=1），tool 层介入判据复用共享 hasUserMessageSince，双侧测试零回退"
  verify_by:
    type: static_only
---

# 自重启防循环双定义收敛（#1288）

## 背景

#1284 检视确认：自重启防循环的 tool 层与 invoker 层是两份独立实现——
SELF_RESTART_LOOP_WINDOW_MS 双定义（circuit-break-support.ts:44 与
tool-factory.ts:1170 各一份）、重试循环两份（tool 层手写 for 循环 vs invoker
层 hasUserMessageSince）、降级落账两份。这是 #811 以来的既有架构形态，#1284
为不稀释修复主题未收敛，本 PR 专项偿还。

## 变更

1. **窗口常量单点化**：circuit-break-support.ts 的
   SELF_RESTART_LOOP_WINDOW_MS 改为 `export const`（含 F20261103srstd 注释
   声明单点真相源地位），tool-factory.ts 删除本地副本改为 import。
2. **介入判据收敛**：tool 层 isSelfRestartLoop 的手写重试 for 循环删除，
   改为包一层 async wrapper 复用共享 hasUserMessageSince——查询函数
   （entry.getEntries 最新 user entry）、重试一次、降级回调语义全部同源；
   降级落账逻辑保留在 tool 层 onDegrade 回调内（context.layer='tool' 标记
   归属不变）。

## 设计取舍（L1 獭拍板）

- **收敛落点选 circuit-break-support 而非新常量模块**：invoker 层已是防循环
  语义的家（isSessionSelfRestartCreated/hasUserMessageSince 都在这），再加
  一个常量模块是过度建设；检视獭-1284 的评估也是「包一层复用即可」。
- **降级落账不收敛、仅判据收敛**：两层的 healing event 字段不同
  （tool 层带 messageId/currentInvokeId 上下文，invoker 层走 recordHealingEvent
  管道）——强行统一要动 invoker 管道签名，超出本 issue 的「常量/重试收敛」
  验收面。layer 标记（'tool'/'invoker'）保留区分。
- **机制判定（步骤 3 前置）**：无新机制——纯行为等价重构，不命中机制预算
  四问任何一项（无新数据流/无新守卫/无新降级路径）；已过最简实现检查
  （仓库已有 hasUserMessageSince 导出，wrapper 复用即最简，无需新代码路径）。

## 验收标准（机械断言）

| 场景 | 操作 | 预期 |
|---|---|---|
| 常量单点 | `grep -rn "SELF_RESTART_LOOP_WINDOW_MS\s*=" src/ --include="*.ts"` | 定义处仅 1 处（circuit-break-support.ts，export const） |
| 常量复用 | `grep -n "SELF_RESTART_LOOP_WINDOW_MS" src/interface-adapters/agent-runtime/tools/tool-factory.ts` | 仅 import 行 + 使用行，无本地定义 |
| 双侧测试 | `npx vitest run tests/interface-adapters/agent-runtime/tools/pending-restart.test.ts tests/interface-adapters/agent-runtime/circuit-break-self-restart.test.ts` | 27 passed, 0 failed（tool 9 + invoker 13 + pending 5） |

## Verification

- 双侧测试 27/27 通过（2026-11-03，worktree srst-dedupe 实测）——含审视严重1
  回归用例（#1288 审：介入判据降级且落账 deferred 时，工具返回前落账已 settle，
  pending-restart.test.ts 新增）
- tsc --noEmit 零错误
- 变更内容：3 文件 + 回归用例（共享契约 onDegrade 改 void | Promise<void> 并
  await——async 落账在返回前 settle，同步回调 await undefined 无害）
- CI：以 PR checks 页 head 最新 run 四绿为准
- Golden Gate: n/a（verify_by=static_only——行为等价重构 + 时序契约修正，
  无行为语义变更面外的场景可跑）

## 负面向验收条目

本次收敛**未触碰**的东西：invoker 层 isSessionSelfRestartCreated 本体逻辑、
降级落账两层的字段差异、HEALTHY_SESSION_THRESHOLD_MS（熔断健康窗口，另一常量
不在本 issue 范围）。无既有保护被绕过——tool 层拦截语义（保守拦截 + 降级留痕）
逐行为保持。
