---
id: F20260921spcm
title: SPA 路由切换对话时消息列表重新拉取（切回看过的对话不再吃旧缓存）
summary: PR #1057 SPA 化后，点左侧栏进入看过的对话时命中 allMessages 旧缓存跳过拉取，海獭切走期间的新发言不可见（需 F5）。守门条件从「缓存不存在才拉」改为「activeId 变化即拉」，恢复 MPA 时代「进入对话即拉最新」语义。
change_type: fix
capability_test: "n/a: 纯前端数据流修复，无 LLM 参与行为"
created_in_conversation: f0f725f8-0bc3-430d-9ff1-99ac7cc6d34f
causal_links:
  - type: caused_by
    target: F20260920spag
    reason: SPA 化把整页跳转改为客户端路由后暴露本缺陷
tags: [web, spa, conversation, cache, routing, regression]
modules: [web/src/pages/conversation/index.tsx]
---

# SPA 路由切换对话时消息列表重新拉取

## 预注册（troubleshooting 防改口）

- 预期根因方向：#1057 SPA 化后，详情页在路由切换/进入时未重新拉取消息列表
- 验证标准：#1057 diff 中存在「进入对话不再重新 fetch」或「SSE/轮询在 SPA 导航下失效」的代码证据
- 最强反例方向：若路由切换逻辑正确（每次都 refetch），转向 #1053（turn 退役）的消息写入路径变化

**预期 vs 实际**：命中。#1057 diff 确认点击行为从 `window.location.href`（整页刷新）改为 `navigate()`（客户端路由），且消息加载守门条件未随之调整。

## 问题现象

搭档报告（2026-09-21）：「海獭发言，我在左侧栏的简要消息中能看到，然后点进去发现没有，需要刷新下页面才有。昨天之前没遇到过。」

三段症状拆解：

1. 左栏能看到 → 对话列表 5 秒轮询正常（`useConversationListPolling`）
2. 点进去没有 → 详情数据停留在旧缓存
3. F5 后有 → 整页刷新重挂载组件、清空缓存、重新拉取

## 根因分析

三处证据叠加（file:line 以 2026-09-21 main 为准）：

1. **#1057 改变了导航语义**：`web/src/pages/conversation-list/index.tsx` 与 `web/src/pages/conversation/index.tsx` 中，点击对话从 `window.location.href = /conversation/${id}`（MPA 整页刷新，组件必然重挂载）改为 `navigate()`（SPA 客户端路由，`/conversation/:id` 参数变化时组件**保持挂载**——见 main.tsx 路由表，同一路由不同参数复用组件实例）。
2. **消息加载守门条件未跟随**：`web/src/pages/conversation/index.tsx:439-442`（修复前）——`useEffect(() => { if (activeId && !allMessages[activeId]) loadConversationDetail(activeId) }, [activeId, allMessages, ...])`。SPA 下切回看过的对话时 `allMessages[activeId]` 已存在，条件为假，**fetch 被跳过**。
3. **切走期间的事件永久丢失**：常驻 SSE 只订阅当前 `activeId`（`/api/conversations/${activeId}/subscribe`，effect 依赖 `[activeId]` 切换才重建）；服务端 subscribe 纯转发新事件、无历史回放（`src/interface-adapters/http/controllers/message-controller.ts:93-104`）。增量刷新 `refreshMessages` 仅在 POST 流的 SSE onError 兜底触发（index.tsx:966），非周期轮询。

三环相扣：缓存跳过 × 无回放 × 无兜底轮询 = 切回对话后新发言不可见，唯一恢复途径是 F5 重挂载。

## 修复

修法排序①（既有机制语义内修）：守门条件从「缓存不存在才拉」改为「activeId 变化即拉」。

```diff
-  useEffect(() => {
-    if (activeId && !allMessages[activeId]) {
-      loadConversationDetail(activeId)
-    }
-  }, [activeId, allMessages, loadConversationDetail])
+  useEffect(() => {
+    if (activeId) {
+      loadConversationDetail(activeId)
+    }
+  }, [activeId, loadConversationDetail])
```

