---
id: F20260820xefif
title: dependency-upgrades
doc_type: feature

summary: |
  统一升级依赖版本，关闭 Dependabot 自动创建的 PR，按照研发流程创建统一的依赖升级 PR。

causal_links:
  from:
    - F20260813x9xh

status: development
change_type: feature_update
tags: [deps, dependencies, upgrade, dependabot]
modules:
  - package-lock.json
capability_test: "n/a: 纯依赖升级，无 LLM 参与行为"
---

# F20260820xefif: 统一升级依赖版本

## 背景与需求

### 问题描述

Dependabot 每周自动创建依赖升级 PR，需要统一处理。

## 变更说明

### 关闭的 Dependabot PR

- #323: Bump @earendil-works/pi-coding-agent from 0.83.0 to 0.84.2
- #322: Bump @node-rs/jieba from 2.0.1 to 2.0.2
- #321: Bump @hono/node-server from 2.1.0 to 2.1.1
- #320: Bump hono from 4.13.1 to 4.13.2
- #319: Bump js-yaml from 5.2.3 to 5.3.0
- #318: Bump @earendil-works/pi-ai from 0.83.0 to 0.84.2

### 升级的依赖

- @node-rs/jieba: 2.0.1 → 2.0.2（补丁版本）
- @hono/node-server: 2.1.0 → 2.1.1（补丁版本）
- hono: 4.13.1 → 4.13.2（补丁版本）
- js-yaml: 5.2.3 → 5.3.0（次要版本）
- @earendil-works/pi-ai: 0.83.0 → 0.84.2（次要版本）
- @earendil-works/pi-coding-agent: 0.83.0 → 0.84.2（次要版本）

## 检查清单

- [ ] 代码检查通过（lint）
- [ ] 构建成功
- [ ] 测试通过
