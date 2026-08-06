---
id: F20260805daaa
title: dependabot-依赖升级整合
doc_type: feature

summary: |
  将 8 个 Dependabot 自动生成的依赖升级 PR 整合为单一 PR。
  减少 review 噪音，一次性验证所有依赖兼容性。

change_type: feature-update
status: implemented
tags: [dependencies, maintenance]
modules:
  - package.json
  - package-lock.json
---

# F20260805daaa: Dependabot 依赖升级整合

## 背景

Dependabot 为每个依赖升级单独创建 PR（#105、#108、#109、#110、#142、#143、#144、#145），产生 8 个待处理 PR。逐个合并会导致重复 CI 跑批、频繁 lockfile 冲突，review 成本高。

## 方案

将 8 个升级合并到单一 PR #154，统一更新 `package.json` 和 `package-lock.json`：

| 包名 | 旧版本 | 新版本 |
|------|--------|--------|
| @earendil-works/pi-ai | 0.81.1 | 0.83.0 |
| @earendil-works/pi-coding-agent | 0.81.1 | 0.83.0 |
| hono | 4.12.31 | 4.12.33 |
| @hono/node-server | 2.0.11 | 2.0.12 |
| better-sqlite3 | 13.0.1 | 13.0.2 |
| js-yaml | 5.2.1 | 5.2.3 |
| eslint | 10.7.0 | 10.8.0 |
| @types/node | 26.1.1 | 26.1.2 |

均为 patch/minor 版本升级，API 兼容。

## 验证

- `npm install` 成功，lockfile 干净
- `npm run build`（lint + tsc + tsc-alias）通过
- `npm run lint` 无新增 warning
