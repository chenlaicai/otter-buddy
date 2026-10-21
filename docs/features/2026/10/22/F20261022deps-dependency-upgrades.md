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

- `package.json`：8 个依赖版本号提升（playwright 见下，已从本批次剔除）
- `package-lock.json`：lockfile 同步更新

### 检视处置：playwright 从本批次剔除（保留 1.63.0 精确钉版）

检视发现（PR #1605 检视报告建议 1）：#1445（commit 1dea920d）引入 playwright 时声明「精确对齐 web 已装版本，复用 Chromium 缓存」——本 PR 原将根仓 playwright 升 1.64.1 且解除钉版（改 caret），与 web/ 子项目（@playwright/test ^1.63.0，实际解析 1.63.x）的对齐被双向破坏（版本偏移 + 钉版机制解除）。

处置（L1 拍板）：**#1445 对齐约束（人的架构决策）优先于 Dependabot 的 minor 升级意图**——从本批次剔除 playwright 升级，恢复 `"playwright": "1.63.0"` 精确钉版（对齐机制完整保留，Chromium 缓存单份）。替代方案否决理由：同 PR 动 web/ 超出 Dependabot 覆盖范围（web 是独立 npm 项目，改动面不可控）；升级+记偏移则缓存双份且钉版机制仍被解除。

跟进项：playwright 升级转为「与 web/ 侧协同」——待 web/ 升级 @playwright/test 时两侧同版本协同升级（届时根仓保留精确钉版形态）。Dependabot 下次再提 playwright 升级时按本决策挡回，直至 web 侧协同窗口出现。

### 现场处置记录

复用了昨日（10-21）另一条对话线遗留的孤儿 worktree `deps-bump-20261021`（零 commit、零推送、无产物登记，疑似断档半成品）：丢弃其过期改动，rebase 到最新 main（fe807285）后在本 worktree 内完成本轮升级。

### 已知问题：rolldown 1.2.15 上游发布残缺

vitest 5.0.5 传递依赖 rolldown ~1.2.14 → 解析到 1.2.15。rolldown 1.2.15 的 `@rolldown/binding-freebsd-x64@1.2.15` **上游未发布**（registry 最新仅 1.2.14），但 rolldown 的 optionalDependencies 仍声明它——mac 本地 npm 生成 lockfile 时裁掉该条目，Linux CI `npm ci` 校验锁完整性即报 `Missing: @rolldown/binding-freebsd-x64@1.2.15`（EUSAGE，首轮 CI check job 失败实证）。

处置：`package.json` 新增 devDependencies 直接锁定 `rolldown@1.2.14`（1.2.14 全平台 binding 完整），绕过残缺版本。属 workaround。

退役通道（检视建议 2 处置）：**退役条件 = rolldown 发布 ≥1.2.16 且其 optionalDependencies 含已实际发布的 `@rolldown/binding-freebsd-x64`（registry 可解析）后，移除 devDependencies 的 rolldown 精确锁定，复跑 `npm ci`（Linux）+ build/lint/test 全绿后合入**。触发器与跟踪：issue #1606（owner：依赖升级自动化批次——每批开工前检查 rolldown 上游状态，命中退役条件即顺手移除；30 天未命中由 regression-verify 断言回查兜底提醒）。

## Verification

- `npm run build`：通过
- `npm run lint`：通过
- `npm test`：6629 通过 / 8 失败——失败集合（generate-guard-replay ×4、game-harness-tools ×4、page-visual ×1）与最新 main 对照**完全一致**，均为存量失败/环境性失败，非本次升级引入（main 与升级分支逐文件对照验证，2026-10-22 01:07）
- 首轮 CI check job 失败后锁定 rolldown 1.2.14 复跑：build ✅ lint ✅ test 同样 6629 通过 / 同 8 个存量失败（2026-10-22 01:15）
