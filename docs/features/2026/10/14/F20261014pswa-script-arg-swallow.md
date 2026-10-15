---
id: F20261014pswa
title: "otter-buddy.sh 参数探测循环吞参修复：全命令落 usage 回归（#1473 引入）"
summary: "脚本回归修复：F20261014alps（#1473）新增的 port_explicit 预探测 while 循环用 shift 遍历参数，循环结束 $@ 已空，下方正式解析循环拿不到任何 token——start/stop/restart/status 全部落 usage 退出 1，脚本整体不可用。修复：预探测改 for 遍历 \"$@\"（只读不消费），机械闸语义不变。10-14 现场：用户升级代码后 scripts/otter-buddy.sh stop 直接打印 Usage。"
change_type: fix
capability_test: "n/a: 纯 shell 脚本参数解析逻辑（A 类），无 LLM 参与行为"
status: development
modules:
  - scripts/otter-buddy.sh
intent:
  problem: "otter-buddy.sh 任何命令（start/stop/restart/status）都打印 Usage 退出 1：port_explicit 预探测 while 循环 shift 吞掉全部参数，正式解析循环永远拿到空 $@，CMD 恒为空。"
  expected_effect: "scripts/otter-buddy.sh status -p 3000 输出运行状态而非 Usage；非法命令仍落 Usage；worktree 无 -p 落到 3000 时机械闸仍拒启（F20261014alps 语义不变）。"
  verify_by:
    type: behavior_check
---

# F20261014pswa: otter-buddy.sh 参数探测循环吞参修复

## 问题与根因

### 现象（10-14 现场）

用户升级代码后执行重启：

```
$ scripts/otter-buddy.sh stop
Usage: otter-buddy.sh <command> [-p port]
```

`start`/`stop`/`restart`/`status` 全部同样落 Usage——脚本整体不可用。

### 根因

F20261014alps（#1473，commit d4f82c2d）在参数解析前新增 port_explicit 预探测循环：

```bash
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--port) port_explicit=true; break ;;
    *) shift ;;        # ← 探测即消费
  esac
done
```

无 `-p` 时该循环把 `$@` shift 到空。下方正式解析循环（`while [[ $# -gt 0 ]]` 赋 CMD）因此永远拿不到 token，`CMD` 恒为空串，case 落 `*) usage; exit 1`。

`bash -x scripts/otter-buddy.sh status` 实证：第一轮循环 `shift` 至 `[[ 0 -gt 0 ]]`，第二轮循环直接跳过，`CMD=` → usage。

同 commit 的机械闸本身无问题（worktree + 默认 3000 拒启语义正确且本次保持），回归仅在探测循环的实现形态。

## 修复设计

预探测改为只读遍历，不消费参数：

```bash
for arg in "$@"; do
  case "$arg" in
    -p|--port) port_explicit=true; break ;;
  esac
done
```

一行注释钉住纪律：探测循环禁止 shift。

不变面：机械闸判定逻辑、正式参数解析循环、各 cmd_* 函数全部不动。

## 验证

worktree 内实测（修复后）：

| 场景 | 命令 | 结果 |
|------|------|------|
| 合法命令 | `status -p 3000` | 输出 `[info] NOT running in this worktree, but port 3000 is in use`（修复前落 Usage） |
| 非法命令 | `badcmd -p 3000` | 落 Usage 退出 1（不变面） |
| 机械闸 | `status`（worktree 无 -p，解析到 3000） | `[error] Refusing to start on port 3000 from a worktree.`（F20261014alps 语义不变） |

修复前主仓基线对照：`bash -x scripts/otter-buddy.sh status` 复现吞参全程（trace 见上文根因）。

## 验收结果

### 证据判定

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| 合法命令正常解析执行 | 命令输出（上表场景 1） | ✅ |
| 非法命令仍落 Usage | 命令输出（上表场景 2） | ✅ |
| worktree 3000 机械闸不回归 | 命令输出（上表场景 3） | ✅ |
