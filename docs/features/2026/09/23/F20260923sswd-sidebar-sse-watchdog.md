---
id: F20260923sswd
title: 右侧栏实时渲染根治（SSE 活性看门狗 + 切对话初始化竞态修复）
doc_type: feature

summary: |
  右侧栏海獭状态卡「运行中」（实际已休息、刷新才恢复）在 F20260922rprf 修复后仍复发。
  排查锁定两个入口、一个病根——状态正确性依赖「一次性拉取成功 + 之后事件不丢」，
  两个环节都没有自愈：
  ①入口 B：SSE 连接「静默半截」——TCP 网络闪断时浏览器 XHR 不触发 onerror/onload
  （readyState=3 悬挂），onprogress 永久停止，F20260922rprf 的断连补偿链永不激活；
  ②入口 A：SPA 切对话初始化竞态——listInvokes 排在 Promise.all 之后被慢查询拖住，
  且 .catch(() => null) 静默吞失败，错误初值永久挂着。
  修复：活性看门狗（40s 无 onprogress 主动 abort 走既有重连+补偿链）；listInvokes
  拆出并行发；去静默 catch 改延迟重试兜底（600ms/2500ms 两次，复用
  syncInvokeStatesFromServer，invokeStatesLoadedRef 标记防双拉）。

causal_links:
  from:
    - F20260922rprf
    - F20260921inrl
    - F20260913ctlv

change_type: fix
tags: [bugfix, realtime-update, SSE, right-panel, watchdog]
modules:
  - web/src/pages/conversation/index.tsx
capability_test: "n/a: 纯前端 UI 状态同步逻辑（A 类），无 LLM 参与行为"
created_in_conversation: 5603032d-569c-42c1-b318-1e3b4629ab1f
---

# F20260923sswd: 右侧栏实时渲染根治（SSE 活性看门狗 + 切对话初始化竞态修复）

Issue：#1134

## 预注册（troubleshooting 步骤 1）

- 预期根因方向：F20260922rprf 修复后仍复发，说明断连补偿链有未覆盖的触发盲区（浏览器未感知断连的场景），或初始化路径另有竞态
- 排除方向：服务端 invoke.end 发射链（日志 broadcastEvent subscriberCount=1 + DB ended_at 已写，发射链干净）

## 问题现象

右侧栏海獭状态卡「运行中」、耗时持续增加，中间栏已显示「休息一下」；手动刷新页面后右栏恢复「休息中」。F20260922rprf（#1095）修复后 2026-09-23 复现。搭档补充：场景多为「点进某对话时发现状态就是错的」，电脑未休眠。

## 根因（证据锚点见 issue #1134）

两个入口、一个病根——状态正确性依赖「一次性拉取成功 + 之后事件不丢」，两个环节都没有自愈。

### 入口 B：SSE 连接「静默半截」

TCP 网络闪断时（Wi-Fi 抖动、路由换信道等，无需休眠），浏览器 XHR 流式读取**既不触发 onerror 也不触发 onload**（readyState=3 悬挂），onprogress 永久停止。F20260922rprf 的补偿逻辑挂在「浏览器意识到断连」的前提上（needsSyncAfterReconnect 只在重连后首次 onprogress 消费），静默死亡场景下 scheduleReconnect 永不执行、补偿永不激活。服务端证据：broadcastEvent 日志确认 invoke.end 已推送且 subscriberCount=1，DB ended_at 已写——发射链干净，丢在投递层。

### 入口 A：SPA 切对话初始化竞态

SPA 下切对话组件不重挂载（F20260921inrl，#1076），loadConversationDetail 中 listInvokes 排在 `Promise.all(listEntries/getKeyResources/getParticipants)` 之后——大库下慢查询拖住右栏状态恢复；窗口期内 SSE 已订阅，旧 invoke 的 tick 事件触发「无 prev 新建 running 态」画错右栏；且 listInvokes 失败被 `.catch(() => null)` 静默吞掉，错误初值永久挂着直到手动刷新。

## 修复内容

