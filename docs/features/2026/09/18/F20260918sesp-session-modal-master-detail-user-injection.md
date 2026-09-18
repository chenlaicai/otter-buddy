---
id: F20260918sesp
title: Session 弹窗主从双栏重设计 + user 侧事件全可见（user_injection）
doc_type: feature

summary: |
  搭档反馈 Session 弹窗两个体验问题：①invoke 列表与展开事件共用一个滚动容器，
  且挂载即"跟随底部"——列表 DESC（最新在顶）+ 视口被拉到最底 = 打开弹窗看到的
  是最老 invoke，想看的 running 反而要往上翻；②steer 发言在流式过程里完全隐形
  （用户不知道插话插到了哪）。修法：A) 弹窗改主从双栏（左 invoke 索引独立滚动 +
  右事件流独立滚动，打开自动选中 running）；B) 打通 pi 的 message_start(role=user)
  事件 → 落库为新事件类型 user_injection（触发 invoke 的首条 prompt、steer、
  followUp 三态同路，含熔断器系统 steer），fold 层直通 user 步渲染——数据源保持
  纯 pi 流（搭档拍板：不自造注入事件，不混源）。

causal_links:
  from:
    - F20260913ctlv   # Session 弹窗与 invoke_events 模型母体
    - F20260914evdz   # 事件折叠/实时通道上一轮（本次在其上重构展示层）
  supersedes: []

change_type: feature
tags: [web-ui, session-panel, invoke-events, user-injection, steer, master-detail, event-mapping]
modules:
  - api-contract/api/invoke.ts
  - src/entities/conversation/invoke.ts
  - src/usecases/conversation/agent-turn-orchestrator/event-mapping.ts
  - web/src/lib/invoke-event-fold.ts
  - web/src/pages/conversation/SessionModal.tsx
created_in_conversation: 93e355c6-4df3-4d78-b17e-7b21c61107f8
capability_test: "n/a: 纯展示层 + 事件映射纯函数，行为由单元/组件测试覆盖（event-mapping.test.ts / invoke-event-fold.test.ts / SessionModal.test.tsx）"
intent:
  problem: "Session 弹窗共享滚动容器导致打开弹窗落在最老 invoke（running 在顶视口在底），且 steer/followUp 插话在流式过程中不可见（用户不知道自己插的话到了哪）"
  expected_effect: "打开弹窗即自动定位 running invoke（左栏索引+右栏事件流独立滚动互不干扰）；每次 invoke 的流式过程完整包含 user 侧消息（触发 prompt + steer + followUp 消费点），插话位置与模型实际看到的时序一致"
  verify_by:
    type: behavior_check
---

# Session 弹窗主从双栏重设计 + user 侧事件全可见

## 背景

搭档 2026-09-18 反馈两个体验问题（原话）：

> 1. 有session、有正在进行中的session展开的流式过程，但是公用一个滚动条，导致我点击进去页面只看到最历史的session，我还得往上翻到当前session的最新流式过程，感觉需要重新设计下这些内容的展示布局
> 2. 当我steer发言时，我打开流式过程，我看不到我的steer是插入到哪个位置，搞得我有点懵。所以我在思考，每一次invoke的流式过程，是不是能把全部的事件都列出来、包括我的发言、steer发言，真实看到完整过程

### 根因定位（file:line 均为本 PR 改前基线 caab1c71）

**①滚动错乱**：两个设计打架——invoke 列表 `ORDER BY started_at DESC`（最新在顶，
`sqlite-invoke-repository.ts:175`），但弹窗挂载时"自动跟随底部"逻辑把整个共享滚动容器
拉到最底部（旧 `SessionModal.tsx:161-167`，followBottom 初始 true + 滚到底）→
视口落在最老 invoke。

**②steer 隐形**：初判"steer 不产生事件"是错的——搭档质疑后源码级核实：

- pi 确实发这些事件：`queue_update`（steer/followUp 入队即发，`agent-session.js:1048`
  push 后 `_emitQueueUpdate`）+ `message_start(role=user)`（消息被模型消费、真正进入
  上下文那一刻发，`agent-session.js:361-381`——steer 消费点甚至伴随队列出队再发一次
  queue_update）。
