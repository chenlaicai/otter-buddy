---
id: F20260830skst
title: "Session 锁 stale 强制接管 + 恢复路径终态守卫（#599 / #423 方案 2 收口）"
summary: |
  Issue #599（8/29 22:24 事故）：服务重启后自动恢复抢 session 锁超时（持有者为
  abort 后 session.run 未 settle 的僵尸 invoke），恢复失败后 prepareForRetry 已复位的
  旧消息悬挂 streaming，用户 10 分钟内被迫 3 次手动中断。双修复：①SimpleLockManager
  增加 stale 强制接管——持有超 stealThreshold（默认 5 分钟）时新 acquire 直接接管，
  generation 世代号使旧持有者的 release 对易主锁 no-op；②ResumeInterruptedService
  增加 finally 终态守卫——链结束（含 allSettled 吞错路径）后收尾仍处 streaming/
  speaking 的旧消息为 failed（半截内容保留），并发系统消息说明去向。
change_type: fix
status: active
capability_test: "n/a: 纯代码锁语义与状态机修复，无 LLM 参与行为"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
---

# Session 锁 stale 强制接管 + 恢复路径终态守卫（#599 / #423 方案 2 收口）

## 背景与需求

### 事故现场（8/29 22:24-22:33，对话 3241317b）

- 22:24:57 chen 强制中断开发獭-574 发言（14 次工具调用后）——消息 ca96d309，status=aborted
- 22:31:08 系统消息「服务重启导致 1 条发言中断，正在自动恢复」
- 22:31:08 恢复失败：`Lock acquire timeout for key: session:a4c584d0-...`——消息 aa47c77b，status=failed
- 22:31:46 / 22:33:06 chen 又两次强制中断**僵尸发言**

### 根因链（对照代码核实）

```
服务重启
  └→ reconcile 将中断消息标 failed、入 restart_pending_resumes 队列
  └→ ResumeInterruptedService.resume()：sendSystem「正在自动恢复」（22:31:08）
  └→ resumeOne：prepareForRetry 旧消息复位 streaming（半截 segments 保留）
  └→ executeChain → invokeFn → PiSessionFactory.invoke → lockManager.acquire(`session:${otterId}`)
       └→ 30s 等待超时 → reject「Lock acquire timeout」→ orchestrator failTerminal
            → 消息 aa47c77b = 恢复 invoke 自己的 streaming 消息落 failed（同秒可见）
  └→ 但 prepareForRetry 复位的「旧消息」仍在 streaming —— 无人收尾 = 僵尸发言①
       └→ chen 手动中断它 → 触发恢复 invoke 对该 otter 的操作 → 竞态窗口再生成僵尸②③
```

两个缺陷：

1. **锁泄漏无兜底**：`PiSessionFactory.invoke()` 在整个 agent 运行期间持锁（正常数分钟）。
   用户 abort 后旧 invoke 的 `session.abort()` 若未 settle run promise（重启/SDK 边界），
   锁被僵尸持有到进程级 GC——后续任何 acquire 必然 30s 超时。#423 方案 1（PR #434）只
   加了诊断日志，方案 2（基于日志定位根因）在 #599 现场得到了答案：**持有者是死路径**。
2. **恢复失败无降级路径**：resumeOne 的 catch 收不到 Lock timeout——executeChain 对
   invoke 失败是 allSettled 吞错语义（processHopResults 只记日志不上抛）。旧消息复位
   streaming 后既无人写入也无人收尾，成为等用户手动中断的僵尸。

## 方案设计

### 缺陷 1 修复：SimpleLockManager stale 强制接管（session-helpers.ts）

- 锁条目新增 `generation` 世代号；`acquire()` 在进入等待队列**前**检查持有者年龄
  （`Date.now() - heldAt`）是否 ≥ `stealThresholdMs`（默认 300_000 = 5 分钟）
- 超龄 → 直接接管（不排队、不等 30s 超时）：`generation += 1`，走获取路径；
  落结构化 warn 日志（lockKey/otterId/holderHeldForMs/stealThresholdMs）
- **旧持有者的 release no-op**：release 时 `lock.generation !== myGeneration` 即静默
  丢弃——不干扰新持有者（不释放、不移交）。抢锁者排在队首的等待者保留，FIFO 不破坏
- 阈值选 5 分钟：正常 invoke（含长编排轮）实测 5 分钟内结束；持有超 5 分钟只可能来自
  异常路径，误伤面≈0

