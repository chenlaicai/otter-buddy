---
id: F20260903deps
title: 统一升级依赖版本（2026-09-03）
doc_type: feature
summary: |
  关闭 9 个 Dependabot PR（#701-#709），按其中 8 个 npm 包的版本创建统一升级 PR：
  sharp 0.34.5→0.35.4、js-yaml 5.3.0→5.4.1、hono 4.13.3→4.13.5、@types/node 26.2.0→26.4.0、
  typescript-eslint 8.67.0→8.68.0、@earendil-works/pi-ai 0.83.0→0.84.4、
  @earendil-works/pi-coding-agent 0.83.0→0.84.4、eslint 10.9.0→10.9.1。
  第 9 个（actions/github-script v7→v9，major）按规范单独 PR 处理。
causal_links:
  from:
    - F20260820xefif
status: development
change_type: feature-update
tags: [deps, dependencies, upgrade, dependabot]
modules:
  - package.json
  - package-lock.json
capability_test: "n/a: 纯依赖升级，无 LLM 参与行为"
created_in_conversation: a3758263-dfac-4396-93ee-37d89efb5b0e
---

# F20260903deps: 统一升级依赖版本（2026-09-03）

## 背景与需求

### 问题描述

定时任务「依赖升级自动化」（仅 Dependabot 驱动，决策来源 PR #419）触发，
发现 9 个 Dependabot PR 待处理（#701-#709）。

## 变更说明

### 关闭的 Dependabot PR

- #709: Bump sharp from 0.34.5 to 0.35.4
- #708: Bump js-yaml from 5.3.0 to 5.4.1
- #707: Bump hono from 4.13.3 to 4.13.5
- #706: Bump @types/node from 26.2.0 to 26.4.0
- #705: Bump typescript-eslint from 8.67.0 to 8.68.0
- #704: Bump @earendil-works/pi-ai from 0.83.0 to 0.84.4
- #703: Bump @earendil-works/pi-coding-agent from 0.83.0 to 0.84.4
- #702: Bump eslint from 10.9.0 to 10.9.1
- #701: Bump actions/github-script from 7 to 9（major，单独 PR，见 F20260903ghsc）

### 升级的依赖（本 PR 范围）

| 依赖 | 版本变化 | 类型 |
|---|---|---|
| sharp | 0.34.5 → 0.35.4 | minor（0.x semver） |
| js-yaml | 5.3.0 → 5.4.1 | minor |
| hono | 4.13.3 → 4.13.5 | patch |
| @types/node | 26.2.0 → 26.4.0 | minor |
| typescript-eslint | 8.67.0 → 8.68.0 | minor |
| @earendil-works/pi-ai | 0.83.0 → 0.84.4 | minor |
| @earendil-works/pi-coding-agent | 0.83.0 → 0.84.4 | minor |
| eslint | 10.9.0 → 10.9.1 | patch |

### 明确不做

- 不主动 npm update 其他包（PR #419 决策：仅 Dependabot 驱动）
- actions/github-script v7→v9 不在本 PR（major 升级单独 PR + 警告标记）

## 验证

- [x] lint 通过（0 errors，5 warnings 为存量非本次引入）
- [x] build 通过
- [x] test 通过（227 文件 / 2818 用例全绿）
