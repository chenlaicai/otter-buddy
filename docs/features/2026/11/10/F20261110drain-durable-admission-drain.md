---
id: F20261110drain
title: 修复终止边界的回执注入与队列续跑
change_type: fix
status: development
created_at: 2026-11-10
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
capability_test: tests/capability/matter-loop/matter-loop.capability.test.ts
intent:
  problem: "板上回执在原 invoke 终止边界到达时可能被提前销账，owner 獭没有新的 invoke 或 durable successor 尚未完成就被清理"
  expected_effect: "运行中回执只有被 durable 实际接纳才销账；已接纳队列在原 invoke 的 abort/工具所有权内完成，idle 回执回退新 invoke"
  verify_by:
    type: capability_test
causal_links:
  - F20260907usti
  - F20260913ctlv
  - F20261109pidrx
summary: 修复板上回执在 invoke 终止边界被误销账或脱离生命周期的问题；以 durable 原子 admission、idle 回退和 conversation 自然 drain 取代 fire-and-forget 与固定延时。
---

# 修复终止边界的回执注入与队列续跑

## 问题与影响

#1788 的 matter-loop ③④ 中，板上 user 回执已经落库，但 owner 獭没有第二次 `invoke_start`，事项停留在 `WAITING_PARTNER`。能力测试第一轮只等 completed `speak`，随后立即发回执；此时真实 `yield` 的 terminating tool 可能仍在收尾。路由器看到 active session 后默认走 steer。

旧路由把 `entry.steer()` 以 fire-and-forget 发出并同步返回 true，随后写 `consumed=steered`。因此「找到 active entry」被错误当成「消息已接纳」。durable 1.5 的 final boundary 又可能放置 queued inputs、从 Inbox 删除并立即启动 successor run；只看原 submission 或 Inbox 会让 `prompt()` 提前返回，factory 随后清理 invoke，而 successor 工具仍可能运行。

## 原案与当前 runtime 的时间边界

- #1788 创建于 2026-11-05；durable 迁移 #1783 到 2026-11-09 才以 `8e562834` 合入。**durable 不是 11-05 原案根因**。
- fire-and-forget steer 及「失败仍可能销账」的已知窗口由 `c7737c70`（F20260907usti / PR #841）引入。
- `b1d11c5f`（F20260913ctlv / PR #886）把 running 目标的用户消息默认切到 steer，使板上回执进入该窗口。这两个 commit 是原案机制来源与暴露路径；没有证据把原案归因于 #1780/#1781 或 durable 迁移。
- 当前修复针对同一 admission/生命周期契约在 durable runtime 中的实现，不把当前复现冒充原案的历史重放。

## 修复契约

1. **真实 admission 才销账**：`SignalRouter` await `steerSession` / `followUp`；factory await durable `submit`。只有成功才返回 true 并写 consumed。
2. **idle 原子拒绝**：durable steer/followUp 使用 `whenIdle: "reject"`。activeSessions 尚未删除但 conversation 已 idle 时不写入、不隐式启动无人托管的新 run，路由回退 `invokeTarget`。
3. **durable 自然 drain**：原 `submission.wait()` 后无条件 `conversation.waitForIdle()`。final boundary 已接纳的 inputs 由 durable 自己消费，原 invoke 的 `currentInvokeId`、abort、guard 与 active entry 保持到 successor 完成。
4. **不手工续跑**：删除固定 `setTimeout(0)`、Inbox 快照和 `continue`。这些做法无法建立 admission 边界，并会在 one-at-a-time 多队列下抛 `ConversationBusy` 或在 abort 后复活工作。
5. **失败不冒充成功**：`ConversationIdle` 是正常回退；其他 admission 错误保留日志/healing，但返回 false，不写 consumed。
6. **内部守卫不浮空**：熔断/编排提示共用捕获式 steer；idle 拒绝作为过期提示 debug，其他错误 warn，避免主进程 unhandledRejection 退出。

## 设计取舍

