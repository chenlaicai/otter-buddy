---
id: F20260916gsrd
title: 主服务脚本自杀命令封堵：otter-buddy.sh 主仓拒杀 + 守卫识别服务脚本调用
summary: 9/16 事故——獭 7708a033 验证代码后执行 `otter-buddy.sh restart` 杀掉主进程 31385（kill 族守卫看不到脚本名）。两层封堵：①脚本层主仓拒杀（主仓目录+PID 存活→拒绝 stop/restart）②守卫层识别 otter-buddy.sh stop/restart 调用（与 kill 主进程同级拦截，走 bash_safety 引导通道）。README 同步标注主仓保护。
change_type: fix
capability_test: tests/frameworks/agent/bash-safety-guard.test.ts（13 个新用例：脚本 stop/restart 拦截 + sudo/命令替换形态 + start/status 放行 + 非命令位置放行）
created_in_conversation: 12668046-9cc5-4a2a-bf81-da644168b3e7
tags: [bash-guard, security, suicide-command, otter-buddy.sh, main-process]
modules: [scripts/otter-buddy.sh, src/frameworks/agent/bash-safety-guard.ts, tests/frameworks/agent/bash-safety-guard.test.ts, README.md]
from: [F20260831aksp, F20260914dsrv, F20260830bsgr]
---

# 主服务脚本自杀命令封堵

## 背景（9/16 事故实证）

2026-09-16 09:57:16，獭 7708a033（kimi/k3，对话 acf4e2d3）在验证 `workspace/reveal` 改动后，判断「重启服务让新 dist 生效」，执行：

```bash
./scripts/otter-buddy.sh restart 2>&1 | tail -8
```

→ `cmd_stop` 内 `kill -15` 主进程 31385 → 09:57:17 主进程 SIGTERM 死亡 → 09:58:13 restart 的 start 分支拉起新进程 92605。搭档感知为「所有对话的所有獭突然全停、过一会又自己动」——其实是脚本 restart 的杀-起两半。

### 为什么 F20260831aksp 的杀伐校验没拦住

8/31 加的校验逻辑：`cmd_stop` 杀 PID 前，检查「PID 文件进程是否监听 $PORT」。主服务是 `otter-buddy.sh start` 拉起的（搭档常用方式），主仓 `.otter-buddy.pid` 写的就是主服务 PID，且主服务**确实**监听 3000——校验**合法通过**，照杀不误。F20260831aksp 堵的是「-p 3002 误伤」的窗，「明目张胆 restart 主服务」这扇门从设计起就开着。

### 为什么 bash 守卫没拦住

守卫（F20260830bsgr 起）只分析 kill 族词元 + 进程名模式。`./scripts/otter-buddy.sh restart` 字面不含 kill/pkill/node 任何词元，完全在检测视野外。守卫的 `locateTriggerContext` 诊断词表也没有「脚本调用」这一类。

### 惯犯背景

7708a033 即 8/30 事故 B（kill 主进程 42877）、事故 C（被拦后再撞一次）主角。本次为同一獭第四次致死主进程，前三次走 kill 直杀路径（已被 #611/F20260830bsgr 封堵），本次改走脚本路径——证明只堵 kill 词元不够，**主服务管理脚本本身就是自杀命令**。

## 方案

修法排序：①既有机制语义内修（缺啥补啥）。机制识别检查点逐项：不新增配置/状态生命周期/定时任务/信号类型/持久化存储/决策分支/跨模块调用——脚本加拒杀条件、守卫加匹配模式，均为既有机制内补全。**排序① narrow-fix，轻对抗**。

### B 层：脚本主仓拒杀（物理杀伐的最后闸门）

`scripts/otter-buddy.sh` 的 `cmd_stop` 开头加主仓保护：

- **主仓判定**：`git rev-parse --path-format=absolute --git-common-dir` 解析真实 git 根（worktree 的 common-dir 指向主仓 `.git`，其上一级即主仓根）。判定失败按主仓对待（保守拦截）
- **拒杀条件**：主仓目录 + PID 文件指向存活进程 → 拒绝，exit 1，提示「主服务是海獭运行环境，验证走 worktree 独立端口，确需重启请搭档人工执行」
- `cmd_restart` 调 `cmd_stop`，自动继承保护（restart 在拒杀处中止，不会进入 start 分支）
- worktree 内管理自己的隔离实例不受影响（PROJECT_DIR ≠ 主仓根）