### 缺陷 2 修复：ResumeInterruptedService finally 终态守卫（resume-interrupted-service.ts）

- `resumeOne` 增加 finally 块：链结束后（无论 try 成功、catch 降级、还是 allSettled
  吞错后正常返回）检查旧消息状态，`canFailMessage`（streaming/speaking）为真则：
  - `sendMessage.fail(messageId, 收尾文案)`——归档为 failed，半截 segments 保留，
    用户可在原条目上手动重试（前端 retry 入口对 failed 开放）
  - `sendSystem(收尾文案)`——按 done/failed 两口径告知用户去向
- 守卫自身 try/catch 包裹，失败仅落日志——守卫不能制造新的僵尸
- 恢复 invoke 写入的是**新消息**（`sendMessage.start()` 新 messageId），收尾旧消息
  与新内容互不干扰

### 非目标

- 不改 executeChain 的 allSettled 语义（它服务于多目标并发的容错，是对的——只是
  resume 场景需要自己的终态保障，由守卫补上）
- 不处理跨进程锁（单进程内 Map，无跨进程竞争）
- 不动 abort → session.run settle 链（SDK 内部行为，进程侧无从根治；steal 是进程侧
  能做的最可靠兜底）

## 变更清单

| 文件 | 变更 |
|---|---|
| `src/frameworks/agent/session-helpers.ts` | SimpleLockManager：generation 字段、stealThresholdMs 参数（默认 300s）、acquire 超龄接管、release 世代校验、steal warn 日志、超时日志补 stealThresholdMs 字段 |
| `src/usecases/conversation/resume-interrupted-service.ts` | resumeOne finally 终态守卫（canFailMessage 守卫 + fail + sendSystem，done/failed 双口径） |
| `src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts` | 新增 `buildRestartResumeTerminalMsg(outcome)` |
| `tests/frameworks/agent/simple-lock-manager.test.ts` | +4 用例：steal 接管、旧 release no-op、阈值内不误伤、steal 结构化日志 |
| `tests/usecases/conversation/resume-interrupted-service.test.ts` | +2 用例（成功收尾/终态 no-clobber）；修正基础用例断言（streaming→failed，旧断言固化了僵尸缺陷） |

## 验证

- `npx vitest run tests/frameworks/agent/ tests/usecases/conversation/`：30 文件 417 用例全绿
- `npx tsc --noEmit`：0 错误（worktree 需先 `npm install`，qrcode 为 #586 新增依赖）
- **最简实现检查**：已过——steal 复用现有 acquire 主路径（fall-through），无新抽象层；
  守卫是单层 finally + 现有 canFailMessage 守卫函数，无新状态机
- capability_test：n/a（纯 A 类代码逻辑，无 LLM 参与行为）

### 证据判定

| 验收场景 | 证据 | 判定 |
|---|---|---|
| 锁被僵尸持有超阈值后新 acquire 立即接管（不等 30s 超时） | simple-lock-manager.test「should steal lock from stale holder」 | ✅ |
| 僵尸的迟到 release 不影响新持有者 | 「stolen holder's release should be a no-op」 | ✅ |
| 正常持锁（<5 分钟）不被误伤，等待者仍走超时路径 | 「normal holder under steal threshold should not be stolen」 | ✅ |
| 恢复链结束后旧消息收尾 failed，不再悬挂 streaming | resume 测试「#599 终态守卫：成功路径旧消息收尾归档」 | ✅ |
| 已终态（completed/aborted）的消息不被守卫改写 | 「终态守卫：消息已被处理到终态时守卫不覆盖」 | ✅ |
| 收尾/接管事件可诊断 | steal warn 日志用例 + failTerminal 既有 error 日志 | ✅ |

## 影响范围与风险

- **steal 的理论风险**：5 分钟仍在正常工作的 invoke（超长编排轮）被接管后并发执行
  同一 session。缓解：正常轮有 speak/yield 事件持续落地（<5 分钟内活动）；编排型长轮
  恰是 #574 在修的目标（未来有心跳/进度信号后阈值可再校准）。当前误伤概率远低于
  僵尸锁 100% 的恢复失败率——两害相权取 steal
- **守卫收尾 failed 的影响**：旧消息从「悬挂 streaming」变「failed + 指引」。前端
  failed 态可手动重试；半截 segments 保留。无数据丢失路径
- 与 #575（熔断打断编排链）的关系：#599 修复后，#575 类事故中「恢复失败留僵尸」的
  分支消失，剩余「审视无人接续」属编排层问题，不受本 PR 影响
