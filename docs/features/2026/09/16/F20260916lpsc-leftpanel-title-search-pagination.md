---
id: F20260916lpsc
title: 左侧栏对话标题搜索 + 对话列表分页加载更多
summary: 左侧栏顶部搜索按钮从「跳转记忆搜索」改为就地展开搜索框按对话标题关键字过滤（服务端 LIKE 子串匹配，通配符转义）；对话列表突破首屏 50 条硬截断，底部「加载更多」分页追加，轮询合并保留已加载的后续页
change_type: feature-update
tags: [web-ui, conversation, search, pagination, left-panel]
modules: [src/interface-adapters/http/controllers/conversation-controller.ts, src/usecases/conversation/conversation-repository.ts, src/usecases/conversation/manage-conversation.ts, src/frameworks/db/conversation/sqlite-conversation-repository.ts, web/src/api/client.ts, web/src/pages/conversation/LeftPanel.tsx, web/src/hooks/use-conversation-list-polling.ts, web/src/pages/conversation-list/index.tsx, web/src/pages/conversation/index.tsx]
from: [F20260805actv]
supersedes: []
created_in_conversation: 9107310c-1653-4495-a6e9-0df86e664448
---

# 左侧栏对话标题搜索 + 对话列表分页加载更多

## 背景（意图锚）

搭档原话（2026-09-16）：「我感觉好像左侧栏的『对话』是否只展示部分？没有全展示？然后也没有分页；以及，左侧栏的顶部的搜索按钮点击之后直接跳转到『记忆搜索』去了，但我这里的搜索我更想要搜索对话的标题关键字匹配即可」。

排查证实两个问题均属实：

1. **列表截断**：`GET /api/conversations` 默认 `limit=50`（conversation-controller.ts:32），前端 `listConversations()` 不传参数写死取前 50 条——第 51 条起的对话在 UI 上不可达，无分页无加载更多
2. **搜索跳错地方**：`LeftPanel.tsx` 顶部搜索按钮写死 `<a href="/memory">`——跳的是记忆（memory）搜索页，不是对话搜索

## 方案设计

### D1. 搜索：就地展开搜索框 + 服务端标题过滤（搭档诉求直达）

- 搜索按钮从 `<a href="/memory">` 改为就地展开搜索输入框（autofocus，Escape/× 关闭）；记忆搜索仍从导航进 /memory 页
- 输入防抖 300ms → `GET /api/conversations?search=<关键字>` → 左侧栏列表**替换**为命中结果；清空/关闭恢复父组件列表
- 服务端：`listConversationsWithMeta` 新增 `search` 选项，SQL `c.title LIKE ? ESCAPE '\'` 子串匹配；**LIKE 通配符（%/_/\）转义**——不转义则搜「50%」会命中所有含「50」的标题（LIKE 注入退化形态）
- 搜索天然覆盖「50 条以外找不到」的痛点：搜索查询同样走全表（archived 排除规则不变）

### D2. 分页：底部「加载更多」按钮（比页码器轻）

- 列表底部「加载更多」按钮：点击拉下一页（limit=50, offset=已加载条数）追加，按 id 去重；满页（返回 50 条）即认为可能还有下一页
- 搜索态下不显示加载更多（搜索结果本身就是过滤视图）

### D3. 轮询与分页共存

5 秒轮询（F20260805actv）每次只拉首屏 50 条——若不处理，分页追加的后续页会在下一次轮询时被冲掉。方案：`useConversationListPolling` 新增 `visibleIds` 参数（当前列表 id 集合），轮询合并时保留「首屏 ∪ visibleIds」——首屏数据以服务端为准（新增/归档/排序/实时字段），后续页按 id 保留。不传 visibleIds 则保持旧全量替换行为（向后兼容）。

### 不做什么

- 不做对话内容全文搜索（标题关键字即搭档明确诉求；内容搜索走 /memory）
- 不做无限滚动自动加载（按钮式更可控，滚动位置保持逻辑 F20260808f4b8 不冲突）
- 搜索结果不做分页（limit=50 一次性返回，标题匹配命中量小）

## 改动明细

| 文件 | 改动 |
|---|---|
| src/usecases/conversation/conversation-repository.ts | `listConversationsWithMeta` options +`search?: string` |
| src/usecases/conversation/manage-conversation.ts | `listWithMeta` 透传 search |
| src/frameworks/db/conversation/sqlite-conversation-repository.ts | SQL +`AND c.title LIKE ? ESCAPE '\'`（条件拼接），LIKE 通配符转义，参数化查询 |
| src/interface-adapters/http/controllers/conversation-controller.ts | list 端点读 `search` query 参数透传 |
| web/src/api/client.ts | `listConversations` options +`search` |
| web/src/pages/conversation/LeftPanel.tsx | 搜索按钮改就地展开（+防抖搜索 + 空态 + Escape 关闭）；列表底部 +「加载更多」按钮（hasMore/onLoadMore/loadingMore props） |
| web/src/hooks/use-conversation-list-polling.ts | +`visibleIds` 参数：轮询合并保留分页追加的对话 |
| web/src/pages/conversation-list/index.tsx | 分页 state（hasMore/loadingMore）+ handleLoadMore + visibleIds 轮询 |
| web/src/pages/conversation/index.tsx | 同上分页接入；loadInitialData 返回 hasMore |

## 测试覆盖

- 仓储层 +6：search 子串过滤 / archived 排除优先 / `%` 转义 / `_` 转义 / 空白退化不过滤 / search+limit+offset 组合
- API 层 +2：search 参数透传 / 未带 search 传 undefined
- 前端 +7：搜索按钮展开（无 /memory 链接）/ 防抖调 API + 列表替换 / 关闭恢复 / 空态提示 / Escape 关闭 / 加载更多按钮展示与回调 / hasMore=false 不展示
- 全量回归：后端 conversation 相关 47 tests / 前端 conversation+hooks 182 tests 全绿；双端 tsc --noEmit 通过

## 影响范围

- API 纯增量（search 可选参数，缺省行为不变）
- `useConversationListPolling` 新参数可选，旧调用方行为不变
- 无 schema 变更、无破坏性变更
