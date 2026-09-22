---
id: F20260922ctbf
title: CI 存量测试失败修复（validate-commit-date 日期炸弹 + weixin-cold-start 环境污染）
doc_type: feature

summary: |
  修复 issue #1098：干净 main 上 2 个存量测试失败阻断所有 PR CI。
  ①validate-commit-date.test.ts CLI 用例硬编码 F20260914 日期基准（跑真实脚本用真实时钟），
  2026-09-22 起超窗失败——改为动态生成日期（今天/10 天前/20 天前），消灭日期炸弹。
  ②weixin-cold-start 用例在开发机有真实微信账号（./data/weixin/accounts.json）时误命中
  孤儿账号降级分支——chdir 到临时空目录隔离环境。

causal_links:
  from:
    - F20260914prdb
    - F20260831wxsp

change_type: fix
tags: [bugfix, ci, test]
modules:
  - tests/scripts/validate-commit-date.test.ts
  - tests/bootstrap/weixin-cold-start.test.ts
capability_test: "n/a: 测试基础设施修复（A 类），无 LLM 参与行为"
created_in_conversation: 9c674ed5-5ba4-4d24-8f01-99da6b57a7a2
---

# F20260922ctbf: CI 存量测试失败修复（#1098）

## 问题现象

干净 main（7ad476c1）全量测试 2 个失败，阻断所有 PR CI（PR #1095 对抗审视 B1 检查发现）：

1. `tests/scripts/validate-commit-date.test.ts` —— 用例「dual-base: 定稿改名合入日后」硬编码 `F20260914wxeg`，隐含「今天 ≤ 2026-09-21」。2026-09-22 起超窗（diffDays=8 > 7）失败。**日期炸弹，每天都会继续红**。
2. `tests/bootstrap/weixin-cold-start.test.ts` —— 「无 weixin 段且无已登录账号」断言 `logger.warn` 不被调用，但开发机有真实账号（`./data/weixin/accounts.json` 含 weixin-muawxk7x），命中孤儿账号降级分支 warn 一次。

## 根因分析

### 失败 1：日期炸弹

- 纯函数用例注入固定 `NOW`，无问题
- CLI 用例（`runCLI`）spawn 真实 `validate-commit-date.mjs`，脚本内部用 `new Date()` 真实时钟——硬编码 ID 日期与真实今天的偏差随时间增长，超过 ±7 天窗口即失败
- 触发点：`tests/scripts/validate-commit-date.test.ts:202`（修复前）`[F20260914wxeg]` + `--at 2026-09-04`；当前时间基准（2026-09-22）与 ID 差 8 天 → 拦

### 失败 2：测试环境污染

- `startWeixinChannels` 无 weixin 段时走 `WeixinAccountStore(undefined)`（`src/bootstrap/platforms.ts:441`），默认 stateDir `./data/weixin`
- 开发机该路径有真实登录账号 → `orphanAccounts.length > 0` → warn + 降级启动
- CI 干净环境无此文件 → 通过。本地红、CI 绿，环境依赖型失败

## 修复方案（修法排序①：既有机制语义内修）

| 失败 | 修复 |
|---|---|
| 日期炸弹 | CLI 用例的硬编码日期改动态生成：`fmtId(new Date())`（今天）/ `fmtId(Date.now() - 10d)` / `fmtId(Date.now() - 20d)`，场景语义不变（创建基准 vs 当前基准的双基准判定） |
| 环境污染 | 用例内 `process.chdir` 到临时空目录，`./data/weixin` 相对路径自然落空（`listAccounts` 读不到文件返回 `[]`），`finally` 恢复 cwd |

**机制识别检查点**：全部未命中——纯测试代码改动，无新增机制。

## Verification

- 修复前：干净 main 复跑 2 个失败（issue #1098 附失败输出）
- 修复后：worktree 全量 267 文件 3659 测试全绿（`npx vitest run`）；两个目标文件单独跑 37 测试全绿
- 日期炸弹不复发证明：动态日期与真实时钟恒在窗口内（今天 ±0 天 / 10 天前 vs 10 天前基准 ±0 天）

## 已知边界

- `--at` 参数语义用例（ID 与注入基准同日）保留硬编码 `2026-09-04`——不依赖真实时钟，非炸弹
- weixin 修复用 chdir 隔离而非 mock WeixinAccountStore——最小侵入，与既有测试风格一致

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 大獭
