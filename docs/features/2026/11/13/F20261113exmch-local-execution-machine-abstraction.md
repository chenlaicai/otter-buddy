---
id: F20261113exmch
title: 执行机抽象与内置 LocalExecutionMachine
doc_type: feature
summary: |
  落实 #1868 阶段 1：建立执行机注册、默认目标解析和统一工作区动作边界，
  让 pi-durable 文件/bash 工具及现有工作区工具共同复用 LocalExecutionMachine，本机行为不变。
change_type: feature
tags: [execution-machine, local, architecture, durable]
modules:
  - src/usecases/execution
  - src/usecases/ports/execution-machine.ts
  - src/frameworks/execution
  - src/frameworks/agent/durable-session.ts
  - src/interface-adapters/agent-runtime/tools/workspace-tools.ts
capability_test: "n/a: 纯 A 类执行路由重构，工具名称、参数和本机结果不变，无 LLM 参与决策变化"
created_in_conversation: 6af46649-f93f-4c5b-a6d2-245a4ed33e9f
created_at: 2026-11-12
intent:
  problem: "文件、bash 与工作区工具直接绑定服务进程所在机器，后续无法在不复制 Agent 的前提下路由到其他执行机"
  expected_effect: "组合根注册唯一 local 执行机；缺省与显式 local 均路由到同一实现，未知目标 fail-closed；真实 read/write/bash/workspace 行为保持可用"
  verify_by:
    type: behavior_check
---

# F20261113exmch：执行机抽象与内置 LocalExecutionMachine

## 背景

总控 issue #1868 已确认：「本机先行」「全程可用」，阶段 1 只做执行机抽象，不引入云端或远程依赖。
本方案不重写 pi-durable 工具，也不改变中枢领域工具的记忆、对话与定时任务路径。

## 目标

- T1：定义 `ExecutionMachine`、`ActionRunner`、工作区动作契约与目标解析入口。
- T2：组合根注册内置 `local` 执行机；未指定目标时只解析到 `local`，未知目标明确报错。
- T3：pi-durable 的 read/write/edit/bash 通过执行机创建的原生 `ExecutionEnv` 运行；workspace 工具通过统一动作入口运行。
- T4：现有工具名、参数、输出和文件位置不变，远程连接器、动作台账和恢复留待后续阶段。

## 非目标

不实现远程执行机、设备选择 UI、动作持久化、自动恢复、跨端文件同步；不把 memory、matters、scheduler 等中枢数据操作远程化。

## 方案设计

### 模块切分

- `src/usecases/ports/execution-machine.ts`：执行机、动作类型和路由接口；动作输入/输出采用判别联合与类型映射，避免调用方取得无类型结果。
- `src/usecases/execution/execution-machine-registry.ts`：注册、默认目标解析与动作转发；空目标使用默认 `local`，显式未知目标 fail-closed。
- `src/frameworks/execution/local-execution-machine.ts`：组合既有 `NodeExecutionEnv` 与 `NodeWorkspaceGateway`，不复制其实现。
- `durable-session.ts`：`Harness.env` 改由已解析执行机创建，继续让 SDK 自己执行 read/write/edit/bash。
- `workspace-tools.ts`：五个现有工具改为发送工作区动作，响应文本与安全边界保持原样。
- `src/app.ts` / `src/bootstrap/platforms.ts`：唯一组合根创建并注册 local，同一路由器注入 durable runtime 与工具工厂。

### 关键接口与核心数据结构

```ts
interface ActionRunner {
  run<K extends ExecutionActionType>(
    action: ExecutionAction<K>,
    targetMachineId?: string,
  ): Promise<ExecutionActionResult<K>>;
}

interface ExecutionMachine extends ActionRunner {
  readonly id: string;
  createExecutionEnvironment(cwd: string): ExecutionEnv;
}

interface ExecutionMachineRouter extends ActionRunner, ExecutionMachineResolver {}
```

`ExecutionAction` 首版只含现有 workspace info/list/read/write/delete 所需操作。`targetMachineId` 是路由入口参数，不加入本阶段工具 schema，因此模型可见契约不变。`ExecutionEnv` 继续由 pi-durable 定义，文件与 shell 的底层动作不在本仓另造一套协议。它不是本机专用句柄：其 `FileSystem`/`Shell` 契约明确允许不同 namespace/远程主机实现，未来 RemoteExecutionMachine 可返回远程 ExecutionEnv，而本地实现返回 NodeExecutionEnv。

### 设计取舍

