---
id: F20260708r6p5
title: project-repo-initialization
from_ids: []
tags: [config, infrastructure]
modules: [project-setup]
doc_kind: spec
status: locked
created_at: 2026-07-08
---

# F20260708r6p5 [project-setup] 项目代码仓初始化

## [design-time]

> 以下章节在需求收敛与设计阶段（代码前）完成并锁定。进入实现阶段后不得单方面修改，如需变更须通过问题卡片向用户提出并确认。

## 背景 [required]

otter-buddy（海獭）是一个全新的 Agentic System 项目，以 Agent 为本、Chat as Substrate、记忆系统为核心。项目设计哲学和架构决策详见 [snail-shell#597](https://github.com/chenlaicai/snail-shell/issues/597)。

当前项目目录仅有 `.claude/` 和 `.agents/`（Snail Shell 协作配置），尚无代码仓。需要完成代码仓初始化，包括 git 仓库、GitHub 私仓、项目骨架和配置文件，为后续 feature 开发提供基础。

用户指示参考 snail-shell 仓库的配置。

## 用户意图锚 [required]

| # | 来源 | 用户原话（逐字引用） | 关键修饰语 | 架构师解读 |
|---|------|---------------------|-----------|-----------|
| UA-1 | msg-4384 | 这是一个新项目otter-buddy | 数量：一个；状态：新的 | 需要从零创建项目，不是在已有项目上改造 |
| UA-2 | msg-4384 | 现在你在本项目下完成代码仓的初始化 | 空间：本项目下；任务范围：代码仓初始化 | 在 /Users/orca/ai/otter-buddy 目录下完成仓库初始化 |
| UA-3 | msg-4384 | 包括git创建等等 | 修饰语"等等"表示范围不限于 git | git 初始化是必要项但不充分，还需其他配置 |
| UA-4 | msg-4384 | 先做一个private私仓 | 时序：先做；条件：优先事项；数量：一个；属性：private | GitHub 仓库设为私有，且这是优先事项，创建一个仓库 |
| UA-5 | msg-4384 | 具体配置什么的可参考snail shell仓库 | 程度：可参考（非必须照搬）；参照物：snail shell | 以 snail-shell 为配置参考模板，但不意味着完全复制 |

## 目标 [required]

### P1 - 代码仓基础设施初始化

完成 git 仓库、GitHub 私仓、项目骨架和核心配置文件的建立，使项目具备开发、构建、测试和 CI 的基本能力。

具体交付物：
1. GitHub 私有仓库 `chenlaicai/otter-buddy` 创建并关联 remote
2. 项目骨架（package.json、tsconfig.json、ESLint、Vitest 配置）
3. 目录结构（src/、tests/、docs/、config/、data/、scripts/）
4. GitHub 配置（CI workflow、PR template、issue templates、CODEOWNERS、dependabot）
5. Git hooks（pre-commit、commit-msg、pre-push、pre-merge-commit）
6. 项目文档（README.md、README.en.md、LICENSE、CONTRIBUTING.md、SECURITY.md）

## 非目标 [required]

- 不实现 otter-buddy 系统的任何业务功能（Agent、Chat、Memory 等领域逻辑）
- 不设计详细的系统架构（后续独立 feature）
- 不配置 LLM 接入、数据库初始化等运行时配置
- 不部署或运行任何服务
- 不设置 Snail Shell 协作流程（已存在）

## 核心业务行为 [required]

本 feature 为基础设施初始化，不涉及系统业务行为。项目初始化后的可验证行为：

| # | 场景 | 预期行为 | 测试覆盖 |
|---|------|----------|----------|
| B1 | 当开发者 clone 仓库后运行 `npm install` 时 | 依赖安装成功，无错误 ← UA-2, UA-5 | |
| B2 | 当开发者运行 `npm run check` 时 | lint + tsc + build 全部通过（空项目状态） ← UA-5 | |
| B3 | 当开发者运行 `npm test` 时 | Vitest 执行通过（passWithNoTests） ← UA-5 | |
| B4 | 当开发者推送到 GitHub 时 | CI workflow 触发并运行 `npm run check` ← UA-3, UA-5 | |

## 设计 [required]

### P1 详设

#### 技术栈选择

> **[D1]** 技术栈参考 snail-shell，使用各库最新稳定版。初始化阶段仅安装后端 + 工具链依赖，前端框架等架构设计后添加。正方：用户指示"可参考 snail shell"；团队已有 snail-shell 技术栈经验；TypeScript 适合复杂系统。反方：otter-buddy 架构与 snail-shell 差异大，可能有更合适的技术选型。依据：用户明确指示参考 snail-shell，且当前阶段只做项目初始化不涉及架构选型，后续可调整。

> **[D5]** 初始化阶段不安装前端依赖（React/Vite）。正方：otter-buddy 的前端是 Chat as Substrate（聊天界面），与 snail-shell 的 Dashboard 前端架构完全不同，过早引入 snail-shell 的 web 配置模式后续大概率需要重写；初始化目标是"具备开发、构建、测试的基本能力"，后端骨架已满足。反方：一次性配置完整技术栈可以减少后续 setup 工作量。依据：前端架构设计应在独立 feature 中完成，避免预设与重写。

技术栈明细：

| 层 | 技术 | 版本策略 | 初始化阶段 |
|----|------|----------|-----------|
| 运行时 | Node.js | 22 (LTS) | 是 |
| 语言 | TypeScript | 最新稳定版 | 是 |
| 后端框架 | Hono | 最新稳定版 | 是 |
| 数据库 | better-sqlite3 | 最新稳定版 | 是 |
| 测试框架 | Vitest | 最新稳定版 | 是 |
| Lint | ESLint | 最新稳定版 (flat config) | 是 |
| 包管理 | npm | lockfile v3 | 是 |
| 前端框架 | React | 最新稳定版 | 否（架构设计后添加） |
| 构建工具 | Vite | 最新稳定版 | 否（架构设计后添加） |

#### 项目结构

```
otter-buddy/
├── .github/
│   ├── workflows/
│   │   └── ci.yml
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── feature_request.yml
│   │   └── config.yml
│   ├── dependabot.yml
│   ├── CODEOWNERS
│   └── pull_request_template.md
├── .githooks/
│   ├── pre-commit
│   ├── commit-msg
│   ├── pre-push
│   └── pre-merge-commit
├── config/
│   └── .gitkeep
├── data/
│   └── file/
│       ├── knowledge/
│       ├── prompts/
│       ├── skills/
│       └── sops/
├── docs/
│   ├── README.md
│   └── features/
│       └── .gitkeep
├── scripts/
│   └── .gitkeep
├── src/
│   └── .gitkeep
├── tests/
│   └── .gitkeep
├── .gitignore
├── CONTRIBUTING.md
├── LICENSE
├── package.json
├── README.md
├── SECURITY.md
├── tsconfig.json
├── eslint.config.mjs
└── vitest.config.ts
```

> **[D2]** 项目结构参考 snail-shell 但简化：初始化阶段只创建空目录骨架（.gitkeep），不预设 domain 模块结构。正方：otter-buddy 架构与 snail-shell 差异大，过早定义模块结构会限制后续设计自由度。反方：预留模块结构可以加速后续开发。依据：当前 feature 的目标仅为基础设施初始化，系统架构设计应在独立 feature 中完成。

#### 配置文件设计

**package.json**:
- name: "otter-buddy"
- version: "0.1.0"
- license: "MIT"
- type: "commonjs"
- scripts: prepare (githooks), build (lint + tsc), lint, lint:fix, test, check, start
- 依赖仅包含后端 + 工具链（无 React/Vite，前端架构设计后添加）

**tsconfig.json**:
- target: ES2022, module: commonjs
- strict mode
- 路径别名暂不预设（等架构设计后添加）
- includes: src/**/*, tests/**/*

**eslint.config.mjs**:
- ESLint flat config
- @eslint/js recommended + typescript-eslint recommended
- 基础规则（复杂度限制、代码长度限制）
- 暂不添加分层架构规则（等模块结构确定后添加）

**vitest.config.ts**:
- includes: tests/**/*.test.ts
- passWithNoTests: true

#### GitHub 配置

**CI (ci.yml)**:
- 触发: push to main + all PRs
- Node.js 22
- npm ci + npm run check
- PR 时检查是否与 main 同步

**CODEOWNERS**: `* @chenlaicai`

**Dependabot**: npm + github-actions, weekly, 10 open PRs

**Issue templates**: bug_report.yml, feature_request.yml, config.yml

**PR template**: Summary, Why, What Changed, Affected Areas (checkboxes,具体项待架构设计后补充), Risks, Verification (lint, build, test, manual), Notes

#### Git Hooks

**pre-commit**:
- 阻止直接提交到 main/master
- 运行 npm run check

**commit-msg**:
- 格式: `[FYYYYMMDDNN|FYYYYMMDDxNNN][module][Feature Update|BugFix|New Feature][Incompatible] 中文标题`
  - `FYYYYMMDDNN`：8位日期 + 2位顺序编号（旧格式）
  - `FYYYYMMDDxNNN`：8位日期 + 1位分隔符(x) + 3位随机码（新格式，字符集 2-9a-kmnp-z）
- 首行必须含 CJK 字符
- 跳过 merge/fixup commits

**pre-push**:
- 阻止直接 push 到 main/master remote

**pre-merge-commit**:
- 运行 npm run check

> **[D3]** Git hooks 参照 snail-shell（4 个 hook），commit-msg 格式与 snail-shell 完全兼容。正方：保持与 snail-shell 一致的提交规范，便于跨项目协作。反方：otter-buddy 可能有自己的工作流。依据：用户指示参考 snail-shell，后续可按需调整。

#### 配置示例文件

> **[D6]** 初始化阶段不创建 config/ 示例文件（server.yaml.example 等）。正方：otter-buddy 的架构（Chat as Substrate、四层记忆系统）与 snail-shell 不同，配置项很可能不同，过早创建示例文件会误导。反方：预留示例文件可以加速后续配置开发。依据：等架构设计确定配置项后再添加。config/ 目录保留但只放 .gitkeep。

#### 文档

**README.md**: 项目简介、技术架构概述、快速开始、配置说明（中文为主）

**README.en.md**: English version of README.md

**LICENSE**: MIT, Copyright (c) 2026 chenlaicai

**CONTRIBUTING.md**: 开发环境设置、PR 规范

**SECURITY.md**: 安全报告渠道

> **[D4]** 文档语言策略与 snail-shell 一致：README.md 中文、README.en.md 英文、CONTRIBUTING.md 和 SECURITY.md 英文、GitHub 模板英文。正方：与 snail-shell 风格一致，英文 README 有助于国际化。反方：新项目初期可能不需要英文 README。依据：用户指示参考 snail-shell，一次性配置到位避免后续补充。

## 生效路径 [required]

本 feature 的配置和约束通过以下长期入口生效：
- `package.json` — 项目依赖和脚本
- `tsconfig.json` — TypeScript 编译配置
- `eslint.config.mjs` — 代码规范
- `vitest.config.ts` — 测试配置
- `.github/workflows/ci.yml` — CI 流程
- `.githooks/` — Git 提交规范
- `.gitignore` — 版本控制忽略规则
- `README.md` — 项目说明

## 设计约束摘要 [required]

### 硬约束（违反即 bug）
- GitHub 仓库必须为 private
- git hooks 必须在 `npm install` 后自动激活（通过 `prepare` 脚本设置 `git config core.hooksPath .githooks`）
- CI 必须在 PR 时检查分支是否与 main 同步
- commit-msg 格式必须与 snail-shell 兼容

### 设计取舍（不得自行推翻）
- 技术栈参考 snail-shell，使用各库最新稳定版，后续架构设计阶段可调整具体依赖
- 初始化阶段仅安装后端 + 工具链依赖，前端框架等架构设计后添加（D5）
- 不创建 config/ 示例文件，等架构设计确定配置项后添加（D6）
- 项目结构简化，不预设 domain 模块（等架构设计）
- ESLint 规则简化，不添加分层架构规则（等模块结构确定）

### 语义不变量（实现中必须保持为真）
- `npm run check` 在空项目状态下必须通过
- `npm test` 在无测试文件时必须通过（passWithNoTests）
- git hooks 在 `npm install` 后自动激活

### 非目标（不得扩展）
- 不实现任何业务功能
- 不设计系统架构
- 不配置运行时环境

## 改动范围 [required]

全部为新增文件：

| 文件/目录 | 说明 |
|-----------|------|
| `package.json` | 项目 manifest（后端 + 工具链依赖，无前端） |
| `tsconfig.json` | TypeScript 配置 |
| `eslint.config.mjs` | ESLint flat config |
| `vitest.config.ts` | Vitest 配置 |
| `.github/workflows/ci.yml` | CI workflow |
| `.github/ISSUE_TEMPLATE/*` | Issue 模板 |
| `.github/dependabot.yml` | Dependabot 配置 |
| `.github/CODEOWNERS` | 代码所有者 |
| `.github/pull_request_template.md` | PR 模板（含 Affected Areas、Notes 段落） |
| `.githooks/pre-commit` | 提交前 hook |
| `.githooks/commit-msg` | 提交消息 hook |
| `.githooks/pre-push` | 推送前 hook |
| `.githooks/pre-merge-commit` | 合并前 hook |
| `config/.gitkeep` | 配置目录占位（不创建示例文件） |
| `data/file/{knowledge,prompts,skills,sops}/.gitkeep` | 数据目录占位 |
| `docs/README.md` | 文档目录说明 |
| `docs/features/.gitkeep` | Feature 文档目录占位 |
| `scripts/.gitkeep` | 脚本目录占位 |
| `src/.gitkeep` | 源码目录占位 |
| `tests/.gitkeep` | 测试目录占位 |
| `README.md` | 项目说明（中文） |
| `README.en.md` | 项目说明（英文） |
| `LICENSE` | MIT 许可证 |
| `CONTRIBUTING.md` | 贡献指南 |
| `SECURITY.md` | 安全策略 |
| `.gitignore` | 已在 bootstrap 阶段创建，需按最终版更新 |

## 验证 [required]

### P1

- [x] `git remote -v` 显示 `origin` 指向 `https://github.com/chenlaicai/otter-buddy.git`
- [x] GitHub 仓库存在且为 private
- [x] `npm install` 成功无错误
- [x] `npm run check` 通过（lint + tsc + build）
- [x] `npm test` 通过（passWithNoTests）
- [x] `npm run prepare` 后 `git config core.hooksPath` 输出 `.githooks`
- [x] commit-msg hook 拒绝不符合格式的提交消息
- [x] pre-push hook 阻止直接推送到 main
- [x] pre-merge-commit hook 运行 npm run check
- [x] CI 在 GitHub 上触发并通过

### 通用

- [x] `.gitignore` 正确忽略 node_modules/、dist/、.claude/ 等
- [x] 目录结构与设计一致
- [x] README.md 内容准确

## 关联 [required]

- **相关**: [snail-shell#597](https://github.com/chenlaicai/snail-shell/issues/597)（otter-buddy 项目设计哲学和架构决策）

## 关键决策记录 [required]

| # | 决策点 | 最终决策 | 状态 |
|---|--------|----------|------|
| D1 | 技术栈选择 | 参考 snail-shell，使用各库最新稳定版 | 设计阶段确认 |
| D2 | 项目结构深度 | 简化：只创建空目录骨架，不预设 domain 模块 | 设计阶段确认 |
| D3 | Git hooks 策略 | 参照 snail-shell（4 个 hook），commit-msg 格式完全兼容 | 设计阶段确认 |
| D4 | 文档语言策略 | 与 snail-shell 一致：README 中英文、CONTRIBUTING/SECURITY 英文、GitHub 模板英文 | 设计阶段确认 |
| D5 | 前端配置范围 | 初始化阶段不安装前端依赖（React/Vite），等架构设计后添加 | 审查阶段新增 |
| D6 | config 示例文件 | 初始化阶段不创建配置示例文件，等架构设计确定配置项后添加 | 审查阶段新增 |

## 风险与缓解 [required]

| # | 风险 | 严重程度 | 影响 | 缓解策略 | 负责方 |
|---|------|----------|------|----------|--------|
| R1 | 技术栈后续需要调整 | 低 | 依赖变更成本 | 初始化阶段依赖最小化，仅包含必需包 | 开发者 |
| R2 | GitHub 仓库创建权限 | 中 | 无法创建私仓 | 使用 gh CLI 确认用户已登录 | 开发者 |
| R3 | git hooks 在不同环境兼容性 | 低 | hooks 不生效 | 使用 shell script，跨平台通过 git config 保证 | 开发者 |
