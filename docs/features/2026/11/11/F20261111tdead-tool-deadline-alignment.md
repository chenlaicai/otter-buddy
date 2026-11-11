---
id: F20261111tdead
title: 工具显式执行预算与 per-event 硬兜底对齐
summary: 修复 bash 显式 timeout 被固定十分钟 per-event 墙钟提前 abort 的双预算冲突；只为合法 bash timeout 增加收尾裕量并设置总硬上限，wait 与其他工具保持原预算。
change_type: fix
capability_test: "n/a: 确定性事件计时与 abort 行为，由 A 类 fake-timer 回归验证，无 LLM 参与"
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
created_at: 2026-11-11
intent:
  problem: "bash 声明 1800 秒执行预算仍被外层固定 600 秒看门狗 abort；声明 600 秒时两层同时到期，工具无法正常返回自身超时结果。"
  expected_effect: "合法 bash timeout 决定外层执行预算并获 30 秒收尾裕量，最长不超过 1 小时加裕量；未声明或非法 timeout、wait 和其他工具保持 maxPerEventTimeMs；并行调用各自计时，真正超过硬 deadline 仍 abort。"
  verify_by:
    type: behavior_check
causal_links:
  - F20260729cbpt
  - F20260805cbpt
  - F20260928slan
tags: [circuit-breaker, timeout, bash, watchdog, parallel-tools]
modules:
  - src/frameworks/agent/circuit-breaker-helpers.ts
  - tests/frameworks/agent/circuit-breaker-tool-deadline.test.ts
---

# 工具显式执行预算与 per-event 硬兜底对齐

## 问题与预注册

- **X（预期根因）**：per-event 看门狗无条件使用 `maxPerEventTimeMs`，没有读取 bash 已声明的执行预算，导致正常长命令被提前 abort，同值预算发生压线竞争。
- **Y（成立证据）**：旧实现下，`bash(timeout=1800)` 在 600 秒触发 `circuit_break:event_timeout`；`bash(timeout=600)` 在工具可返回自身超时结果的同一时刻被外层 abort。
- **Z（反例方向）**：若事件未携带 bash 参数、SDK 已在进入看门狗前统一截止，或计时器已按工具预算装配，则不应在本层修复。

Issue #1838 的生产证据与当前代码均支持 X：事件同时携带 `toolName` 与 `args`，看门狗在 `tool_execution_start` 直接以固定 `maxPerEventTimeMs` 创建计时器。实际与预期一致。

## 设计取舍

### 模块边界与关键接口

只修改既有 `attachCircuitBreaker` 的事件计时计算，不新增跨模块调用、不改 `CircuitBreakerConfig`、不改 abort reason 或工具接口。核心数据仍是既有 `Map<toolCallId, timer>`；每次 start 根据该调用自己的工具名和参数计算 `eventTimeoutMs`，end 仍只清理对应 ID。

### 候选路径

- **采用：既有看门狗内对齐 bash 预算**。`timeout` 是有限正数时，外层预算为 `max(maxPerEventTimeMs, timeout * 1000 + 30_000)`，再 capped 到 `max(maxPerEventTimeMs, 3_630_000)`。这保留默认配置作为下限，也保留更大自定义配置的语义。
- **否决：只把全局固定值调大**。仍会误杀更长任务，同时推迟所有无响应工具的保护，未消除双预算。
- **否决：豁免 bash 或信任任意工具参数**。会失去真挂死兜底；`wait` 已有独立预算契约，不能借通用解析成为逃逸通道。
- **否决：不加收尾裕量**。工具自身 timeout 与外层同刻到期仍有 race，#1838 的 600 秒案例不能闭环。

30 秒裕量用于工具到时后的终止、结果封装和 `tool_execution_end` 送达；总硬上限为 1 小时加这 30 秒。SDK 在工具执行前会以 `coerce: true` 把数字字符串转为数字，而看门狗事件更早、携带原始 args，因此字符串先按同规则做数值转换再校验。`NaN`、Infinity、无法转换为有限正数的字符串、零、负数和缺失值均不延长预算。该校验只在运行时局部发生，不写配置或持久化状态。

### 机制识别检查点

逐项核对：不新增配置字段/枚举/开关；不新增状态生命周期；不新增定时任务或后台进程（仅既有调用内局部 timer）；不新增信号类型/消息格式；不新增持久化；不新增会被记住并影响后续行为的决策分支；不新增跨模块调用路径。**全部未命中**。

