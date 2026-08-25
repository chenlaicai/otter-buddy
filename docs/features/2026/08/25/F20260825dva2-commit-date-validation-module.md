---
id: F20260825dva2
title: commit-msg 钩子/CI 日期校验逻辑持久化测试 + 极端时区漂移根除
summary: |
  Issue #442（Refactor）：PR #435 实现的日期校验逻辑在钩子和 CI 中各维护一份 inline 代码，
  存在双处维护风险。本 PR 抽取 `scripts/validate-commit-date.mjs` 作为单一实现，
  钩子和 CI 均调用同一模块；新增 18 条 vitest 持久化测试覆盖 F/R/无 ID/非法日期/DST 边界；
  用 `Intl.DateTimeFormat.formatToParts()` 替代 `toLocaleString` 字符串解析，根除 ~0.3s/roundtrip 理论漂移。
change_type: feature_update
status: active
capability_test: "n/a: 纯 A 类逻辑（日期校验是确定性代码），无 LLM 参与行为"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
---

# commit-msg 钩子/CI 日期校验逻辑持久化测试 + 极端时区漂移根除

## 背景与需求

### 问题描述

PR #435（已合入）实现了三层日期校验方案，其中工具层的日期校验逻辑分别在两个位置维护：

1. `.githooks/commit-msg`——内联 node -e 脚本
2. `.github/workflows/ci.yml`——内联 shell 脚本（sed + date）

**风险**：
- 双处维护——修改逻辑需同步两处，漏改会导致本地/CI 行为不一致
- 钩子使用 `toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })` 字符串解析构造 Date，PR #435 检视时发现 roundtrip 有 ~0.3s 理论漂移（跨午夜进位场景）
- 无持久化测试——行为验证全靠手动 `git commit` 测试，回归风险高

### 方案选择

抽取单一模块 `scripts/validate-commit-date.mjs`：
- 导出 `validateCommitDate(firstLine, now?)` 函数供测试直接调用
- CLI 入口供钩子 `node scripts/validate-commit-date.mjs` 和 CI `echo | node` 调用
- `now` 参数注入点——测试不依赖系统时钟

## 方案设计

### 模块设计

`scripts/validate-commit-date.mjs`：
- `getDatePartsInZone(date, timeZone)`——用 `Intl.DateTimeFormat.formatToParts()` 获取指定时区的年/月/日，不走字符串解析
- `validateCommitDate(firstLine, now)`——返回 `{ valid, status, idDate?, systemDate?, diffDays? }`
- CLI 入口——`isDirectRun` guard 确保 import 时不触发 stdin 读取
- 退出码 0 = 通过（ok/skip），1 = 偏差 > 2 天

### TZ 根除

原实现：`new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }))`——字符串解析构造 Date 对象，roundtrip 有理论漂移。

新实现：`Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)`——直接提取年月日数值，零字符串解析，零漂移。

### 日期校验规则（不变）

- F 类 ID：解析前 8 位日期，与 Asia/Shanghai 系统日期偏差 > 2 天 → reject
- R 类 ID：跳过校验（研究文档日期是 frontmatter 锚点，跨天迭代时必然不同）
- 无 ID：跳过
- Merge/fixup commit：钩子层 case 短路（模块层也返回 skip）
- 非法日期（13 月、40 日、Feb 30）：fail-closed（bad_date 状态）
- ±2 天容忍推导：最大时区差 ~1 天 + 跨午夜边界 ±1 天 = 2 天

### 非法日期校验

原实现用 `new Date(y, m, d)` 构造后 `isNaN` 检查——但 JavaScript Date 会静默滚转非法日期（month 13 → 次年 1 月，day 40 → 进位）。新实现用 `new Date(year, month, 0).getDate()` 取当月天数上限，显式范围校验。

## 影响范围

| 文件 | 变更类型 | 说明 |
|---|---|---|
| `scripts/validate-commit-date.mjs` | 新增 | 日期校验单一实现（导出函数 + CLI） |
| `scripts/validate-commit-date.d.mts` | 新增 | TypeScript 类型声明 |
| `tests/scripts/validate-commit-date.test.ts` | 新增 | 18 条持久化测试 |
| `.githooks/commit-msg` | 修改 | 日期校验改调新模块（~30 行 → ~10 行） |
| `.github/workflows/ci.yml` | 修改 | 日期校验改调新模块（~25 行 → ~10 行） |

行为变化：
- 日期校验逻辑单一维护（改一处生效两处）
- 非法日期（13 月、40 日）现在正确触发 bad_date（原实现静默滚转）
- TZ 解析漂移根除（formatToParts 替代 toLocaleString 字符串解析）

## 验证

- [x] 新增 21 条测试全通过：F 类今天/±1/±2 通过、±3/±7 拒绝、R 类跳过、无 ID 跳过、Merge 跳过、非法日期（月 13/日 40/Feb 30）拒绝、DST 边界正确、CLI 真跑验证（exit 0/1/bad_date 三态）
- [x] 全量测试 134 文件 1608 用例通过（含新增 21 条）
- [x] `npm run check`（tsc + eslint）通过
- [x] lint（skills/tool-manifest/tests/capability-docs）通过
- [x] CLI 手动验证：F 类通过（exit 0）、F 类 7 天前拒绝（exit 1）、R 类跳过（exit 0）、非法日期拒绝（exit 1）

## Discovered Issues

无。

## 决策史

- 2026-08-25：初始实现（开发獭-442，mimo）。issue #442 由检视獭-435 在 PR #435 delta 复核时创建；模块化+测试+TZ 根除范围由大獭任务简报确定；非法日期显式范围校验由 vitest 实测发现（Date 滚转行为）
- 2026-08-25：检视獭-453 delta 复核发现 bad_date CLI 出口静默放行 + isDirectRun guard 脆弱 + CLI 测试未真跑 CLI。全部修复：CLI 改 `if (!result.valid)` 统一拦截、guard 改 pathToFileURL 精确匹配、CLI 测试改 execFileSync 真跑
