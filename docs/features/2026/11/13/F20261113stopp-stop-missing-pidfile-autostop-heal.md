---
id: F20261113stopp
title: stop 无 PID 文件时验明身份直接代停 + start/status 自愈重建 PID 文件
summary: 2026-11-13 搭档重启系统再撞 F20261103portx 遗留问题——主服务健康在跑但 .otter-buddy.pid 缺失（11/11 启动时正常写入，后在脚本管辖外被删，轨迹不可考），stop 只给「kill <pid> && start」指引不动手。搭档拍板：stop 的语义就是停掉当前服务，PID 文件只是寻址手段。本次把信任根从「PID 文件」扩展为 listener_class 三重验证（LISTEN 端口 + cwd=本仓 + node/main.js 特征），验证通过即代停；start/status 发现主服务缺 PID 文件时自愈重建，文件丢失从此无感。
change_type: fix
capability_test: tests/scripts/port-identity.test.sh
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
tags: [scripts, stop, pid-file, self-heal]
modules: [scripts]
created_at: 2026-11-13

intent:
  problem: "PID 文件丢失后 stop 只提示不停止，搭档要重启系统被迫手动 kill；且文件丢失本身无自愈通道"
  expected_effect: "stop 对验明身份（LISTEN 端口 + cwd=本仓 + node 特征）的本仓服务直接代停；start/status 自愈重建 PID 文件；外人占用依旧拒杀"
  verify_by:
    type: behavior_check
---

# F20261113stopp：stop 无 PID 文件代停 + PID 文件自愈

## 现场（2026-11-13 08:54）

搭档执行 `scripts/otter-buddy.sh stop` 想重启系统：

```
[warn] Otter Buddy appears to be running (PID 91689) but /Users/orca/ai/otter-buddy/.otter-buddy.pid is missing.
       To restart it:  kill 91689 && scripts/otter-buddy.sh start
```

## 排查：PID 文件为什么丢（Q1）

- 主服务 91689 自 11/11 10:18 运行至今；`.otter-buddy.log` 首页即该进程启动输出（`cmd_start` 先截断日志再拉起）——证明是脚本正常启动，**PID 文件当时必然写入**（`echo $! > .otter-buddy.pid` 无条件执行）。
- 全仓枚举删除路径：仅脚本自身 3 条 `rm -f`（stop 成功杀后 / stop 清理死 PID / start 健康检查失败），逐条核对**无一条能在进程存活时误删**；`restart-service.mjs` 只读；npm 生命周期不碰；`git clean` 任何会删它的变体（-x/-X）必然连带删 node_modules/dist/data——三者俱在，排除。
- 结论同 F20261103portx 遗留问题：**删除发生在脚本管辖之外（手动 rm / 第三方工具），无审计轨迹，事后不可考**。本次不再追因，改让丢失无感化（自愈）+ stop 不依赖文件（身份寻址）。

## 需求变更（搭档拍板 2026-11-13）

F20261103portx 当时的取舍：「PID 文件缺失时拒绝代杀（信任根=PID 文件），只给手动 kill 指引」。搭档明确反转：**「我要的效果就是停止当前进程，至于根据 pid 文件还是其他方式都是具体实现逻辑」**。

## 修复

1. **stop 代停**：无 PID 文件（或文件过期）但监听者 `listener_class=main-service` → 直接 SIGTERM（5s 宽限→SIGKILL，与原 kill 分支同节奏，抽为 `terminate_pid` 公共函数）。安全边界不松动：信任根不是「端口上任何 node」，而是三重验证（LISTEN 端口 + cwd=本仓 + node/main.js 特征）；otter-or-node/foreign 占用依旧 `report_port_occupant` 拒杀（场景C 回归锁定）。
2. **PID 文件自愈**：`start`/`status` 发现主服务在跑但缺文件 → `heal_pid_file` 重建后正常返回（start 由 exit 1 报错改为幂等「Already running (PID file re-created)」）。
3. **测试重写**（`tests/scripts/port-identity.test.sh`）：旧版隐含假设「仓根无存活 PID 文件」，自愈落地后该假设恒假（真实主服务的 stop 会撞 F20260831aksp T1 拒杀分支）。改为 mktemp 沙箱隔离（脚本副本的 PROJECT_DIR=沙箱，TMP 经 `pwd -P` 物理归一——macOS /var 软链会让 lsof cwd 比对失配），真实主服务零接触。新增场景：B 无文件代停 / B2 过期文件代停 / B3 status 自愈 / B4 start 自愈 / C foreign 拒杀 / D PID 文件正路回归。

## 验证

- `bash tests/scripts/port-identity.test.sh` 七场景全绿（含拒杀边界与正路回归），跑完无残留监听进程
- `bash tests/scripts/script-arg-parse.test.sh` 全绿（worktree 撞闸场景按设计 SKIP）
- `bash -n scripts/otter-buddy.sh` 语法通过
- 测试自身事故修复：哑进程 spawn 曾在 `$()` 子壳里 `PIDS+=`（不回传父壳，trap 漏杀致首轮残留监听者污染次轮）——改全局变量回传，本轮起隔离严密

## 设计取舍

- **为什么反转 F20261103portx 的「不代杀」**：当时的顾虑是「端口上任何 node 进程都可被杀」的攻击面；但 listener_class 已把识别做到 cwd 级（本仓）+ 特征级（node/main.js），误杀面收敛为「本仓目录起的、监听本端口的 node 服务」——这正是 stop 的目标本体。搭档作为安全边界的最终裁决者已明确拍板。
- **为什么不追「谁删了文件」**：两次现场（11/02、11/11）删除轨迹均不可考；自愈 + 身份寻址让该问题从「阻断操作」降级为「无感事件」，追因 ROI 为负。
- **worktree 语义不变**：worktree 内 stop -p 3000 打主服务时，监听者 cwd=主仓≠worktree PROJECT_DIR → 分类 otter-or-node → 依旧拒杀，跨仓代杀不可能发生。