| 取舍 | 决策 | 被否替代 | 理由 |
|---|---|---|---|
| 文件/bash 接入点 | 复用 pi-durable `ExecutionEnv`，由 LocalExecutionMachine 提供 | 包装或复制每个 SDK 工具 | 保留 SDK 的流式输出、超时、取消和 unsafe replay 语义，避免双执行路径 |
| 工作区接入点 | 显式、可判别的工作区动作经 ActionRunner | 把 WorkspaceGateway 继续直接注入工具 | 后续远程实现可翻译同一动作，本阶段仍直接复用原 gateway |
| 默认目标 | 注册表缺省解析 local，未知 ID 抛错 | 未指定时散落在各工具中隐式 new 本机实现 | 目标解析只有一个入口，误配置不会静默换机器 |
| 实例归属 | app 组合根注册并共享一个 registry | 每个 session 自行构造 local | 启动时完成内置注册，避免各路径目标集合漂移 |
| ExecutionEnv 接口位置 | 留在 ExecutionMachine，本地返回 NodeExecutionEnv | 另建仅本机可用的旁路接口 | pi-durable 将其定义为可移植 FileSystem + Shell，远程机同样可实现；无需为本机特设第二通道 |
| 动作实现穷尽 | LocalExecutionMachine 对动作联合做 never 穷尽检查 | 只靠调用方类型映射 | 新增动作而漏改本地实现时由编译直接失败 |

### 机制识别检查点

- 新增配置字段/枚举/开关：否（local 是固定内置 ID，不是用户配置）。
- 新增状态生命周期：否（注册表仅进程内装配，无运行态生命周期）。
- 新增定时任务/后台进程：否。
- 新增信号类型/消息格式：是（进程内 ExecutionAction 判别联合）。
- 新增持久化存储：否。
- 新增会被记住的决策分支：否（只有临时目标解析）。
- 新增跨模块调用路径：是（app → registry → durable/workspace tools）。

结论：命中消息格式与跨模块路径，属修法决策树④新增机制。既有机制内修、收窄或删除都无法建立目前不存在的执行机边界，因此选择④。

### 机制预算四问

1. **谁需要它**：#1868 已拍板的多执行机方向需要当前本机大獭/小獭先走稳定默认路由；后续阶段的 connector 与设备选择流程复用同一解析入口。
2. **失败后果**：若路由错误，用户会直接看到文件写错位置、bash 在错误机器运行或工作区不可用；若注册缺失或目标未知，本实现选择明确失败，不静默执行。
3. **后续机制**：动作类型可能与实现漂移、重复注册或默认目标缺失会导致工具失败；以类型映射、重复/缺目标测试和真实 durable 工具回归防守。未来新增动作必须同时补本地实现与行为测试，远程动作台账在阶段 3 处理，不在本阶段提前引入。
4. **退役条件**：若 pi-durable 原生 ExecutionEnv 与统一 ActionRunner 已被更直接的单一路由协议取代，且所有本机/远程调用方迁移且等价回归通过，可删除本注册表；远程能力落地本身不是退役条件。

### 机制提案准入三问

1. **决策者变了么**：没有。搭档仍拍板架构与合入，獭仍决定工具调用；本机制只决定动作在哪台已选执行机运行。
2. **靠自觉还是靠守卫**：类型映射、重复注册、未知目标、默认 local 与真实工具行为均可机械测试；「未来动作是否同步实现」由 never 穷尽检查 + 类型检查 + 异体审兜底。
3. **深潜成本降了吗**：是。组合根可看到执行机注册，路由接口可集中审查，真实 read/write/bash/workspace 验收可定位到单一出口。
4. **P0 负面清单**：未命中；不自动巡检、不替人审批、不自动跳过或重放。

### 重对抗门

2026-11-12 独立异体检视结论：**确认治本，允许实现继续**。检视逐项核实 ExecutionEnv 覆盖 read/write/edit/bash、工作区五工具边界、唯一本机实现创建点及 fail-closed 验收，无严重发现。

建议发现处置：

1. **部分接受**：保留 ExecutionMachine.createExecutionEnvironment；文档补充 ExecutionEnv 是可移植契约而非本机句柄，远程机可实现同一接口。依据为 pi-durable `dist/env/index.d.ts` 的 FileSystem/Shell 抽象。这样保留 SDK 单一路径，比新增本机旁路更好。
2. **接受**：实现加入 never 穷尽检查，让新增动作漏实现成为编译错误；仅保留口头类型检查承诺会更弱。
3. **接受**：模块路径已改为 `src/bootstrap/platforms.ts`。
4. **接受**：四问①已收紧为 #1868 已拍板方向，不把现况直注重构成品本身写成用户新需求。

