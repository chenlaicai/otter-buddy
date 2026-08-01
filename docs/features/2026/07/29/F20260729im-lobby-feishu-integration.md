# F20260729im IM 大厅：飞书接入对话能力

## 变更类型
Feature

## 概述
新增 IM 大厅系统，支持飞书群作为通道接入对话。用户可以在飞书群中使用命令与系统交互，飞书消息自动同步到 Web 端展示。

## 需求背景
- 飞书群需要能够接入系统对话
- 需要一个"连接"概念，代表飞书群在系统中的代理
- 连接可以自由切换进入不同的对话
- 一个对话同时只能有一个连接进入（独占约束）
- 飞书消息需要同步到 Web 端，但 Web 消息不回流飞书（防回环）

## 技术选型：长连接 vs Webhook

采用飞书 SDK 的 **WSClient 长连接模式**，而非传统的 Webhook HTTP 回调。

**选型理由：**
- **无需公网 IP/域名**：长连接模式由客户端主动连接飞书服务器，适合本地开发和内网部署
- **无需配置回调地址**：Webhook 需要在飞书开放平台配置公网可达的回调 URL
- **实时性更好**：WebSocket 双向通信，消息延迟更低
- **部署更简单**：不需要反向代理、SSL 证书等基础设施

**架构：**
```
飞书服务器 ←─WebSocket─→ WSClient（本服务）←─内部事件─→ MessageProcessor
```

## 核心设计

### 1. Connection-Session 模型

```
飞书群 (Connection) ──进入──> Conversation (对话)
         ↓ 可以切换
      另一个 Conversation
```

- **Connection**: 飞书群在系统中的代理实体
- **ConnectionSession**: Connection 与 Conversation 的绑定关系
- **独占约束**: 一个 Conversation 同时只能有一个 ConnectionSession 处于 active 状态

### 2. 消息 Source 字段

消息实体新增 `source` 字段，区分消息来源：
- `web`: 来自 Web 端（默认）
- `feishu`: 来自飞书端

### 3. 命令系统

飞书端支持以下命令：
- `/list` - 查看所有活跃对话
- `/in <对话ID>` - 进入指定对话
- `/history` - 查看当前对话历史消息
- `/help` - 显示帮助信息

### 4. 消息同步

- 飞书消息 → Web：同步展示，带蓝色"飞书"标签
- Web 消息 → 飞书：不回流（防回环）

## 实现细节

### 新增实体

**Connection**
```typescript
interface Connection {
  id: string;
  name: string;
  externalId: string;  // 飞书 open_chat_id
  externalType: string; // "feishu"
  metadata: Record<string, unknown> | null;
  status: "active" | "inactive";
  createdAt: string;
  updatedAt: string;
}
```

**ConnectionSession**
```typescript
interface ConnectionSession {
  id: string;
  connectionId: string;
  conversationId: string;
  status: "active" | "released";
  joinedAt: string;
  releasedAt: string | null;
}
```

### 数据库 Schema

**connections 表**
```sql
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_type TEXT NOT NULL DEFAULT 'feishu',
  metadata TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_connections_external_id ON connections(external_id) WHERE status = 'active';
```

**connection_sessions 表**
```sql
CREATE TABLE connection_sessions (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  joined_at TEXT NOT NULL,
  released_at TEXT,
  FOREIGN KEY (connection_id) REFERENCES connections(id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);
-- 独占约束：一个 conversation 同时只有一个 active session
CREATE UNIQUE INDEX idx_conn_sessions_conv_active ON connection_sessions(conversation_id) WHERE status = 'active';
```

### API 端点

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | /api/connections | 列出所有 Connection |
| POST | /api/connections | 创建 Connection |
| GET | /api/connections/:id | 获取单个 Connection |
| GET | /api/connections/:id/session | 获取当前 Session |
| POST | /api/connections/:id/enter | 进入 Conversation |
| POST | /api/connections/:id/leave | 离开 Conversation |
| GET | /api/connections/:id/conversations | 获取可进入的对话列表 |

### Web UI

新增 Connection 管理页面 `/connections`，功能包括：

**Connection 列表**
- 显示所有 Connection 的名称、状态、当前绑定的对话
- 支持创建新 Connection（输入名称和飞书群 ID）

**Connection 详情**
- 显示 Connection 详细信息
- 显示当前 Session 状态
- 支持进入/离开对话操作

**页面路由**
- `/connections` - Connection 列表页
- 从主导航栏可访问

**UI 设计**
- 复用现有的 glass-card 样式
- 使用现有的组件库（lucide-react 图标）
- 响应式布局，适配移动端

### 配置

在 `config/config.yaml` 中添加：
```yaml
feishu:
  appId: "cli_xxxxxxxxxxxxxxxx"
  appSecret: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  encryptKey: "optional-encrypt-key"  # 可选，用于解密飞书加密事件
```

## 文件清单

### 新增文件
- `src/entities/im/connection.ts` - Connection 实体
- `src/usecases/im/connection-repository.ts` - Repository 接口
- `src/usecases/im/manage-connection.ts` - Use Case
- `src/usecases/im/feishu-command-parser.ts` - 命令解析
- `src/usecases/im/feishu-gateway.ts` - 飞书网关接口
- `src/frameworks/db/im/sqlite-connection-repository.ts` - SQLite 实现
- `src/frameworks/feishu/client.ts` - 飞书 API 客户端
- `src/frameworks/feishu/long-connection-client.ts` - 飞书长连接客户端（WSClient）
- `src/frameworks/feishu/access-token-manager.ts` - 飞书 Token 管理
- `src/interface-adapters/feishu/long-connection-handler.ts` - 长连接事件处理
- `src/interface-adapters/feishu/message-processor.ts` - 飞书消息处理
- `src/interface-adapters/feishu/command-dispatcher.ts` - 命令分发
- `src/interface-adapters/http/controllers/connection-controller.ts` - REST 控制器
- `src/interface-adapters/http/dto/connection-dto.ts` - DTO 转换

### 修改文件
- `src/entities/conversation/message.ts` - 添加 source 字段
- `src/frameworks/db/schema.ts` - 添加新表
- `src/frameworks/db/migration.ts` - 添加迁移
- `src/frameworks/config-service.ts` - 添加 feishu 配置
- `src/usecases/conversation/send-message.ts` - 支持 source 参数
- `api-contract/api/message.ts` - MessageDTO 添加 src 字段
- `web/src/lib/mappers.ts` - LocalMessage 添加 src 字段
- `web/src/pages/conversation/MessageList.tsx` - 显示来源标签
- `web/connections.html` - Connection 页面入口
- `web/src/pages/connections/index.tsx` - Connection 页面主组件
- `web/src/api/client.ts` - 添加 Connection API 调用
- `web/src/lib/mappers.ts` - 添加 Connection 类型映射

## 测试

### 单元测试
- `tests/usecases/im/manage-connection.test.ts` - ManageConnection 用例测试
- `tests/usecases/im/feishu-command-parser.test.ts` - 命令解析测试

### 集成测试
- `tests/api/connection.test.ts` - Connection API 测试

## 飞书配置步骤

1. 在飞书开放平台创建自建应用
2. 启用"机器人"能力
3. 订阅事件：`im.message.receive_v1`
4. 配置请求地址：`https://your-domain.com/feishu/webhook`
5. 获取 App ID 和 App Secret
6. 在系统配置文件中填入飞书配置
7. 在 Web 端创建 Connection，绑定飞书群
8. 在飞书群中使用命令交互
