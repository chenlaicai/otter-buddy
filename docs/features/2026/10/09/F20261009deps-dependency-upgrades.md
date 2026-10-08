---
id: F20261009deps
title: 统一升级依赖版本（2026-10-09 批次）
doc_type: feature

summary: |
  统一升级依赖版本，关闭 Dependabot 自动创建的 PR（#1326/#1328/#1329/#1330/#1331/#1332/#1333/#1334），按照研发流程创建统一的依赖升级 PR。

causal_links:
  from:
    - F20260820xefif

change_type: feature-update
tags: [deps, dependencies, upgrade, dependabot]
modules:
  - package-lock.json
capability_test: "n/a: 纯依赖升级，无 LLM 参与行为"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
---

# F20261009deps: 统一升级依赖版本（2026-10-09 批次）

## 背景与需求

### 问题描述

Dependabot 自动创建了 8 个依赖升级 PR，需要统一处理（决策来源：搭档 2026-08-25 在 PR #419 的关闭评论——本定时任务只处理 Dependabot PR，不主动 `npm update`）。

### 覆盖的 Dependabot PR

| PR | 包 | 从 | 到 |
|---|---|---|---|
| #1334 | tsc-alias | 1.9.5 | 1.9.7 |
| #1333 | sharp | 0.35.4 | 0.35.5 |
| #1332 | pino | 10.3.1 | 10.4.0 |
| #1331 | vitest | 5.0.1 | 5.0.3 |
| #1330 | eslint | 10.11.0 | 10.12.0 |
| #1329 | hono | 4.13.8 | 4.13.13 |
| #1328 | typescript-eslint | 8.70.0 | 8.71.0 |
| #1326 | @types/node | 26.6.2 | 26.6.4 |

全部为小版本/补丁版本升级，无主版本升级。

## 变更说明

- `package.json`：8 个依赖版本号提升
- `package-lock.json`：lockfile 同步更新

## Verification

- `npm run build`：通过
- `npm run lint`：通过
- `npm run test`：337 个测试文件、5055 个测试全部通过（25.45s）
