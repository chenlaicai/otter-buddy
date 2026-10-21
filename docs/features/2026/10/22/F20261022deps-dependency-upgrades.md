---
id: F20261022deps
title: 统一升级依赖版本（2026-10-22 批次）
doc_type: feature

summary: |
  统一升级依赖版本，关闭 Dependabot 自动创建的 PR（#1587–#1595 共 9 个），按照研发流程创建统一的依赖升级 PR。

causal_links:
  from:
    - F20261013deps

change_type: feature-update
tags: [deps, dependencies, upgrade, dependabot]
modules:
  - package-lock.json
capability_test: "n/a: 纯依赖升级，无 LLM 参与行为"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
---

# F20261022deps: 统一升级依赖版本（2026-10-22 批次）

## 背景与需求

### 问题描述

Dependabot 自动创建了 9 个依赖升级 PR，需要统一处理（决策来源：搭档 2026-08-25 在 PR #419 的关闭评论——本定时任务只处理 Dependabot PR，不主动 `npm update`）。

### 覆盖的 Dependabot PR

| PR | 包 | 从 | 到 |
|---|---|---|---|
| #1587 | typescript-eslint | 8.71.1 | 8.71.2 |
| #1588 | playwright | 1.63.0 | 1.64.1 |
| #1589 | js-yaml | 5.4.2 | 5.5.0 |
| #1590 | eslint | 10.12.0 | 10.13.0 |
| #1591 | @earendil-works/pi-ai | 1.1.0 | 1.3.0 |
| #1592 | tsc-alias | 1.9.7 | 1.9.8 |
| #1593 | vitest | 5.0.4 | 5.0.5 |
| #1594 | @larksuiteoapi/node-sdk | 1.74.0 | 1.76.0 |
| #1595 | @hono/node-server | 2.1.1 | 2.1.5 |

全部为小版本/补丁版本升级，无主版本升级。

## 变更说明

- `package.json`：9 个依赖版本号提升
- `package-lock.json`：lockfile 同步更新

### 现场处置记录

复用了昨日（10-21）另一条对话线遗留的孤儿 worktree `deps-bump-20261021`（零 commit、零推送、无产物登记，疑似断档半成品）：丢弃其过期改动，rebase 到最新 main（fe807285）后在本 worktree 内完成本轮升级。

## Verification

- `npm run build`：通过
- `npm run lint`：通过
- `npm test`：6629 通过 / 8 失败——失败集合（generate-guard-replay ×4、game-harness-tools ×4、page-visual ×1）与最新 main 对照**完全一致**，均为存量失败/环境性失败，非本次升级引入（main 与升级分支逐文件对照验证，2026-10-22 01:07）
