---
id: F20260716ttf7
title: system-integration-and-startup
from_ids: [F20260715f4k9, F20260715b8c6, F20260713u9v4, F20260716i5n2]
tags: [architecture, integration, frontend, api-client, sse, startup, api-contract]
modules: [api-contract/, web/src/, web/vite.config.ts, src/interface-adapters/, src/usecases/, src/frameworks/]
doc_kind: spec
status: draft
created_at: 2026-07-16
---

# F20260716ttf7 API 契约层 + 前端 API 集成 + 后端补齐 + 系统启动打通

> 本文档定义 API 契约层（前后端共享类型），补齐后端缺失端点，并将前端 UI 对接到后端 API + SSE 流式推送，使系统可启动并开始对话。

## 背景 [required]

### 当前状态（基于 commit 8c287e6）

| 层 | 目录 | 状态 | 关键产物 |
|---|------|------|---------|
| Entities | `src/entities/` | ✅ 完成 | 5 文件，3 限界上下文 |
| Use Cases | `src/usecases/` | ✅ 完成 | 14 文件，Repository/Gateway 接口 + Use Case 类 |
| Frameworks | `src/frameworks/` | ✅ 完成 | SQLite 3 仓库 + Pi Agent + bge-m3 + LLM 工厂 |
| Interface Adapters | `src/interface-adapters/` | ✅ 完成 | 17 源文件：6 控制器 + DTO + SSE Streamer + AgentInvoker |
| Composition Root | `src/main.ts` | ✅ 完成 | 完整 DI 组装，Hono 服务器启动 |
| **API 契约层** | **`api-contract/`** | **❌ 不存在** | **前后端零类型共享** |
| 前端 UI | `web/src/` | ✅ UI 完成，mock 数据 | 4 页面 MPA，零后端集成 |
| 前端 API 客户端 | `web/src/` | ❌ 不存在 | 无 fetch 调用 |
| Vite 代理 | `web/vite.config.ts` | ⚠️ 仅 /ws | 缺少 `/api` 代理 |
| 构建产物 | `dist/`, `web/dist/` | ❌ 过期/不存在 | 未构建 |
| 环境配置 | `.env` | ❌ 不存在 | 无 API key |

### 后端缺失端点（本次补齐）

| 缺失端点 | 前端 UI 已有功能 | 需改动层 |
|---------|----------------|---------|
| `DELETE /api/conversations/:id/key-facts/:factId` | RightPanel 删除按钮 | Use Cases + Frameworks + Interface Adapters |
| `DELETE /api/conversations/:id/resources/:resourceId` | RightPanel 删除按钮 | 同上 |
| `PUT /api/settings` | Settings 页面保存按钮 | 新建 SettingsRepository + DB 表 + Interface Adapters |

### 当前问题：类型断裂

后端 DTO 和前端 mock 类型完全独立定义，存在 6 处字段差异。没有机制保证前后端类型一致。

### 项目结构约束

- **非 monorepo**：根目录（CommonJS）和 `web/`（ESM）是两个独立包
- **模块系统不兼容**：后端 `commonjs`，前端 `ESNext`
- **共享类型必须是纯接口**：不能有运行时代码

### 用户意图锚 [required]

| ID | 用户原话 | 关键修饰语 | 架构师解读 | 来源 |
|----|---------|-----------|-----------|------|
| UA-1 | "检查当前实现是什么进度，还缺少什么？前后端打通？" | 目标：前后端打通 | 用户期望了解现状差距，并设计打通方案 | msg-1 |
| UA-2 | "我期望目标是准备能启动系统开始对话" | 终态：能启动系统；操作：开始对话 | 最终验收标准是系统可启动、用户可发起对话并获得 Otter 回复 | msg-1 |
| UA-3 | "先跑起来是目标不是手段，代码该怎么做就还得怎么做" | 标准：正确工程；底线：不造屎山 | 工程质量不能降级 | msg-2 |
| UA-4 | "发现问题就要修改完整，没有锁定一说" | 方式：发现问题就修完；态度：不留尾巴 | 所有发现的缺口必须在本次 PR 中补齐 | msg-3 |

### 上游设计约束

- **F20260716i5n2**：Interface Adapters 层实现（PR #30）
- **F20260715f4k9**：Frameworks 层实现（PR #27）
- **F20260715b8c6**：Use Cases 层实现（PR #17）
- **流式协议**：后端使用 SSE，前端必须消费 SSE 事件流

## 目标 [required]

### P0 - API 契约层（`api-contract/`）

建立前后端共享的类型定义层，消除类型断裂。

#### 目录结构

```
api-contract/
├── api/
│   ├── conversation.ts
│   ├── message.ts
│   ├── otter.ts
│   ├── memory.ts
│   ├── key-info.ts
│   ├── settings.ts        # SettingsDTO, UpdateSettingsRequestDTO
│   └── index.ts
└── sse/
    └── events.ts
```

#### 设计原则

1. **纯接口/类型**：无运行时代码（无 import、无函数、无 class）
2. **单一来源**：后端 DTO 接口迁移到 `api-contract/`，转换函数留后端
3. **前端直接引用**：从 `@contract/api` 导入
4. **不属于后端四层架构**：是前后端之间的契约边界

