---
id: F20260902u5tr
title: '协作机制 v2：信号轨迹 UI — 状态盒与投递状态原位展示'
summary: '信号协议展示层落地（母方案 F20260901sgpx §7）：新增 /signal-trail 只读端点（服务端从游标/streaming 持久层推导投递状态 PENDING/CONSUMING/CONSUMED），消息原位渲染「谁→谁·档位·状态」轨迹条，措辞约束固化（排队只说「待消化」，不说「正在忙」/队列位置）。'
change_type: feature
status: draft
capability_test: "tests/usecases/conversation/query-signal-trail.test.ts"
created_in_conversation: 52bfdd91-a61e-4323-b1f7-1fe3daaadc32
---

# F20260902u5tr: 信号轨迹 UI — 状态盒与投递状态原位展示

## 背景

母方案 F20260901sgpx §7 定义了信号展示语义（谁→谁、档位、状态；busy+DELIVERED 显「排队待消化」、CONSUMED 显「已处理」）。P1 信号路由器（#692）已让插话排队必达，但用户看不到「我插的话排上没有」——本特性补齐交互契约的可见性半边。

设计依据：flash《交互契约与系统一致性》提案（2026-09-02 三獭设计讨论）+ #695 大獭裁决三条：
1. busyQueue 维持进程内必达（排队显示 = 游标未消费的持久事实，非内存队列位置）
2. 排队只说「待消化」不说「第几位」（队列位置内存态，重启会说谎）
3. HALT 到小獭维持丢弃+回执（本特性不涉及，回执归后续 PR）

## 核心设计决策（含被否方案）

| 决策 | 取舍 | 被否方案及理由 |
|---|---|---|
| 状态推导放服务端（新 usecase QuerySignalTrail） | 「已消化」判据 = otter 游标（conversation_participants.last_read_turn_number），持久层真相前端不可达 | 前端推导：拿不到游标，重启前后不一致，违反状态盒铁律「状态 = f(持久层)」 |
| 信号判据与路由器对齐 | completed + 非 system + tsp 含 otter 目标（SignalRouter.queryCandidateSignals 同款）——路由器怎么消费、轨迹就怎么展示，单一真相源 | 第二套判据：两个视图漂移后「显示已处理但实际没消费」比没有轨迹更糟 |
| 游标缺省降级 PENDING | 无参与者行不能假证已读，诚实降级 | 缺省视为已消费：会把 dissolve 獭的欠账显示成已清 |
| 消息原位 chip 而非独立轨迹弹窗 | 信号语义紧贴消息正文，零新增路由/入口 | 独立 Modal：多一个入口维护成本，且割裂「消息↔其投递状态」的空间关联 |
| 前端 trailItems 可选透传 | 未拉到轨迹时徽标不渲染（非信号消息零成本） | 前端合并推导：违反对齐原则 |

## 投递状态机（服务端推导）

| 状态 | 判据（全部持久层/近持久层） |
|---|---|
| CONSUMED | turn_number < last_read_turn_number（游标已越过信号 turn）。生产库实证：user 消息独占 turn、otter 回应独占下一 turn，markBatchRead 推进即覆盖 |
| CONSUMING | 目标最新消息 streaming 且 5min 窗口内（invoke 进行中，游标未推进的窗口；与 SignalRouter.ACTIVE_WINDOW_MS 同语义） |
| PENDING | 其余。已知边界：busy 獭「消费但未注入」的插话会被标 CONSUMED——内容经 busyQueue 快照显式注入，显示「已处理」与实际语义一致 |

## 变更清单

| 层 | 文件 | 内容 |
|---|---|---|
| 契约 | api-contract/api/message.ts | MessageDTO 加 lvl（档位透出）；SignalTrailItemDTO/SignalTrailResponseDTO |
| usecase | src/usecases/conversation/query-signal-trail.ts（新） | 三态推导，读路径仅依赖 conversationRepo + queryMessage |
| 控制器 | message-controller.ts + router.ts | GET /api/conversations/:id/signal-trail（可选注入，未装配 501） |
| DTO | message-dto.ts | signalLevel 透出（非空才携带） |
| 装配 | bootstrap/{usecases,types,controllers}.ts | QuerySignalTrail 接线 |
| 前端 | web/src/lib/signal-trail.ts（新） | 信号判据 + 状态盒措辞映射（措辞约束固化点，测试锁定） |
| 前端 | SignalTrailChip.tsx（新）+ MessageList/ChatView/index | 徽标渲染 + 轮询刷新链（2s，随 refreshMessages 同节奏） |

## 验证

- 后端 vitest 2735 passed（含 query-signal-trail.test.ts 6 用例：三态判定/档位透出/多目标展开/非信号边界/游标缺省降级/时序）
- 前端 vitest 375 passed（含 signal-trail.test.ts 11 用例：信号判据边界 + 措辞约束回归锁定「禁止出现正在忙」）
- tsc --noEmit 双侧 0 error；eslint --quiet 双侧 0 error
- 已过最简实现检查：判据复用 DTO 已有 tsp 投影，无新表/新列/新迁移；chip 复用 SignalBadge 交互模式
