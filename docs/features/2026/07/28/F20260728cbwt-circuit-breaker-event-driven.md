---
id: F20260728cbwt
title: circuit-breaker-event-driven
doc_type: feature

summary: |
  熔断器从「时间驱动」改为「事件驱动两档制」，根治 steer 死线误杀：
  移除 steer 后 30s wall-clock 强杀定时器（事故：对话 t002，大獭已纠正行为仍被杀），
  改为「首次触发规则 → steer 警告；警告后继续触发满 maxRepeatAfterWarning（默认 5）次
  → terminate 当场中断；中途任何一次正常调用（allow）即解除警告状态」。
  同时修复「连续相同」判据过粗：同名工具不再一律算重复，改为行为签名
  （bash 取命令词并穿透 sudo/time/env 包装与 -C 等带值 flag；read 取目标路径；
  edit/write 取路径+内容指纹），排查式工作序列与同文件连续重构编辑不再误报。
  顺带修复：force abort 携带 circuit_break:<trigger> 原因，且用户侧呈现熔断专属
  文案「检测到工具调用异常循环」（此前一律 internal_abort →「输出异常」，
  把熔断器误杀伪装成模型输出退化）。

causal_links:
  from:
    - F20260716bte2   # agent-circuit-breaker（初版设计，steer 死线 B-5b 来源）
    - F20260728cbtf   # 工具名字段修复（同一起事故的第一次修复，遗留死线语义缺陷）
    - F20260727guard  # OutputGuard（接管时间维度的挂死保护）

status: final
change_type: fix
tags: [circuit-breaker, steer, incident-fix, event-driven, tool-signature]
modules:
  - src/frameworks/agent/tool-call-circuit-breaker.ts
  - src/frameworks/agent/circuit-breaker-helpers.ts
  - src/frameworks/agent/pi-session-factory.ts
  - src/frameworks/config-service.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - config/config.yaml.example
  - tests/frameworks/agent/tool-call-circuit-breaker.test.ts
  - tests/frameworks/agent/circuit-breaker-helpers.test.ts
  - tests/interface-adapters/agent-invoker.test.ts

created_at: 2026-07-28
---

# F20260728cbwt 熔断器事件驱动两档制改造

## 术语定义

| 术语 | 定义 |
|------|------|
| **行为签名（signature）** | 「连续相同」的判据。bash → `bash: <命令词序列>`（如 `bash: git commit`，忽略参数）；read/write/edit → `<工具>: <目标路径>`；其他工具 → 工具名 |
| **steer 警告** | 触发规则时向对话注入的纠正提示（如 `Consecutive identical call "..." N times. Break the pattern.`） |
| **steer strike** | 自上次 allow 以来连续 steer 的次数；任何一次 allow 即清零 |
| **两档制** | 首次触发规则 → steer；strike 超过 `maxRepeatAfterWarning`（默认 5）→ terminate |
| **steer 死线（已移除）** | 旧机制 B-5b：steer 后 30s wall-clock 定时器到点强杀。配置键 `steerTimeoutMs` 同步移除，由 `maxRepeatAfterWarning` 取代 |

## 事故现象

2026-07-28 19:11（本地），对话 **t002** 中搭档让大獭继续此前被中断的任务（确认 package-lock.json diff 并提 PR）。19:13:38，大獭再次被强制中断，日志：

```
19:13:38 [circuit-breaker] Steer timeout: otter=0710b3b0-… — force aborting after 30000ms
19:13:38 [circuit-breaker] CIRCUIT_BREAK: trigger=steer_timeout calls=11 history=[bash,bash,bash,bash,bash,bash,bash,read,read,read,read]
19:13:38 Agent invocation error: "[output-guard] internal_abort" isAbort=true
```

关键事实（session 转录逐条核对）：

1. 大獭连击 7 次 bash，但**每条命令都不同**（git status / git commit / git branch / git checkout / cat / ls）——这是正常的排查式工作序列，不是死循环。
2. 第 6、7 次 bash 触发 steer 警告后，大獭**当场纠正**：改用 read 读 `.githooks/commit-msg`，已看懂 commit 模板 regex，离正确提交只差一步。
3. 30 秒死亡定时器照常在 19:13:38 触发，把正在恢复中的健康调用杀掉。

同一起事故在当天 17:09（PR #99 修复前）已发生过一次，触发路径完全相同（steer_timeout）。PR #99 修掉了工具名误记为 `unknown` 的字段 bug，但死线语义缺陷原样保留，重启后复现。

## 根因分析

### 根因一：steer 死线是「只上膛不卸弹」的定时器