1. **活性看门狗**（治 B）：服务端有 15s keep-alive，正常连接下 onprogress ≤15s 必触发。SSE 订阅 effect 内加哨兵（10s 间隔检查）：onprogress 记录 lastProgressAt，超 40s 无回调 → notifyConn(false) + xhr.abort() + 走既有 scheduleReconnect（重连+补偿链复用）。看门狗只在首个有效连接安装一次（防重连叠加 interval），cleanup 时清理。
2. **listInvokes 拆出并行**（治 A-1）：从 Promise.all 依赖链拆出，与 entries/participants 并行发，不再被慢查询拖住。
3. **去静默 catch + 延迟重试**（治 A-2）：内联拉取失败 → console.warn + 600ms/2500ms 两次延迟重试（复用 syncInvokeStatesFromServer；mergeInvokesFromServer 幂等，重试安全）。新增 invokeStatesLoadedRef 标记：内联成功置 true，重试链路读标记跳过防双拉；loadConversationDetail 入口重置标记（新会话需重新恢复）。

## 核心行为

| ID | 触发条件 | 预期行为 |
|----|----------|----------|
| B1 | SSE 连接静默死亡（>40s 无任何数据含 keep-alive） | 看门狗主动 abort + 重连；重连后补偿拉取 invoke 状态，右栏自愈 |
| B2 | SSE 正常心跳（15s keep-alive 注释行到达） | lastProgressAt 持续刷新，看门狗不误判 |
| B3 | 切对话 listEntries 慢/participants 慢 | listInvokes 并行发出不被拖住，右栏状态按时恢复 |
| B4 | 切对话 listInvokes 网络失败 | 不静默吞：warn + 600ms/2500ms 重试；任一成功即收敛 |
| B5 | 内联拉取已成功 + 重试定时器后到 | invokeStatesLoadedRef=true，重试链路跳过（不双拉） |

## 验证

- `web`：536/536 测试全绿（58 文件），含 index.spa-nav.test.tsx 新增 2 个回归测试
  （listInvokes 成功恢复 / 失败后延迟重试兜底链，fake timers）
- `npx tsc --noEmit`：exit 0
- `npm run build`：✓ built
- 看门狗逻辑本身（XHR 静默死亡模拟）需浏览器环境，jsdom 无法复现——靠代码路径复用
  （abort→scheduleReconnect→needsSyncAfterReconnect 既有链路已被 F20260922rprf 测试覆盖）

## 设计取舍（Modification-Class: mechanism-addition 申报四问）

本变更净新增两个机制：①10s 间隔哨兵看门狗（SSE 活性主动检测）；②invokeStatesLoadedRef
防双拉标记 + invokeRetryTimersRef 重试清理。按机制新增申报：

1. **为什么必须新增而不是复用现有机制**：现有重连链（onerror/onload → scheduleReconnect）
   的前提是「浏览器感知到断连」；XHR 流式读取在 TCP 静默死亡时不触发任何回调——这是浏览器
   API 行为盲区，无任何现有机制能捕获。只能靠「服务端 15s keep-alive 必然周期性触发
   onprogress」这一不变量主动检测。
2. **为什么阈值取 40s / 哨兵间隔 10s**：keep-alive 周期 15s，40s ≈ 2.7 个周期，
   足够容忍单次心跳延迟（GC 停顿/事件循环拥堵），又远小于用户可感知的卡顿时长；
   10s 哨兵间隔使检测延迟在 40-50s 之间，定时器开销可忽略。
3. **误报代价**：看门狗误触发 = 一次多余重连 + 补偿拉取（mergeInvokesFromServer 幂等），
   代价是一次 HTTP 请求，可接受；漏报代价是用户看到永久错误状态，不可接受——偏向敏感。
4. **为何不修浏览器侧根源**（如换 EventSource/fetch stream）：SSE 端点是 GET 订阅，
   本可用 EventSource，但现有 XHR 方案承载着手写增量解析与重连退避，整体替换成本高、
   收益等同（EventSource 同样存在静默死亡场景，仍需看门狗）——看门狗是传输层无关的兜底。

## 影响范围

- `web/src/pages/conversation/index.tsx`：SSE 订阅 effect（看门狗）+ loadConversationDetail（并行+重试）+ syncInvokeStatesFromServer（标记防双拉）
- `web/src/pages/conversation/index.spa-nav.test.tsx`：+2 回归测试
- 无服务端改动；无 API 契约改动
