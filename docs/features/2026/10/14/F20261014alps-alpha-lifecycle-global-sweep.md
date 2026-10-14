---
id: F20261014alps
title: alpha 进程生命周期全局兜底 + worktree 端口机械闸 + 跨项目通用机制
summary: 3000 被占事故与孤儿实例复发的根因修复——alpha.sh 新增 sweep 全局兜底扫描（委托给跨项目通用工具 service-lifecycle-sweep.sh）、otter-buddy.sh 在 worktree 场景硬拒默认 3000、跨项目通用生命周期管理落地（含 colink 接入）。
change_type: feature
capability_test: tests/scripts/alpha-lifecycle-guard.test.sh
created_in_conversation: 6c04e16b-644e-4b41-8124-8dbaa5cdebf1
intent:
  problem: "2026-10-14 搭档报告：最近两天升级重启系统时频繁遇到「3000 被 worktree 用了」，需手动杀死进程；同时发现 worktree 启动的进程成孤儿（PPID=1，无人回收），导致操作系统负载增大。根因：①otter-buddy.sh 在 worktree 场景下无端口宪法硬闸（worktree 无 config.yaml → 落默认 3000 抢主服务端口）②alpha 进程管理只有「本 worktree 视野」（跨 worktree、无锁文件的实例三不管）③跨项目同样形态存在（colink 项目 dm-forward worktree 下两只 detached 实例）。"
  expected_effect: "alpha.sh 新增 sweep 全局兜底扫描（委托给跨项目通用工具 service-lifecycle-sweep.sh，找「无锁文件 + cwd 属于已删 worktree」的孤儿，默认只报告 --kill 才清理）；otter-buddy.sh 在 worktree 场景硬拒默认 3000（未显式 -p 且解析到 3000 时拒绝启动并引导 alpha.sh，显式 -p 3000 不拦）；跨项目通用生命周期管理落地（service-lifecycle.toml 配置格式 + colink 接入 + 顺手清理 colink 孤儿实例）。"
  verify_by:
    type: behavior_check
tags: [alpha-isolation, port-constitution, lifecycle, orphan-cleanup, cross-project]
modules: [scripts/alpha.sh, scripts/otter-buddy.sh, scripts/service-lifecycle-sweep.sh, docs/designs]
---

# alpha 进程生命周期全局兜底 + worktree 端口机械闸 + 跨项目通用机制

## 问题现象

2026-10-14 搭档报告：最近两天升级重启系统时频繁遇到「3000 被 worktree 用了」，需手动杀死进程；同时发现 worktree 启动的进程成孤儿（PPID=1，无人回收），导致操作系统负载增大。

## 根因分析

### 根因 1：otter-buddy.sh 在 worktree 场景下无端口宪法硬闸

- 端口解析优先级：`-p/--port` 显式覆盖 > `config.yaml server.port` > 默认 3000
- worktree 通常无 `config/config.yaml` → 落默认 3000
- 结果：worktree 内跑 `otter-buddy.sh start` 直接抢主服务端口
- **alpha.sh 分流 3100+ 只是约定，没有机械闸把「worktree 内起 3000」这条路焊死**

### 根因 2：alpha 进程管理只有「本 worktree 视野」，无全局兜底

- 现有清理：①alpha.sh stop（本 worktree）②post-merge-cleanup 流程 ③alpha.sh start 时 stale-lock 清理（只扫本 worktree 锁文件端口）
- **跨 worktree、无锁文件的实例三不管**
- F20261005clup 曾提出 L3 全局兜底扫描，当时拍板「缓缓」——事故信号已出现（10/13 抓到悬空实例 21577，cwd 指向已删目录）

### 根因 3：跨项目同样形态存在

- 实证：colink 项目 dm-forward worktree 下两只 detached 实例（PID 18239/18240 backend + 90123/90124 frontend），PPID=1 已脱离终端
- 同一「worktree 起 detached 进程无人收」模式在 otter-buddy 之外也在发生

## 方案设计

### 修法 1：跨项目通用 sweep 工具 + alpha.sh 委托（L2 落地）

**机制**：
1. **新建 `scripts/service-lifecycle-sweep.sh`**：跨项目通用扫描工具，支持 `service-lifecycle.toml` 配置格式
2. **alpha.sh sweep 委托给通用工具**：吃自己的狗粮，otter-buddy 走同一套逻辑
3. **colink 接入**：在 colink 仓库根目录放 `service-lifecycle.toml`，sweep 工具扫到时自动识别

**service-lifecycle.toml 配置格式**：
```toml
[project]
name = "otter-buddy"
main_port = 3000
alpha_port_range = [3100, 3198, 2]
worktree_pattern = ".otter/worktrees/*"
lock_file_name = ".otter-alpha.json"
process_pattern = "dist/src/main.js"
```

**接口**：
- `service-lifecycle-sweep.sh`：扫所有注册项目（otter-buddy + colink）
- `service-lifecycle-sweep.sh --project <name>`：只扫指定项目
- `service-lifecycle-sweep.sh --kill`：终止孤儿（默认只报告）
- `alpha.sh sweep`：委托给 `service-lifecycle-sweep.sh --project otter-buddy`

