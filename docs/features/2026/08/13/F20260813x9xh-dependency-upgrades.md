---
id: F20260813x9xh
title: dependency-upgrades
doc_type: feature

summary: |
  统一升级依赖版本，关闭 Dependabot 自动创建的 PR，按照研发流程创建统一的依赖升级 PR。
  包含主版本升级（@types/better-sqlite3: 7.6.13 → 9.6.0）和多个次要版本升级。

causal_links:
  from:
    - F20260812a2b3

status: development
change_type: feature_update
tags: [deps, dependencies, upgrade, dependabot]
modules:
  - package-lock.json
capability_test: "n/a: 纯依赖升级，无 LLM 参与行为"
---

# F20260813x9xh: 统一升级依赖版本

## 背景与需求

### 问题描述

Dependabot 每周自动创建依赖升级 PR，导致多个 PR 同时打开，需要人工逐个检视和合入，效率低下。

### 现状分析

当前行为：
- Dependabot 每周自动创建依赖升级 PR
- 每个 PR 包含单个依赖的升级
- 需要人工逐个检视和合入

问题：
- 多个 PR 同时打开，增加检视负担
- 无法统一管理依赖升级
- 主版本升级可能带来破坏性变更，需要特别关注

## 方案设计

### 核心逻辑变更

1. **定时任务触发**：每天早上 9:00（上海时间）自动检查 Dependabot PR
2. **关闭 Dependabot PR**：自动关闭所有 Dependabot 创建的 PR
3. **创建统一 PR**：创建统一的依赖升级 PR，包含所有依赖升级
4. **按研发流程提交**：按照研发流程格式提交代码，包含特性编号和特性文档

### 升级策略

- **补丁版本升级**（^1.0.0 → 1.0.1）：自动升级
- **次要版本升级**（^1.0.0 → 1.1.0）：自动升级
- **主版本升级**（^1.0.0 → 2.0.0）：包含在统一 PR 中，但添加警告标记

## 变更说明

### 关闭的 Dependabot PR

- #240: Bump @types/better-sqlite3 from 7.6.13 to 9.6.0
- #239: Bump typescript-eslint from 8.65.0 to 8.66.0
- #238: Bump @earendil-works/pi-ai from 0.83.0 to 0.84.1
- #237: Bump @types/node from 26.1.2 to 26.2.0
- #236: Bump eslint from 10.8.0 to 10.8.1
- #235: Bump @earendil-works/pi-coding-agent from 0.83.0 to 0.84.1
- #234: Bump hono from 4.13.0 to 4.13.1

### 升级的依赖

- **主版本升级**：
  - @types/better-sqlite3: 7.6.13 → 9.6.0

- **次要版本升级**：
  - typescript-eslint: 8.65.0 → 8.66.0
  - @earendil-works/pi-ai: 0.83.0 → 0.84.1
  - @types/node: 26.1.2 → 26.2.0
  - @earendil-works/pi-coding-agent: 0.83.0 → 0.84.1

- **补丁版本升级**：
  - eslint: 10.8.0 → 10.8.1
  - hono: 4.13.0 → 4.13.1

## 检查清单

- [ ] 代码检查通过（lint）
- [ ] 构建成功
- [ ] 测试通过
- [ ] 确认主版本升级无破坏性变更
- [ ] 确认所有依赖升级无兼容性问题

## 影响范围

### 文件变更

- `package-lock.json`：依赖版本升级

### 潜在影响

- **主版本升级**：@types/better-sqlite3 (7.6.13 → 9.6.0) 可能带来类型定义变更
- **次要版本升级**：可能带来新功能或行为变更
- **补丁版本升级**：通常只包含 bug 修复，影响较小

## 验证方式

1. 运行 `npm run check` 验证构建成功
2. 运行 `npm test` 验证测试通过
3. 检查主版本升级的 changelog，确认无破坏性变更
