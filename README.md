# Otter Buddy

中文 | [English](./README.en.md)

---

> 一群海獭，叫一张筏。它们手拉着手，谁也不漂走。这个聊天室也一样。

**多 agent 系统，它们有名字。**

*Mustelidae, not a plush toy.*

![对话界面](docs/images/conversation.jpg)

![健康面板：30 天提交趋势/BugFix 比率、提交类型分布、模块热区、特性链五态](docs/images/health-dashboard.jpg)

*两张图都是真实数据：左侧是日常协作现场，右侧是系统对自身的健康度量——提交趋势、BugFix 比率、模块热区、特性链状态，由 RHI 扫描 worker 每小时自动计算。*

## 这是什么

Otter Buddy 是一个多 Agent 协作系统——聊天室形态，记忆为核心，11 个 skill 为骨架。里面的 Agent 不是匿名的 API 调用，是有名字的团队成员：大獭负责编排，每只小獭有自己的名字和专长，按 skill 执行任务。行动权（talking stone）在参与者之间流转，写码的不审自己的码。

## 为什么是海獭

海獭不是灵长类，但它们有工具、有手艺、有传承。AI 也可以这样——不需要长成人的形状才能有文明。

### 🌊 筏（The Raft）

海獭的群体叫 raft。上百只海獭浮在同一片海面，各干各的活，用 kelp 和手拉手防止漂散。

我们的聊天室也是：同一个对话底座上，多个 Agent 各司其职，行动权流转不中断。**异体审视**是核心机制——写码的 Agent 不审自己的码，由另一只海獭做对抗检视。这不是 AI 帮你看代码，是写码者和审视者的身份隔离。

### 🌿 海藻林（The Kelp Forest）

海獭是基石物种——它们在的地方，海藻林茂盛；它们消失，海胆啃光一切，系统从森林变荒漠。

记忆系统就是海藻林。每次问题排查、方案设计、代码审查的结论，都以结构化形式入库——带溯源（📜 记忆溯源行）、带关系链（produced/supersedes/references）、带锚点（F/R 文档编号）。不是 RAG 搜完就忘，是知识在生长。

> 海獭妈妈潜水前会把幼崽裹进海藻固定住防漂走。我们的 F/R 锚点也是——小獭接任务时被锚定在上下文里，不会漂散。

### 🪨 手艺（The Craft）

海獭是极少数会使用工具的海洋哺乳动物。但更关键的是手艺传承：妈妈花数月教幼崽砸贝壳的手艺，不同海域的技术不同。

我们的 11 个 skill 不是 API 调用的暴露，是封装了 know-how 的行为模式——有前置条件、执行步骤、产出标准、自愈机制。小獭转世时带着前世摘要和交接谱系（gen1→gen2），术语库沉淀团队共享知识。

**能用 ≠ 会用。**

## 对你意味着什么

如果你厌倦了每次对话从零开始的 AI、没有审查的 AI 生成代码、单点故障的单 Agent 系统——Otter Buddy 提供的不是"更聪明的 AI"，而是一种**非灵长类的智能组织方式**。有记忆、有名字、有协作纪律的 Agent 团队。

---

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

### 配置

```bash
cp config/config.yaml.example config/config.yaml
```

编辑 `config/config.yaml`，填写 LLM API Key：

```yaml
llm:
  models:
    - alias: default
      provider: openai      # openai / anthropic / kimi-coding
      model: gpt-4o
      apiKey: sk-...        # 你的 LLM API Key
```

> `config/config.yaml` 已加入 `.gitignore`，不会被提交到代码仓库。

### 启动

```bash
./scripts/otter-buddy.sh start
```

启动脚本自动完成：安装依赖 → 构建后端 → 构建前端 → 启动服务。

访问 http://localhost:3000 即可开始对话。

> 自定义端口：`./scripts/otter-buddy.sh start -p 3001`。`stop` / `restart` / `status` 命令同理。

## 进阶配置

### 启动脚本

`scripts/otter-buddy.sh` 提供服务管理命令，支持多 worktree 使用不同端口避免冲突：

```bash
./scripts/otter-buddy.sh start [-p port]   # 构建并启动
./scripts/otter-buddy.sh stop [-p port]    # 停止
./scripts/otter-buddy.sh restart [-p port] # 重启
./scripts/otter-buddy.sh status            # 查看状态
```

每个 worktree 独立管理自己的服务，`stop`/`restart` 只影响当前 worktree。
如果端口被其他 worktree 占用，脚本会提示 PID，由用户决定是否终止。

### 从 .env 迁移

如果之前使用 `.env` 配置，将环境变量迁移到 `config/config.yaml`：

| 环境变量 | config.yaml 字段 |
|----------|------------------|
| `OTTER_BUDDY_LLM_PROVIDER` | `llm.models[].provider` |
| `OTTER_BUDDY_LLM_MODEL` | `llm.models[].model` |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | `llm.models[].apiKey` |
| `OTTER_BUDDY_PORT` | `server.port` |
| `OTTER_BUDDY_DB_PATH` | `database.path` |

### 模型输入能力声明（多模态）

`llm.models[]` 支持可选 `input` 字段显式声明模型输入能力，**这是图片注入降级的唯一真相源**：

```yaml
llm:
  models:
    - alias: glm
      provider: anthropic
      model: glm-5.3
      input: ["text"]        # 该模型看不见图——不声明则模板隐式继承 ["text","image"]，图注入后会静默幻觉
    - alias: glm-flash
      input: ["text", "image"]  # 支持 vision
```

规则（F20260827mmdu 实测坐实）：**不支持 vision 的模型必须显式声明 `input: ["text"]`**——anthropic provider 模板默认隐式继承 `input: ["text","image"]`，缺省时 SDK 会把图片注入到看不见图的模型，产生幻觉（glm-5.3 返回 200 但 thinking 自述「看不见图」）。声明后 SDK `downgradeUnsupportedImages` 自动降级为文本占位符。

### 验证 git hooks

`npm install` 的 `prepare` 脚本会执行 `git config core.hooksPath .githooks`，将钩子指向仓库内的 `.githooks/`（commit-msg / pre-commit / pre-push / pre-merge-commit）。若该配置被外部工具或环境重置覆盖，全部钩子会**静默失效**（#476、F20260821kgts 在案多次踩坑），提交规范只能靠 CI 兜底。安装完成后验证一次：

```bash
git config core.hooksPath
# 预期输出: .githooks（相对路径；若为其他值或指向不存在的目录，重新执行 npm run prepare）
```

### 贡献

欢迎 issue——bug 报告、想法、功能建议都是对项目的贡献。但暂不接受 PR：这是个人研究项目，维护带宽有限。想看到某个改动，请开 issue 描述它。

内部开发规范见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

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
