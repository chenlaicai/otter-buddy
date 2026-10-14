---
id: F20261013grrf
title: 守卫回放固化首轮产出——2026-10-13 UTC 样本裁决映射与成规模误拦发现
summary: F20261008gdcc 项 4 固化自动化首轮执行产出：108 拦截 → 92 候选 → 45 固化（ALLOW 22 / BLOCK 23）/ SKIP 47。6 类成规模误拦（main_write 20 条 ALLOW）归口 #1468：python heredoc/-c 引用 worktree fixture、git -C worktree 写族、cat/printf >> worktree、node -e 纯只读 require、data_destructive rm workspaces。45 条非 SKIP → 13 用例全量映射表落盘（可复核），6 条红 ALLOW 用例 it.skip 挂 #1468（分支保护 required check 不可合入红测试），SKIP 47 条未固化（14 条探针已放行属自愈，33 条 commandHead 截断不可裁决）。
from: F20261008gdcc
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
created_date: 2026-10-14
---

# 守卫回放固化首轮产出（2026-10-13 UTC）

## 背景

`scripts/generate-guard-replay.mjs`（F20261008gdcc 项 4）首轮每日执行：处理 2026-10-13（UTC 日界）guard_intercept 回放样本。产出 PR #1467（worktree `guard-replay-freeze-1013`，commit d6066f26）。

- **数据源**：`data/guard-replay-candidates-2026-10-13.json`（108 拦截 → 92 候选，commandHead 截断 120 字符 + 脱敏）
- **裁决执行**：固化獭（kimi-k28），探针验证于 worktree 内 tsx 直跑 `checkBashCommandSafety`
- **检视**：检视獭（mimo-flash，异体）3 严重 + 5 建议 → 固化獭修复 → 本文件为修复后状态

## 统计

| 维度 | 数值 |
|---|---|
| 拦截 | 108 |
| 候选（去重后） | 92 |
| 固化（非 SKIP） | 45 = ALLOW 22 + BLOCK 23 |
| SKIP | 47（14 探针已放行自愈 / 33 commandHead 截断不可裁决） |
| 新增用例 | 13（6 ALLOW skip 挂 #1468 + 7 BLOCK 负门） |

## 成规模误拦发现（已归口 #1468）

| 形态 | 条数 | V1 根因 |
|---|---|---|
| python heredoc/-c 引用 worktree fixture | ~14 | `MAIN_WRITE_PATTERNS[1]` 按形态整体拦，不查 heredoc 体路径 |
| git -C worktree add/commit | ~3 | `bash-safety-guard.ts:988` GIT_WRITE_SUBCOMMAND 跳过 -C 但不查目标路径 |
| cat/printf >> worktree | ~1 | `isAbsNonMain` 只豁免 `data/workspaces/`，不豁免 `.otter/worktrees/` |
| node -e 纯只读 require | ~1 | one-liner 白名单只放 fs/util/path @ `bash-safety-guard.ts:1480`（#1432 同类） |
| data_destructive rm workspaces | ~1 | `resolvesToMainData` 不排除 workspaces sandbox |

## 45 条非 SKIP → 13 用例映射表

