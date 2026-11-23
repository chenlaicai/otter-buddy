---
title: 显式附件上传与调度执行环境解耦（阶段 7 重实现）
id: F20261123rexec
date: 2026-11-23
created_at: 2026-11-23T11:10:00Z
created_in_conversation: 6af46649-f93f-4c5b-a6d2-245a4ed33e9f
module: session
change_type: feature
supersedes:
  - F20261123rattc
summary: |
  关闭 #1991 后按搭档职责纠偏重实现：保留设备/hub 文件经显式动作上传为
  中枢附件的能力；定时触发仍是云端调度机制，不存执行机字段、不预查设备
  在线状态。执行机只在工具执行环境中解析，离线由执行层 fail-closed，不回 local。
intent:
  problem: "#1991 把 targetMachineId 放在 scheduler 触发守卫中，但该字段并未参与工具路由，导致定时机制与执行机在线状态错误耦合，甚至可误挡云端 function executor"
  expected_effect: "设备文件可显式上传为中枢附件且 reader 全路径关闭；定时器无论执行机在线与否都按原机制唤醒海獭，实际工具动作按执行上下文路由并在目标不可用时明确报错"
  verify_by:
    type: behavior_check
    evidence:
      - "upload_device_file 本地/远端 env 字节一致落附件存储，错误与限制明确返回，成功/失败 reader 均关闭"
      - "scheduled_tasks 无 target_machine_id 迁移/DTO/UI，SchedulerService 无设备在线预查或 TargetMachineUnavailableError"
      - "既有远程执行离线测试继续证明 fail-closed，既有 scheduler 测试证明触发链不依赖设备状态"
capability_test: tests/interface-adapters/agent-runtime/tools/upload-device-file.test.ts
---

# F20261123rexec：显式附件上传与调度执行环境解耦

## 背景

搭档意图锚（原话）：

- 「定时触发应该只是云端海獭系统的机制而已……定时任务机制不应该跟执行机绑定。」
- 「定时任务的任务内容可以说要在哪个执行机处理什么事情……执行机更像是海獭调用工具执行时的一个执行环境参数的指定。」
- 「整理好需求之后，我建议你直接关闭1991然后重新实现。」

#1991 的 `targetMachineId` 只在 `SchedulerService.assertTargetMachineRunnable` 中校验对话绑定和设备在线，未传入真实执行路由；真正 env 由 DurableSession 按 conversationId 解析。守卫还位于 function executor 分支之前，会误挡只在云端运行的纯代码任务。因此旧方案不是“任务在 B 执行”，而是“B 离线则不唤醒任务”，职责层级错误。

意图确认：搭档上述原话及关闭重实现指令，已确认「保留显式附件上传、撤掉 scheduler 目标机绑定」的方向。本方案不沿用旧 Part B 的任何 schema/UI/守卫设计。

## 目标

- T1：设备或 hub 本地文件可经显式 `upload_device_file` 上传为中枢可寻址附件，复用既有附件存储、内容寻址去重、MIME/尺寸/kind 闸。
- T2：上传读取与 SDK coding face 共用对话执行环境；reader 在成功、读错、上传拒绝等所有出口显式关闭。
- T3：云端定时任务只负责何时触发、唤醒谁、交付什么任务及执行台账；不存执行机字段、不查询设备在线状态、不做目标机触发守卫。
- T4：执行机只作为工具动作的执行环境。定时器在设备离线时仍按原机制唤醒海獭；实际远程动作不可用时由执行层明确报错，海獭可报告或继续云端步骤，绝不静默回 local。

## 非目标

- 不新增 `scheduled_tasks.target_machine_id`、对应 DTO/UI、设备在线预查或 `TargetMachineUnavailableError`。
- 不解析自然语言猜目标机器，不新造任务级独立执行机覆盖字段。
- 不在本切片扩展 SDK read/write/bash 的 per-tool machine 参数；同一对话不同任务需要独立选机时，另行设计 invocation/tool 执行上下文覆盖。
- 不做设备盘自动同步、设备到设备传输、离线补跑、waiting 状态或 caption 透传。

