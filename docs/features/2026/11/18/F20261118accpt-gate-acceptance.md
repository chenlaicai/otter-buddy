---
title: connector 总闸与验收层（阶段 4 C3）
id: F20261118accpt
date: 2026-11-18
module: session
change_type: feature
summary: |
  落实 #1868 阶段 4 C3（收尾）：主动下线五步全链的收尾语义分流——优雅下线
  （offline 帧）在途动作确定性落 interrupted（可安全重做），意外断开（心跳超时/
  hub 重启）真相不明落 unknown（S2 不对称边界）+ connector SIGTERM 自杀收尾（在途立即落
  interrupted——与中枢同裁决，两侧一致；M1 检视处置后回方案原设计）+ 旧 sid 晚到
  action.result 帧丢弃专测（模块 C 红线）+ issue 三条验收全过（六动作/下线后
  旧会话不能执行/本机海獭并存零回归——alpha 实启真进程验证）。
intent:
  problem: "C2 后下线收尾一刀切 unknown：优雅下线（设备明确告别）与意外断开（真相不明）语义混同——恢复链对可安全重做的动作给了过度保守的「禁止盲目重试」指引；旧 sid 晚到回执丢弃缺 result 帧专测；issue 三条验收缺端到端实证"
  expected_effect: "优雅下线在途落 interrupted（恢复指引=可安全重做）；意外断开保持 unknown（禁止盲目重试）；SIGTERM 后 connector 在途动作有界等待入账；下线后旧会话执行 fail-closed；local 机器与 connector 并存零回归"
  verify_by:
    type: behavior_check
    evidence:
      - "tests/frameworks/execution/remote-execution-machine.test.ts：意外断开 unknown / 优雅下线 interrupted 分流互斥（C3 两例）+ M1 双设备回归（reason 透传）"
      - "tests/frameworks/execution/connector-execution-e2e.test.ts：offline 帧优雅下线在途 interrupted + 下线后总闸拒 + 重连恢复可达 + 旧 sid 晚到 result 丢弃计数"
      - "workspace verify-c3-alpha.mts：issue 三条验收真进程实证（含 local 并存冒烟）"
capability_test: "tests/frameworks/execution/connector-execution-e2e.test.ts"
---

# F20261118accpt：connector 总闸与验收层（阶段 4 C3）

## 背景

#1868 阶段 4 最后切片（方案 v3 §6 下线总闸五步 + §8 C3 验收）。C1（通道与会话）+
C2（执行通道）已合入；本切片补齐下线收尾的语义分流与 issue 三条验收。

## 交付

### 收尾语义分流（方案 §6 第 4 步 / S2 不对称边界）

- **gateway**：`onSessionDown` 回调签名加 reason（device-offline /
  heartbeat-timeout / hub-restart）——shutdown 调用点透传既有 reason 参数
- **RemoteExecutionMachine**：按 reason 分流——
  - `device-offline`（优雅告别）→ 在途落 **interrupted**（确定性裁决：设备明确
    收到告别，动作可安全重做）
  - `heartbeat-timeout` / `hub-restart`（意外断开）→ 在途落 **unknown**（真相
    不明：设备可能执行到一半，禁止盲目重试）
  - waiter reject 信息带裁决（`(interrupted)` / `(unknown)`）
- **registry**：`markSessionRequestsUnknown` 通用化为 `markSessionRequests(sessionId,
  status, settledAt, error)`（interrupted/unknown 两态批量，幂等保护不变）

### connector SIGTERM 优雅退出窗（§6 第 4 步 connector 侧）

信号处理从「100ms 固定窗退出」升级为「在途感知有界窗」：dispatcher 暴露
`inflightCount`，SIGTERM 后轮询等在途归零（上限 3s；超时/未完成 → 进程死 →
台账 running 残留由开机清扫 sweepStaleBoot 按 verdict 分类裁决——兜底等价）。
中枢侧已按 device-offline 落 interrupted（先到真相保持），端上完成度以 connector
台账为真相（alpha 实证：窗内完成的动作 succeeded 保持不被改写）。

### 旧 sid 晚到回执丢弃（模块 C 红线 result 帧专测）

C1 已有 sid 校验丢弃（heartbeat 帧用例）；C3 补 action.result 变体：旧会话的
晚到回执从当前活跃连接发出 → gateway sid 校验丢弃 + `staleDropCount` 计数 +
不产生任何落账。

## 设计取舍

| 取舍 | 决策 | 被否替代 | 理由 |
|---|---|---|---|
| 优雅/意外分流粒度 | gateway reason 透传到 machine 分流 | 一律 unknown | 方案 §6/S2 明确不对称边界：优雅告别可确定性裁决 interrupted；混同会让恢复链给「可安全重做」的动作过度保守指引 |
| connector 侧收尾 | 在途感知有界窗（等完成）而非主动取消 | AbortSignal 取消链 | fs 操作不可真取消；完成入账（succeeded）比强制取消（interrupted）信息更完整；超时兜底=开机清扫分类裁决（比一刀 interrupted 更准） |
| 中枢/端上不对称 | 中枢 interrupted 先落（幂等不改写）+ 端上 succeeded 可共存 | 强一致 | 两层真相源定位（中枢投影裁决恢复链 / 端上台账机器真相）：恢复链给保守可重做指引，核对时端上可见完成度 |

