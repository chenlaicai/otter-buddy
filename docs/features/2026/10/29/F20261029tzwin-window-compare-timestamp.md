---
id: F20261029tzwin
title: "persistSnapshot 窗口归属改时间戳比较：跨时区 author date 字典序错位修复（#1704）"
summary: "rhi-scan-worker.ts:345 的窗口过滤用字符串比较混比两种时区格式（%aI 带偏移 vs toISOString UTC Z），边界日随当日 UTC 10:00 前后翻转（CI run 40862931480 实爆，run 40826709374 同日 14:05 绿的谜底）。改 Date.parse 时间戳比较（commitInWindow 纯函数导出），新增跨时区边界回归测试（含修复前字典序误判的复现断言）。"
change_type: fix
capability_test: "n/a: 修复统计窗口归属语义（既有行为的 bug 修正），以本节 Verification 证据链为验证载体"
intent:
  problem: "persistSnapshot 的 60 天窗口过滤 `signalInputs.filter(c => c.date >= windowStart)` 是字符串字典序比较，混比 %aI（author date，带原时区偏移如 +08:00）与 toISOString()（UTC 'Z' 全串）两种格式——当 commit 的 author date 与窗口起点同日时，归属随 windowStart 的当日时刻位翻转（实测翻转点 UTC 10:00 = 'T10:00:00+08:00' 字面量边界）。2026-10-29 实爆：fixture 写死日期 2026-08-30 在其 +60 天卡进窗口边界，14:05 CST 绿 / 19:12 CST 红（同 commit），commits 派生维度（D1/D4）断数据。"
  solution: "比较改时间戳语义：导出纯函数 commitInWindow(date, windowStart)（Date.parse 双侧），persistSnapshot 过滤改用之。修法决策树①既有语义内修（narrow-fix）：窗口归属的正确语义就是时间戳序，抽取导出仅为可测性。"
  expected_effect: "跨时区 author date 的窗口归属只取决于时间戳序，与当日时刻/字符串字典序无关；D1/D4 等 commits 派生维度不再因边界日时刻翻转断数据。"
  verify_by:
    type: behavior_check
    assertions:
      - "窗口边界日跨时区 author date（+08:00）归属按时间戳语义：windowStart UTC 03:00 晚于 commit（UTC 02:00）时判 false（修复前字典序误判 true——回归锁定断言）"
      - "跨日边界：+08:00 凌晨 author date 归属前一 UTC 日，不落入次日窗口（修复前字典序误判 true）"
      - "回归有效性证明：临时恢复字符串比较跑同测试 → 2 断言红（expected true to be false，与误判预测逐字一致）"
      - "同族 tests/usecases/health/ 326 用例零回归（3 个 git-init 依赖文件为沙箱环境项，与本修复无关）"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [health, timezone, window-filter, regression-test]
modules:
  - health
---

# persistSnapshot 窗口归属改时间戳比较（#1704）

## 背景

CI 破案记录（PR #1701 合入前）：同 commit 在 2026-10-29 14:05 CST 绿（run 40826709374，main）、
19:12/19:18 CST 稳定红（run 40862931480 ×2 + rerun）。定位为 `rhi-scan-worker.ts:345`
`signalInputs.filter(c => c.date >= windowStart)` 的字符串比较跨时区错位：

- `c.date` = `%aI`（author date，带原时区偏移，如 `2026-08-30T10:00:00+08:00`）
- `windowStart` = `isoDaysAgo()` = `toISOString()`（UTC 'Z' 全串，含时刻）

字典序在边界日随 windowStart 的当日时刻位翻转（翻转点='T10:00:00+08:00' 字面量 vs
windowStart 的 'T1x:xx'）。触发链与完整根因分析见 issue #1704（含 file:line 与两条 CI 现场）。

## 修法

```ts
/** commit author date 是否落在统计窗口内（#1704）——必须时间戳比较。 */
export function commitInWindow(date: string, windowStart: string): boolean {
  return Date.parse(date) >= Date.parse(windowStart);
}
```

`persistSnapshot` 过滤改用 `commitInWindow`。纯函数导出是为了让窗口归属语义可单测
（原 filter 行为埋在 private 方法里无法直接锁定）。

## Verification（证据链）

1. **新增回归测试**（`tests/usecases/health/window-compare.test.ts`，3 断言）：
   边界日 +08:00 author date（=UTC 02:00）在 windowStart UTC 01:00（true）/03:00（false）
   两侧按时间戳语义归属；跨日边界 +08:00 凌晨 author date 不落入次日窗口；窗口深处稳定包含。
   → `Test Files 1 passed | Tests 3 passed`
2. **回归有效性证明（修复前失败输出）**：临时把 `commitInWindow` 恢复为字符串比较
   （`return date >= windowStart`）→ 同测试 **2 断言红**：`AssertionError: expected true to be
   false`（字典序误判 true，正确应 false）——与误判预测逐字一致，证明测试锁定的是真实缺陷。
3. **同族零回归**：`tests/usecases/health/` 全目录 `326 passed | 24 skipped`，3 个 failed 文件
   均为 `git init` 沙箱环境项（/var/folders 拒写，本机已知限制，与本修复无关；CI 上正常执行）。

## 影响范围

`src/usecases/health/rhi-scan-worker.ts` 2 处（filter 行 + 文件末导出函数），生产行为修正为
时间戳语义；tests/usecases/health/window-compare.test.ts 新增。既有 snapshot/health_index
消费方（model-efficiency-report.ts 的 snapshot_date 日期串比较为同格式比较，语义正确，未动）。