#### tsconfig 配置

```jsonc
// 根 tsconfig.json
"@contract/*": ["api-contract/*"]

// web/tsconfig.json
"@contract/*": ["../api-contract/*"]

// web/vite.config.ts
resolve: { alias: { '@contract': path.resolve(__dirname, '../api-contract') } }
```

#### SSE 事件类型化

```typescript
// api-contract/sse/events.ts
export type SSEEventMap = {
  'message.start': { messageId: string; otterId: string };
  'message.delta': { text: string };
  'tool.start': { toolName: string };
  'tool.result': { toolName: string; result: unknown };
  'message.complete': { messageId: string; duration: string; ctx?: number; ctxMax?: number };
  'turn.complete': Record<string, never>;
  'agent.idle': Record<string, never>;
  'message.aborted': { messageId: string };
  'error': { message: string };
};
export type SSEEventType = keyof SSEEventMap;
export type SSEEventPayload<T extends SSEEventType> = SSEEventMap[T];
```

#### 后端 DTO 改造

- `src/interface-adapters/http/dto/*.ts` 接口定义移入 `api-contract/api/`
- 后端 DTO 文件改为 re-export + 保留 `to*DTO()` 转换函数
- `RetrievalSource` 重定义到 `api-contract/api/memory.ts`
- Controller 导入路径更新为 `@contract/` 别名
- `tsconfig.json` 新增 `@contract/*` 路径别名
- `eslint.config.mjs` 新增 `api-contract/` 层边界规则

### P1 - 前端 API 客户端模块

在 `web/src/api/` 创建统一的 API 客户端：
- REST 封装：`fetch()` + JSON 解析 + 错误处理
- SSE 消费：`fetch` + `ReadableStream`，使用 `api-contract/sse/events.ts` 类型化事件
- 类型导入：从 `@contract/api` 导入

### P2 - 对话页面 API 替换

将 `web/src/pages/conversation/` 从 mock 数据切换为真实 API：
- 创建对话 → `POST /api/conversations`
- 发送消息 → `POST /api/conversations/:id/messages`（返回 SSE 流）
- 获取对话列表 → `GET /api/conversations?otterId=xxx`
- 获取消息列表 → `GET /api/conversations/:id/messages`
- Otter 创建/解散 → `POST /api/otters` / `DELETE /api/otters/:id`
- 会话管理 → `POST /api/otters/:id/sessions` / `POST /api/otters/:id/restart`
- 删除关键事实 → `DELETE /api/conversations/:id/key-facts/:factId`
- 删除关联资源 → `DELETE /api/conversations/:id/resources/:resourceId`

### P3 - SSE 流式接收

替换 `setInterval` 模拟，接入真实 SSE：
- 使用 `api-contract/sse/events.ts` 类型化事件
- 监听 `message.delta`，增量渲染 Otter 回复
- 处理 `tool.start` / `tool.result` 显示工具调用进度
- 处理 `message.complete`：提取 `duration`、`ctx`、`ctxMax` 存储到消息状态
- 处理 `agent.idle` / `error` 结束流
- 支持 `POST /api/messages/:id/abort` 中断
- 网络断开时展示错误提示

### P4 - Vite 代理配置

更新 `web/vite.config.ts`：
- 添加 `/api` → `http://localhost:3000` 代理
- 移除过时的 `/ws` 代理

### P5 - 其他页面 API 集成

- 记忆页面：`GET /api/memory/search` / `PATCH /api/memory/:id/flag`
- 设置页面：`GET /api/settings` / `PUT /api/settings`
- 技能页面：暂无后端 API，可保持 mock

### P6 - 后端补齐缺失端点

本次补齐全部 3 个缺失端点，改动涉及 Use Cases + Frameworks + Interface Adapters 层：

#### DELETE key-facts / DELETE resources

| 层 | 文件 | 改动 |
|---|------|------|
| Use Cases | `conversation-repository.ts` | 新增 `deleteKeyFact(id)` / `deleteLinkedResource(id)` 接口方法 |
| Use Cases | `manage-key-info.ts` | 新增 `deleteKeyFact()` / `deleteLinkedResource()` 业务方法 |
| Frameworks | `sqlite-conversation-repository.ts` | 实现 DELETE SQL |
| Interface Adapters | `key-info-controller.ts` | 新增控制器方法 |
| Interface Adapters | `router.ts` | 注册 DELETE 路由 |
| API Contract | `api-contract/api/settings.ts` | 新增 SettingsDTO 类型 |

#### PUT settings

| 层 | 文件 | 改动 |
|---|------|------|
| Use Cases | `settings-repository.ts`（新建） | 定义 `SettingsRepository` 接口：`get()` / `update()` |
| Frameworks | `schema.ts` | 新增 `settings` 表 |
| Frameworks | `sqlite-settings-repository.ts`（新建） | 实现 SettingsRepository |
| Interface Adapters | `settings-controller.ts` | 新增 `updateSettings()` 方法 |
| Interface Adapters | `router.ts` | 注册 PUT 路由 |
| API Contract | `api-contract/api/settings.ts` | 新增 UpdateSettingsRequestDTO |
| Composition Root | `main.ts` | 注入 SettingsRepository 到 SettingsController |

