---
id: F20260922cgrp
title: 对话管理机制优化：归档报错修复 + 左侧栏三分组分页 + 弱状态两态管理
doc_type: feature

summary: |
  搭档三个诉求的合并实现：①修复「归档」按钮 400 报错（根因：状态机只允许
  completed→archived，而 UI 对 active 对话开放归档入口）；②左侧栏重构为
  《IM 助理》《对话》《已归档》三分组（可折叠、组头计数、折叠态 localStorage 持久化），
  《对话》组内置顶区加区分底色 + 普通区每页 20 条页码跳转（退役「加载更多」）；
  ③搭档追加拍板：对话弱状态管理——completed 状态整体退役，只剩 active | archived，
  归档即「移到独立空间」。后端 listConversations 链路加 status/kind 过滤并返回
  { items, total }（breaking change，全部调用点已适配）。

causal_links:
  from:
    - F20260918imas
    - F20260916lpsc

change_type: feature
tags: [conversation, archive, pagination, ui, state-machine, weak-state]
modules:
  - src/entities/conversation/conversation.ts
  - src/usecases/conversation/manage-conversation.ts
  - src/frameworks/db/conversation/sqlite-conversation-repository.ts
  - src/interface-adapters/http/controllers/conversation-controller.ts
  - web/src/pages/conversation/LeftPanel.tsx
  - web/src/pages/conversation/index.tsx
  - web/src/pages/conversation-list/index.tsx
capability_test: "n/a: 纯 A 类改动（UI 分组/分页 + 状态机收窄 + API 过滤参数），无 LLM 参与行为"
created_in_conversation: 7d20a136-83e4-4a37-8e56-b427d94ae149
---

# 对话管理机制优化：归档报错修复 + 左侧栏三分组分页 + 弱状态两态管理

## 背景

搭档 2026-09-22 原话诉求：

1. 「现在点击《归档》会报错」——生产日志 16:17 实锤 PATCH /api/conversations/:id/archive 返 400
2. 左侧栏分《IM助理》《对话》《已归档》三分组，可折叠/展开，前两个默认开、已归档默认关，组头显示当前对话数
3. 《对话》下分置顶和普通，置顶底色要不一样（边界看不清）
4. 分组下分页：一页固定 20 个，不做下拉加载更多，底部页码跳转（1 2 3 … 10）

**范围变更（同日搭档追加拍板，优先级最高）**：「状态机这个也可以移除了，现在就两个状态，
正常 > 归档，没有完成一说了，咱们对话是弱状态管理。就算是归档，其实也就是移到一个独立空间」
——completed 状态整体退役（生产库零 completed 存量，已核实），canArchiveConversation
从「completed→archived」改为「active→archived」，PATCH /complete 路由与 complete() 用例删除。

## 设计取舍

**机制识别检查点判定（本特性未经 RA 流程，动手前完成）**：命中——左侧栏三分组分页是新 UI 机制，
completed 退役是状态机语义变更。四问：

1. **为什么需要新机制？** 旧「加载更多」追加模式与分组视图天然冲突（分组内追加会跨组错位），
   且归档对话无入口查看；搭档明确「有分组就不适合下拉加载更多」。
2. **能否用既有机制达成？** 不能——列表 API 无 status 过滤，归档对话在 SQL 层被
   `WHERE status != 'archived'` 永久排除，前端拿不到已归档数据。
3. **后续机制会怎么演进？** unarchive（取消归档）是已识别的后续项——本特性不做
   （后端无接口，搭档诉求是「从分组里移除」而非「恢复」），归档为终态。
4. **退役条件？** 若未来对话量级稳定在 <20，分页器自动隐藏（total ≤ 20 不渲染）；
   completed 状态机无退役条件问题（已退役，生产零存量）。

**关键技术取舍**：

- **归档报错修法**：不修 UI 入口（把归档按钮藏起来）而修状态机——搭档语义就是
  「active 对话可归档」，UI 行为是对的，错的是状态机过时约束。
- **listConversations 返回 { items, total }（breaking）**：total 是页码跳转的必要输入
  （不知道总数无法渲染 `1 2 3 … N`）；数组 → 对象的破坏性变更一次性适配全部 6 个调用点
  （client.ts、conversation 页、conversation-list 页、im 页、LeftPanel 搜索、state-inventory），
  优于保留旧结构另开 /count 端点（两次请求 + 一致性窗口）。
