# Otter Buddy

中文 | [English](./README.en.md)

Otter Buddy（海獭）是一个以 Agent 为本、Chat as Substrate、记忆系统为核心的 Agentic System 项目。

## 设计哲学

- **Agent 为本**：系统围绕 Agent 设计，Agent 是第一公民
- **Chat as Substrate**：聊天界面作为系统的底层交互范式
- **记忆系统为核心**：持久化记忆驱动 Agent 的长期协作能力

详细设计哲学和架构决策参见 [otter-buddy#3](https://github.com/chenlaicai/otter-buddy/issues/3)。

## 技术栈

| 层 | 技术 |
|----|------|
| 运行时 | Node.js 22 (LTS) |
| 语言 | TypeScript |
| 后端框架 | Hono |
| 数据库 | better-sqlite3 |
| 测试框架 | Vitest |
| Lint | ESLint (flat config) |
| 包管理 | npm |

## 快速开始

### 前置条件

- Node.js 22 (LTS)
- npm
- LLM API Key（OpenAI 或 Anthropic）

### 安装依赖

```bash
# 后端依赖（prepare 脚本会自动设置 git hooks 路径）
npm install

# 前端依赖
cd web && npm install && cd ..
```

#### 验证 git hooks 已激活

`npm install` 的 `prepare` 脚本会执行 `git config core.hooksPath .githooks`，将钩子指向仓库内的 `.githooks/`（commit-msg / pre-commit / pre-push / pre-merge-commit）。若该配置被外部工具或环境重置覆盖，全部钩子会**静默失效**（#476、F20260821kgts 在案多次踩坑），提交规范只能靠 CI 兜底。安装完成后验证一次：

```bash
git config core.hooksPath
# 预期输出: .githooks（相对路径；若为其他值或指向不存在的目录，重新执行 npm run prepare）
```

### 配置

复制配置模板并填入实际值：

```bash
cp config/config.yaml.example config/config.yaml
```

编辑 `config/config.yaml`，至少填写以下必填项：

```yaml
llm:
  models:
    - alias: default
      provider: openai      # openai / anthropic / kimi-coding
      model: gpt-4o
      apiKey: sk-...        # LLM API Key
```

> `config/config.yaml` 已加入 `.gitignore`，不会被提交到代码仓库。

#### 从 .env 迁移

如果之前使用 `.env` 配置，将环境变量迁移到 `config/config.yaml`：

| 环境变量 | config.yaml 字段 |
|----------|------------------|
| `OTTER_BUDDY_LLM_PROVIDER` | `llm.models[].provider` |
| `OTTER_BUDDY_LLM_MODEL` | `llm.models[].model` |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | `llm.models[].apiKey` |
| `OTTER_BUDDY_PORT` | `server.port` |
| `OTTER_BUDDY_DB_PATH` | `database.path` |

### 构建前端

```bash
cd web && npm run build && cd ..
```

### 启动系统

```bash
# 方式一：使用启动脚本（推荐）
./scripts/otter-buddy.sh start              # 默认端口 3000
./scripts/otter-buddy.sh start -p 3001      # 指定端口

# 方式二：直接 npm
npm start
```

启动后访问 http://localhost:3000 即可开始对话。

#### 启动脚本

`scripts/otter-buddy.sh` 提供服务管理命令，支持多 worktree 使用不同端口避免冲突：

```bash
./scripts/otter-buddy.sh start [-p port]   # 构建并启动
./scripts/otter-buddy.sh stop [-p port]    # 停止
./scripts/otter-buddy.sh restart [-p port] # 重启
./scripts/otter-buddy.sh status            # 查看状态
```

多 worktree 示例：

```bash
# worktree A
./scripts/otter-buddy.sh start -p 3000

# worktree B（不同端口）
./scripts/otter-buddy.sh start -p 3001
```

每个 worktree 独立管理自己的服务，`stop`/`restart` 只影响当前 worktree。
如果端口被其他 worktree 占用，脚本会提示 PID，由用户决定是否终止。

### 开发模式

前后端分离启动，支持热重载：

```bash
# 终端 1：后端（TypeScript 编译 + 启动）
npm start

# 终端 2：前端（Vite dev server，自动代理 /api 到后端）
cd web && npm run dev
```

前端 dev server 运行在 http://localhost:5173，自动将 `/api` 请求代理到后端 `http://localhost:3000`。

### 运行测试

```bash
npm test
```

### 完整检查（lint + build）

```bash
npm run check
```

## 系统架构

```
┌─────────────────────────────────────────────────────┐
│  Web Frontend (React + Vite)                         │
│  web/ → http://localhost:5173 (dev) / :3000 (prod)   │
│  Pages: 对话 · 记忆 · 技能 · 设置                      │
└──────────────────┬──────────────────────────────────┘
                   │ /api/* (REST + SSE)
┌──────────────────▼──────────────────────────────────┐
│  Backend (Hono + Node.js)                            │
│  src/main.ts → http://localhost:3000                  │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ │
│  │ Controllers  │ │ Use Cases    │ │ Frameworks   │ │
│  │ (HTTP/REST)  │→│ (业务逻辑)    │→│ (DB/LLM/Emb) │ │
│  └──────────────┘ └──────────────┘ └──────────────┘ │
│  ┌──────────────┐                                    │
│  │ Agent Runtime│ (Pi Agent + Tools)                 │
│  └──────────────┘                                    │
└─────────────────────────────────────────────────────┘
                   │
        ┌──────────┴──────────┐
        │ SQLite (better-sqlite3) │
        │ 向量嵌入 (sqlite-vec)    │
        └─────────────────────┘
```

## 项目结构

```
otter-buddy/
├── api-contract/     # 前后端共享的 TypeScript 类型定义（DTO + SSE 事件）
├── web/              # React 前端（Vite + Tailwind CSS）
│   ├── src/          # 前端源码（React 组件、API 客户端）
│   ├── index.html    # 对话页入口
│   ├── memory.html   # 记忆页入口
│   ├── skills.html   # 技能页入口
│   └── settings.html # 设置页入口
├── src/              # 后端源码（整洁架构）
│   ├── frameworks/       # 框架层（DB、LLM、Embedding、Config）
│   ├── usecases/         # 用例层（业务逻辑）
│   ├── interface-adapters/# 接口适配层（HTTP 控制器、Agent Runtime）
│   └── main.ts           # Composition Root（依赖注入装配）
├── tests/            # 测试
├── .github/          # GitHub 配置（CI、Issue 模板、PR 模板等）
├── .githooks/        # Git hooks（提交规范、分支保护）
├── docs/             # 项目文档
├── package.json
├── tsconfig.json
├── eslint.config.mjs
└── vitest.config.ts
```

## 许可证

[MIT](./LICENSE)