- 但全被我们自己扔了：`mapToInvokeEventInput`（旧 `event-mapping.ts:91`）只认
  tool_execution_start/end、message_end（且 `extractAssistantContent` 显式跳过
  role=user）——message_start 和 queue_update 落到 default return null，从未落库。

搭档拍板要点：**数据源必须是纯 pi 流，不混源**（否决了自造 user_injection 事件的
第一版方案——那会让流式过程数据源从"单一 pi 返回"变成"pi + 自造"混杂）。

## 方案设计

### A. 主从双栏布局（问题 ①）

- 弹窗加宽 max-w-2xl → max-w-5xl；body 区改双栏 flex：
  - 左栏 w-56：invoke 索引（状态徽章 + 时间 + 耗时 + 工具数），独立滚动
  - 右栏 flex-1：当前选中 invoke 的事件流（顶部参数行 + 事件列表），独立滚动
- 状态模型简化：`expandedEvents: Record<id, events>`（多开）→ `selectedInvokeId`（单选）
  + `selectedEvents`；折叠步展开键 `${invokeId}:${idx}` 不变
- 挂载自动选中 running（无 running 选最新一条）；invoke.start 实时信号自动选中新行动
- running 时右栏贴底跟随（上滚暂停/回底恢复不变）；切换选中重置跟随态
- 加载竞态防御：`selectedInvokeIdRef` 镜像，异步回来只写"仍是当前选中"的

### B. user_injection 落库 + 渲染（问题 ②，纯 pi 源）

事件链（pi 源码锚点）：

```
用户 steer ──> session.steer() ──> _queueSteer: push 队列 + emit queue_update
                                        │
                                        ▼ agent 消费
                              message_start(role=user) 事件
                                        │ 我们的 subscribe（全量）
                                        ▼
                    mapToInvokeEventInput 新分支：eventType=user_injection
                    payload={content(文本拼接), timestamp}
                                        │
                                        ▼
                    invoke_events 落库 + SSE invoke.event 广播（复用现有管线）
                                        │
                                        ▼
                    invoke-event-fold: user 步直通（无配对语义）
                                        │
                                        ▼
                    SessionModal: 用户消息行（蓝调底 + UserRound 图标 + 展开全文）
```

- 触发 invoke 的首条 prompt：同为 message_start(role=user) → 自然成为流的第一条
  user 步（"每次 invoke 完整过程"零额外逻辑）
- 熔断器/编排护栏的系统 steer：同走 session.steer() → 同样可见（加分项③随主链达成）
- `queue_update` **不落库**：与 message_start 必然重复（agent-session.js:369 出队即再发）
- `mapToSSEEvent(message_start)` 返回 null：不广播（落库独享，与流式过程其他事件口径一致）
- 旧数据兼容：无 user_injection 的历史 invoke_events 照常折叠（fold default 跳过）

### 设计取舍

- **为何消费点而非注入点**：steer 的"注入时刻"（按发送键）与"模型看到时刻"（message_start）
  之间有排队延迟，展示消费点与工具调用天然同序、与模型真实视角一致；注入点信息
  （queue_update）与消费点必然重复，只留消费点。
- **为何不改 DB schema**：invoke_events 表无 event_type CHECK 约束（schema.ts:910-918），
  新增枚举值纯应用层变更，零迁移。
- **为何 single-select 不 multi-expand**：旧版多开 + 共享滚动正是滚动错乱根因之一；
  双栏单选后"看哪个"是显式导航行为，且右栏滚动与左栏解耦。
- **queue_update 的 pushCursorOnStartup 排除**：`pi-session-factory.ts:688` 已显式排除
  queue_update 作为"启动成功"信号——本变更不动该游标逻辑，message_start(user) 落库
  与游标推进互不影响（游标仍由首个非 queue_update 事件推进，行为不变）。

## 机制识别检查点判定

命中「新增持久化事件类型 + 新展示步」——机制预算四问：

1. **可否用现有机制表达**：不可。user 侧事件此前无任何落库路径（message_start 被
   default 丢弃），展示层也无对应步类型；复用 assistant_text 会污染语义（角色混淆）。
2. **退役条件**：若未来 pi 原生提供结构化 user 事件 DTO，本映射分支可一行替换——
   落库格式（content 文本）保持稳定。