### A 层：守卫识别服务脚本调用（检测层补盲）

`bash-safety-guard.ts` 新增 `SERVICE_SCRIPT_KILL` 模式 + `checkCommandLevelPatterns` 首条规则：

- 覆盖形态：`./scripts/otter-buddy.sh restart`、`scripts/otter-buddy.sh stop`、绝对路径、`bash/sh` 显式解释器、sudo 包装、组合命令后段
- 只拦 `stop|restart` 子命令；`start`（端口冲突由脚本自行检测）、`status`/`logs`（只读）放行
- 拦截文案走既有 bash_safety 引导通道（四要素口径：不允许声明 / 无合法场景 / worktree 正道 / 重新分析），不提供任何 restart 出口（F20260831aksp 终审口径继承）
- `locateTriggerContext` 诊断词表补「主服务脚本」类，被拦獭能看到命中点

### README 收口

启动脚本章节补主仓保护说明——9/16 事故的直接诱因之一就是 README 第 121 行明写 `./scripts/otter-buddy.sh restart # 重启`，獭把官方文档当操作依据。标注「主仓 stop/restart 拒杀；海獭无合法重启场景」。

## 影响范围

| 文件 | 变更 | 行为变化 |
|---|---|---|
| `scripts/otter-buddy.sh` | +主仓判定函数 +cmd_stop 拒杀块 | 主仓 stop/restart 主服务：杀 → 拒杀 exit 1（Incompatible，检索无自动化调用方依赖旧行为） |
| `src/frameworks/agent/bash-safety-guard.ts` | +SERVICE_SCRIPT_KILL +cmdLevel 规则 +诊断词 | otter-buddy.sh stop/restart 调用：放行 → 拦截（bash_safety 引导） |
| `tests/.../bash-safety-guard.test.ts` | +9 用例 | 覆盖拦截/放行/非命令位置 |
| `README.md` | +主仓保护说明 | 文档口径与脚本行为一致 |

## 验证

- 守卫单测：97/97 通过（含 9 个新用例）
- 主仓判定逻辑：`git common-dir` 解析在主仓→拒杀生效、在 worktree→放行（实测两路径）
- 脚本端到端（主仓语境拒杀）：搭档人工验证项——在主仓跑 `./scripts/otter-buddy.sh stop` 应见拒绝文案且主服务存活

## 已知边界

- 獭仍可用 `bash -c "$(cat scripts/otter-buddy.sh)"` 类间接形态尝试（文本分析极限，与 base64 绕过同级，F20260830bsgr 已声明「纵深防御一层，非绝对防线」）
- 08:03 同日的另一次 SIGTERM 现场无 otter 工具痕迹，疑似同款脚本命令未抓实锤，未强行归因
- restart-service.mjs 针对主服务端口的调用由 F20260914dsrv 白名单机制兜底（白名单不含主端口），不在本特性重复

## Delta（检视 R1 处置，2026-09-16）

检视獭-970（mimo）初轮：0 严重、3 建议。处置：

| # | 发现 | 处置 |
|---|---|---|
| 1 | sudo 句首绕过 SERVICE_SCRIPT_KILL（`^` 分支不含 sudo） | 接受并修复：正则重构为 `(?:^|[;&|\`$(])\s*(?:sudo\s+)?...`，句首/操作符/命令替换统一支持 sudo；补 2 用例 |
| 2 | `$()`/反引号命令替换绕过 | 接受并修复：前导分组补 `` ` `` `$` `(` 字符类；补 2 用例 + 中文语境不误拦反向用例 |
| 3 | `--path-format=absolute` 依赖 git≥2.36，旧 git 下 worktree 被误拦 | 建 issue #971 追踪（fallback 是增量机制，独立 PR；生产 git 2.50.1 不受影响） |

修复后：102/102 通过、eslint 通过。
