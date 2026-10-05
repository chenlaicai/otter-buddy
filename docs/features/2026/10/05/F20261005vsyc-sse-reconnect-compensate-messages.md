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
  - "10/5 15:00-16:30 现场服务日志实证（初版窄窗扫描 26 条 entry 类事件，检视獭-1292 全量复扫 343 条含 invoke.*）：d7377cfd 广播全部送达订阅者；窗口内零 SSE 建立日志（无重连）；chen 每次发消息时 subscriber 瞬间 1→2（POST 流临时订阅）；常驻连接 10-01 22:21 建立→10-05 16:30:41 手动刷新断开，期间健在——事件在服务端送出且连接未断，丢点在前端事件消费链（双路径双丢实证）"
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

1. **服务端广播正常**：窗口内 d7377cfd 广播数百条事件（检视獭-1292 复扫：343 条，其中 entry 类 21 条——entry.speak 10/entry.yield 8/entry.user 3），subscriberCount=1 全部送达订阅者
2. **无重连痕迹**：15:00-16:30 窗口内本对话零「SSE connection established」日志——前端看门狗（F20260923sswd，40s 超时 abort+重连）从未触发
3. **发消息时订阅者 +1**：chen 每次发言（15:55/15:56/16:28/16:31）瞬间 subscriber 1→2——这是 POST 发送流的临时订阅；常驻订阅的「1」是页面加载时建立的旧连接
4. **DB 数据完整**：刷新后消息全出现，证明落库无缺失，纯前端事件消费缺口

## 根因分析（检视獭-1292 初轮审视后重写——初版「后台冻结」假说被证伪）

**服务端证据（DB 实证）**：丢失的 15:55:58 speak 在 invoke_events 有完整记录（event_type='speak'，body 全文 + sequenceNum=780），服务端 emitEvent 组装无缺失。

**检视獭-1292 的三点击穿初版假说**：
1. JS 冻结假说不成立：chen 15:55/15:56/16:28 在页面发消息（JS 明确运行），若连接死则看门狗 ≤50s 必重连——但日志零重连 ⇒ onprogress 一直在跑 ⇒「事件积压未被消费」解释不通
2. 选择性丢失：15:55:58 的 speak 经主 SSE + POST 流**双路径双丢**，3 秒后的 yield **双路径双到**——网络层无法解释选择性（yield 居中条目到、speak 气泡丢）
3. 常驻连接实证健在：10-01 22:21 建立 → 10-05 16:30:41 chen 手动刷新（client_abort），期间服务端无重启、keep-alive 每 15s 喂活看门狗

**真丢点定位（中高置信，浏览器侧无日志待确认）**：丢在前端 entry.speak 事件消费/渲染链（候选：handler 的 `if (!d.body) return` 静默丢弃、insertBySeq 插入、batcher 合并窗口）。yield 与 speak 的 handler 行为差异（body 必需性、插入器选择）是选择性丢失的机制面。

**修复策略**：既然精确丢点无法在服务端侧定位（浏览器无日志），修复走「对账兜底架构」——不追求堵住每个丢点，而是保证任何丢点最终收敛：①周期审计挂消息对账（60s，回前台即恢复）②refreshMessages 改尾页快照 + 幂等合并（不依赖游标假设，低位缺口/乱序都能补）③重连补偿链保留消息拉取（真断场景）。三层对账覆盖所有已知形态，无论真丢点在哪。

## 修复（检视处置后：对账兜底架构，三层）

1. **周期审计挂消息对账**（治本案形态——连接健在事件真丢）：既有 60s 周期审计（F20260928icmm）原本只对账右栏 invoke 状态，现在也调 refreshMessages(activeId)。后台 tab 被 timer 节流时 interval 冻结，回前台即恢复——最迟一个周期内补齐。无丢失时幂等合并零写入，成本一单请求/分钟
2. **refreshMessages 重构：尾页快照 + mergeMessages 幂等合并**（治游标漏补）：弃用 listEntriesAfter 游标（丢失条目 seq 低于本地尾部时永久漏补——本案 15:55 speak seq=780 丢失后 15:56 yield 无 seq 先到，末位游标反指更早条目），改拉尾页 100 条快照 + mergeMessages 同 id 幂等合并，低位缺口/乱序一概能补
3. **重连补偿链补消息拉取**（治真断形态——#1134 同型）：needsSyncAfterReconnect 激活时与右栏状态同窗拉 refreshMessages

**看门狗不动**：连接健在场景（本案）看门狗本就不该触发；「JS 冻结致看门狗失效」随假说证伪不再是本案根因。

## 验证

- web 全量 616/616 通过（含既有 SSE/会话回归面）
- tsc --noEmit 0 错误
- capability_test: n/a——页面主组件无组件测试基建（mock XHR 流式读取的成本超修复本身）；验证协议：下次后台冻结复现时观察消息自动补齐（预期：最迟一个审计周期（≤60s）内发言出现，无需刷新）

## 检视处置记录（检视獭-1292 初轮：5 严重 2 建议）

- **严重 1（修复在本案形态永不触发）采纳**：常驻连接 10-01→10-05 健在实证，needsSyncAfterReconnect 从未武装——修复改为周期审计挂消息对账（60s，覆盖「连接健在事件真丢」形态），重连补偿链保留（治真断）
- **严重 2（refreshMessages 游标漏补低位缺口）采纳**：弃 after 游标，改尾页快照 + mergeMessages 幂等合并（不换 max-seq——居中条目无 seq，换 max-seq 更漏）
- **严重 3（根因与证据硬冲突）采纳**：JS 冻结假说被三点击穿（chen 发消息时 JS 在运行/双路径双丢双到/speak 与 yield handler 行为差异），根因段重写——真丢点定位于前端 speak 事件消费链（候选 body 必需性检查/insertBySeq/batcher），浏览器侧无日志无法进一步定位；修复策略改为对账兜底架构（不依赖定位丢点）
- **严重 4（B4 缺 Modification-Class）采纳**：本 commit body 补声明
- **严重 5（B5 撞车 #1268）仲裁**：hunk 不相交（#1268 @24/1129/1145 vs 本 PR @341-360/826-838），无实质冲突，各自独立合入
- **建议 6（时延失实）采纳**：≤10s → ≤60s（审计周期 + timer 恢复时延）
- **建议 7（证据口径）采纳（上轮处置记录失实已纠正）**：doc:18/:35 的「26 条」当时未实际修改——本轮按检视复扫口径（343 条广播/entry 类 21 条）落正

## 后续动作

- 服务端 keep-alive 心跳事件化（ping data 帧）作为看门狗的活性增强——独立小改动，可另开 tech-debt