因此走修法决策树①，在既有 per-event 语义内修，`Modification-Class: narrow-fix`，采用轻对抗。最简实现检查：现有事件已有所需工具名、参数与独立 timer，只需一个局部预算计算函数，无需新依赖、配置或抽象层。

### 代价与旧保护

极端长命令最坏可占用一次 invoke 直到 1 小时硬上限，较旧固定 10 分钟更晚介入；这是支持显式长任务预算的直接代价，不写成收益。没有绕过看门狗：未声明预算的工具保持原阈值，显式 bash 也有总硬上限，并行工具不能互相清除计时器。旧契约中“固定 10 分钟覆盖所有 bash”被有意替换为“默认 10 分钟、合法显式预算可延长但有硬上限”；其余工具与 abort/retry 契约不变。

## 验收标准

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 1800 秒 CI watch | fake timer 推进超过 600 秒，再在 1800 秒发送 end | 600 秒不 abort，end 后不留计时器 |
| 600 秒工具自身超时 | 到 600 秒发送 end，模拟工具超时结果正常收尾 | 外层不压线 abort |
| 工具自身未收尾 | `bash(timeout=600)` 持续到 630 秒 | 达到执行预算后触发 `circuit_break:event_timeout` |
| 超大显式预算 | `bash(timeout=7200)` 持续到硬上限 | 3630000ms 前不 abort，到点仍 abort |
| 非逃逸通道 | `wait(seconds=3600)`、非法 bash timeout | 仍按原 `maxPerEventTimeMs` abort |
| SDK coerce 对齐 | 原始 args 使用 `timeout: "1800"` / `"not-a-number"` | 数字字符串不在 600 秒误杀；非法字符串保持默认预算 |
| 自定义配置组合 | `maxPerEventTimeMs` 分别取 900000、4000000、10000 | 配置下限不被工具预算缩短；大于通用硬上限时不被截短；较小配置可被合法工具预算加裕量延长 |
| 并行隔离 | 长 bash 与普通 read 并行，read 先 end | read 完成不影响 bash 预算，二者均不提前 abort |

## Verification

### 失败用例证据（bugfix）

修复前运行 `npx vitest run tests/frameworks/agent/circuit-breaker-tool-deadline.test.ts`：**7 个用例中 5 failed、2 passed**。1800 秒 bash 在 `600_001ms` 已收到 `circuit_break:event_timeout`；600 秒 bash 在自身可收尾的同一时刻被 abort；未收尾、硬上限与并行用例也都在 600 秒提前触发。两个控制组（wait 不延长、非法 timeout 不延长）按预期通过。失败发生在未改实现的测试首提交，断言未随修复调整。

### 对抗发现的红绿证据

独立检视指出数字字符串 coerce 错位后，在未改实现时新增 5 个用例并复跑同文件：**12 个用例中 1 failed、11 passed**。唯一失败是 `timeout: "1800"` 在 600001ms 被 abort；非法字符串与三个自定义 `maxPerEventTimeMs` 组合均通过。该失败证明发现成立，修复仅增加字符串数值转换，既有断言未改弱。

### 验证记录

- 初轮修复后聚焦回归：`circuit-breaker-tool-deadline.test.ts`、`circuit-breaker-helpers.test.ts`、`durable-runtime.test.ts` 与 `retry-policy.test.ts` 共 **4 文件、93/93 passed**；对抗处置后同组为 **98/98 passed**，其中 deadline 用例 12/12。真实 durable-runtime 的挂死工具看门狗仍触发原 abort reason。
- 初轮全量 A 类为 5878/5878；对抗处置后 `npm test` **458 文件、5883/5883 passed、0 failed、0 skipped**；pretest 全量 ESLint 同步通过。没有 pre-existing 失败声明。
- `npm run build` 通过；`lint:intent` 本 PR 文档 intent/verify_by 均为 1/1，`lint:docs`、`lint:tests`、`lint:criteria`、`git diff --check` 通过。lint 的既有存量 warning 未新增。
- 最简实现检查：只增加一个局部纯函数和两个实现常量，复用现有事件参数、Map 与 abort 链；无新文件级生产模块、新依赖、新配置或兼容桥，已达同等效果的最小改动。
- 负向契约核对：普通工具与 wait 不被延长；非法 bash timeout 不被延长；真正超过自身预算加裕量或总硬上限仍中断；并行 end 仍只清自身 timer。用户文案保持“单次工具调用超时”，日志记录实际生效预算，不把到期描述为已确认无响应。