- 不用固定 sleep：时序让路不是可靠性协议，也无法覆盖 prompt 已返回后的消息。
- 不用 Inbox 判空： successor 被放置后已从 Inbox 删除，空 Inbox 不等于 idle。
- 不在本修复中新增队列机制：复用 durable 的 atomic admission 与 `waitForIdle` 公开契约。
- 同批修 followUp：它共享 fire-and-forget/idle 误销账根因；只修 steer 会留下显式排队入口的同族缺陷。
- successor 在原 submission 已 done 后被 abort 时，原 submission 的成功事实不改写；successor 自身落 `unanswered=aborted`，不再执行后续工具。本修复不额外发明跨 submission 错误聚合。

## 回归与判别力

`durable-runtime.test.ts` 使用真实 Harness + faux provider + 临时 SQLite，不依赖固定延时：

- 原 run 工具执行中 admitted 的 steer 在 terminate 后完成。
- 首个 speak 不 terminate、yield terminate；在公开 `afterTool`（execute 已返回、result 尚未提交）注入回执，修正原 fixture 的不可达前置。
- 两个 steer 按默认 one-at-a-time 全部 drain；首个 successor 被 gate 住时原 prompt 必须仍 pending。
- successor 运行中 abort：工具收到取消、后续模型轮不执行、submissions 全终态。
- factory 对 `ConversationIdle` 和其他 admission 失败均返回 false。
- 路由在 stale running + idle 的 steer/followUp 两种路径回退新 invoke，且不写 consumed。
- 熔断与编排两个内部提示入口分别覆盖 `ConversationIdle` / 普通 Error；rejection 被捕获，不产生 unhandledRejection。
- matter-loop ③④ 等待回执消息时传 `afterSeq=firstRound.seq`，排除首轮 completed speak；原写法会在新 invoke 创建前读取 matter，产生假阴性。

## Acceptance Test

### 需求与权威证据

| 需求 | 权威证据 | 当前状态 |
|---|---|---|
| 终止边界 admitted 回执不丢、不脱离 invoke 生命周期 | durable-runtime 专项测试、submission/工具计数断言 | ✅ 聚焦集通过 |
| idle admission 不错误销账，回退新 invoke | steer-session + signal-router-entries 回归 | ✅ 聚焦集通过 |
| 原 issue 真链恢复 | matter-loop ③④ 在当前真系统 + 真 LLM 各 3/3，连续两轮 | ✅ 两轮均通过 |
| 类型与静态约束不回归 | `tsc --noEmit`、ESLint、文档 lint | ✅ 通过 |

### 证据判定

- 单元/集成聚焦集：最新 main（`4e4f0cb6`）上 5 文件 73 用例通过；`npm run build`、`tsc --noEmit`、相关 ESLint、docs/intent lint 通过。
- 真 LLM 能力链：Kimi `k3.1-pro`、真 Harness/SQLite/embedding；③④ 第一轮各 3/3（2026-11-09 19:56—20:00），第二轮各 3/3（20:00—20:04）。每次均断言 matter 的机械迁移/登记结果。
- 测试环境处置：旧 local overlay 指向无额度 MiMo；切 Kimi 后首跑暴露 `prompt_cache_retention` 400，按主配置设 `cacheLongRetention:false` 后重跑。这些失败不计入代码通过证据。
- 原案历史：已定位机制来源/默认路径暴露 commit；原 runtime 已被 durable 替换，不伪称在当前 head 重放了旧 runtime。

## 独立审查

检视獭-1788 首轮报告 `review-1788-adversarial.md` 判定「需要修改」，指出 session-only 修复不闭合、successor 漏等、continue 误用、红测不可达及缺能力证据。本实现按上述契约处置，真链两轮已补齐。

Delta 报告 `review-1788-delta.md` 确认首轮 S1–S5 与 followUp 已处置，新发现内部守卫 steer 浮空拒绝（D1）。已以共享 `steerGuardHint` 收口并补 4 个拒绝组合回归；聚焦集增至 73 用例全绿。最终 delta 报告 `review-1788-final-delta.md` 通过（0 严重、0 建议），并独立复跑 73/73、tsc 与相关 ESLint。双方同为 kimi-lty，属同模型降级审查；真 LLM 两轮结果由作者执行并留档。