**幂等性**：零状态扫描，可随时跑；无孤儿时输出 "No orphaned instances found across all projects."

**边界**：
- 不扫主服务端口（主服务归搭档管）
- 不扫白名单端口（外部项目 dev server 不算孤儿）
- 不扫非本项目形态进程（cmdline 不含 process_pattern 的跳过）

### 修法 2：otter-buddy.sh 在 worktree 场景硬拒默认 3000

**机制**：未显式 `-p` 且解析到 3000 时，检查 `PROJECT_DIR != main_repo_root()`：
- 不等 → 拒绝启动，输出错误 + 引导 `alpha.sh start`
- 相等 → 放行（主仓正常启动）

**显式 `-p 3000` 不拦**：搭档显式指定是特权行为，机械闸不挡人。

### 修法 3：跨项目通用生命周期管理（设计文档）

见 `docs/designs/cross-project-service-lifecycle.md`。

核心思路：
1. **端口宪法推广**：每个项目定义「主服务端口」与「worktree 隔离段」，机械闸强制
2. **锁文件标准化**：所有 detached 启动必须写锁文件（PID + 端口 + 项目根 + worktree 路径）
3. **全局 sweep 工具**：跨项目扫描——「无锁文件 + cwd 属于已删 worktree」= 孤儿
4. **系统级看门狗**（可选）：launchd/cron 定时跑 sweep，自动清理或报告

## 影响范围

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| scripts/alpha.sh | 修改 | 新增 sweep_orphans() + cmd_sweep() + start 前置自动扫描 |
| scripts/otter-buddy.sh | 修改 | 新增 worktree 场景 3000 端口机械闸 |
| docs/designs/cross-project-service-lifecycle.md | 新建 | 跨项目通用机制设计文档 |

## 设计取舍

### 机制预算四问（判定：命中③新增机制）

1. **问题真实吗？** 是。搭档 10/14 报告两天内多次遇到 3000 被占 + 孤儿进程；10/13 记忆实证抓到悬空实例 21577；colink 项目同样形态存在。
2. **最小修法是什么？** 修法 1（跨项目 sweep 工具）+ 修法 2（机械闸）是完整闭环——单项目 sweep 已在 F20261005clup 时「缓缓」，本次搭档明确要求「做完整」，L2 跨项目泛化一并落地。
3. **后续机制会膨胀吗？** sweep 是零状态扫描，不引入常驻进程；机械闸是启动时一次性校验，无状态。不引入新的后台机制。
4. **退役条件？** 若未来所有项目都迁移到统一生命周期管理框架（修法 3 落地），本仓的 sweep/机械闸可被框架吸收；但框架未落地前，本机制是必要兜底。

### 为什么 sweep 默认只报告不杀？

- 杀进程是不可逆操作，默认安全模式防止误杀
- 报告模式让搭档/獭先确认孤儿身份，再决定 `--kill`
- start 前置自动扫描发现孤儿时拒绝启动（而非自动杀），把决策权留给人

### 为什么机械闸不拦显式 `-p 3000`？

- 显式指定是搭档特权，机械闸的职责是拦「默认路径的意外」，不是限制「人的显式决策」
- 与端口宪法一致：「主服务 3000 只有搭档碰」——显式 -p 3000 是搭档在碰

## 验证

| 场景 | 验证点 | 结果 |
|------|--------|------|
| worktree 内 otter-buddy.sh start 未显式 -p | 拒绝启动，输出引导 alpha.sh | 待验证 |
| 主仓 otter-buddy.sh start 未显式 -p | 正常启动 | 待验证 |
| worktree 内 otter-buddy.sh start -p 3000 | 显式覆盖放行 | 待验证 |
| alpha.sh sweep 无孤儿 | 报告 none | 待验证 |
| alpha.sh sweep 有孤儿 | 报告 PID + cwd | 待验证 |
| alpha.sh sweep --kill | 终止孤儿 | 待验证 |
| alpha.sh start 前置自动 sweep 发现孤儿 | 拒绝启动 | 待验证 |

## 负面向验收条目

**本次变更破坏了什么旧契约 / 绕过了什么既有保护？**

- 无。本次变更新增保护（sweep + 机械闸），未绕过任何既有保护。
- alpha.sh start 前置自动扫描是**新增**校验，不改变原有 stale-lock 清理逻辑。
- otter-buddy.sh 机械闸只拦「未显式 -p 且落 3000」的默认路径，不影响显式指定。

## 最简实现检查

- 仓库已有实现：sweep_orphans 复用现有 kill_process_tree/stop_process_tree/is_port_free 等 helpers，无重复造轮子
- stdlib/平台原生：lsof/ps/awk 均为 macOS 原生工具，无新依赖
- 已装依赖：无新 npm 依赖
- 结论：已过最简检查

## Discovered Issues

无。

## 参考

- F20260917alph：alpha 验证环境隔离特性（端口宪法、独立数据根）
- F20261005clup：合入清理补进程生命周期闭环（post-merge-cleanup 先停实例再删目录）
- F20260930p125：启动事故 Discovered Issues（worktree 内 otter-buddy.sh 守卫盲区）
- docs/designs/cross-project-service-lifecycle.md：跨项目通用机制设计文档