| 用例 | 裁决 | 样本 id（前8位） | 理由 |
|---|---|---|---|
| 1013-A1 | ALLOW | a6ed340b | python heredoc 读 worktree fixture |
| 1013-A1 | ALLOW | c6ffc656 | python heredoc 读 workspaces 内 JSON |
| 1013-A1 | ALLOW | 0676ef9d | python heredoc 读 worktree fixture |
| 1013-A1 | ALLOW | 267df373 | python heredoc 读 worktree fixture |
| 1013-A1 | ALLOW | 381daca8 | python heredoc 读 worktree fixture |
| 1013-A1 | ALLOW | 92336bdd | python heredoc 读 worktree fixture |
| 1013-A1 | ALLOW | 38969f81 | python heredoc 读 worktree fixture |
| 1013-A1 | ALLOW | b19dbdc2 | python heredoc 读 worktree fixture |
| 1013-A1 | ALLOW | 01ea3c4c | python heredoc 读 worktree fixture |
| 1013-A2 | ALLOW | cd4ea86f | python3 -c 读 worktree fixture |
| 1013-A2 | ALLOW | 1ce469c3 | python3 -c 读 worktree fixture |
| 1013-A2 | ALLOW | 1565d108 | python3 -c 读 worktree fixture |
| 1013-A3 | ALLOW | 572b7726 | cat >> worktree test.ts |
| 1013-A4 | ALLOW | 7bccfbf5 | node -e 纯只读 require(package.json) |
| 1013-A5 | ALLOW | 0efc13ea | git -C worktree add && commit |
| 1013-A5 | ALLOW | 3457f89c | git -C worktree add && commit |
| 1013-A5 | ALLOW | 9a07382a | git -C worktree commit |
| 1013-A6 | ALLOW | 9d50f659 | rm -f workspaces 内文件 |
| 1013-B1 | BLOCK | b35d31de | git stash push（cwd 主仓，无 -C） |
| 1013-B1 | BLOCK | 5fa4f615 | git stash push（cwd 主仓，无 -C） |
| 1013-B2 | BLOCK | 8ae8edb8 | git push --delete |
| 1013-B3 | BLOCK | d30aa40e | git add -A && commit --amend（无 -C） |
| 1013-B4 | BLOCK | ca165165 | sleep 180 && ... |
| 1013-B4 | BLOCK | 07871cef | sleep 3600 && ... |
| 1013-B4 | BLOCK | 06b26886 | sleep 20 + for 循环 |
| 1013-B4 | BLOCK | 329acfe0 | sleep 7200 |
| 1013-B4 | BLOCK | 16c9ee04 | sleep 120 |
| 1013-B4 | BLOCK | af3e4d14 | sleep 180 |
| 1013-B4 | BLOCK | b28bda8d | sleep 420 |
| 1013-B4 | BLOCK | f64ea7f5 | sleep 180 |
| 1013-B5 | BLOCK | 040c8fc8 | bash script.sh（workspaces 内） |
| 1013-B5 | BLOCK | 7daea038 | bash do-commit.sh（workspaces 内） |
| 1013-B6 | BLOCK | 24b76637 | pkill -f（worktree 内 chromium） |
| 1013-B7 | BLOCK | 835b22db | rm -f data/worktrees（构造样本，无对应实拦） |

## 红测试合入策略

6 条 ALLOW 用例（A1-A6）初始为红（V1 现存误拦暴露），因分支保护 `required_status_checks=["check"]` + `enforce_admins=true` 物理不可合入，改 `it.skip` 挂 #1468。**#1468 修复 PR 验收须含「解除 guard-v2-real-replay.test.ts 6 处 it.skip」**。

## 检视处置对应

| 检视发现 | 处置 |
|---|---|
| 严重1：6 红 ALLOW 使 check 必查项常红不可合入 | 改 it.skip 挂 #1468（禁 it.fails 防掩盖新问题） |
| 严重2：3 幻影 ID（f05b841e/76e43e73/ce5d0633） | 测试标题/PR 描述全量删除（候选 JSON + healing_events 双源 0 命中） |
| 严重2：4 处形态错配 | 62d04c3d（主仓相对路径 BLOCK）从 A3 移除；735bcf3b（非 data_destructive）B7 改「构造样本」；d7f24e3e/a116ae05（探针已放行 SKIP）从 A4 移除 |
| 严重3：特性文档挂载错 | 本文件新建（from F20261008gdcc），F20261012gtfr 还原不动 |
| 建议4：B5/B6 策略翻转风险 | 加「翻转须重裁」注记 |
| 建议5：PR 描述根因措辞 | require 白名单实为 fs/util/path @ bash-safety-guard.ts:1480 |

## 遗留

- SKIP 33 条 commandHead 截断样本：候选生成器 v2 可考虑导出完整命令（脱敏后）提升可裁决率
- 14 条探针已放行但样本记录被拦：分类器（guard-intercept-classify）准确率待查——可能把其他规则拦截误标 main_write