## 机制识别检查点

- 新增持久化存储：否（复用 remote_action_requests）
- 新增状态生命周期：否（五态不变；interrupted 态首次有批量落点）
- 新增信号/消息格式：否（回调签名扩展，协议帧不变）
- 新增决策分支：是（reason 分流/优雅退出窗轮询）
- 新增跨模块路径：否（既有链路语义补全）

结论：修法决策树①纯行为补全（既有机制内语义分流，无新机制）。

## 验收标准（方案 v3 §8 C3 + issue #1868 三条）

| 场景 | 预期 | 结果 |
|---|---|---|
| 主动下线（offline 帧）在途 | 落 interrupted（可安全重做）+ waiter reject (interrupted) | ✅ 单测+E2E |
| 意外断开（心跳超时/SIGKILL）在途 | 落 unknown（禁止盲目重试）——C2 行为保持 | ✅ 单测+E2E |
| 分流互斥 | 优雅路径不落 unknown（反之亦然） | ✅ 单测 |
| 下线后旧会话不能执行（issue②） | 总闸①拒（connector device offline or unpaired） | ✅ E2E+alpha |
| 重连后恢复可达 | 新会话可执行（重连≠恢复，顶替上线） | ✅ E2E |
| 旧 sid 晚到 result | 丢弃+计数+零落账 | ✅ E2E |
| 本机海獭正常使用（issue③） | local 机器与 connector 并存零回归 | ✅ 全量 6116 绿+alpha 冒烟 |
| 六动作（issue①） | C2 已验收，回归保持 | ✅ |

## Verification

| 验证 | 结果 |
|---|---|
| `npx tsc --noEmit` | PASS |
| 定向（machine 14 + dispatcher 7 + E2E 7） | PASS |
| `npm test` 全量 | 484 files / 6116 全绿 |
| `npm run build:connector` | 闭包断言 PASS |
| alpha 实启（verify-c3-alpha.mts） | issue 三条验收全过 + 优雅下线 succeeded 保持（窗内完成）+ disconnectReason=device-offline + local 并存冒烟 |

## 检视处置记录（dspro 首轮：0 blocker / 1 major / 6 minor / 2 suggestion）

- **M1 优雅下线两面裁决冲突**（中枢 interrupted / 端上 succeeded 违反 S2 前提）：
  已修——**选处置 (a) 回方案 §6 第4步原设计**：connector SIGTERM 改自杀收尾
  （`markInflightInterrupted`——在途 actionId 立即对台账 settle interrupted，不等
  fs 完成；完成后 executor 的 succeeded settle 被幂等拦），两侧一致 interrupted；
  alpha 验证升级为「两层同态」断言（interrupted/interrupted 或赶上完成的
  succeeded/succeeded，禁止交叉）。
- **m1** hub-restart 收尾仅 dispose 路径（硬重启 boot sweep 不收 requested）：
  已修——`sweepStaleRequested`（残留 requested 全落 unknown/hub restart before
  result）挂 app.ts 启动清扫（与 online 行清扫同位）+ 单测。
- **m2** 优雅窗与重连循环未互斥（顶替重连再死）：已修——`exiting` 标志，重连
  循环见此不再起新连接（自杀收尾后窗口缩至 150ms 发送拍，不再 3s drain）。
- **m3** disconnect_reason=device-offline 无断言：已修——E2E + alpha 双断言。
- **m4** reason union 三处行内重复：已修——统一引用 `ConnectorSessionDownReason`。
- **m5** 旧 sid「零落账」断言同义反复：已修——先登记 requested 行，stale result
  后断言行保持 requested（未被 settle）。
- **m6** hub-restart 分支无测试：已修——机器单测（emitSessionDown hub-restart →
  unknown）+ sweepStaleRequested 单测。
- **s1** 双信号重复 goOffline：已修——shuttingDown 幂等守卫（与 m2 共用标志）。
- **s2** 信号注册挪 buildRuntime 后（boot sweep 期间 SIGTERM 走默认处置）：留档
  ——此刻无连接无在途，行为可接受（F 文档此行即留档）。

## 设计修订（M1 处置后的语义定稿）

connector 侧收尾从「有界等待完成」回到方案 §6 原设计「自杀收尾（取消在途，
台账落 interrupted）」：优雅下线时在途动作在两端一致裁决 interrupted（可安全
重做——重做由 actionId 幂等兜底，write 类覆盖同内容幂等）；fs 物理完成但裁决
interrupted 的窗口，其补充裁决（write 类 hash 核对 upgradedToSucceeded）由台账
开机清扫体系承担，与本机台账崩溃恢复语义同构。

## Rollback

Revert 本 PR：收尾回落一刀 unknown（C2 行为，恢复链指引变保守但正确性不变）；
connector 信号处理回落固定 100ms 窗（开机清扫兜底不变）；回调签名回缩需同步
三处（gateway/channel 接口/machine）。无数据迁移。
