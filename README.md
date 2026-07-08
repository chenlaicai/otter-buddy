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

### 安装依赖

```bash
npm install
```

### 构建项目

```bash
npm run build
```

### 运行测试

```bash
npm test
```

### 完整检查（lint + build）

```bash
npm run check
```

## 项目结构

```
otter-buddy/
├── .github/          # GitHub 配置（CI、Issue 模板、PR 模板等）
├── .githooks/        # Git hooks（提交规范、分支保护）
├── docs/             # 项目文档
├── src/              # 源码
├── tests/            # 测试
├── package.json
├── tsconfig.json
├── eslint.config.mjs
└── vitest.config.ts
```

## 许可证

[MIT](./LICENSE)
