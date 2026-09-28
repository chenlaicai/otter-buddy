---
id: F20260928audt
title: 右栏状态长尾兜底（60s 周期对账 + invoke.end 零订阅可观测 + settle 首查竞态）
doc_type: feature

summary: |
  F20260928icmm 阶段1（PR #1179）把右栏 invokeStates 换轨为服务端 invokes 表的缓存、
  挂齐事件型对账读点（切回/聚焦/POST 流结束/retry 流结束）后，本 PR 补长尾兜底三件：
  ① running 存在期间 60s 周期静默对账——覆盖「页面一直开着不动」的丢终态场景
  （tab 休眠/后台节流使 SSE 停滞且无任何读点时机），无 running 时零开销；
  ② broadcastEvent 零订阅丢 invoke.end 从 debug 升 info——右栏延迟更新场景的定位入口；
  ③ POST 流 settle 首查竞态修复——首查延迟 500ms 起步，堵 entry 落库与 invoke 行创建
  的竞态窗口（9/25 实证关流 14:51:02.246 / invoke 创建 .288）误判 settled 提前关流。
  mechanism-addition（周期 interval），机制四问见正文设计取舍节。

type: BugFix
domain: web
status: implemented
created: 2026-09-28
created_in_conversation: 5603032d-569c-42c1-b318-1e3b4629ab1f
related_issues: [1160]
related_pr: []
causal_links:
  - F20260928icmm
  - F20260923sswd
  - F20260922rprf
---

# 右栏状态长尾兜底：周期对账 + 可观测性 + settle 竞态

## 背景

阶段1（F20260928icmm / PR #1179）落地后，右栏正确性由「拉取对账 + 缓存合并语义」保证，
SSE 事件只承担新鲜度。但对账读点全部是**事件触发型**（切回对话/窗口聚焦/POST 流结束），
存在一个长尾：**页面开着、用户不动**（tab 休眠回来但没有 focus 事件、后台节流导致
SSE 停滞但看门狗未触发、或事件丢失且无任何读点时机）时，右栏错误要等到下一次用户
交互才被纠正。本 PR 补时间维度的兜底，并顺手修 POST 流 settle 首查竞态（架构獭 9/25
联合排查发现的第 5 条路径）。

## 修改点

| # | 位置 | 修改 |
|---|---|---|
| 1 | `web/src/pages/conversation/index.tsx` SSE 订阅 effect | 新增 60s 周期静默对账：`setInterval` 每 60s 检查 `invokeStatesRef`，当前会话存在 `running` 时调无门控对账 `syncInvokeStatesOnReconnect`；无 running 零拉取。生命周期与 SSE effect 同源（同装同卸），cleanup 与看门狗一起清理 |
| 2 | `src/usecases/im/message-broadcaster.ts` | 零订阅丢事件日志分级收窄：`invoke.end`（丢终态直接影响右栏收敛时机）升 info 且文案标注「前端对账兜底」；其余事件（scheduler/cron 常态分支）维持 debug 防噪音 |
| 3 | `src/interface-adapters/http/sse-settle-waiter.ts` | settle 首查延迟 500ms 起步（`setTimeout(tick, SSE_SETTLE_POLL_MS)`）：POST 链路 entry 落库与 invoke 行创建有竞态窗口（实测最短 ~40ms，极端调度数百 ms），首查立即执行时 invoke 未创建会被误判 settled 提前关流。延迟后正常链路判据可靠，30s 超时兜底不变 |

## 机制四问（设计取舍）

- **① 谁需要**：右栏状态卡的用户可见正确性——「页面开着不动」长尾场景的最后一道兜底；
  阶段1 读点已把错误窗口压到交互边界，本机制把上界收敛为 60s。
- **② 失败后果**：无此机制时极端场景（tab 休眠丢终态且无交互）右栏卡「行动中」直到
  用户下一次切页/聚焦——低频但体验差；有此机制最坏 60s 自愈。
- **③ 与后续机制的关系**：与阶段1 读点正交（时间维度 vs 事件维度）；与服务端 SSE 看门狗
  互补（看门狗管连接活性 40s，本机制管数据正确性 60s，各管一面）；不新增服务端状态。
- **④ 退役条件**：若服务端将来支持 SSE 重连回放或心跳携带终态摘要（invoke.end 的
  since 参数化），本周期对账可退役——它是对「断连即丢、无回放」架构的补偿，不是终态。

**取舍记录**：周期选 60s 而非更短——invoke 典型时长分钟级，60s 已远小于人工感知阈值，
且仅 running 存在时才发请求（空闲对话零开销）；不看 SSE 连接状态（断连时也应拉——
重连补偿链与周期对账幂等共存）。

## 测试

- **失败测试先行**：settle 竞态回归用例（`sse-settle-waiter.test.ts` +1）——首查落在
  invoke 创建窗口时旧实现立即误判 settle，新实现等到 invoke 出现且终态；fake timers
  推进三段断言（0ms 不 settle / 600ms 仍 running 不 settle / 终态后 settle，查询次数 3）。
- 周期对账组件级用例（`index.spa-nav.test.tsx` +1）：60s 推进 → running 存在触发拉取
  （两次独立周期各拉一次）→ 服务端变终态后下一周期右栏收敛「行动中」消失 →
  无 running 后 120s 推进零拉取（零开销断言）。
- 验证：web 574/574（59 文件）+ server 3994/3994（284 文件）+ 双侧 tsc exit 0。

## 影响范围

- `web/src/pages/conversation/index.tsx`（周期对账 interval + cleanup）
- `src/usecases/im/message-broadcaster.ts`（日志分级）
- `src/interface-adapters/http/sse-settle-waiter.ts`（首查延迟）
- 测试：sse-settle-waiter.test.ts +1、index.spa-nav.test.tsx +1
