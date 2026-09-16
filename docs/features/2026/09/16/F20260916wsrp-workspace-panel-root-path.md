---
id: F20260916wsrp
title: 工作区面板头部展示根目录绝对路径
summary: 搭档每次都要问海獭工作区目录在哪——WorkspacePanel 头部新增工作区根目录绝对路径展示（截断 + title 悬停全文 + 可选中复制），listDir 响应体扩展 rootPath 字段
change_type: feature-update
tags: [web-ui, workspace, dx]
modules: [api-contract/api/workspace.ts, src/interface-adapters/http/controllers/workspace-controller.ts, web/src/pages/conversation/WorkspacePanel.tsx, web/src/pages/conversation/WorkspacePanel.test.tsx, tests/interface-adapters/http/workspace-api.test.ts]
from: [F20260831wsui]
supersedes: []
created_in_conversation: 9107310c-1653-4495-a6e9-0df86e664448
---

# 工作区面板头部展示根目录绝对路径

## 背景（意图锚）

搭档原话：「工作区再次优化下，显示下工作区目录路径，否则每次我都得问你」。

现状：右侧栏 WorkspacePanel（F20260831wsui）只展示文件树和文件预览，搭档想知道工作区在本机的目录位置只能问海獭调 `workspace_info`，或右键单个文件「在文件管理器中显示」间接看到——获取路径本身没有直达入口。

## 方案设计

在 WorkspacePanel 头部标题「工作区」下方展示工作区根目录绝对路径：

- **数据来源**：`GET /api/conversations/:id/workspace`（listDir）响应体新增 `rootPath` 字段，由 controller 调用既有的 `ManageWorkspace.getWorkspacePath(conversationId)` 填充——无需新端点，根目录加载时顺手带回
- **契约**：`WorkspaceListDirResponse.rootPath: string`（api-contract 单一真相源，三侧 tsc 锁死）
- **前端展示**：仅根目录加载（组件初次 mount）时更新 state；子目录懒加载不重复设置。样式 `text-[10px] font-mono truncate` + `title` 悬停全文 + `select-all` 方便复制
- **不做什么**：不加「复制」按钮（select-all + title 已够用，避免头部元素膨胀）；子目录响应同样带 rootPath（同一份 DTO，无害）

## 改动明细

| 文件 | 改动 |
|---|---|
| api-contract/api/workspace.ts | `WorkspaceListDirResponse` +`rootPath: string` |
| src/interface-adapters/http/controllers/workspace-controller.ts | listDir 响应体填充 `rootPath`（调 `getWorkspacePath`） |
| web/src/pages/conversation/WorkspacePanel.tsx | `fetchDir` 返回完整 response（原只取 entries）；+rootPath state；头部标题下移一行展示路径 |
| web/src/pages/conversation/WorkspacePanel.test.tsx | ROOT_ENTRIES fixture 补 rootPath/basePath；+1 测试（头部展示路径 + title） |
| tests/interface-adapters/http/workspace-api.test.ts | +1 测试（listDir 响应体含非空 rootPath） |

## 测试覆盖

- 后端：listDir 响应体含 `rootPath` 非空字符串（workspace-api.test.ts）
- 前端：头部渲染 `data-testid="workspace-root-path"`，textContent 与 title 均为根路径（WorkspacePanel.test.tsx）
- 双端 tsc --noEmit 通过；后端 26 tests / 前端 14 tests 全绿

## 影响范围

- API 响应体新增字段（纯增量，无破坏性；旧前端忽略未知字段）
- 无 schema 变更、无权限变更（路径仅对已能浏览该工作区文件树的会话可见）
