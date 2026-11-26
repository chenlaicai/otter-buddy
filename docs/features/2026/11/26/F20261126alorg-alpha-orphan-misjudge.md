---
id: F20261126alorg
title: alpha 缺锁实例被误判孤儿：sweep/preflight 孤儿判据补 worktree 存活双源
summary: 修复 alpha.sh sweep 全局兜底与 start 前置 preflight 的孤儿判据——原判据「无 .otter-alpha.json 锁文件即孤儿」误杀/误阻塞「无锁但 worktree 目录仍在、数据根活动」的零登记在用实例；补齐「worktree 目录已删」条件，回归 F20261014alps 设计意图。
change_type: fix
capability_test: tests/scripts/repro-alpha-orphan-misjudge.sh
created_in_conversation: 6af46649-f93f-4c5b-a6d2-245a4ed33e9f
from:
  - F20261014alps
causal_links:
  - issue:#2022
tags: [alpha-isolation, orphan-detection, lifecycle, sweep, fail-closed]
modules: [scripts/alpha.sh, scripts/service-lifecycle-sweep.sh]
created_at: 2026-11-26
intent:
  problem: "alpha.sh sweep 全局兜底与 start 前置 preflight 把「无 .otter-alpha.json 锁文件」当作判孤儿的充分条件，误杀/误阻塞「无锁但 worktree 目录仍在、数据根活动」的零登记在用实例（detached 直拉/锁文件被删），跨对话验证环境互相误杀或无法启动。"
  expected_effect: "无锁但 worktree 目录仍在的实例不被 sweep 列为孤儿、不阻塞 start；无锁且 worktree 目录已删的真孤儿仍可回收；主服务与他对话实例均不受影响。"
  verify_by:
    type: behavior_check
    evidence:
      - "tests/scripts/repro-alpha-orphan-misjudge.sh：keep（目录在）修复前 ORPHAN → 修复后 NOT_ORPHAN；deleted（目录删）修复前后均 ORPHAN"
---

# alpha 缺锁实例被误判孤儿：sweep/preflight 孤儿判据补 worktree 存活双源

## 预注册（动手前三行）

- **预期根因方向**：`sweep_orphans`（alpha.sh）与 `scan_project`（service-lifecycle-sweep.sh）都把「无 `.otter-alpha.json` 锁文件」当作判孤儿的充分条件，漏掉了「worktree 目录是否已删」这一维——而 F20261014alps 设计意图明确是「无锁文件 **且 cwd 属于已删 worktree**」才算孤儿。
- **验证标准**：构造「无锁 + worktree 目录存在」实例，修复前 sweep 返回 PID（误判），修复后不返回；「无锁 + worktree 目录已删」实例修复前后都返回（真孤儿）。
- **最强反例**：若「无锁 + 目录存在」实际上已是僵尸（git 已 prune），我的「目录存在=在用」假设会漏回收——但漏回收交给 post-merge-cleanup 精确识别，偏向 fail-closed（宁漏不误杀），可接受。

## 问题现象

#2022 案发现场：healing `cbc5c0d4` 与 signal `f475dd16` 记录——`scripts/alpha.sh` 只凭 worktree 内 `.otter-alpha.json` 锁文件判断实例存活。实机反例 PID 87118 的 cwd 为 `.otter/worktrees/F20261124rscap`（对应 OPEN PR #2018），数据根 `~/.otter/alpha/fe9de8d3` 仍有活动，但该 worktree 没有锁文件。若执行 `alpha.sh sweep --kill` 会按「无锁=孤儿」误杀；`start` 前置 preflight 也会误阻塞。

## 根因分析（附 file:line）

两处孤儿判据同源，都漏了「worktree 目录已删」这一设计条件：