旧实现中，每次 steer 都会调用 `setSteerDeadline` 武装一个 30s `setTimeout`，到点无条件 `forceAbort`。而 `clearSteerDeadline` 全项目**只在 invoke 结束的 finally 里调用**（pi-session-factory.ts）——「agent 已纠正行为」这个事件没有任何人监听。惩罚的正是 steer 想诱导的行为：agent 听从警告、停止连击、转入排查/长文本生成时，没有新的工具调用，定时器照样到点杀人。

（PR #99 的 F20260728cbtf 文档已将此记录为遗留问题 #1，本次按搭档拍板的方案根治。）

### 根因二：「连续相同」判据过粗，警告本身是误报

旧 `updateConsecutive` 只看工具名：所有 bash 调用归为一类，「连续使用 7 次终端」即判为死循环。但 bash 是通用工具，是否重复必须看**干什么**，不能只看**用什么**。大獭的 7 次 bash 是 7 条不同命令，任何真人开发者排查问题都是这个节奏。

### 误杀放大链

判据过粗（误报 steer）→ 死线不卸弹（纠正也死）→ abort 无原因（`internal_abort`，前端呈现为「输出异常，已自动中断」，把熔断器误杀伪装成模型输出退化）。三个缺陷串联，任意一个修好都能避免本次事故；本次修复前两个 + 第三个。

## 变更

### 设计：事件驱动两档制

搭档拍板的范式（与既有 `checkToolCallLimit`「到限 steer、超硬顶 terminate」同款，全规则体系统一）：

```
首次触发规则 → steer 警告（无定时器、无副作用）
警告后继续触发规则 → 每次记 1 个 strike
strike > maxRepeatAfterWarning（默认 5）→ terminate，当场中断流
中途出现任何一次 allow → strike 清零，警告状态解除
```

- **恢复自动生效**：agent 换了命令/工具，下一次 check 返回 allow，strike 清零。不存在「需要有人取消倒计时却没人取消」的状态，误杀在结构上不可能发生。
- **杀的依据是行为事实**：「观察到警告后第 N 次重复」而非「时间到了」。快循环时 30s 能烧几十次调用，计数制反而更省 token。
- **时间维度保护不缺位**：agent 不调工具也不输出的干挂，由 OutputGuard 的 `streamingTimeoutMs`（F20260727guard）负责。分工干净：熔断器管行为模式，OutputGuard 管时间。
- **模式跳跃公平性**：agent 被警告后换一个新循环，新循环的前几次调用是 allow（strike 已清零），重新享受「先警告」待遇；A-B-A-B 交替循环仍由滑动窗口检测兜底。

### 签名判据（`buildToolSignature`）

| 工具 | 签名 | 效果 |
|------|------|------|
| bash | `bash: <每段命令词，分发器带子命令>` | `git commit -m a` 与 `git commit -m b` 相同（真卡壳抓得住）；`git status` 与 `git commit` 不同（排查不误报）；`cd /x && git add y && git commit` → `cd \| git add \| git commit`；穿透 `sudo`/`time`/`env`/`nice`/`watch` 包装层，跳过 `-C`/`-c`/`--git-dir` 等带值 flag（`git -C /repoA status` 与 `git -C /repoB commit` 不塌缩） |
| read | `read: <路径>` | 反复读同一文件才算循环 |
| edit/write | `<工具>: <路径>#<内容指纹>` | 同一文件的不同编辑是正常工作（重构连续编辑 10 次不误报）；同一编辑反复重试、同内容反复重写才是卡壳 |
| 其他 | 工具名 | speak 刷屏等仍能抓住 |

bash 命令词提取规则：按 `&&`、`||`、`;`、`|`、换行切段；跳过前导 `VAR=val` 赋值与包装层；取真实命令词（去路径前缀）；属于分发器集合（git/gh/npm/npx/docker/kubectl/…）时取第一个非 flag 词为子命令，带值 flag 连值跳过。

### 代码

- **tool-call-circuit-breaker.ts**：新增 `buildToolSignature`；`check(toolName, args?)` 按签名累计连续计数；新增 `steerStrikes` 状态与两档升级逻辑；删除 `steerDeadline`/`setSteerDeadline`/`clearSteerDeadline`/`checkSteerDeadline` 及未被读取的 `steered` 字段；terminate 结果携带 `trigger`。
- **circuit-breaker-helpers.ts**：事件 `args` 透传给 `check`；steer 后不再武装死线；terminate 时 `doAbort("circuit_break:<trigger>")` 传递真实原因（修掉遗留问题 #2：此前一律 `internal_abort`）。
- **pi-session-factory.ts**：finally 中移除 `clearSteerDeadline()` 调用（方法已不存在）。
- **config-service.ts / config.yaml.example**：配置键 `steerTimeoutMs` → `maxRepeatAfterWarning`（默认 5）。