### P7 - 启动流程验证

- 创建 `.env.example`
- 后端开发：添加 `tsx watch src/main.ts` 作为 dev script
- 前端开发：`cd web && npm run dev`（Vite proxy → 后端）
- 验证命令：
  - `curl http://localhost:3000/api/settings` → JSON
  - `curl -X POST http://localhost:3000/api/conversations -H 'Content-Type: application/json' -d '{"title":"test"}'` → 对话 ID
  - `curl -N -X POST http://localhost:3000/api/conversations/{id}/messages -H 'Content-Type: application/json' -d '{"content":"hello","senderId":"user"}'` → SSE 流
  - `curl -X DELETE http://localhost:3000/api/conversations/{id}/key-facts/{factId}` → 204
  - `curl -X PUT http://localhost:3000/api/settings -H 'Content-Type: application/json' -d '{"llmProvider":"openai"}'` → 更新后设置

## 核心业务行为

| ID | 触发条件 | 预期行为 | 来源 |
|----|---------|---------|------|
| B1 | 用户点击"新建对话" | 前端 `POST /api/conversations`，导航到 `/conversation/:id` | ← UA-2 |
| B2 | 用户输入消息并发送 | 前端 `POST /api/conversations/:id/messages`，SSE 流式接收回复 | ← UA-2 |
| B3 | SSE 收到 `message.delta` | 前端增量渲染 Otter 回复文本 | ← UA-2 |
| B4 | SSE 收到 `message.complete` | 前端关闭流式渲染，提取 duration/ctx/ctxMax | ← UA-2 |
| B5 | 用户点击"中断回复" | 前端 `POST /api/messages/:id/abort` | ← UA-2 |
| B6 | 用户刷新对话页面 | 前端加载对话历史 | ← UA-2 |
| B7 | 系统启动 | 后端初始化 DB + Schema + 启动 HTTP 服务器 | ← UA-2 |
| B8 | SSE 连接中断 | 前端展示错误提示 | ← UA-2 |
| B9 | 用户删除关键事实 | 前端 `DELETE /api/conversations/:id/key-facts/:factId`，RightPanel 更新 | ← UA-4 |
| B10 | 用户删除关联资源 | 前端 `DELETE /api/conversations/:id/resources/:resourceId`，RightPanel 更新 | ← UA-4 |
| B11 | 用户保存设置 | 前端 `PUT /api/settings`，持久化到 DB | ← UA-4 |

## 设计约束摘要

1. **全量补齐**：所有发现的缺口在本次 PR 中修复，不留 Phase 2
2. **API 契约层**：`api-contract/` 是前后端类型共享的单一来源，纯类型，无运行时代码
3. **流式协议**：后端 SSE，前端 `fetch` + `ReadableStream`
4. **TS 版本兼容**：`api-contract/` 只使用 TS 5.x 兼容语法
5. **开发模式**：Vite dev (5173) + `tsx watch` 后端 (3000)，proxy `/api`
6. **生产模式**：`web build` → Hono 静态文件服务

## 关键决策记录

### 决策 1：流式通信协议

- **事实**：后端使用 SSE（`streamSSE()`），非 WebSocket
- **决策**：前端 `fetch` + `ReadableStream` 消费（SSE 端点是 POST，不能用 EventSource）
- **参与者**：架构师-1、架构师-2

### 决策 2：API 契约层设计

- **决策**：独立 `api-contract/` 目录 + 双 tsconfig path alias + Vite alias
- **依据**：非 monorepo，纯接口共享，不破坏后端四层架构
- **参与者**：架构师-1、架构师-2（用户推动：不接受类型断裂）

### 决策 3：DTO 归属

- **决策**：接口定义迁移到 `api-contract/`，`to*DTO()` 转换函数留后端
- **依据**：转换函数依赖实体类型，不能放在纯类型层
- **参与者**：架构师-1、架构师-2

### 决策 4：RetrievalSource 跨层处理

- **问题**：`RetrievalSource` 在 `@usecases/`，DTO 迁移后会导致 `api-contract/` 依赖 `@usecases/`
- **决策**：重定义到 `api-contract/api/memory.ts`（纯字符串联合类型）
- **参与者**：架构师-2（发现）、架构师-1（接受）

### 决策 5：缺失端点处置

- **原决策**：移至 Phase 2
- **用户纠正**：发现问题就要修完，不留尾巴
- **最终决策**：全部纳入本次 PR，改动涉及 Use Cases + Frameworks + Interface Adapters 层
- **参与者**：用户（决策）、架构师-1（执行）

### 决策 6：API 契约层命名

- **用户偏好**：不叫 `shared/`，叫 `api-contract/`
- **依据**：`shared/` 太泛，`api-contract/` 明确表达"前后端之间的 API 契约"
- **参与者**：用户（决策）
