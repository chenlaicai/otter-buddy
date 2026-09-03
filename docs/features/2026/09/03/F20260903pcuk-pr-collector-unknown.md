---
id: F20260903pcuk
title: "pr-collector 区分「无数据」vs「获取失败」：viewFailed 标记 + unknownPrCount 可观测"
date: 2026-09-02
change_type: feature-update
status: development
modules:
  - src/usecases/health/pr-collector.ts
  - src/usecases/health/chain-builder.ts
  - tests/usecases/health/pr-collector.test.ts
  - tests/usecases/health/chain-builder.test.ts
  - tests/api/rhi-api.test.ts
  - tests/usecases/health/post-merge-fix-density.test.ts
tags:
  - health
  - pr-collector
  - observability
  - chain-model
from:
  - F20260902sigm
supersedes: []
intent:
  problem: "gh pr view 单 PR 失败时，lastActivityAt=null 与「真无活动」不可区分，静默排除出停滞检测——观测力悄悄下降无人知晓"
  verify_by:
    type: static_only
    reason: "纯 A类代码逻辑改动（类型扩展 + 过滤逻辑），无 LLM 参与——vitest 单测（runner 注入 mock 三场景：正常/真无活动/获取失败）+ tsc 覆盖"
summary: "pr-collector 区分「无数据」vs「获取失败」：viewFailed 标记 + unknownPrCount 可观测"
---

# pr-collector 区分「无数据」vs「获取失败」

## 背景

PR #720（F20260902sigm 链路信号模型）合入后，勘流审视发现 3：

- **现状**：gh pr list 成功但某条 PR 的 `gh pr view` 失败 → `lastActivityAt=null` → 该 PR 不判停滞
- **与全量失败不对称**：全量失败 → 空数组 → pr-stalled 信号整体缺席（可观测的降级）；单 PR 失败 → 该 PR 静默滑出停滞检测（**不可观测**的降级）

## 变更

### pr-collector.ts

1. `OpenPrInfo` 接口新增可空字段 `viewFailed?: boolean`
   - `view === null`（view 失败/超时）→ `viewFailed: true`
   - `view` 成功 → `viewFailed: undefined`（不占位）

2. `buildPrInfo` 函数根据 view 结果设置 `viewFailed`

### chain-builder.ts

1. `FeatureChain` 接口新增 `unknownPrCount: number`（链上 view 失败的 open PR 数）

2. `findPrStalled` 函数：
   - 先计数 `viewFailed` PR → 累加到 `chain.unknownPrCount`
   - 只对 `viewFailed !== true` 的 PR 判定停滞
   - **行为不变**：viewFailed PR 不参与停滞判定（未知数据不猜），但失败计数可观测

### 测试

- pr-collector.test.ts：新增 2 个用例
  - view 失败 → `viewFailed=true`
  - 正常 PR → `viewFailed=undefined`

- chain-builder.test.ts：新增 2 个用例
  - viewFailed PR → 不判停滞，`unknownPrCount=1`
  - 混合 PR（viewFailed + 正常）→ 只对正常 PR 判定，unknownPrCount 累计

## 验证

- [x] 后端全套测试绿（227 文件，2821 用例）
- [x] tsc 0 error
- [x] eslint 无新增 warning
- [x] 已过最简检查：单字段扩展 + 过滤逻辑，无新依赖，无新文件

## Discovered Issues

无