- **数据源分工**：IM 助理 + 置顶区来自父组件 conversations（全量拉 active，数量小）；
  普通对话 + 已归档由 LeftPanel 内部独立分页查询（每页 20 条 + total）。理由：置顶区必须
  全量可见（分页会藏置顶项，违背置顶语义）；助理对话数量小（IM 开户频率低）不值得分页。
- **折叠状态 localStorage**：key 为 `leftPanel:collapsed:<group>`，默认 助理开/对话开/归档关
  （搭档原话）。跨设备不同步（localStorage 单机）——对话列表本身也是本机视图，可接受。
- **completedAt 字段保留**：DB 列不动（历史数据可读），DTO 保留该字段（恒 null 或旧值），
  只退役状态机与写入路径。
- **搜索态不重构**：命中结果保持既有平铺行为（替换列表、不分组不分页）——搜索语义是
  「跨组找特定对话」，分组反而干扰。搜索范围不含已归档（搜索请求不传 status，服务端缺省
  排除 archived——要找归档对话请展开《已归档》组浏览）。

## 实现

**后端**：
- `entities/conversation/conversation.ts`：`ConversationStatus` 收窄为 `"active" | "archived"`；
  删除 `canCompleteConversation`；`canArchiveConversation` 改为 `status === "active"`。
- `sqlite-conversation-repository.ts`：`listConversationsWithMeta` 加 status/kind 过滤，
  返回 `{ items, total }`（total = 满足过滤条件的总数，单独 COUNT 查询）；where 构建抽
  `buildConversationListWhere`（lint 复杂度约束）；`updateStatus` 删 completed 分支。
- `manage-conversation.ts`：删除 `complete()` 用例；`listWithMeta` 透传新过滤参数。
- `conversation-controller.ts`：list 解析 status/kind query 参数（非法值静默忽略走缺省），
  响应 `{ items, total }`；删除 `complete()` handler。
- `router.ts`：删除 `PATCH /api/conversations/:id/complete` 路由。
- `api-contract/api/conversation.ts`：status 收窄为 `"active" | "archived"`；
  新增 `ConversationListResponseDTO { items, total }`。

**前端**：
- `LeftPanel.tsx` 重构：三分组 GroupHeader（chevron 折叠 + 计数）+ Pagination 组件
  （`‹ 1 2 3 … N ›`，N>10 折叠中间页：首尾 + 当前±2）；置顶项 `bg-otter-100/50` 底色区分；
  移除 onLoadMore/hasMore/loadingMore props（「加载更多」机制退役）。
- `client.ts`：`listConversations` 返回 `ConversationListResponseDTO`，加 status/kind 参数。
- `conversation/index.tsx`、`conversation-list/index.tsx`、`im/index.tsx`、
  `use-conversation-list-polling.ts`：全部适配 { items, total } 结构。
- `ChatView.tsx`：状态徽标去「已完成」分支（活跃 | 已归档）。

**不做**：unarchive 接口（无需求，归档即终态）；搜索行为变更；conversation-list 页布局改动
（仅适配）；messages/entries 逻辑。

## 负面向条目（破坏了什么旧契约）

1. **`GET /api/conversations` 响应结构**：`ConversationListItemDTO[]` → `{ items, total }`。
   已适配调用点清单：web/src/api/client.ts、pages/conversation/index.tsx（3 处）、
   pages/conversation-list/index.tsx（2 处）、pages/im/index.tsx（1 处）、
   hooks/use-conversation-list-polling.ts、LeftPanel.tsx 搜索、
   src/frameworks/agent/state-inventory.ts。无其他消费者（grep 全仓确认）。
2. **PATCH /api/conversations/:id/complete 路由删除**：前端无入口（ChatView 无「完成」按钮），
   生产库零 completed 存量——死代码退役，无真实消费者。
3. **`ConversationStatus` 类型收窄**：`"completed"` 不再是合法值。注意边界：消息/invoke/entry
   级的 `'completed'`（MessageStatus/EntryStatus/scheduler execution）与对话状态无关，不受影响。

## 验证

