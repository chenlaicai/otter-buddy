---
id: F20261009rwqa
title: 对话页上跳三轮根治：refreshMessages 快照窗口对齐
summary: "对话页自动上跳三轮修复：前两轮（scroll-pin 状态机、W8/RO 修复）后仍上跳且左侧栏也跳——本轮帧级取证锁定数据层真凶：refreshMessages 快照宽 100≠首屏 50，长会话每 60s 审计把窗口外 50 条历史塞进列表（实测 scrollHeight +8800px）。修复：after=oldest 游标升序拉取对齐窗口，只补增量不塞历史。"
created: 2026-10-09
created_in_conversation: 27398619-8e0b-4147-8230-93e23f1a01ac
status: implemented
module: conversation
tags: [web, scroll, bugfix, pagination]
causal_links:
  - F20261008w8lt-stale-restore-mine（二轮修复，未治本因——本案是数据层暴增，非滚动状态机问题）
  - F20261008scpg（一轮 #1344 scroll-pin 状态机——同上）
  - issue #1340（用户主诉追踪）
intent:
  problem: "长会话周期审计/焦点对账触发 refreshMessages 时，固定拉尾页 100 条快照把窗口外 50 条历史塞进首屏 50 条的列表，内容暴增 ~8800px 致贴底用户被推离——对话页自动上跳三轮主因"
  expected_effect: "60s 周期审计触发时，已加载 50 条的列表仅追加真实新条目（1 条新消息 → n=51），scrollHeight 不出现窗口外历史暴增；长会话静置 60s+ scrollTop 稳定"
  verify_by:
    type: behavior_check
---

# 对话页上跳三轮根治：refreshMessages 快照窗口对齐

## 0. 一句话

前两轮修滚动状态机都对，但真凶在数据层：refreshMessages 快照宽度（100）≠ 首屏加载宽度（50），长会话每次刷新把窗口外 50 条历史塞进列表，内容暴增 ~8800px——修复为 after=oldest 游标升序拉取，快照窗口与已加载窗口对齐。

## 1. 背景与问题现象

- 10/9 14:29 搭档报告：#1367（二轮修复）合入重启后**仍上跳**，且**左侧栏也上跳**（新症状）
- 主诉特征（两轮一致）：看最新消息时突然跳一下，跳到滚动条中间位置；历史对话更容易出现

## 2. 根因（帧级实锚，全链闭合）

### 2.1 机制链

1. 首屏加载 `api.listEntries(convId, 50)`（index.tsx:286）——长会话（实测《reseach》1293 条）只装最新 50 条
2. 60s 周期审计定时器触发 `refreshMessages`（index.tsx `PERIODIC_AUDIT_INTERVAL_MS = 60_000`）
3. 旧版 refreshMessages 固定拉尾页 `api.listEntries(convId, 100)`——**100 条**
4. `mergeMessages`（message-stream.ts:160）以快照为主体合成 → 列表 50→100 条
5. 上方凭空多出 50 条历史 ≈ +8817px（实测 sh 6667→15489）
6. 贴底用户：scrollTop 被推离（视觉「跳一下」）；中部阅读：内容位移（「跳到中间」感知）

### 2.2 实测证据（复刻环境，端口 3198）

- **修复前**（tri-msg-count.spec.ts）：t=0~55s 稳定（n=50，sh=6667，贴底）→ t=60s 整（恰为审计点）→ n=50→100、sh=6633→15544、scrollTop 6206→15068 十连帧跳变
- **时序锁定**：注入发生在 t=10s，暴动恰在 t=55-60s——与 60s 周期审计对齐，排除 SSE/轮询（5s 周期）嫌疑
- **左栏次级症状**（tri-scroll-leftpanel3.spec.ts）：后台会话 entry 注入后 5s（左栏轮询周期），左栏 scrollTop 自动 +26px（from=352 to=378）——列表重渲染致项高度变化，浏览器 clamp

### 2.3 为什么前两轮没治住

- #1344（scroll-pin 状态机）：管「谁有权写 scrollTop」——内容暴增时贴底跟随是**合法行为**，状态机不拦
- #1367（W8/RO）：修历史加载恢复与 RO 冷启动——本案 loadMore 未触发（scrollTop 从未到 0）
- 两轮共享盲区：假设「高度变化来自正常内容流」，未料数据层缺陷会**制造**暴增

### 2.4 为什么「历史对话更容易出现」

只有总条数 > 50 的会话，快照(100) > 已加载(50)，才有暴增窗口；新会话 snapshot ⊆ current 无感。