## 未决问题

- **任务级独立选机是已识别的后续边界，不是本切片已交付能力。** 当前 SDK 工具（含新 upload）只按对话绑定解析执行环境；`ActionRunner.run(targetOverride?)` 的显式覆盖只服务 workspace 六动作调用方，并未成为 SDK read/write/bash/upload 的 per-tool 参数。任务正文可以表达机器意图，但要在同一对话中可靠实现不同任务使用不同机器，仍需后续 invocation/tool 执行上下文覆盖设计。本切片不做自然语言猜测，也不宣称已支持该能力。

## 方案设计

### Part A：显式附件上传

- 新增 `upload_device_file(filePath, originalName?, mimeType?)`，经 ToolContext 注入的 `resolveExecutionEnv(conversationId)` 取得当前对话执行环境。
- `filePath` 遵循 SDK coding face：设备绝对路径、`~/`、`file://`；不改变 `workspace_*` 管理面的 `resolveSafe` 沙箱。
- 通过 `openBinaryReader` 以 64KB 分块读取，`Readable.from(async generator)` 接既有 `AttachmentUploadService.upload`。
- 返回既有附件元数据（id/kind/originalName/mimeType/sizeBytes/sha256/filePath），由既有下载 API 和消息附件引用消费。
- reader 使用 try/finally 全路径关闭；close 错误不覆盖上传主结果/主错误。
- 不自动登记 linked resource、不自动同步目录；只有显式工具调用才复制设备文件到中枢附件存储。

### Part B：定时调度保持解耦（无生产代码改动）

- SchedulerService、scheduled task schema/repository/DTO/UI 全部保持 main 原样。
- 任务正文继续承载自然语言任务意图；实际执行位置由现有执行上下文决定：对话绑定，以及既有 ActionRouter 支持的显式 target override。
- 设备离线不是定时器触发条件。远程 env/动作在目标未注册、旧会话或离线时沿用 PR-A/B 的 fail-closed 错误，不回 hub/local。
- 不为了证明“未耦合”新增冗余 scheduler 分支或设备 mock；用 diff 边界、既有 scheduler 回归与远程执行离线测试共同验证。

## 影响范围

- 组合根与 ToolContext 增加上传服务/执行环境解析的窄口装配，tool-factory 注册新工具。
- 新附件工具与测试、特性文档随本 PR 合入。
- 定时任务实体、DB schema、SchedulerService、定时任务 Web UI 零变化。
- 中枢附件存储与远程执行协议零变化；复用 PR-B 的 binary reader。

## 风险与约束

- 显式上传会把设备字节复制到中枢；必须继续受既有 MIME/kind/尺寸闸限制，且只由用户可见的工具动作触发。
- 流式读取中断或上传失败时必须关闭远端 reader，防止 ReaderHandleTable 泄漏。
- 本地对话使用同一工具时读取 hub 本地文件，语义仍是显式复制为附件，不扩大 workspace 沙箱。
- 定时任务离线时可能得到执行失败而非旧 PR 的预触发 skipped；这是职责纠偏后的预期行为，台账必须来自真实执行链。

## 不兼容更新

无。无 DB schema 变更，无既有 API 行为破坏；#1991 未合入，无需迁移或兼容其字段。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 定时器与执行机 | 完全解耦，scheduler 无机器字段/在线守卫 | #1991 的 targetMachineId + 触发前 skip | 执行机是工具环境；旧字段不参与路由且误挡 function executor |
| 设备离线语义 | 执行层 fail-closed，海獭获得真实错误 | 调度器预查并不唤醒 | 保留海獭报告与处理云端步骤的能力，触发机制不被设备状态接管 |
| 文件上中枢 | 显式 upload_device_file | 默认同步设备目录 | 三层数据边界要求默认留在设备，避免隐式复制与权限扩大 |
| 上传存储 | 复用 AttachmentUploadService | 新建设备资源存储 | 既有附件已具备寻址、去重、安全闸与下载消费方，不造第二资源系统 |
| 任务级独立选机 | 本切片不新增 | scheduled task 持久化 target 字段 | 当前需求是职责解耦；独立覆盖应在 invocation/tool 上下文另案设计 |

