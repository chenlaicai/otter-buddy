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
# 后端依赖
npm install

# 前端依赖
cd web && npm install && cd ..
```

### 配置环境变量

创建 `.env` 文件或在 shell 中设置：

```bash
# === 必填 ===
# LLM API Key（根据 provider 选择其一）
export OPENAI_API_KEY="sk-..."          # provider=openai 时必填
export ANTHROPIC_API_KEY="sk-ant-..."   # provider=anthropic 时必填

# === 可选（有默认值） ===
export OTTER_BUDDY_LLM_PROVIDER="openai"      # LLM 提供商：openai | anthropic（默认 openai）
export OTTER_BUDDY_LLM_MODEL="gpt-4o"         # 模型 ID（默认 gpt-4o）
export OTTER_BUDDY_PORT="3000"                 # 后端端口（默认 3000）
export OTTER_BUDDY_DB_PATH="./otter-buddy.db"  # SQLite 数据库路径
```

### 构建前端

```bash
cd web && npm run build && cd ..
```

### 启动系统

```bash
npm start
```

启动后访问 http://localhost:3000 即可开始对话。

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