### 新旧术语/配置映射（全局排查结论）

| 旧 | 新 | 说明 |
|----|----|----|
| `steerTimeoutMs`（配置键） | `maxRepeatAfterWarning` | 语义从「时间」变「次数」，无兼容桥（项目规约：新设计即当前设计） |
| steer 死线 / B-5b | steer strike 两档制 | 机制已删除，历史文档（F20260716bte2、F20260717yngs）为日期快照，不回改 |
| `internal_abort`（熔断 abort 原因） | `circuit_break:<trigger>` | trigger ∈ `tool_call_limit` / `consecutive_identical`（经 ignored_steer）/ `timeout` / `ignored_steer` |

## 设计决策（拍板史）

1. **移除 30s 强杀 vs 纠正时清除定时器**：搭档提出并拍板移除，改事件驱动两档制。理由：定时器方案的本质缺陷是「恢复事件无人监听」，补丁式 clear 只是治标；计数制让恢复在结构上自动生效。
2. **判据带参数签名**：搭档指出 bash 是通用工具，不能按工具名判重复。签名只取「行为」（命令词/路径），忽略参数值，保证同一命令换参数重试仍算卡壳。
3. **strike 全局记 + allow 清零，而非按签名维度各自记**：讨论中曾倾向按签名记警告（每个新循环重新享受先警告待遇）。实现时发现 allow 清零天然达成同样效果——新循环的前几次调用本来就是 allow，strike 已复位；全局计数还能覆盖滑窗 steer 的升级路径。两种方案效果等价，取实现更简者。
4. **挂死保护归 OutputGuard**：移除死线后「agent 不调工具也不输出」的场景由 `streamingTimeoutMs` 覆盖，职责本就重复，删除后分工更清晰。

### 对抗审视轮（独立 agent 审视 → 搭档逐题拍板）

初版实现经独立 agent 对抗审视，发现 3 个应修项，全部按拍板修复：

5. **同文件连续 edit/write 误杀（拍板：签名加内容指纹）**：审视发现签名只取路径时，重构场景对同一文件连续编辑 11 次仍会被杀。edit/write 签名加内容指纹（edit 取 edits 数组 oldText/newText、write 取 content 的 djb2 摘要）：不同编辑不算重复，同一编辑重试仍算卡壳。read 保持路径签名（反复读同一文件确实可疑）。
6. **`git -C` / `sudo` 塌缩误报（拍板：穿透包装+跳过 flag）**：`git -C /repoA status` 与 `git -C /repoB commit` 曾被判为相同行为。签名提取穿透 sudo/time/env/nice/watch 包装层，跳过 `-C`/`-c`/`--git-dir`/`--work-tree`/`--namespace`/`--exec-path` 等带值 flag 及其值。
7. **用户侧文案只修了一半（拍板：加专属文案）**：`circuit_break:*` 原因虽进了日志，但 buildAbortBody 兜底仍呈现「输出异常」。wrapInternalAbort/成功路径按归因打 `[circuit-breaker]` 前缀，buildAbortBody 对该前缀返回「[系统保护] 检测到工具调用异常循环，已自动中断。」，熔断 abort 不再伪装成 OutputGuard。
8. **审视提出但拍板不做的项**：文档措辞降温、`tokenWarningThreshold` 死键接配置、`"warn"` action 与 `stageId` 死代码清理——搭档决定不在本 feature 内处理，留作后续观察项。

审视确认无阻断缺陷的维度：两档制方向（比旧机制严格更宽容）、滑窗兜底有效性、跨规则 strike 语义、limit 硬顶与 ignored_steer 的先后关系（硬顶永远先触发）、abort 原因传递链路完整性。

## 测试

- 签名单测 10 个：命令词提取、子命令区分、复合命令切段、环境变量/路径前缀、包装层与带值 flag 穿透、write 内容指纹、edit 编辑指纹、退化兜底
- 行为测试 8 个：不同命令 bash 连击不 steer（t002 现场复现）、同一命令重试累计、同文件不同编辑不杀（重构场景）、同一编辑重试杀、steer 后纠正不升级、警告后满 N 次 terminate、滑窗 steer 升级 terminate（全局 strike 跨规则路径）、跨规则 strike 累计
- helpers 集成测试：SDK 事件带 args 驱动、三种 terminate 的 abort 原因（`circuit_break:ignored_steer` / `tool_call_limit` / `timeout`）、无死亡定时器（纠正后大量调用不 abort）
- agent-invoker 回归：circuit_break abort 呈现熔断专属文案
- 删除 4 个死线相关旧测试（机制已移除）
- `npm run check`（lint + tsc）通过；`npx vitest run` 全量 626 个测试通过