## 3. 修复设计

**原则：刷新快照必须 ⊆ 当前已加载窗口 ∪ 新条目——刷新不得改变窗口边界。**

```ts
const loaded = allMessagesRef.current[convId] || []
const oldestId = loaded.find(m => !m.id.startsWith('tmp-') && !m.id.startsWith('err-'))?.id
const resp = oldestId
  ? await api.listEntriesAfter(convId, oldestId, 200)  // after 游标升序：窗口内更新 + 新条目
  : await api.listEntries(convId, 100)                   // 空列表退化：原尾页语义
```

### 3.1 Why after 而非历史弃用决策

F20260921 弃用的是「**末位**游标」（列表尾部 seq——低位缺口时反指更早条目漏补）。本案用**头部游标**（oldest）+ after 语义：拉 oldest 之后全部（升序 ≤200）——窗口内条目已在本地（低位缺口不存在），新条目 seq 恒 > oldest。语义互补不冲突。

### 3.2 边界

| 边界 | 处理 |
|---|---|
| oldest 是 tmp-/err- 乐观条目 | find 跳过取首个真实条目；全乐观（无真实）退化尾页拉取 |
| oldestId 在后端不存在（删除等） | getEntriesAfter fail-closed 返 []，刷新退化但无害 |
| oldest 后超 200 条（断连数小时首刷） | ASC+LIMIT 截最新端（检视 S2 实锤，初版注释方向写反）——循环翻页拉到尾，上限 5 轮/1000 条防失控；超限丢弃更低批次靠 loadMoreBefore 补全。在场用户 60s 审计单轮增量恒 <200，永不进循环 |

### 3.3 不变量（单测钉死）

- mergeMessages：快照=窗口内+新条目时结果不引入窗口外历史（50→52 而非 50→100）
- listEntriesAfter 契约：after/limit 查询参数生成
- 游标筛选：tmp-/err- 不作游标

## 4. 验证

- **场景重放**（e2e tri-msg-count，同修复前场景）：t=60s 审计点 n=50→**51**（仅注入的 1 条新消息），top +87px（新消息高度的正常贴底跟随）——修复前 n=50→100/150、sh +8817px
- **三层监控**（tri-scroll-leftpanel3）：60s 静置 0 事件（修复前左栏 +26px）
- 单测：新增 refresh-window-align.test.ts 3 例全绿；全量 67 文件 673 用例绿；tsc/eslint 干净
- 最简检查：已过——改动一处调用点（10 行含注释），复用既有 listEntriesAfter API 与 mergeMessages 幂等性，无新依赖新组件

## 5. 影响范围

refreshMessages 的全部触发方受益：60s 周期审计、窗口 focus/visibility 对账、SSE 重连补偿、已读 ack 前置刷新。翻页历史（loadMoreBefore）路径不变。

## 6. 设计取舍

- **机制识别检查点**（troubleshooting 修法决策树）：未命中「补丁叠加」形态——本修复改的是刷新语义（窗口对齐不变量），非在滚动层再加一层补偿。四问：①受害场景=长会话每分钟暴增跳变；②不修则每分钟复发+用户对滚动系统信任崩塌；③后续错误路径=若只加大首屏条数（方案 B）则 >N 会话复发，若在滚动层补偿则是第三层补丁掩盖数据缺陷；④退役条件=若未来改为虚拟列表（窗口渲染），refreshMessages 快照语义随之重构，本案不变量并入虚拟列表的数据协议。

## 7. 遗留

- 左栏 +26px 跳变是次级症状（左栏轮询重渲染 clamp），主修复后实测未复现；若搭档仍感知，单独治左栏滚动位置保持（LeftPanel sessionStorage 已有恢复机制，可扩展为轮询期间保持）
- e2e tri-msg-count 留仓作回归锚（依赖复刻环境，CI 恒 skip——E2E_REPLICA_DATA 门控）；其余 6 个取证 spec 已删（探针依赖死链，检视 R1）
- **组件层覆盖缺口（检视 R3）**：refreshMessages 游标传递的组件级测试缺失——单测覆盖合并层/API 层，但「index.tsx 真实调用链传 oldest 游标 + S2 翻页循环」唯一覆盖是需复刻库+60s 窗口的 e2e（CI 永不跑）。后续若做组件测试基建（index.tsx mock 面收敛）可补
- 另案：lint-docs.mjs 动态 import dist/ validator——本地陈旧 dist 会假绿误导预检（检视附注）。建 issue 跟踪
