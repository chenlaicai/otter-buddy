---
id: F20260903ah68
title: "S3.5 调度闸门交互投影：会话横幅 + 中断告知 + 熔断反馈 + 徽标弱化 + 黑话清理"
doc_type: feature
summary: >
  全员会议（09-03）整改路线 S3.5——闸门状态的用户可见性（会议第四要素）。五件：
  会话级调度横幅（停机/限流冷却两态，getGateState 只读查询 + /signal-trail 附带）；
  中断显式告知（abort toast + 恢复 toast）；熔断期发消息落系统消息（G6 沉默闭环）；
  徽标弱化模式（搭档 A 方案：正常流转只图标，FAILED/高优豁免）；G7 黑话映射
  （note 内部语言人话化，title 只带本轮原因）。
status: implemented
change_type: feature
tags: [signal-protocol, gate-visibility, ux, sgp2-s35]
modules: [src/usecases/conversation/, src/interface-adapters/http/, web/src/pages/conversation/, web/src/lib/]
capability_test: web/src/pages/conversation/GateBanner.test.tsx
created_in_conversation: 52bfdd91-a61e-4323-b1f7-1fe3daaadc32
causal_links:
  from:
    - F20260903ihlt   # 调度闸门本体（#766）——本设计是其第四要素（用户可见性）的落地
    - F2026090326c5   # K2/K3（轨迹/横幅的数据链路基础）
    - F20260903dmpe   # S2.1 阻尼（pending 判据——横幅数据推导的前置）
---

# F20260903ah68: S3.5 调度闸门交互投影

## 目标

全员会议结论：调度闸门四要素（名字/真相源/失效模式/**用户可见性**）里第四要素整体缺失——
闸门冻结期间徽标照显「排队待消化」（说谎）、中断零反馈、熔断期发消息 HTTP 200 + 零响应
（最差交互组合）。本设计把闸门状态投影到交互面，五种用户可见变化：

| # | 场景 | 之前 | 之后 |
|---|------|------|------|
| 1 | 用户按中断 | toast「回复已中断」（单条语义） | + toast「已暂停本会话新任务，发新消息即恢复」+ 顶部横幅「🛑 已停机」 |
| 2 | 停机/熔断期间看消息流 | 徽标「⏳排队待消化」（暗示会消化） | 横幅说明真实状态（停机/冷却至几点）；徽标待闸门投影进轨迹后随 S4 语义修正 |
| 3 | 熔断期发消息 | HTTP 200 + 零反馈 | 系统消息「模型限流冷却中（至 HH:MM），消息已排队、恢复后自动处理」 |
| 4 | 停机态发新消息 | 无感知（隐式解除） | toast「调度已恢复」 |
| 5 | 看到轨迹徽标 | 每条全文字 + note 黑话（「进程重启，派发中断」） | 正常流转只图标；❌ 保持醒目且 title 说人话 |

## 方案设计

### 1. 会话级调度横幅（GateBanner.tsx 新组件）

- **数据源**：`SignalRouter.getGateState(conversationId)`（新增只读查询，返回
  `{ halted, rateLimitedUntil }`——rateLimitedUntil 从 healing 事件推导取窗口最晚者，
  与 isRateLimited 同源不同值：判定要 boolean，投影要截止时间）
- **传输**：挂在既有 `GET /signal-trail` 响应上（`gate` 字段，可空）——前端 2s 轮询
  天然刷新横幅，零新增请求；路由器未注入（降级直连链）时 `gate: null` → 横幅不渲染
- **两态优先级**：halted > rateLimited（用户显式意志 > 系统推导态，大獭裁决 ①）
- 文案纪律：停机态必须给出恢复路径（「发新消息即恢复」）；熔断态给出自动恢复截止时间
  + 排队说明（「消息已排队、恢复后按序处理」——呼应闸门的「信号保留」语义）

### 2. 中断显式告知（G3）

- abort 成功（前端 `.then`）→ toast「已暂停本会话新任务，发新消息即恢复」——把
  #766 的会话级停机语义从黑箱变成用户知情的操作后果
- 停机态下发新消息 → toast「调度已恢复」（gateState.halted 时才提示，不常驻打扰）

### 3. 熔断期发消息反馈（G6）

- 入口 route 返回含 `skipped_rate_limited`/`skipped_halted` 时 → `sendSystem` 落一条
  系统消息（走消息表，用户离开页面回来也能看到），内容区分停机/冷却并带截止时间
- 系统消息而非仅 SSE push：与 K3 全 skipped 立即关流兼容（消息持久，流关了信息还在）

### 4. 徽标弱化（G8/A 方案）

- `trailStateMeta` 增加 `quiet` 参数：quiet 时正常流转态（PENDING/CONSUMING/CONSUMED）
  的 label 缩为图标本身；**FAILED 与 URGENT/HALT 档豁免**（异常才显眼，高优不打折）
- SignalTrailChip 汇总徽标默认 quiet=true；展开详情行保持全文字（透明度在需要时可用）
- 5 条措辞纪律（待消化/不说正在忙等）全部保留，quiet 只影响「显不显文字」不影响「说什么」

### 5. G7 黑话映射

- `humanizeNote`：内部措辞 → 人话（「进程重启，派发中断」→「服务重启时被打断」；
  「router catch:」→「自动处理失败」；「legacy-attempted」→「历史消息（升级台账前已处理）」）
- title 只带**本轮原因**（首个分号前）——§8.2 retry 前情链（prev=...）对用户是噪音，
  展开详情时看全量 note
- 未命中的 note 原样透出（排查线索不丢）

## 影响范围

- 后端：signal-router（+getGateState 只读方法）、message-controller（trail 端点 + 入口
  系统消息，~20 行）——纯读路径与展示层，点火/记账/闸门判定逻辑零改动
- 前端：GateBanner 新组件、ChatView/index 接线、signal-trail 弱化与人话映射
- 回滚面：revert 本 PR（无 schema/行为变更，横幅消失回到静默）

## 取舍表

| # | 决策 | 取 | 舍 | 理由 |
|---|------|----|----|------|
| 1 | gate 状态传输 | 挂 /signal-trail 响应 | 独立 /gate-state 端点 | 前端 2s 轮询已存在，搭车零新增请求；横幅与轨迹同源同节奏，不会出现「横幅说冷却、徽标说处理中」的分裂 |
| 2 | 熔断反馈载体 | sendSystem 消息 | 仅 SSE push | K3 全 skipped 立即关流——push 会随流关闭丢失；消息表持久，回看可见 |
| 3 | 弱化豁免面 | FAILED + URGENT/HALT | 全部弱化 | 「异常才显眼」的语义完整性：失败和高优是需要行动的信号，静默它们等于 G8 又犯一遍 |
| 4 | title 取本轮原因 | 首个分号前 | 全量 note 链 | 前情链（prev=）是排查线索，给详情展开；气泡 title 一行内说完 |
| 5 | halted 状态继续内存态 | 本 PR 不动 | 顺路做 G5 持久化 | G5 持久化是大獭裁决的独立事项（settings 表方案），混进来会稀释本 PR 的投影职责；S4 批处理 |

## 验证

- 前端 404 全绿（GateBanner 12 用例：两态优先级/渲染/null 不渲染 + 弱化规则 + G7 映射；
  既有 signal-trail 测试适配人话 title 断言）
- 后端 2903 全绿 + tsc/eslint 双侧 0 error
- 措辞纪律回归：signal-trail.test.ts 既有「不含正在忙/队列位置」用例全保留全过