## 影响范围

仅 Agent 工具执行装配。HTTP 工作区 API、记忆索引、文档同步与定时任务仓储不经过执行机路由；它们仍使用原有中枢/工作区用例。

## 风险与约束

- 不得改变 pi-durable unsafe 工具恢复策略；本方案只替换环境创建来源。
- 不得让 session 池跨 invoke 留存不同目标；本阶段只有固定 local，后续目标选择必须进入 session 配置重建条件。
- 不兼容更新：无用户可见不兼容；内部装配要求显式注入执行机路由器，防止悄悄回退到第二套本机路径。

## 验收标准

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 默认目标 | registry.run(action) | 由 local 完成，结果与直接 NodeWorkspaceGateway 一致 |
| 显式目标 | registry.run(action, "local") | 与缺省结果一致 |
| 未知目标 | registry.run(action, "ghost") | reject，且不执行动作 |
| 重复注册 | 注册两个同 ID machine | 第二次注册抛错 |
| 工作区行为 | 跑现有 workspace 工具测试及真实临时目录读写删 | 原响应与安全边界不变 |
| 文件/bash 行为 | faux 模型驱动真实 durable read/write/bash | 文件真实写入、命令输出和读取结果正确 |
| 本机回归 | build、lint、相关测试、完整 npm test、alpha 启动 | 全部通过；对话/记忆/定时任务装配无远程依赖 |

## 代码对抗审视处置

### 初轮建议 1：bootstrap 形参使用具体 Registry 类

**接受并修复。** 改成 `ExecutionMachineRouter` 端口让系统更好：组合根本来就同时需要 ActionRunner 与 ExecutionMachineResolver，显式组合端口既保留这两种能力，又与 DurableSession、PiSessionFactory、createTools 的端口注入对称；维持具体类没有额外收益。`ExecutionMachineRegistry` 实现该端口，`createAgentGateway` 改依赖端口。纯类型边界调整，无运行行为变化，build 与定向行为回归重验。

## Verification

| 验证 | 结果 |
|---|---|
| `npx tsc --noEmit` / `npm run build` | PASS；含 SDK patch 校验与 tsc-alias |
| 执行机与工作区专项 | PASS；默认/显式 local、未知目标零副作用、重复注册、工作区读写删 |
| 真实 durable 工具链 | PASS；faux 模型驱动真实 `write → bash → read`，文件内容、bash 输出和 read 结果均可观察 |
| durable 恢复相关回归 | PASS；含真实 SIGKILL 后 unsafe 工具不重放、session 重开、合成与换世 |
| `npm test` | PASS：472 files / 5999 tests |
| `npm run check` | PASS：build、lint、schema、全新/存量 DB 全栈装配、脚本与端口/探活检查 |
| `npm run lint:intent` / `lint:capability` / `lint:docs` | PASS；本 PR intent 1/1、capability_test 声明有效，输出仅存量豁免/警告 |
| alpha 真启动 | PASS：端口 3196 启动，Web `/` 200；无身份 API 401；声明式本机身份下 `/api/conversations` 200、`/api/health/memory` 200 且 healthy=true；验证后已停止实例 |
| GitHub CI | PASS：run 43204974197 的 check / guard-macos / e2e / golden-selftest 全绿（PR body 编辑事件）；首次 opened run 仅缺测试改动声明，已在 PR body 补齐；旧 rerun 固化旧 body 的失败记录不代表代码失败 |
| 旧路径清查 | PASS：`new NodeExecutionEnv` 仅存在于 LocalExecutionMachine；createAgentGateway 不再接受 WorkspaceGateway 直注；工具 schema 未改 |

最简实现检查：已通过。方案复用现有 NodeExecutionEnv、NodeWorkspaceGateway 与 SDK 工具，只新增路由/动作边界，不新增依赖；没有另写 shell、文件或工作区实现。

负面向核查：未改变工具名/参数/输出、本机文件位置、bash 安全门、single-writer/admission 或 durable unsafe replay 策略；真实 SIGKILL 回归证明既有恢复保护未被绕过。内部装配契约改为必须显式注入执行机路由器，属于防隐式回退的有意收紧，用户可见行为无不兼容。

## Discovered Issues

- alpha 真启动时发现独立的 RHI patrol 工作目录问题，已登记 #1869；与本 PR 执行机路由无关，本 PR 未修改该路径。