- 单测：后端 273 文件 3737 用例全绿；web 58 文件 528 用例全绿。
  - entities：`canArchiveConversation` 两态用例（active 可归档 / archived 终态拒绝）。
  - usecase：`archive` active→archived / archived 重复归档 400；`complete` describe 删除。
  - repository：status/kind 过滤 + total 断言（含归档排除、分页跨页、LIKE 转义既有用例适配）。
  - API：list 响应 { items, total }、status/kind 透传、非法值静默忽略。
  - web LeftPanel：三分组渲染/默认折叠态/localStorage 持久化/分页器交互/置顶底色/计数。
- lint：0 error（8 warning 均为 pre-existing，与本次变更无关的文件）。
- typecheck：后端 + web 均 0 error。
- 真机 UI 自查：alpha 实例无头浏览器截图（见对话工作区 screenshots/）。
- 最简实现检查：已过——分页器为组件内 ~50 行实现（未引第三方分页库）；where 构建复用
  现有 SQL 拼接模式；折叠持久化用 localStorage（平台原生，无新依赖）。

## Delta 修复记录（PR #1119 检视处置，2026-09-22）

检视獭（mimo）首轮审视发现 3 严重 + 5 建议，全部接受并当场修复（更好/更差判断均为「改了更好」）：

1. **严重：组头计数双重计数置顶**——`ListConversationsFilter` 新增 `pinned?: boolean`，
   SQL 加 `AND c.pinned = 0/1` 子句；普通区拉取传 `pinned: false`，items/total/组头计数
   三位一体对齐（原 `pinnedConvs.length + normalTotal` 中 normalTotal 恒含置顶）。
2. **严重：页数收缩空白页死锁**——normal/archived 两个 load 回调加 clamp：
   `items.length === 0 && page > pageCount` 时回退到新末页重拉，页码器永远有回去的路。
   新增 LeftPanel clamp 测试（45→20 条收缩场景）。
3. **严重：归档菜单点击穿透**——右键菜单「归档对话」onClick 加
   `status !== 'archived'` 守卫（原仅 className 置灰，本 PR 让 archived 对话首次可右键
   激活了该路径，与本 PR 主目标直接冲突）。
4. 建议（归档错对象，pre-existing 顺手修）：`confirmArchive(cid)` 透传 modal.cid
   替代 activeId——右键非当前对话归档的应是该对话；仅当归档当前对话时才整页跳转，
   否则 SPA 原地刷新 + toast。
5. 建议（mock 残留）：tests/api/helpers.ts 删已退役的 complete mock 方法名。
6. 建议（limit:500 截断）：conversation-list 页接 total，超限显示
   「仅展示前 500 条（共 N 条）」提示（最简实现：提示条而非引入分页器——该页是入口页，
   对话浏览主路径在 conversation 页）。
7. 建议（轮询请求放大）：折叠组跳过分页拉取——归档组默认折叠，不再每 5s 白拉；
   展开时因 collapsed 依赖变化自动重拉（stale 标记为防御性冗余）。
8. 建议（文档）：搜索态段补「搜索范围不含已归档」。

验证：后端 273 文件 3757 用例全绿（含新增 pinned 过滤 3 用例）；web 58 文件 529 用例
全绿（含新增 clamp 用例）；lint 0 error（parseListFilter 抽 parseBoolQuery 压复杂度）；
typecheck 双端 0 error。delta 真机复验（隔离实例 3194）：计数口径（对话组头 25 = 2 置顶 +
23 非置顶，修复前 27）、归档组折叠时计数常显（3）、归档项右键菜单守卫生效
（cursor-not-allowed + 点击不穿、modal 不弹），截图 screenshots/05/06。

**delta 过程中新发现（第 9 条，当场修复）**：右键归档项菜单整体不渲染——
`activeConvForMenu = conversations.find(cid)` 的数据源是 active-only 列表，归档项 find 落空
→ 菜单条件渲染整体跳过（两页同缺陷）。修复：find 落空时按 `status: 'archived'` 合成最小对象；
conversation-list 页对归档项不渲染菜单（该页菜单只有置顶项，对 archived 无意义）。
另：建议 7 的折叠跳过拉取初版导致归档组头计数恒 0（搭档诉求「组头显示对话数」），
调整为折叠时仅拉轻量计数（limit=1 取 total）。
