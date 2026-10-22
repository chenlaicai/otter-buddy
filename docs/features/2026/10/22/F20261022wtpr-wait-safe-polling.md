---
id: F20261022wtpr
title: wait 条件等待补安全轮询：单命令 until 在总预算内探活 + 守卫文案可达引导
summary: wait 的 until 原为先固定 sleep、醒后只检查一次，表达不了真实 CI/服务状态等待，獭退回 bash sleep/轮询又撞守卫。保留单命令、禁元字符、execFile 无 shell 的安全边界，在一次 wait 内立即探测并按固定间隔重试至就绪或 seconds 总预算耗尽；补 abort 清理与等 CI/服务/状态的引导。
doc_type: feature
change_type: fix
intent:
  problem: "F20260928slan 的 until 是固定等待后的单次苏醒检查；真实条件等待需要在预算内反复探活。until 又刻意禁止管道/复合命令，獭无法把 sleep N + 状态检查翻译为 wait，退回 bash sleep 后被守卫拦截，形成指路正确但无法跟随的 catch-22。"
  why_now: "2026-10-22 大獭根因排查与派工：guard_intercept×sleep_block 已积累同族现场；要求补既有 wait 表达力，而不是放开 until 的 shell 元字符。"
  expected_effect: "一次 wait(seconds, reason, until) 可完成等 CI 变绿/服务起监听/状态就绪；条件非零不立即结束，而在 seconds 总预算内重试；超时返回最后失败，abort 不留子进程或计时器；注入与进程终止命令仍在首次执行前拒绝。"
  verify_by:
    type: behavior_check
    note: "A 类单测覆盖 pending→ready、多次失败至预算耗尽、立即成功、轮询间隔 abort、注入拒绝及工具/守卫描述；真实子进程探针与全量 A 类回归另记验证节。工具描述属 B 类软代码，变更只提供可跟随指引，不把文本断言冒充 LLM 采纳率证明。"
capability_test: "n/a: 核心行为为确定性工具控制流，由 tests/interface-adapters/agent-runtime/tools/wait-tool.test.ts 验证；description 仅改引导，未新增需真 LLM 断言的协议"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
created_at: 2026-10-22
tags: [wait-tool, polling, bash-guard, sleep, timeout, abort-safety]
modules: [src/interface-adapters/agent-runtime/tools/tool-factory.ts, src/frameworks/agent/sleep-command-guard.ts, tests/interface-adapters/agent-runtime/tools/wait-tool.test.ts, tests/frameworks/agent/bash-sleep-guard.test.ts]
causal_links:
  - F20260928slan（sleep 工具化与 wait/until 既有安全边界；本特性补齐其终结轮询心智的未竟语义）
  - F20261019kbpc（sleep 文案的 until 单次探活示范；本特性同步为预算内轮询）
---

# wait 条件等待补安全轮询

## 根因与预注册

**预注册（按大獭已完成的根因排查继续，不把假设写成新事实）**：

- X：若 until 只是固定等待后的单次检查，则条件未就绪会立即返回，獭仍需手写下一轮等待。
- Y：若 until 能执行复杂 shell，则可通过放开管道/复合命令解决；但现有禁元字符是刻意防注入边界，此方向不可接受。
- Z：若 wait 本身缺少可中断的预算循环，则只改文案会制造新的不可跟随指引。

代码核对确认 X/Z：`runUntilCheck` 只执行一次；`execute` 先等待完整 seconds，再调用它。F20260928slan 的设计目标已经包含「终结轮询心智」，本次是补齐实现，不推翻原设计。

## 方案

### 条件等待语义

- 无 `until`：保持原有固定时长 `wait(seconds)`。
- 有 `until`：`seconds` 是**条件等待总预算**（5–560 秒），不是先睡满再检查。
- 立即执行第一次探测；exit 0 表示就绪并返回真实耗时与探测次数。
- 非零表示尚未就绪，每隔 10 秒再探测；不另增 interval 参数。
- 单次检查超时取 `min(30 秒, 剩余预算)`；预算耗尽返回最后一次退出码/stderr，不后台继续轮询。
- 保留 2KB 输出截断、原有 seconds 上限和 reason 回显。

