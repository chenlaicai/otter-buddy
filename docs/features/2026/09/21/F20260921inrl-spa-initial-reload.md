---
id: F20260921inrl
title: SPA 切换对话不再重拉列表与设置（activeId 从路由参数派生）
summary: '#1074 债务清理：`useEffect([urlConvId])` 在 SPA 下每次切换对话重跑 loadInitialData（全量对话列表）+ getSettings。activeId 改为从 useParams 直接派生（去 useState 中转），初始化 effect 收窄为 mount-only；深链接指向不存在对话时 navigate(replace) 兜底为列表首个。'
change_type: fix
capability_test: "n/a: 纯前端数据流修复，无 LLM 参与行为"
created_in_conversation: f0f725f8-0bc3-430d-9ff1-99ac7cc6d34f
causal_links:
  - type: caused_by
    target: F20260920spag
    reason: SPA 化（#1057）使 [urlConvId] 依赖在切换时反复触发，MPA 前提失效
  - type: follows
    target: F20260921spcm
    reason: 同一回归家族的债务侧收尾（PR #1072 检视獭建议发现 D1 → issue #1074）
tags: [web, spa, conversation, routing, tech-debt]
modules: [web/src/pages/conversation/index.tsx]
---

# SPA 切换对话不再重拉列表与设置（#1074）

## 问题现象

PR #1072 检视獭「检视1072」建议发现（D1）：`web/src/pages/conversation/index.tsx` 的初始加载 `useEffect` 依赖 `[urlConvId]`——MPA 时代（整页跳转必重挂载）该依赖等价于 mount-only；#1057 SPA 化后，切换对话只是参数变化、组件不重挂载，effect 每次切换重跑：

- `loadInitialData()` → GET /api/conversations（全量 50 条）
- `api.getSettings()` → GET /api/settings

纯冗余请求（列表新鲜度已有 5s 轮询保障），不影响正确性。代码注释仍停留 MPA 前提（「mount 后不变，行为等价」）。

## 修复

修法排序①（既有机制语义内修）——检视獭在 issue #1074 中给出的方案落地：

1. **activeId 从路由参数直接派生**（去 useState 中转）：`const activeId = urlConvId ?? null`。切换对话只变 urlConvId，消息加载 effect（F20260921spcm）依赖 `[activeId]` 照常触发详情拉取。`activeIdRef` 镜像 effect 不变（F20260921urdo 判定换轨依赖），派生值同样被镜像。
2. **初始化 effect 收窄为 mount-only**（`[]`）：拉列表 + 设置 + 首次 pageState 判定，只跑一次。加了 `disposed` 标志防 unmount 后 setState。
3. **深链接兜底改走 navigate(replace)**：URL 指向不存在/已删除对话时，`navigate(/conversation/${convs[0].id}, { replace: true })`——URL 与视图一致（可刷新可分享）。旧代码只 setActiveId 不改 URL（旧 URL 再刷新一次还是进不了目标对话）。**不 early-return**：pageState 判定不依赖 navigate 完成，早退会卡 loading 态（实现中踩过，测试锚定）。

### 为什么这是收窄而非行为变化

- MPA 时代每次进入页面 = mount + 一次列表拉取 + 一次设置拉取——本修复后 SPA 下整个生命周期恰好也是 mount 时拉一次，语义对齐。
- 切换对话时的详情拉取（entries/unread/invokes/key-resources/participants）由 F20260921spcm 的 `[activeId]` effect 承担，不受影响。

**机制识别检查点自检**：未新增配置/状态/定时任务/信号/持久化/决策分支/跨模块调用——activeId 从 state 变为派生值是状态收窄（净删除一个 useState），走修法①，commit 声明 `Modification-Class: narrow-fix`。

## 验证（失败用例证据链）

新增 2 用例（`web/src/pages/conversation/index.spa-nav.test.tsx`，复用 F20260921spcm 的测试基建）：

1. **切换对话不重拉列表与设置**：mount 各一次 → navigate 到 B → 断言 `listCalls`/`settingsCalls` 仍为 1、`listEntriesCalls` 为 `['conv-a','conv-b']`（详情照拉）+ B 内容渲染。
   - 修复前失败：`AssertionError: expected 2 to be 1`（列表被重拉）
   - 修复后通过。
2. **深链接兜底**：initialEntry `/conversation/conv-gone` → 断言 URL 替换为 `/conversation/conv-a`、内容渲染、entries 拉取发生。
   - 修复前失败：URL 不变（旧代码只 setActiveId）+ 修复中 early-return 版本曾卡 loading（`expected '' to contain 'A的第一条'`）
   - 修复后通过。

回归面：web 单测 57 文件 510 用例全绿；tsc --noEmit 干净。F20260921spcm 原用例（切回看过的对话重拉详情）不受影响。

### 测试基建备注

- mock 的列表分支须精确匹配 `/api/conversations?`（带 query）或裸 `/api/conversations`——宽匹配 `/api/conversations` 开头会把 entries/participants 等子路径请求误计入列表计数（实现中用 fetch 调用栈探针定位过，教训记档）。
- 兜底 navigate 是异步链（loadInitialData 完成后触发），断言前需两轮 flushAsync。

## 影响面

- 行为变化（正向）：切换对话少 2 个冗余请求；深链接指向已删除对话时 URL 会被替换为有效对话（旧版为静默显示首个对话但 URL 保留死链）。
- `setActiveId` 调用点唯一（原初始加载处），无其他消费者受影响；`activeIdRef` 镜像链路（#1070 未读判定）不变。
- 与 #1070（F20260921urdo，未读机制）同文件相邻区域，本修复基于其合入后的 main（9db47b77）开发，`activeIdRef` 语义完整保留。
