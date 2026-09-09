---
id: F20260909cwup
title: 成本/产出修复补充：多轮扫描回归测试 + 趋势聚合注释澄清
summary: PR #860（F20260909csdt）对抗审视两条建议发现的落地——按搭档裁决不留 issue 直接补充修复：① rhi-scan-worker 测试新增「多轮扫描后历史日期行存活且数值不重复累计」回归用例；② rhi-controller buildCostTrendSeries 补注释澄清 per-otter 行与全局行混合求和的安全性（键集合不相交）。附：测试夹具提取 setupCostOutputFixture 消除重复搭建代码。
change_type: fix
capability_test: tests/usecases/health/rhi-scan-worker.test.ts
tags: [rhi, cost-output, health-dashboard, test, docs]
modules:
  - tests/usecases/health/rhi-scan-worker.test.ts
  - src/interface-adapters/http/controllers/rhi-controller.ts
from: [F20260909csdt]
created_in_conversation: 7cde6e5e-a8ef-4bec-8161-bceccf3d16df
created_at: 2026-09-09T11:10:00+08:00
---

# F20260909cwup 成本/产出修复补充：多轮扫描回归测试 + 趋势聚合注释澄清

## 背景

PR #860（F20260909csdt）对抗审视产生 2 条建议发现，初处置为「建 issue 留后续」（#862/#863）。搭档裁决：两条都与本修复强关联，**建 issue 是偷懒**，应直接补充 PR 修复。本 PR 即该裁决的执行。规范层反思另立 issue #865（检视发现「建 issue」处置边界过松）。

## 改动

| 文件 | 改动 |
|------|------|
| `tests/usecases/health/rhi-scan-worker.test.ts` | 新增用例「多轮扫描后历史日期 cost_output 行存活且数值不重复累计」——scanOnce 连跑两次，断言历史日期行存活且两轮结果完全一致（幂等）；提取 `setupCostOutputFixture` 共享夹具（session JSONL + otter/session/message 行 + sink + 按日查询），#583 原有用例同步改用，消除重复搭建代码，顺带解决 describe 主体超 max-lines-per-function（220 行）lint 上限 |
| `rhi-controller.ts` | `buildCostTrendSeries` 头部注释补充混合求和安全性说明：per-otter 指标键与全局指标键（pr/fdoc/dispatch）集合不相交，按 metric_key 求和无重复计数风险 |

## 验证

- `rhi-scan-worker.test.ts`：11 用例通过（含新增回归用例）
- health 目录 + rhi-api：284 用例通过
- 全量测试：248 文件 3116 用例通过（比 main 多 1）
- eslint / tsc --noEmit：0 error
- 已过最简检查：测试复用共享夹具（代码净减少）；注释改动零行为变更

## 本次变更对旧特性做了什么

- 对 F20260909csdt（PR #860）：补上其修复核心语义的回归保险（多轮幂等），防止「历史日期被覆盖」类回退再次存活一个发布周期才被发现
- 对 F20260829cstd（#583）：趋势聚合函数的隐含设计前提（键集合不相交）显式化

## 关联

- 规范反思 issue：#865（搭档对本类处置的批评 → 检视处置规范修订）