- 恢复 MPA 时代「进入对话 = 拉最新数据」的用户可感知语义（MPA 下每次导航都是全新 mount + fetch，本修复等价）
- `loadConversationDetail` 同时刷新未读分隔线、invoke 状态恢复、参与者列表、key resources——这些状态同样会过期，一并收敛
- `allMessages` 移出依赖数组：拉取结果 setState 会更新 `allMessages`，若留在依赖里会重触发本 effect 造成死循环（原代码靠守门条件短路，新代码靠依赖数组收窄）

**机制识别检查点自检**：未新增配置/状态/定时任务/信号/持久化/决策分支/跨模块调用——纯条件收窄。走修法①，commit 声明 `Modification-Class: narrow-fix`。

**既有性能语义保留**：`allMessages` 按 convId 分键缓存（`setAllMessages(prev => ({ ...prev, [convId]: msgs }))`）——同对话内不重拉，切对话重拉一次，与 MPA 行为一致，无新增网络放大。

## 验证

**失败用例证据链**（troubleshooting 5a 固化，`web/src/pages/conversation/index.spa-nav.test.tsx`）：

- 修复前失败输出（vitest，2026-09-21 09:12）：
  ```
  FAIL  src/pages/conversation/index.spa-nav.test.tsx > 切回看过的对话时，listEntries 必须再次调用并渲染切走期间的新发言
  AssertionError: expected [ 'conv-a', 'conv-b' ] to deeply equal [ 'conv-a', 'conv-b', 'conv-a' ]
  ```
  精确复现：A → B → 切回 A，第三次 `listEntries('conv-a')` 未发生（缓存命中跳过），「切走期间海獭的新发言」断言不可达。
- 修复后通过：`Test Files 1 passed (1) / Tests 1 passed (1)`，断言 `['conv-a', 'conv-b', 'conv-a']` 通过、新发言渲染可见。
- 回归面：web 单测 56 文件 505 用例全绿（含本测试）；`tsc --noEmit` 干净。

测试场景编排说明：A → B → 切回 A（而非 A → B 首访）——B 首访时缓存不存在、原逻辑也会拉取，不构成 bug 触发条件；必须「切回看过的对话」才命中旧缓存，与搭档报告的场景严格一致。

## 影响面

- **行为变化**：切换对话时多一次 `listEntries` 请求（50 条）+ 伴生请求（unread/invokes/key-resources/participants）——每次切换一组，与 MPA 整页刷新时的请求量相同，用户无感
- **未覆盖**：同一对话内切走再切回期间的历史条目已通过本修复覆盖；纯实时增量（对话内 SSE 断连重连间隙的补洞）依赖既有 onError 兜底，不在本缺陷范围
- **关联回归源**：F20260920spag（PR #1057）SPA 化引入；本修复为窄修复，不动 SPA 架构

## 审视处置记录

检视獭：检视1072（mimo，异体模型）。结论：通过，0 严重 / 1 建议。

焦点验证：①activeId 变化链路完整性（useParams → effect[243] → setActiveId → effect[438] → loadConversationDetail）链条完整；②快速 A→B→A 竞态——无 AbortController 但分键隔离互不覆盖，预存问题无新增风险；③测试保真度——createMemoryRouter + navigate() 等价真实 SPA 导航，A→B→A 编排精确复现触发条件。

建议发现处置：
- D1（建议）：`useEffect([urlConvId])` 在 SPA 下每次切对话重拉全量对话列表 + 设置（#1057 预存债务，注释仍停留 MPA 前提）→ 接受，建 issue #1074 跟踪（检视獭建议方案：activeId 从 urlConvId 派生）。不扩大本 narrow-fix 范围。

独立验证：单测 505 全绿、tsc 干净、CI（check/e2e/golden-selftest）SUCCESS、特性文档与实现一致性、与 PR #1070 无冲突——均由检视獭独立复核。