3. **后续机制依赖**：无。fold 直通步无配对状态机，不依赖其他机制配合。
4. **最小面**：3 处类型枚举 + 1 个 switch 分支 + 1 个 fold case + 1 个渲染分支，
   无新表、无迁移、无新依赖。

Modification-Class: mechanism-addition（净新增 user_injection 落库机制，四问已答）。

## 变更清单

| 文件 | 变更 |
|---|---|
| `src/entities/conversation/invoke.ts` | InvokeEventType + `user_injection` |
| `api-contract/api/invoke.ts` | InvokeEventTypeDTO + `user_injection`（含注释） |
| `src/usecases/conversation/agent-turn-orchestrator/event-mapping.ts` | `mapToInvokeEventInput` 新增 `message_start` 分支（role=user → user_injection；assistant/toolResult → null 维持旧行为） |
| `web/src/lib/invoke-event-fold.ts` | FoldedStep + `user` 步；fold switch 新增 `user_injection` 直通 case |
| `web/src/pages/conversation/SessionModal.tsx` | 主从双栏重构（左索引/右事件流独立滚动）+ selectedInvokeId 单选态 + 竞态防御 + user 步渲染（蓝调底/UserRound/展开全文） |
| `tests/usecases/event-mapping.test.ts` | 新增：message_start user/assistant/queue_update 映射 + SSE 不广播 |
| `web/src/lib/invoke-event-fold.test.ts` | 新增：user 步直通 + 旧数据兼容 |
| `web/src/pages/conversation/SessionModal.test.tsx` | 重写：自动选中/双栏切换/steer 可见性/空态/中断标记 |

DTO 链路（invoke-controller.toInvokeEventDTO）字段一一透传，eventType 联合类型扩
枚举后全链自动兼容，零改动。

## 验证

### 单元/组件测试

- 后端：`npx vitest run` → 268 files / 3632 tests 全绿（含新增 event-mapping 5 用例）
- web：`npx vitest run` → 53 files / 485 tests 全绿（含新增 fold 2 用例 + 重写
  SessionModal 5 用例）
- `tsc --noEmit` 双端 0 错误；`web npm run build` 成功

### UI 真机验证（alpha 隔离实例，2026-09-18）

方法：`scripts/alpha.sh start`（端口 3192，独立数据根）+ 种子数据（2 invoke × 7
events，含 user_injection×3：触发 prompt / steer / followUp 消费点）+ Playwright
无头浏览器驱动真实 UI 路径。

**渲染层数值取证**（getBoundingClientRect/computedStyle）：

- 双栏分离：左索引 x=129/w=224，右事件流 x=353/w=798，无重叠
- steer 可见：user 步 2 条，steer 文本「先别改文件，等一下」位于 y=437.25
  （read 工具行之后），w=766/h=42.25
- user 步样式：`rgba(56,102,141,0.08)` 蓝调底 + 8px 圆角（与工具步透明底区分）
- 选中态：左栏 border-teal 选中样式存在；「实时观察中」指示条 teal 正常渲染

**截图目检**（视检獭 mimo-vision 异体复核，7/7 验收点通过）：
A 双栏布局 ✓ B 头部 ✓ C running 自动选中+实时条 ✓ D 用户消息/steer/工具行时序正确 ✓
E 切换联动 ✓ F 展开全文 ✓ G 无布局破损 ✓

截图存档：`data/workspaces/93e355c6-4df3-4d78-b17e-7b21c61107f8/shot-{1,2,3}-*.png`

### 最简实现检查

已过：无新表/无迁移/无新依赖；复用 appendInvokeEvent 落库管线与 SSE invoke.event
广播；fold 直通步无状态机。备选的"注入点 queue_update 落库"被否（与消费点重复）。

## 已知边界

- steer 打断的"模型半截输出"pi 不作为独立事件发（SDK 内部 abort 重生成），流里表现
  为 message 序列切换——如实展示消费点，SDK 黑盒部分不臆造
- 旧数据（本 PR 前的 invoke_events）无 user 侧事件，弹窗照常展示（不含 user 步）
- 恢复队列（resume）在 alpha 验证中把手工注入的 running invoke 标记为 failed——
  属 alpha 验证环境的手工种子数据边界，非本变更行为（生产 running invoke 由
  agent-invoker 生命周期管理）
