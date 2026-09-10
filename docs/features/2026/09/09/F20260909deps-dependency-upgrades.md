---
id: F20260909deps
title: 统一升级依赖版本（2026-09-09）
doc_type: feature
summary: |
  关闭 9 个 Dependabot PR（#869-#878，剔除 vitest 5.0.0 主版本），按其中 8 个 npm 包 + 1 个
  GitHub Action 创建统一升级 PR：tsc-alias 1.9.2→1.9.4、typescript-eslint 8.68.0→8.69.0、
  eslint 10.9.1→10.10.0、@larksuiteoapi/node-sdk 1.73.0→1.73.3、hono 4.13.5→4.13.7、
  @earendil-works/pi-ai 0.84.4→0.85.1、@earendil-works/pi-coding-agent 0.84.4→0.85.1、
  @types/node 26.4.0→26.4.1、actions/cache v4→v6。
  vitest 4.1.11→5.0.0（#871，主版本含多项 breaking changes）按规范拆分单独评估。
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
created_in_conversation: a3758263-dfac-4396-93ee-37d89efb5b0e
---

# F20260909deps: 统一升级依赖版本（2026-09-09）

## 背景与需求

定时任务「依赖升级自动化」2026-09-09 21:39 触发，GitHub 上存在 10 个 open Dependabot PR
（#869-#878）。按 PR #419 决策统一处理。

## 变更说明

### 关闭的 Dependabot PR

- #869: Bump actions/cache from 4 to 6
- #870: Bump tsc-alias from 1.9.2 to 1.9.4
- #872: Bump typescript-eslint from 8.68.0 to 8.69.0
- #873: Bump eslint from 10.9.1 to 10.10.0
- #874: Bump @larksuiteoapi/node-sdk from 1.73.0 to 1.73.3
- #875: Bump hono from 4.13.5 to 4.13.7
- #876: Bump @earendil-works/pi-ai from 0.84.4 to 0.85.1
- #877: Bump @types/node from 26.4.0 to 26.4.1
- #878: Bump @earendil-works/pi-coding-agent from 0.84.4 to 0.85.1

### 拆分的 PR（主版本升级，不进本批次）

- #871: Bump vitest from 4.1.11 to 5.0.0 —— 主版本升级，含多项 breaking changes
  （test.for/each `$` 变量去引号、移除 sequential 选项、expect.poll 超时行为变更、
  要求 Node 22 / Vite 6.4、locator 对象化等）。关闭并删除分支，待单独评估 PR。

### 升级的依赖（npm）

| 包 | 从 | 到 | 版本类型 |
|---|---|---|---|
| tsc-alias | 1.9.2 | 1.9.4 | 补丁 |
| typescript-eslint | 8.68.0 | 8.69.0 | 次要 |
| eslint | 10.9.1 | 10.10.0 | 次要 |
| @larksuiteoapi/node-sdk | 1.73.0 | 1.73.3 | 补丁 |
| hono | 4.13.5 | 4.13.7 | 补丁 |
| @earendil-works/pi-ai | 0.84.4 | 0.85.1 | 次要 |
| @earendil-works/pi-coding-agent | 0.84.4 | 0.85.1 | 次要 |
| @types/node | 26.4.0 | 26.4.1 | 补丁 |

### 升级的 GitHub Actions

- actions/cache: v4 → v6（.github/workflows/ci.yml L161，bge-m3 模型缓存步骤）

## 验证

- `npm install` 8 个 npm 包成功，package.json + package-lock.json 更新
- `npm run check`：0 error，5 warning（全部为 pre-existing：cost-output-collector.ts
  no-console ×2、web conversation/index.tsx react-hooks ×3；已用 `git stash -u` 基线
  对照验证，stash 后 warning 数 ≥5，与本次变更无关）
- `npx vitest run`：248 个测试文件、3124 个测试全部通过
- 最简检查：升级范围严格限于 Dependabot PR 覆盖的包，未做全量 npm update（PR #419 决策）

## 影响范围

- 运行时依赖：hono、@larksuiteoapi/node-sdk、@earendil-works/pi-ai、
  @earendil-works/pi-coding-agent（均为补丁/次要版本）
- 开发依赖：eslint、typescript-eslint、tsc-alias、@types/node
- CI：actions/cache v6（缓存行为兼容，key 不变）
