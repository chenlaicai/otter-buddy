---
id: F20260915dabm
title: 测试日期炸弹静态扫描防线
date: 2026-09-15
change_type: feature
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
summary: 新增 commit-time 静态扫描脚本 lint-date-bombs.mjs，检测测试中日期校验函数调用使用硬编码特性 ID 且未注入 now 参数的日期炸弹模式（#544 防线）
tags: [test, ci, date-validation, static-analysis]
modules: [scripts/lint-date-bombs.mjs, tests/scripts/lint-date-bombs.test.ts, .githooks/pre-commit, package.json]
closes: 544
intent:
  problem: "时间敏感测试硬编码特性 ID 日期（如 F20260825abcd）编写时绿，日期滚动后必然 CI 红——#422→#541 两次炸弹无防线兜底"
  expected_effect: "新增 validateCommitDate 调用中硬编码 FID 且无 now 注入的检测，commit-time fail 阻断新日期炸弹入仓；全仓扫描 0 error（存量炸弹已由 #541 修复）"
  verify_by:
    type: behavior_check
---

# 测试日期炸弹静态扫描防线

## 背景

#422 修了「生成侧」（commit 钩子校验特性 ID 日期语义），#541 排掉了
`validate-commit-date.test.ts` 里硬编码日期的集成用例（#442 修 #422 时自己埋的雷）。
但全仓仍无防线覆盖「既有存量」——时间敏感测试写的时候绿（日期还在容忍窗内），
衰减后炸。同型问题反复发生时，逐案修不如下沉一道静态防线（同型参考：
PR #536/#540「initSchema 新表漏登三次发生才机制性根治」）。

## 方案设计

### 扫描策略

扫描 `tests/` 下的测试文件，检测「日期校验函数调用中硬编码特性 ID 且未注入 now 参数」的危险模式。

**不扫描**所有特性 ID（F20YYMMDDxxxx）——大部分只是测试数据字符串
（otter 名、describe 标签），不会随时间衰减。

**扫描目标**：`validateCommitDate` 调用中出现硬编码 FID 且：
- 无第二参数（依赖默认 `new Date()`）
- 第二参数是 `new Date()`（依赖系统时钟）

**安全模式**（不触发）：
- `validateCommitDate(fid, NOW)` — 有固定常量注入
- `validateCommitDate(fid, baseTime)` — 有变量注入

### 豁免机制

`// date-literal: explicit-now` 注释可豁免单行（当前行或上一行）。
用于显式传 now 参数的断言场景，扫描器不检出。

### 辅助扫描

ISO 日期（`202x-xx-xx`）在测试文件中的使用以 warning 级报告，
不阻断提交，仅作信息参考。

### 范围

| 范围 | severity | 说明 |
|------|----------|------|
| tests/ | error | 主防线，硬编码 FID 在日期校验函数中且无 now 注入 |
| tests/ (ISO 日期) | warning | 辅助信息，不阻断 |
| scripts/、src/ | 不扫描 | 非测试文件中的日期字面量多为文档引用 |

## 改动范围

| 文件 | 改动 |
|------|------|
| `scripts/lint-date-bombs.mjs` | 新增：扫描脚本，CLI + 可测试导出 |
| `tests/scripts/lint-date-bombs.test.ts` | 新增：22 个测试用例（temp 文件 fixture，全动态日期） |
| `package.json` | 新增 `lint:date-bombs` 脚本 |
| `.githooks/pre-commit` | 末尾追加 `npm run lint:date-bombs` |

## 自检

- 测试：`tests/scripts/` 全部 88/88 通过（含已有 6 个脚本测试文件）
- 全仓扫描：0 error（存量 `validateCommitDate` 调用均已注入 now 参数）
- 最简检查：已过——扫描器复用现有 lint 脚本模式（walkSync + CLI + 导出测试），无额外依赖

## 与现有防线的关系

```
层                    职责                      失效场景
─────────────────────────────────────────────────────────────────
identity 注入日期     每 turn 注入日期锚点       LLM 理论上可忽略
commit 钩子校验       validate-commit-date.mjs  只拦 commit message
CI PR 标题校验        同上，CI 环境              只拦 PR 标题
本脚本 lint-date-bombs  拦测试代码硬编码日期     只拦 tests/（主防线）
```

四层互补：「预防-拦截-拦截-拦截」全链路覆盖。
