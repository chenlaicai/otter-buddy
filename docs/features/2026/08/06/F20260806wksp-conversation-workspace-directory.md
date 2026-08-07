---
id: F20260806wksp
title: 对话工作区目录
summary: 每个对话拥有专属沙箱目录，生命周期随对话走。大小獭通过 workspace_* 工具读写，存放研究报告和临时文件。
---

## 问题

海獭在对话中产生的研究报告、临时文件没有结构化存储。需要为每个对话创建专属目录，让海獭知道目录在哪、何时用、如何用。

## 方案

### 目录结构

```
data/
  workspaces/
    {conversation_id}/     ← 每个对话的专属目录
```

### 数据模型

`conversations` 表新增 `workspace_dir TEXT` 列（相对路径），创建对话时写入。

### 工具

4 个 `workspace_*` 工具，大小獭均可用：

| 工具 | 功能 |
|------|------|
| `workspace_info` | 返回工作区路径 + 目录概览 |
| `workspace_list` | 列出目录条目 |
| `workspace_read` | 读取文件内容 |
| `workspace_write` | 写入文件（自动建目录） |

### 上下文注入

`DynamicContext` 新增 `workspacePath` 字段。每次 invoke 时注入消息前缀：

```
## 对话工作区
你的对话工作区路径：{absolutePath}
使用 workspace_* 工具操作工作区文件。
```

### 生命周期

- **创建**：`ManageConversation.create()` 时建目录
- **清理**：`ManageConversation.archive()` 时删目录（失败不阻断）

### 安全

- `NodeWorkspaceGateway.resolveSafe()` 防止 `..` 路径穿越
- 小獭的 `workspace_write` 只在沙箱内写入，不影响项目代码

## 文件变更

### 新建

- `src/usecases/ports/workspace-gateway.ts` — 接口
- `src/frameworks/file-system/node-workspace-gateway.ts` — 实现
- `src/interface-adapters/agent-runtime/tools/workspace-tools.ts` — 4 个工具

### 修改

- `src/entities/conversation/conversation.ts` — 加 `workspaceDir`
- `src/frameworks/db/schema.ts` — 加列
- `src/frameworks/db/migration.ts` — 加迁移
- `src/frameworks/db/conversation/conversation-mapper.ts` — 映射
- `src/frameworks/agent/session-helpers.ts` — 白名单 + 消息注入
- `src/interface-adapters/agent-runtime/agent-invoke-port.ts` — DynamicContext
- `src/interface-adapters/agent-runtime/agent-invoker.ts` — 注入工作区路径
- `src/interface-adapters/agent-runtime/tools/tool-factory.ts` — 注册工具
- `src/usecases/conversation/manage-conversation.ts` — 创建/清理
- `src/bootstrap/usecases.ts` — 依赖注入
- `src/bootstrap/platforms.ts` — 依赖注入
- `src/app.ts` — 装配