### 机制识别检查点

命中「新增跨模块调用路径」：工具层 → 对话执行环境 → 附件上传服务。其余新增配置、状态生命周期、后台进程、信号格式、持久化字段、被记住的决策分支均不涉及；定时任务机制零新增。**B4 补充：新工具只是既有 env/reader/附件管线的新入口，跨模块路径是组合根接线，不新造存储、路由或资源生命周期，因而不是净新增底层机制。**

### 机制预算四问

① **谁需要它**：在执行机生成报告/图片/PDF 的用户与獭，需要把指定文件变成中枢可下载、可引用的附件；定时任务用户需要云端调度不被设备在线状态绑架。

② **失败后果**：没有显式上传时，用户只能手工搬设备文件，云端中枢无法寻址；若 scheduler 与设备绑定，设备离线会让纯云端任务也不触发，造成静默漏跑。reader 泄漏则会累积远端句柄并耗尽资源。

③ **后续机制**：上传输入可能不存在、超限、MIME 不符、流中断或句柄关闭失败，分别由既有附件闸、错误响应与 finally close 承担；远端 reader 数量由成功/失败回归监控。本方案不创造新的任务状态、配置或恢复机制。

④ **退役条件**：若未来统一资源系统提供同等显式上传、执行环境路由和句柄生命周期，并能完整接管附件下载/消息引用消费方，可删除本工具适配层；在此之前是长期能力承诺。scheduler 解耦无新增机制可退役。

### 机制提案准入三问

① **决策者变了么**：没有。用户/獭仍显式决定上传哪个文件、使用哪个执行环境；系统不替人决定同步、换机或跳过任务。

② **靠自觉还是靠守卫**：机械守卫优先——附件尺寸/MIME/kind、执行机注册/onlineSession、reader finally close 与测试；自然语言任务意图不做机械路由猜测。

③ **深潜成本降了吗**：是。附件元数据与既有下载/引用路径可追踪，执行错误发生在真实工具链，用户不必从 scheduler 的预触发 skip 反推哪台设备阻碍了唤醒。

P0 负面清单：不命中；无自动巡检、随机审计、产出限速、自动跳过或智能预审。

## 验证

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 本地显式上传 | 以本地 env 上传字节流 | 附件字节一致、中枢可寻址、存储持有副本 |
| 远端显式上传 | 以远端 env/binary reader 上传 | 字节一致、reader openHandleCount 最终为 0 |
| 上传失败收尾 | 注入读错/上传拒绝 | 工具明确报错，reader 仍关闭 |
| 既有安全闸 | 不存在/超限/不支持类型 | 明确错误，不生成越界附件 |
| 调度解耦 | diff + 搜索 scheduled task/schema/SchedulerService | 无 target_machine_id、设备在线预查或新错误类型 |
| 执行层离线 | 跑既有远程执行离线测试 | 目标不可用明确报错，不回 local |
| 全链回归 | tsc、ESLint、connector closure、Web build、smoke:boot、CI | 全绿；全新/存量库均可启动 |

最简实现检查：上传复用现有 AttachmentUploadService、PR-B binary reader 与组合根窄口，未新增存储、协议帧、DB 字段或后台机制；定时部分删除错误设计而非搬移，已过最简检查。

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/interface-adapters/agent-runtime/tools/upload-device-file.ts` | 新增 | 显式上传工具与 reader 生命周期 |
| `tests/interface-adapters/agent-runtime/tools/upload-device-file.test.ts` | 新增 | 本地/远端/错误/关闭回归 |
| `src/usecases/ports/agent-tools.ts` | 修改 | ToolContext 上传与 env 解析窄口 |
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | 修改 | 注册工具 |
| `src/app.ts`、`src/bootstrap/{platforms,types,usecases}.ts` | 修改 | 组合根装配 |
| `docs/features/2026/11/23/F20261123rexec-explicit-upload-execution-context.md` | 新增 | 需求、设计与验证 |
| scheduled task / scheduler / schema / Web | 不变 | 明确排除 #1991 Part B |