1. `scripts/service-lifecycle-sweep.sh:126`（`scan_project`）：原 `if [ ! -f "$lock_file" ]` 直接判孤儿，未检查 `$project_dir/.otter/worktrees/$wt_name` 目录是否仍存在。
2. `scripts/alpha.sh:160`（`sweep_orphans`，start 的 L3 兜底 preflight 调用）：同样 `if [ ! -f "$lock_file" ]` 直接 `echo "$pid"`。

历史锚点：F20261014alps 的 `intent.expected_effect` 明文「找**无锁文件 + cwd 属于已删 worktree**的孤儿」——设计意图本就有「已删 worktree」条件，代码实现时把它丢了，只剩「无锁文件」。这正是「设计说 A、代码实现成 B」的语义漂移，而非设计本身过宽。

## 修复

两处判据各补一个 worktree 目录存活判断，回归设计意图：

- `service-lifecycle-sweep.sh:126`：`if [ ! -f "$lock_file" ]` 内层加 `if [ ! -d "$project_dir/.otter/worktrees/$wt_name" ]` 才报孤儿。
- `alpha.sh:160`：`if [ ! -f "$lock_file" ]` 内层加 `if [ ! -d "$main/.otter/worktrees/$wt_name" ]` 才 `echo "$pid"`。

方向：`narrow-fix`（补齐缺失的既有设计条件，不新增机制、不新增状态生命周期、不新增跨模块路径）。

## 验证

### 失败用例证据（bugfix）

复现脚本 `tests/scripts/repro-alpha-orphan-misjudge.sh`（最小复现 + 真实进程：lsof 监听 alpha 端口 3160 + cmdline 含 `dist/src/main.js` + cwd 落在 `.otter/worktrees/` + 无锁文件）。

**修复前**（worktree HEAD 修复前版本）：

| 场景 | 预期 | 实测 |
|---|---|---|
| keep（无锁 + worktree 目录存在，#2022 现场） | 不应判孤儿 | ❌ `ORPHAN(判孤儿 PID 58397)` —— 误判复现 |
| deleted（无锁 + worktree 目录已删，真孤儿） | 应判孤儿 | ✅ `ORPHAN(判孤儿 PID 58594)` |

**修复后**：

| 场景 | 预期 | 实测 |
|---|---|---|
| keep | 不应判孤儿 | ✅ `NOT_ORPHAN(未判孤儿)` |
| deleted | 应判孤儿 | ✅ `ORPHAN(判孤儿 PID 59163)` |

复现命令（在 worktree 根）：
```bash
bash tests/scripts/repro-alpha-orphan-misjudge.sh scripts/service-lifecycle-sweep.sh keep
bash tests/scripts/repro-alpha-orphan-misjudge.sh scripts/service-lifecycle-sweep.sh deleted
```

机器锚点：`bash -n scripts/alpha.sh` 与 `bash -n scripts/service-lifecycle-sweep.sh` 均通过（语法无错）。

agent 陈述（未单独做真实进程复现，标注）：`sweep_orphans`（preflight 路径）未跑真实进程复现——`source scripts/alpha.sh` 会触发 `lib/probe-host.sh` 副作用，故其修复仅经 `bash -n` + 与 `scan_project` 逻辑同构（同样补 `! -d` 判断）确认。逻辑对称，风险低。

## 影响范围

- 收窄 sweep/preflight 的孤儿回收面：只回收「无锁 + worktree 已删」的真孤儿；「无锁 + worktree 在」的零登记实例不再被 sweep 动，交由 post-merge-cleanup（ps + lsof cwd 精确识别）在 worktree 清理时处理。
- 不改变端口宪法、不改变 start 的 stale-lock 清理（那只扫本 worktree 锁文件端口，语义独立）。
- 主服务（3000）从不入 sweep 扫描段（只扫 3100-3198 偶数 + 白名单避让），不受影响。

## 预期 vs 实际

预期命中：根因正是「无锁文件被当充分条件、漏了 worktree 已删条件」，修复后 keep 不判孤儿 / deleted 判孤儿，与预注册的验证标准一致；无偏离。
