---
id: F20260918da41
title: 日期炸弹修复与 lint-date-bombs 扫描器退役
date: 2026-09-18
change_type: fix
capability_test: "n/a: 测试写法修正 + 工具链删除 + 规范文档补充（verify_by=static_only：测试全绿无警告 + lint 全绿 + 规范条目为写作纪律类，无工具轨迹可自动断言）"
created_in_conversation: a56c349e-c566-438c-97d0-653a260171ed
summary: 修 #931 catch-up 测试硬编码日期漂移（narrow-fix），退役 lint-date-bombs 扫描器（deletion），补测试时间注入规范（docs-config）
tags: [test, date-validation, cleanup, docs-config]
modules: [tests/usecases/scheduler/scheduler-service.test.ts, scripts/lint-date-bombs.mjs, scripts/lint-date-bombs.d.mts, tests/scripts/lint-date-bombs.test.ts, package.json, .githooks/pre-commit, .github/workflows/ci.yml, .pi/skills/code-implementation/references/testing-rules.md, tests/scripts/lint-prompt-size.test.ts]
closes: 931
intent:
  problem: "#931 catch-up 测试硬编码绝对日期（2026-09-13/14/15）随真实时钟漂移产生 TimeoutNegativeWarning（实测 -348630094），随时假失败污染 CI 信心；lint-date-bombs 扫描器实证失效（949 条 warning 噪音藏住 12 条真炸弹，默认不展开等于没有）"
  expected_effect: "catch-up 测试改为相对时间构造永不过期；扫描器整体退役消除维护成本倒挂；测试规范补时间注入条款成为唯一防线"
  verify_by:
    type: static_only
---

# 日期炸弹修复与 lint-date-bombs 扫描器退役

## 背景

### #931 现象

`tests/usecases/scheduler/scheduler-service.test.ts` 中 catch-up 相关用例硬编码了绝对日期（2026-09-13/14/15 等），真实时钟越过后 scheduler `setTimeout(next - Date.now())` 产生 `TimeoutNegativeWarning`（实测复现：-348630094，负约 4 天）。测试当前仍绿，但每天漂移一天，随时假失败。

### 搭档决策（2026-09-18 本对话）

> 「这个机制也是我一直很抗拒但是你们 ai 经常会做的：不断叠加一套套兜底机制，只关心出错之后、而不去思考如何做对」

搭档拍板：lint-date-bombs 扫描器整体退役，把「测试涉时间一律注入时钟」写进测试规范作为唯一防线。

### 扫描器失效实证

扫描器主防线（error 级）只拦 `validateCommitDate` 特定模式（scripts/lint-date-bombs.mjs:197-216），通用 ISO 日期字面量降级 warning（:217-229）不阻断提交。warning 默认不展开（源码注释自明「避免 873 条刷屏训练开发者无视扫描器」:306），当前存量 **949 条 warning**，#914 新增的 12 条完美隐身。保留它拦的模式近一年零命中，维护成本倒挂。

## 预注册

本次属排查后修复——根因已在 #931 排查中定位（mock cronParser 返回固定「现在」，scheduler `setTimeout(next - Date.now())` 随真实时钟漂移产生负 delay），无预期分歧，直接实施。

## 修法排序与机制判定

| 任务 | 修法 | 声明 |
|------|------|------|
| A：#931 catch-up 测试 | ① narrow-fix（既有机制语义内修——改测试写法，不动 scheduler 逻辑） | `narrow-fix` |
| B：lint-date-bombs 扫描器 | ③ deletion（删除机制） | `deletion` |
| C：测试规范补时间注入条款 | docs-config（纯文档微调） | `docs-config` |

### 为何 B 走 ③ deletion 而非 ①②

- **① narrow-fix 不行**：扫描器主防线只拦 `validateCommitDate` 特定模式，#931 类 ISO 字面量降级 warning 后被 949 条噪音淹没——修扫描器规则 = 收窄边界，但收窄后（去掉 warning）主防线与 #931 类问题无关仍拦不住
- **② scope-reduction 不行**：去掉 warning 后主防线只剩 `validateCommitDate` 模式，近一年零命中，保留它拦的模式与 #931 类问题无关
- **③ deletion 成立**：接受原始问题回归的代价由任务 C 的写法规范承接——正确性靠写法保证，不靠事后扫描

## 方案设计

### A：#931 修复（narrow-fix）

把 `scheduler-service.test.ts` 中 catch-up 相关 describe 块（#913/#814/#929）内所有「会过期的固定日期」改为相对时间构造：

```typescript
// 修复前（硬编码绝对日期，随真实时钟漂移）
const cronParser = createMockCronParser(new Date('2026-09-14T01:00:00.000Z'));

// 修复后（相对时间构造，永不过期）
const cronParser = createMockCronParser(new Date(Date.now()));
```

**判断标准**：该日期是否参与与 `Date.now()` 的差值计算——参与则改，不参与（如 2025-01-01、2025-06-15 纯数据）不动。

**边界锁定语义保留**：5s 容差边界用例 4999/5000/5001ms 的边界锁定语义必须保留——`prevDue` 改为 `Date.now() - 3600_000`，`lastTriggeredAt` 改为 `prevDue.getTime() - offsetMs`，边界数学不变。

### B：扫描器退役（deletion）

删除清单：
1. `scripts/lint-date-bombs.mjs` 和 `scripts/lint-date-bombs.d.mts`（删文件）
2. `tests/scripts/lint-date-bombs.test.ts`（删文件）
3. `package.json` 的 `lint:date-bombs` script（删行）
4. `.githooks/pre-commit` 的 `npm run lint:date-bombs`（删行）
5. `.github/workflows/ci.yml` step 名中的 date-bombs 提及与 `npm run lint:date-bombs`（清理）
6. 全局 grep `lint-date-bombs` 确认无残留引用（dist/ 下编译产物不管；`docs/features/2026/09/15/F20260915dabm-date-bomb-scanner.md` 是历史文档，不改不删——铁律：不改历史文档）
7. `tests/scripts/lint-prompt-size.test.ts:9` 注释更新为不带死引用

### C：测试规范补时间注入条款（docs-config）

在 `.pi/skills/code-implementation/references/testing-rules.md` 的「A 类硬规则」补一条：

> 测试涉时间一律注入时钟：用 fake timer（`vi.useFakeTimers`）或显式 `now` 参数构造相对时间，禁止硬编码会过期的绝对日期字面量参与与真实时钟的差值计算。写的时候绿的测试可能在任意未来日期炸成假失败——正确性靠写法保证，不靠事后扫描。（lint-date-bombs 扫描器已退役，本规范是唯一防线）

## 验证

- `npx vitest run tests/usecases/scheduler/scheduler-service.test.ts` 全绿且输出中不再有 `TimeoutNegativeWarning`
- 全局 grep `lint-date-bombs` 无残留引用（dist/ 和历史文档除外）
- `npm run lint:skills` 全绿（skill 修改后）
- CI 全绿

## 豁免声明

本 PR 含 skill 修改（软代码），frontmatter intent 块 verify_by.type=static_only——规范条目是写作纪律类，无工具轨迹可自动断言，豁免 golden gate 跑测。豁免声明已写入本段（F20260917lssc B7 口径）。
