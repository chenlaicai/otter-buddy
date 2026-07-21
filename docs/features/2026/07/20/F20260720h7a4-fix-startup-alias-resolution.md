---
id: F20260720h7a4
title: — 修复 TypeScript 路径别名导致的启动失败
doc_type: feature

# 记忆索引
summary: |
  修复 TypeScript 路径别名导致的启动失败问题，确保模块解析在构建和运行时一致。
  涉及 tsconfig paths、tsc-alias、vitest 等工具链的配置对齐。


# 元数据
status: ## 状态
change_type: feature
tags: []
modules: []

# 时间
created_at: 
---

# F20260720h7a4 — 修复 TypeScript 路径别名导致的启动失败

## 状态

- [x] design
- [x] development
- [ ] review
- [ ] merge

## 概述

系统按 README 步骤执行 `npm start` 后立即崩溃：`Error: Cannot find module '@frameworks/config'`。根因是 TypeScript 路径别名（`@frameworks/*`、`@entities/*` 等）仅在编译时生效，`tsc` 将别名字符串原样输出到 `.js` 文件，Node.js 运行时无法解析。

## 用户意图锚

| ID | 用户原话 | 来源 | 关键修饰语 | 架构师解读 |
|----|---------|------|-----------|-----------|
| UA-1 | 按readme步骤启动系统报错 | Issue 标题 | 按readme步骤、启动、报错 | 用户严格遵循 README 文档操作，执行 `npm start` 后遇到运行时错误。隐含期望：按文档操作应能正常启动。 |

## [design-time] 问题分析

### 现象

```
$ npm start
> otter-buddy@0.1.0 start
> npm run build && node dist/src/main.js

node:internal/modules/cjs/loader:1459
  throw err;
  ^
Error: Cannot find module '@frameworks/config'
Require stack:
- /Users/orca/ai/otter-buddy/dist/src/main.js
```

### 根因链

1. `tsconfig.json` 定义了 5 组路径别名（`@entities/*`、`@usecases/*`、`@interface-adapters/*`、`@frameworks/*`、`@contract/*`）
2. `tsc` 仅在编译期使用这些别名进行模块解析，输出的 `.js` 文件保留原始别名字符串
3. `package.json` 的 `build` 脚本为 `npm run lint && ... && npx tsc`，无路径重写步骤
4. 项目从未引入 `tsc-alias`、`tsconfig-paths`、`module-alias` 等运行时路径解析工具（git 历史确认）
5. Node.js 将 `@frameworks/config` 解释为 scoped npm 包，在 `node_modules/@frameworks/` 中查找失败

### 影响范围

此问题影响编译输出中的 **所有** 路径别名引用（60+ 处），涵盖全部 5 个别名前缀。`@frameworks/config` 只是 `main.js` 中第一个被执行的别名导入，因此最先触发错误。

### 为什么测试能通过

`vitest.config.ts` 单独配置了 `resolve.alias`，Vitest 在运行测试时自行解析路径别名，不依赖 Node.js 原生模块解析。因此 `npm test` 不受影响。

### 为什么之前没发现

项目可能从未通过 `node dist/src/main.js` 启动成功过（测试通过 Vitest 的别名解析运行），或者曾经有路径重写机制但已被移除（git 历史未发现此类工具）。

## [design-time] 方案设计

### 推荐方案：引入 `tsc-alias` 作为编译后处理步骤

**技术理由**：
- 最小改动：仅需安装一个 devDependency + 修改 build 脚本
- `tsc-alias` 读取 `tsconfig.json` 的 `paths` 配置，将编译输出中的别名替换为正确的相对路径
- 不改变现有源码结构和导入风格
- 社区成熟方案，与 `tsc` + `commonjs` 输出完全兼容

**具体变更**：

1. 安装依赖：`npm install -D tsc-alias`
2. 修改 `package.json` 的 `build` 脚本：
   ```
   "build": "npm run lint && node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\" && npx tsc && npx tsc-alias"
   ```
3. 验证：`npm start` 后系统正常启动

**风险**：
- `tsc-alias` 增加约 1 秒构建时间（可忽略）
- 需要确保 `tsc-alias` 版本与 TypeScript 6.x 兼容

**替代方案**：使用 Node.js 原生 `#imports`（需改动全部源码中的 `@` 前缀为 `#` 前缀 + 添加 `package.json` 的 `imports` 字段），改动量大且改变开发者心智模型。

### 不兼容更新

无。此变更仅影响构建流程，不改变运行时 API 或配置格式。

### 实现指引

- **兼容性验证**：安装 `tsc-alias` 后，第一个验证步骤为 `npx tsc-alias` 能否在当前 TypeScript 6.x 下正常执行（`tsc-alias` 通过读取 `tsconfig.json` 的 `paths` 做字符串替换，不直接依赖 Compiler API，理论兼容，但需实测确认）
- `tsc-alias` 无需额外配置文件，它直接读取 `tsconfig.json` 的 `paths`
- 无需修改 `vitest.config.ts`，Vitest 的别名解析独立于 `tsc-alias`
- `@contract/*` → `api-contract/*` 映射指向根目录级别（非 `src/` 子目录），实现者需验证 `tsc-alias` 正确计算从 `dist/src/xxx.js` 到 `dist/api-contract/` 的相对路径

## [design-time] 行为条目

| ID | 触发条件 | 预期行为 | 来源 |
|----|---------|---------|------|
| B-1 | 执行 `npm start`（README 中的启动命令） | 系统正常启动，监听端口 3000 ← UA-1 | UA-1 |
| B-2 | 执行 `npm run build` | 编译输出中的路径别名被替换为正确的相对路径 | 根因分析 |
| B-3 | 执行 `npm test` | 测试通过（不受此变更影响） | 回归保障 |

## [design-time] 验收标准

| ID | 验收条件 | 验证方法 |
|----|---------|---------|
| AC-1 | `npm start` 后系统正常启动，无 `Cannot find module` 错误 | 执行 `npm start`，观察输出 |
| AC-2 | `dist/src/` 目录下不包含 `@frameworks/`、`@entities/`、`@usecases/`、`@interface-adapters/`、`@contract/` 别名字符串 | `grep -r "@frameworks/\|@entities/\|@usecases/\|@interface-adapters/\|@contract/" dist/src/` 返回空 |
| AC-3 | `npm test` 通过 | 执行 `npm test` |

## 决策记录

| 决策 | 理由 | 替代方案 | 决策模式 |
|------|------|---------|---------|
| 选择 `tsc-alias` 而非 `#imports` 或 bundler | 最小改动量，不改变源码结构，社区成熟方案 | `#imports`（需改全部源码）、esbuild/rollup（过重） | 技术事实，自主决策 |
