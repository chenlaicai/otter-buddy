---
id: F20261112grpla
title: 固化 2026-11-11 守卫实录 12 条（ALLOW 3 / BLOCK 9）
doc_type: feature

summary: |
  每日健康检查回放 2026-11-11（UTC）guard_intercept：13 次拦截去重 12 条，逐条按完整
  toolcall 裁决固化。3 条误拦 ALLOW（heredoc 证据文本 / curl|head / 远端 sshd 只读核查）
  钉成回归约束防止守卫回退再误拦；9 条真实负门 BLOCK 钉住现行安全边界。守卫实现零改动。

causal_links:
  from:
    - F20261010grig

change_type: feature-update
tags: [guard, replay, regression-pin, daily-health-check]
modules:
  - tests/guard/replay/cases-2026-10-29.ts
capability_test: "n/a: 回放样本为静态断言，无 LLM 行为"
created_at: 2026-11-12

intent:
  problem: "守卫误拦修复后无回归约束，守卫实现回退会让已确认的误拦形态复发；真实负门也需实录锚定"
  expected_effect: "12 条实录进回放套件：3 条 ALLOW 防误拦回退，9 条 BLOCK 防负门放松，replay.test.ts 全量绿"
  verify_by:
    type: behavior_check
---

# F20261112grpla: 固化 2026-11-11 守卫实录 12 条

## 范围与数据源

候选原文 `data/guard-replay-candidates-2026-11-11.json`（totalIntercepts=13，去重 uniqueSamples=12）。
12 条 fixture 的 command 与候选 fullCommand 逐字一致（独立检视已逐条核对，事件 ID 一一对应）。

## ALLOW 3 条（误拦放行，钉成回归约束）

| 实录 | 形态 | 裁决依据 |
|---|---|---|
| b5ab77f7 | heredoc 内 pkill 字样 | `cat <<EOF` 生成 issue 证据文本，非命令位置；真实负门（#1836 的 pkill -f 主进程）不受影响 |
| 1cb9eea4 | API curl \| head | 管道下游是 head 非解释器；python3 是独立本地配置读取，不构成下载管道 |
| 93d6c336 | 远端 sshd 只读核查 | grep/ls /etc/ssh/sshd_config 非凭证目录读取；私钥未读入，历史 cred_dir_access 属误拦 |

## BLOCK 9 条（真实负门）

- 6 条 download_exec：外部网页/manifest 的 `curl | python3`（fetcher 上游 + interpreter 下游结构）
- 1 条 self_kill_process_group：`kill -TERM -负PID` 进程组终止
- 2 条 cred_dir_access：直接读取/列举 `/Users/orca/.ssh`

## 验证

- `npx vitest run tests/guard/replay/replay.test.ts`：107/107 passed
- 独立检视（reviewer-tests 首轮 + delta）：12 条裁决与 `bash-safety-guard.ts` 现行语义一致，ALLOW 不构成运行时放行放松
- CI 四绿（check / e2e / golden-selftest / guard-macos）

## 与 #1836 的关系

同文件不同日期批次：#1836 固化 11-10 九条（全部 BLOCK），本 PR 固化 11-11 十二条；新增 source ID 交集为空、无相反裁决（检视确认）。两分支在 mustBlockCases 追加点有文本冲突，先合者为准、后者 rebase 保留双方共 21 条。

## 回滚

revert 本 PR merge commit 即移除 12 条样本；守卫实现、配置、数据零改动。
