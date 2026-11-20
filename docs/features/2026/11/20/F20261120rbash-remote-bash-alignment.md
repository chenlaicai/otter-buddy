---
title: 远程 bash 执行对齐（阶段 7 PR-A）
id: F20261120rbash
date: 2026-11-20
module: session
change_type: feature
summary: |
  落实 #1868 阶段 7 PR-A：SDK bash 按业务对话当前执行机物理落到 connector，
  不再由 RemoteExecutionMachine 拒绝构造环境，也不把远程对话命令静默留在 hub。
  协议升 v2 并保留 v1 六动作双栈；新增 shell.exec、action.output/action.cancel，
  覆盖流式输出、超时、取消、进程组、输出窗口与五态恢复分类。
intent:
  problem: "阶段 5 只开放 workspace 六动作；DurableSession 的 env 工厂无业务对话维度，RemoteExecutionMachine 无远程 ExecutionEnv，导致远程对话的 SDK bash 不能真实落到所选设备"
  expected_effect: "对话选择 connector 后 SDK bash 在该设备工作区执行并回传输出；取消/超时杀对应进程组；断线按既有五态收尾；默认本机与 v1 六动作保持兼容"
  verify_by:
    type: behavior_check
    evidence:
      - "tests/frameworks/agent/durable-execution-machine.test.ts：真实 SDK bash 经 ALS 业务对话路由并物理写设备侧目录"
      - "tests/frameworks/execution/remote-execution-machine.test.ts：远程 env、cwd 跨机映射、v1 拒绝、v2 输出与取消"
      - "tests/frameworks/execution/connector-shell-e2e.test.ts：真 WSS 流式输出、取消、版本闸"
      - "tests/connector/shell-action-executor.test.ts：命令/环境/退出码/窗口/取消/超时/幂等/下线"
capability_test: "tests/frameworks/execution/connector-shell-e2e.test.ts"
---

# F20261120rbash：远程 bash 执行对齐（阶段 7 PR-A）

## 背景

执行机总控的阶段 5 已交付对话选择与 workspace 六动作路由，但 SDK 的
read/write/edit/bash 仍依赖本机 ExecutionEnv。本切片先把 bash 做成真远程，
消除「界面选 B、命令却在 A 跑」的歧义。文件与 Git 对齐属后续切片。

## 交付

### 对话级 SDK 环境路由

- per-invoke ALS 增加业务 conversationId；它与 pi-durable 内部 root
  conversationId 不同，不混用。
- ConversationActionRouter 同时实现 ActionRunner 与 Resolver，新增异步
  resolveForConversation；DurableSession env 工厂据此选机器。
- app 组合根让 workspace 工具和 SDK env 共用同一路由；无业务对话的 reset、
  合成与后台通道仍走 local。
- RemoteExecutionEnv 当前只开放 shell.exec；文件面显式 not_supported，
  不静默回退 hub。

### shell.exec 与跨机 cwd

- input 必带业务 conversationId、command，支持 cwd/env/inheritEnv/timeout/
  spill/window；remote_action_requests 与 connector 台账均保留对话/invoke 归因。
- hub 先取设备 workspace.path，再把 hub 工作区内 cwd 映射为设备工作区
  相对后缀；设备绝对路径仅用于显式设备侧调用。
- string 走 shell，argv 直跑不过 shell；非零 exitCode 是已完成动作的结果，
  不误记 failed。

### 协议 v2 与 v1 共存

- hello 支持集取交集最高；upgrade 子协议双收并优先 v2。
- 每个连接保存协商版本，收发帧校验使用该版本，不用全局常量覆盖旧会话。
- v1 只通行既有六动作；v2 新增 action.output/action.cancel 与 shell.exec。
- output 不结终态；cancel 不伪报成功；最终状态只由 action.result 结算。

### 端上执行与恢复

- 每个 shell 动作持有独立 NodeExecutionEnv + AbortController；SDK 负责
  进程组 timeout/abort/spill，取消只影响目标 actionId。
- connector 直接使用 NodeExecutionEnv + 既有台账，不引入 agent/model/
  embedding/主记忆；闭包闸只精确放行 chord/context 轻量子路径。
- window 由 connector 输出泵实现尾部保留、采样节流与 skipped 精确计数；
  spillPath 是设备本机诊断路径，跨机不承诺可读。
- 优雅下线先取消在途进程组再收尾；意外断线/崩溃仍落 unknown，不盲重放。

## 设计取舍

| 取舍 | 决策 | 被否替代 | 理由 |
|---|---|---|---|
| 路由事实源 | 工具与 SDK env 共用对话路由 | 两套解析路径 | 避免界面/工具/SDK 目标分裂 |
| 文件面过渡 | 显式 not_supported | 继续落 hub | 错误位置执行比明确不可用更危险 |
| 协议 | v2 + v1 双栈 | v1 内直接加双向帧 | 防止旧端把 output 当协议错误 |
| 输出 | 流式帧 + 终态帧分离 | output 改状态 | 只有 result 有结算权 |
| spill | 保留设备诊断路径 | 本切片回传完整文件 | 大输出先靠 window/skipped；附件传输另切片 |

## 机制识别检查点

- 新增持久化存储：否（复用 remote_action_requests 与 connector 台账）。
- 新增状态生命周期：是（shell 动作 requested 到五态，输出/取消不另造终态）。
- 新增信号/消息格式：是（协议 v2 三类帧与版本协商）。
- 新增决策分支：是（业务对话解析、cwd 映射、版本能力闸）。
- 新增跨模块路径：是（DurableSession → router → RemoteExecutionEnv → WSS → connector SDK env）。

## 验收标准

| 场景 | 预期 |
|---|---|
| 默认/存量对话 | SDK bash 与 workspace 行为不变，物理落 local |
| 对话选择 B | SDK bash 在 B 的设备工作区执行，hub 无同名产物 |
| string/argv/env/cwd | 与 NodeExecutionEnv 语义一致 |
| 流式输出 | stdout/stderr 按 actionId/sid 归路，output 不提前结算 |
| timeout/abort | 只杀目标进程组，分类为 timeout/aborted |
| v1 会话 | 六动作可用；shell/output/cancel 能力面关闭 |
| 重复 actionId | hub 拒重复登记；connector 已成功动作直接回记录结果 |
| 优雅下线/意外断线 | 分别 interrupted/unknown；旧 sid 晚到帧不复活 |
| 远程文件面 | 明确 not_supported，不静默写 hub |

## Verification

| 验证 | 结果 |
|---|---|
| `npx tsc --noEmit` | PASS |
| 远程机器/路由/DurableSession + connector dispatcher/shell/gateway/执行 e2e | 85 tests PASS |
| `npm run build:connector` + closure + 主仓 build | PASS |
| 全量测试与 lint | 待 rebase 后最终复验 |

## Rollback

Revert 本切片即可恢复 local-only SDK env 与协议 v1 行为。无数据库 schema
变更；已写 remote_action_requests/connector 台账保留为历史证据。回滚后远程
对话不再提供 bash 环境，本地执行路径不受影响。
