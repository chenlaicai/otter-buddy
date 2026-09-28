---
id: F20260928deps
title: 统一升级依赖版本（2026-09-28）
doc_type: feature
summary: |
  关闭 7 个 Dependabot npm PR（#1136-#1142），按其版本创建统一升级 PR：
  @types/node 26.5.1→26.6.2、@larksuiteoapi/node-sdk 1.73.3→1.74.0、
  @earendil-works/pi-coding-agent 0.85.1→0.86.0、eslint 10.10.0→10.11.0、
  hono 4.13.7→4.13.8、@earendil-works/pi-ai 0.85.1→0.86.0、
  @huggingface/transformers 4.2.0→4.3.0；
  另含 GitHub Actions：actions/upload-artifact v4→v7（#1135）。
  vitest 4.1.11→5.0.1（#1143，主版本）按规范单独 PR 处理（F20260928vitt）。
  编号顺延说明：9/24 启动，因 kimi 模型 429 断档搁置，9/28 续完交付——
  特性编号按搭档指示顺延至实际交付日（F20260924deps → F20260928deps）。
causal_links:
  from:
    - F20260903deps
change_type: feature-update
tags: [deps, dependencies, upgrade, dependabot]
modules:
  - package.json
  - package-lock.json
  - .github/workflows/ci.yml
capability_test: "n/a: 纯依赖升级，无 LLM 参与行为"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
---

# F20260928deps: 统一升级依赖版本（2026-09-28）

## 背景与需求

### 问题描述

定时任务「依赖升级自动化」（仅 Dependabot 驱动，决策来源 PR #419）触发，
发现 9 个 Dependabot PR 待处理（#1135-#1143）。

### 交付时间线（编号顺延原因）

- 2026-09-24 启动：关闭 7 个 Dependabot PR、创建本 PR 后，kimi 模型配额 429 断档，
  无人处置 CI 失败（PR 标题缺 [F ID] 前缀 + 分支落后 main），PR 挂 4 天
- 2026-09-28 续完：glm 接棒——修正标题、rebase main、订正悬空引用、对抗审视通过后交付
- 特性编号按搭档指示顺延至实际交付日

## 变更说明

### 关闭的 Dependabot PR

- #1136: Bump @huggingface/transformers from 4.2.0 to 4.3.0
- #1137: Bump @earendil-works/pi-ai from 0.85.1 to 0.86.0
- #1138: Bump hono from 4.13.7 to 4.13.8
- #1139: Bump eslint from 10.10.0 to 10.11.0
- #1140: Bump @earendil-works/pi-coding-agent from 0.85.1 to 0.86.0
- #1141: Bump @larksuiteoapi/node-sdk from 1.73.3 to 1.74.0
- #1142: Bump @types/node from 26.5.1 to 26.6.2
- #1135: Bump actions/upload-artifact from 4 to 7（GitHub Actions，随本 PR 一并升级）
- #1143: Bump vitest from 4.1.11 to 5.0.1（major，单独 PR，见 F20260928vitt）

### 升级的依赖（本 PR 范围）

| 依赖 | 版本变化 | 类型 |
|---|---|---|
| @types/node | 26.5.1 → 26.6.2 | minor |
| @larksuiteoapi/node-sdk | 1.73.3 → 1.74.0 | minor |
| @earendil-works/pi-coding-agent | 0.85.1 → 0.86.0 | minor |
| eslint | 10.10.0 → 10.11.0 | minor |
| hono | 4.13.7 → 4.13.8 | patch |
| @earendil-works/pi-ai | 0.85.1 → 0.86.0 | minor |
| @huggingface/transformers | 4.2.0 → 4.3.0 | minor |
| actions/upload-artifact | v4 → v7 | GitHub Actions major |

### actions/upload-artifact v4→v7 说明

- 仅一处使用：`.github/workflows/ci.yml` e2e-screenshots 上传（标准 name/path/retention-days 用法）
- v5/v6/v7 的 breaking changes（Node 24 runtime、ESM、direct uploads）均不影响本用法；
  v7 新增的 `archive` 参数为可选，默认行为不变
- 使用 GitHub 托管 runner（ubuntu-latest），无自托管 runner 版本约束问题

### 明确不做

- 不升级 vitest 5.x（主版本，单独 PR F20260928vitt）
- 不做全量 `npm update`（PR #419 决策：仅 Dependabot 信号驱动）

## 验证

- [x] `npx tsc --noEmit` 通过
- [x] `npm run lint` 通过
- [x] `npm test` 通过（9/24 基线：279 个测试文件，3856 个测试）
- [x] 9/28 rebase main 后 CI 三绿（run 36374230736：check/e2e/golden-selftest，检视獭 delta 复核实查）
