---
id: F20260917deps
title: 统一升级依赖版本（2026-09-17）
doc_type: feature
summary: |
  定时任务「依赖升级自动化」触发，发现 6 个 Dependabot PR（#973-#978），全部关闭后按统一升级流程处理：
  yaml 2.9.0→2.9.1、typescript-eslint 8.69.0→8.70.0、@types/node 26.4.1→26.5.1、
  @node-rs/jieba 2.0.2→2.0.3、tsc-alias 1.9.4→1.9.5、js-yaml 5.4.1→5.4.2。
  全部为 patch/minor 升级，无主版本变更。
causal_links:
  from:
    - F20260914deps
change_type: feature-update
tags: [deps, dependencies, upgrade, dependabot]
modules:
  - package.json
  - package-lock.json
capability_test: "n/a: 纯依赖升级，无 LLM 参与行为"
created_in_conversation: a3758263-dfac-4396-93ee-37d89efb5b0e
---

# F20260917deps: 统一升级依赖版本（2026-09-17）

## 背景与需求

定时任务「依赖升级自动化」（仅 Dependabot 驱动，决策来源 PR #419）触发，
发现 6 个 Dependabot PR 待处理（#973-#978）。

## 变更说明

### 关闭的 Dependabot PR

- #978: Bump js-yaml from 5.4.1 to 5.4.2
- #977: Bump tsc-alias from 1.9.4 to 1.9.5
- #976: Bump @node-rs/jieba from 2.0.2 to 2.0.3
- #975: Bump @types/node from 26.4.1 to 26.5.1
- #974: Bump typescript-eslint from 8.69.0 to 8.70.0
- #973: Bump yaml from 2.9.0 to 2.9.1

### 升级的依赖（本 PR 范围）

| 依赖 | 版本变化 | 类型 |
|---|---|---|
| js-yaml | 5.4.1 → 5.4.2 | patch |
| tsc-alias | 1.9.4 → 1.9.5 | patch |
| @node-rs/jieba | 2.0.2 → 2.0.3 | patch |
| @types/node | 26.4.1 → 26.5.1 | minor |
| typescript-eslint | 8.69.0 → 8.70.0 | minor |
| yaml | 2.9.0 → 2.9.1 | patch |

### 明确不做

- 不主动 `npm update`（PR #419 决策：仅 Dependabot 驱动）
- 无主版本升级，无需单独 PR

## 验证

- `npx tsc --noEmit`：通过
- `npm test`：3175 个测试全部通过（261 个测试文件）
