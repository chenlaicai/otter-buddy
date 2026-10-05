---
id: F20261005clup
title: 合入清理补进程生命周期闭环（孤儿 alpha 实例事故修复）
summary: 3194 孤儿实例空转 5 天 10 小时打满 CPU 事故的修复——post-merge-cleanup 步骤 3 插入「先停实例再删目录」（锁文件 alpha.sh stop + ps/lsof cwd 匹配兜底），worktree-isolation 补实例登记纪律（手工直拉必须当场 kill）。改动仅限两个 skill 文档，alpha.sh 已具备所需幂等性，无新机制。
change_type: fix
tags: [cleanup, lifecycle, orphan-process, alpha, skill]
modules: [.pi/skills/post-merge-cleanup, .pi/skills/worktree-isolation]
created_at: 2026-10-05
created_in_conversation: 4d5de028-1807-43d6-989e-a421dda48f5b
causal_links:
  - F20260930p125
---

# 合入清理补进程生命周期闭环（孤儿 alpha 实例事故修复）

## 背景与事故

2026-10-05 晚搭档电脑风扇狂转，排查发现 PID 78421（`node dist/src/main.js --port 3194`）单核打满 99.4% CPU、累计 CPU 时间 715 分钟、已存活 5 天 10 小时。该实例是 9/30 issue #1252（F20260930p125）修复验证期间从 worktree `fix-1252-port-tdz` 手工 detached 直拉的验证实例；10/1 PR #1258 合入后清理移除了 worktree 与分支，但**进程没有停止步骤**，实例成为孤儿空转至今。

## 根因（三层漏洞叠加，详见当日排查）

1. **流程漏洞（主因）**：post-merge-cleanup 步骤 3-5 只覆盖文件生命周期（worktree/分支/issue/产物），没有「停该 worktree 关联的运行中实例」步骤——文件系统实体与进程实体被当成两个互不相干的世界管理，而它们本是同一个「验证环境」资源的两个投影。
2. **入口绕过**：3194 实例是手工 `node dist/src/main.js --port 3194`（detached-launch）直拉，未走 alpha.sh，零登记（无 `.otter-alpha.json` 锁文件）——worktree 一删，最后一点线索消失。
3. **无兜底回收**：alpha.sh start 的孤儿清理只清「本 worktree 锁文件端口」上的孤儿且要求锁文件还在；无全局扫描，孤儿实例三不管。

第一性原理：资源生命周期必须闭环——谁创建、谁销毁、销毁动作挂在哪个事件上。本事故断在「销毁事件（worktree 删除）不级联到进程」。

## 方案

修法决策树① 既有语义内修：cleanup 的职责本来就该覆盖「回收该特性的一切产物」，实例也是产物；alpha.sh stop 已具备幂等性（stop.mjs 对死锁文件返回 `stopped:false` 不报错）。改动仅限两个 skill 文档，无新机制。

### L1 流程修复（post-merge-cleanup 步骤 3 前置）

删 worktree 前插入「先停实例再删目录」，顺序不可反（alpha.sh 随 worktree 一并消失，先删目录就再也停不了）：

- 有锁文件 `<worktree>/.otter-alpha.json` → 读 PID + `kill -0` 确认 → worktree 内 `bash scripts/alpha.sh stop`
- 无锁文件兜底：`ps -ax -o pid,command | grep "node dist/src/main.js"` 列候选 → `lsof -a -p <pid> -d cwd -Fn` 取 cwd → cwd 精确匹配该 worktree 路径 → kill
- 杀不掉的记入清理报告呈搭档，不阻塞

### L2 入口收敛（worktree-isolation 验证纪律补充）

「验证服务行为的标准动作」段后补「实例登记纪律」：实例生命周期必须闭环（创建即登记、销毁有级联）；手工直拉零登记，万不得已直拉时验证完必须当场 `kill <pid>`。

## 关键实现细节：macOS pgrep 坑

兜底命令选型时发现并实证：`pgrep -f "node dist/src/main.js"` 在 macOS 上对截断 argv 匹配失灵——2026-10-05 实测进程 49231 正在运行 `node dist/src/main.js` 但 `pgrep -f` 返回空（exit 1）。改用 `ps -ax -o pid,command | grep` 稳定命中。skill 文档中已注明该实证，防止后来者「顺手优化」回 pgrep。

## Verification

- 兜底命令实测（2026-10-05 22:05，本机）：`ps -ax -o pid,command | grep "node dist/src/main.js" | grep -v grep` 命中 PID 49231；`lsof -a -p 49231 -d cwd -Fn` 返回 cwd `/Users/orca/ai/otter-buddy`（主仓实例，不在任何 worktree 下——证明 cwd 匹配不误伤主服务）
- 对照实测：`pgrep -f "node dist/src/main.js"` 同刻返回 exit 1（漏检实证）
- 现状核实：事故实例 PID 78421 已不在（排查时已确认退出）；当前所有 worktree 无 `.otter-alpha.json`、无残留实例
- 文档改动 diff 自检：两处插入均为既有步骤内的补充说明，未改变任何既有步骤语义

## 影响范围

- 仅 `.pi/skills/post-merge-cleanup/SKILL.md`（步骤 3 前置实例停止）与 `.pi/skills/worktree-isolation/SKILL.md`（验证纪律补登记纪律）
- 后续所有 PR 合入清理自动获得进程回收能力；无代码改动，无运行时影响

## 未做（搭档已拍板缓缓）

L3 兜底扫描（alpha.sh start 时全局孤儿扫描：监听中 + cwd 已死 → 报告）——幂等零状态，可做可不做，留待下次事故信号出现再立项。
