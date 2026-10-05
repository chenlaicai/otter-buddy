---
id: F20261005vsyc
title: SSE 断连补偿链补消息增量：后台冻结/连接假死恢复后发言实时渲染丢失
summary: chen 目击现场（10/5 15:00-16:30 实时看不到獭发言、刷新全出现）——SSE 重连补偿链只对账右栏 invoke 状态不补消息列表，断连窗口丢的 entry.speak 永久缺失。修复=重连成功补偿拉取加 refreshMessages 增量同步
change_type: fix
capability_test: "n/a: 页面主组件（1657 行）无组件测试基建，mock XHR 流成本超修复本身；走事件链路推演+全量回归（616/616）+验证协议"
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
tags: [web, sse, conversation, realtime, frontend]
modules:
  - web/src/pages/conversation/index.tsx
from:
  - F20260922rprf
  - F20260923sswd
  - F20260924ircc
  - F20260921urdo
  - F20260928icmm
causal_links:
  - "10/5 15:00-16:30 现场服务日志实证：d7377cfd 广播 26 条事件 subscribers=1 全送达；窗口内零 SSE 建立日志（无重连）；chen 每次发消息时 subscriber 瞬间 1→2（POST 流临时订阅）——常驻订阅为页面未刷新的旧连接，后台冻结期事件积压在 responseText 未被 JS 处理"
created_at: "2026-10-05"
intent:
  problem: "后台 tab JS 节流/冻结或连接假死恢复后，断连窗口内丢失的 entry.speak/entry.user 消息事件无补偿链，历史发言实时渲染永久缺失（直到手动刷新）"
  expected_effect: "断连/冻结恢复后消息列表自动补齐（用户不再需要手动刷新）；与右栏 invoke 状态对账同窗触发"
  verify_by:
    type: static_only
---

# SSE 断连补偿链补消息增量

## 现象（chen 目击现场，10/5 15:00-16:30）

「实时渲染没看到你们的发言！但我一刷新页面，你们的发言就都出现了」——期间本对话獭间活动密集（检视獭往返、yield 交接），chen 的页面只显示居中条目（系统条目「检视獭-1284 加入了对话」等），speak 气泡全部缺失，刷新后全量出现。

## 排查证据链（服务日志 + DB 双源）

1. **服务端广播正常**：窗口内 d7377cfd 广播 26 条事件（invoke.event/entry.speak/entry.yield 等），subscriberCount=1 全部送达订阅者
2. **无重连痕迹**：15:00-16:30 窗口内本对话零「SSE connection established」日志——前端看门狗（F20260923sswd，40s 超时 abort+重连）从未触发
3. **发消息时订阅者 +1**：chen 每次发言（15:55/15:56/16:28/16:31）瞬间 subscriber 1→2——这是 POST 发送流的临时订阅；常驻订阅的「1」是页面加载时建立的旧连接
4. **DB 数据完整**：刷新后消息全出现，证明落库无缺失，纯前端事件消费缺口

## 根因分析

两个复合缺口：

**缺口 1（主因）：补偿链不对账消息**。F20260922rprf 的重连补偿机制（needsSyncAfterReconnect → 首个 onprogress 触发）只调 syncInvokeStatesFromServer（右栏 invoke 状态）——entry.speak/entry.user 消息事件在断连/冻结窗口丢失后**没有任何补偿拉取**。SSE 无回放，丢了就是丢了。

**缺口 2（诱因）：看门狗与 JS 冻结同源失效**。40s 活性看门狗靠 setInterval(10s) 检查 lastProgressAt——后台 tab 被 macOS/Chrome timer throttling 节流（interval 降到 ≥60s 甚至冻结）时，看门狗与 onprogress 一起冻结，「连接静默死亡」检测失效。连接实际活着（服务端 keep-alive 持续写），事件积压在 responseText 中未被 JS 消费——恢复可见性的瞬间若 onprogress 补跑，事件其实能到；若浏览器丢弃了积压（内存压缩后 responseText 截断），事件真丢。缺口 1 在两种形态下都是最终兜底。

**为什么 focus 对账没救回来**：F20260921urdo 的 focus/visibilitychange 处理器会调 refreshMessages——但案发时 chen 的「实时渲染」观察发生在 tab 可见状态（他盯着页面看交接），不触发 visibilitychange；且 300ms 防抖窗口内若 JS 刚从节流恢复，focus 事件可能已错过。而 needsSyncAfterReconnect 路径在「连接从未断开」（只是 JS 冻结）时根本不激活。

## 修复

重连补偿链补消息增量（一行实质改动 + effect 依赖）：

```diff
 if (activeId && needsSyncAfterReconnect) {
   needsSyncAfterReconnect = false
   void syncInvokeStatesFromServer(activeId)
+  void refreshMessages(activeId)  // 增量拉取断连窗口丢失的消息条目
 }
```

refreshMessages（F20260913ctlv 增量刷新）按本地最新 seq 游标 listEntriesAfter——无新条目零写入，幂等安全；有丢失条目则补进 state 并按聚焦态 ack。

**为什么不改看门狗**：缺口 2 的「看门狗被节流」无法用 JS 自身修复（节流面前一切 timer 平等），治本在服务端事件化心跳（ping data 帧）——但那是独立增强（前端可把「收到 ping」记为活性），与本修复正交。缺口 1 修复后，只要看门狗最终触发重连（tab 回前台 interval 恢复，最迟一次 40s 检查即 abort），补偿链即补齐消息——形成闭环。

## 验证

- web 全量 616/616 通过（含既有 SSE/会话回归面）
- tsc --noEmit 0 错误
- capability_test: n/a——页面主组件无组件测试基建（mock XHR 流式读取的成本超修复本身）；验证协议：下次后台冻结复现时观察消息自动补齐（预期：切回/唤醒后 ≤10s 内发言出现，无需刷新）

## 后续动作

- 服务端 keep-alive 心跳事件化（ping data 帧）作为看门狗的活性增强——独立小改动，可另开 tech-debt