示例：`wait seconds=120 reason="等 PR #1604 CI 变绿" until="gh pr checks 1604"`。这里描述的是工具参数语义，实际调用走结构化参数，不把示例字符串再交给 shell。

### 安全与资源边界

- `validateUntil` 原样复用：先过 bash 安全守卫与 kill 族拒绝，再拒绝管道、重定向、分号、引号、变量/命令替换等。
- 每次探测仍由 `execFile` 无 shell 直执；不把管道或复合命令交给 shell。
- `AbortSignal` 同时传给当前子进程与轮询计时器；中断、成功、超时路径都清理计时器。
- 复杂检查不裸放开：用命令自身退出码/过滤参数表达，或接受全量输出由獭判读。多 PR 聚合检查不是本特性承诺的表达面。

## 机制识别与 Modification-Class

机械清单按偏严口径判定：**命中「被记住的决策分支」**——wait 工具 description 与 sleep 守卫文案现在明确引导「等 CI / 服务 / 状态用 until，一次调用内轮询」。

其余项：不新增配置字段（10 秒间隔为实现常量）；不新增持久化状态生命周期或定时任务（仅既有同步工具调用内的局部计时器，非 scheduled task）；不新增信号格式、持久化或跨模块调用路径（wait 与守卫既有指向关系不变）。

因此仍判修法决策树①、**Modification-Class: narrow-fix**：这是既有 wait/until 同一参数契约、同步调用生命周期与安全边界内的能力补全；命中的仅是软代码行为分支说明，不构成净新增系统机制。采用轻对抗，由大獭另召异模型检视獭审视，实现者不自审、不合自己的 PR。

## 验收标准

| 场景 | 预期 |
|---|---|
| until 第一次 exit 0 | 立即返回，不先睡满 seconds |
| pending、pending、ready | 一次调用内探测 3 次，返回真实耗时与成功输出 |
| 持续非零 | 在 seconds 总预算内停止，返回最后退出码/stderr，不留计时器 |
| 轮询间隔收到 abort | promise 中断，无下一次探测，无残留计时器 |
| 管道/命令替换/kill 族 | 首次执行前拒绝；原安全用例继续通过 |
| 无 until | 固定时长等待行为与 reason 回显不变 |
| 工具与守卫描述 | 明确等 CI/服务/状态的 until 路径与轮询/超时语义 |

## 验证

- `npm test`：最终代码全量 416 文件，6678 passed、6 skipped、0 failed；pretest 全量 ESLint 通过。
- `npx tsc --noEmit` 与 `npm run build`：通过。
- 聚焦测试：`wait-tool.test.ts` + `bash-sleep-guard.test.ts` 共 25 用例通过；含立即成功、第三次成功、预算超时、两种 abort 时序、命令替换拒执行与描述引导。
- 真实构建产物探针（非 mock，临时脚本位于对话工作区）：`test -f <就绪文件>` 第 3 次探测/20047ms 成功；持续未就绪 5003ms 停止；阻塞 `tail -f /dev/null` 在 5004ms 预算停止；管道注入首次执行前拒绝；轮询间隔 abort 104ms 返回 AbortError。
- 自检捕获并修复：初版只向 execFile 传 AbortSignal，模拟阻塞子进程不回调时 promise 仍挂起；新增「执行中 abort」用例先红，随后在工具边界加入 abort race，真实/模拟两种时序均通过。
- B 类验证限制：`sleep-announce.capability.test.ts` 与 Golden Gate 已实际启动，但本机未配置 LLM 端点，分别 1 skipped、10 skipped；不记为行为通过。A 类与真实探针不依赖 LLM，其结果有效。
- pre-existing 失败声明：无（最终全量 0 failed），无需也无权虚构基线对照。

## 影响与已知限制

- 等 CI 是否成功仍取决于 `until` 命令的退出码语义；wait 不解析 CI JSON，也不猜测 pending 文本。
- 固定 10 秒间隔是简单、有界的默认实现，不承诺 backoff 或自适应轮询。
- 单次外部命令可能在超时信号后存在操作系统级退出延迟；本特性通过 execFile timeout + AbortSignal 发起终止，不把它描述为强杀整个进程树的能力。
