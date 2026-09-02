---
id: F20260903ghsc
title: 升级 actions/github-script v7→v9（major，含 breaking changes 评估）
doc_type: feature
summary: |
  关闭 Dependabot PR #701（Bump actions/github-script from 7 to 9），按主版本升级规范单独 PR 处理。
  v9 breaking change 为 require('@actions/github') 失效（ESM-only）；经核查本仓库唯一使用点
  auto-close-external-prs.yml 仅用注入的 github/context 全局变量，无 require 调用，兼容 v9。
causal_links:
  from:
    - F20260903deps
status: development
change_type: feature-update
tags: [deps, github-actions, major-upgrade]
modules:
  - .github/workflows/auto-close-external-prs.yml
capability_test: "n/a: CI workflow 版本变更，无 LLM 参与行为"
created_in_conversation: a3758263-dfac-4396-93ee-37d89efb5b0e
---

# F20260903ghsc: 升级 actions/github-script v7→v9

## 背景与需求

### 问题描述

Dependabot PR #701 请求将 actions/github-script 从 v7 升到 v9（跨 v8 的 major 升级）。
按依赖升级规范，主版本升级单独 PR 并标记警告。

### v9 Breaking Changes 评估

v9.0.0 的破坏性变更（官方 release notes）：

1. `require('@actions/github')` 不再可用（@actions/github v9 为 ESM-only）
2. `getOctokit` 变为注入的函数参数——脚本内 `const getOctokit = ...` 声明会 SyntaxError
3. 访问其他 `@actions/github` 内部结构需更新引用

**仓库唯一使用点核查**：`.github/workflows/auto-close-external-prs.yml`（grep 全 workflows 目录仅此一处）：

- 脚本仅使用注入的 `context.payload` / `github.rest.issues.createComment` / `github.rest.pulls.update`
- 无 `require('@actions/github')`、无 `getOctokit` 声明
- 结论：**兼容 v9，无需改动脚本逻辑**，仅升版本引用

## 变更说明

- `.github/workflows/auto-close-external-prs.yml`：`actions/github-script@v7` → `@v9`

## 验证

- [x] 全仓 grep 确认 github-script 仅 1 处使用
- [x] 脚本逻辑对照 v9 breaking changes 逐条核查，无命中
- [ ] 合入后观察下一次外部 PR 触发时的实际运行（本 workflow 仅在外部 PR 打开时触发，无主动触发手段）

## 风险提示（⚠️ major 升级）

- v9 要求 runner ≥ v2.327.1（GitHub 托管 runner 已满足）
- 若合入后外部 PR 自动关闭流程报错，回滚方式：将 `@v9` 改回 `@v7` 即可
