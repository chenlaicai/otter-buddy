---
title: 附件显式上传与定时任务目标执行机（阶段 7 PR-C）
id: F20261120rattc
date: 2026-11-20
module: session
change_type: feature
summary: |
  落实 #1868 阶段 7 PR-C：设备侧文件只能经显式动作上传为中枢可寻址副本
  （新工具 upload_device_file 经对话执行机 env 流式读出，复用既有附件存储
  与 MIME 校验/去重/尺寸闸，不新造资源系统、不默认同步设备盘）；定时任务
  可声明目标执行机（target_machine_id），执行前再查注册中心/在线会话，
  目标未注册/离线/绑定漂移时 execution 记 skipped 显式留痕，绝不静默落到
  hub/local；恢复走既有 claim/admission 单写者，重新上线不补跑旧触发。
intent:
  problem: "PR-B 后远程编码面已通，但三层数据边界缺两条产品语义：设备产物无显式上中枢通道（要么留在设备要么靠人搬）；定时任务不知道该跑哪台机器，目标离线时无明确非执行语义、有静默落到本地的风险"
  expected_effect: "獭一条工具调用即把设备文件变为中枢可寻址附件（字节一致、去重、尺寸/MIME 闸沿用）；带目标机的定时任务在目标离线时明确 skipped 留痕、不计熔断、不落本地；重上线后下一次 tick 正常触发，无重放无补跑；不带目标的存量任务与本地链路行为零变化"
  verify_by:
    type: behavior_check
    evidence:
      - "upload_device_file 工具测试：本地/远端 env 字节一致落附件存储、超限与不存在明确报错、中枢可寻址"
      - "scheduler 守卫测试：离线/未注册/绑定漂移/端口缺失 fail-closed 四类 skipped + 不计熔断 + once 有界重试链转 error"
      - "目标在线时正常执行；无 target 任务走原路径（存量用例全绿）"
      - "迁移幂等：老库 PRAGMA 探测补列，新库 schema 直建"
capability_test: "tests/usecases/scheduler/scheduler-target-machine.test.ts"
---

# F20261120rattc：附件显式上传 + 定时任务目标执行机

## 背景与边界

三层数据边界（拍板）：本机 artifacts / hub workspace / 执行现场 workspace 各归其位；
远端会话不默认上传附件或构建产物；任务侧只做调度与恢复，不扩大权限。
PR-B 已把 SDK 文件面打通（binary file.read / 读器句柄）；PR-C 补两条产品语义：

1. **设备 → 中枢的显式上传通道**（新增接口，不是协议新帧）
2. **定时任务目标执行机**（声明 + 执行前再校验 + 离线不跑）

## Part A：upload_device_file 工具（显式上传）

**通道**：新 agent 工具 `upload_device_file`，挂在 tool-factory（与 artifact 工具同族）。

- 入参：`filePath`（SDK coding face 语义——设备绝对路径 / `~/` / `file://`，
  与 DurableSession 给 SDK 的 env 同一解析通道，不碰 workspace_* 的 resolveSafe 管理面）、
  `originalName?`、`caption?`、`mimeType?`（声明值仅供嗅探参考，服务端 sniff 说了算）。
- 执行：按当前 invoke 的对话执行机解析 env（`resolveForConversation` → 机器 → session → env，
  与 pi-session-factory env 工厂同链路）；`openBinaryReader` 64KB 分块流式读出，
  `Readable.from(async generator)` 接入既有 `AttachmentUploadService.upload`——
  内容寻址落盘 + sha256 去重 + MIME 双路径校验 + 尺寸上限全部复用，不重造存储。
- 返回：attachment 元数据（id/kind/sizeBytes/sha256/originalName/filePath），
  中枢可寻址（下载 API 与消息附件引用既有通路）。
- 本地对话（env=hub 本地）同样可用——显式动作把 hub 磁盘文件复制为可寻址附件，语义一致。
- **不做的**：不自动同步设备目录、不自动登记 linked_resource（需要时显式
  create_linked_resource 指 attachment URL）、不做设备到设备传输（无产品面）。

## Part B：定时任务目标执行机

### 数据与契约

- `scheduled_tasks.target_machine_id TEXT NULL`（schema.ts 直建 + PRAGMA 探测幂等迁移 +
  mapper/repo 贯通）。NULL = 现状（按对话绑定解析），存量行为零变化。
- 创建/更新校验（manage-scheduled-task，输入校验层）：
  - 设备必须在注册中心存在（否则 400「未注册设备」）；
  - 对话当前执行机绑定必须等于 target（否则 400「先在该对话选择执行机」）。
- API/UI 贯通：create/update DTO + ScheduledTaskDTO 投影 + Modal 选择器
  （选项来自 `/api/execution-machines`，默认当前对话绑定机）+ Section 列表展示。

### 触发守卫（scheduler-service.claimAndValidateTask，对话活性检查之后）

任务携带 target 时，执行**前**再查（不依赖创建时刻状态）：

1. 对话绑定仍 === target？绑定漂移 → skip（fail-closed，不静默在别处跑）。
2. 设备在注册中心？未注册 → skip。
3. 设备有在线会话（online_sessions）？离线 → skip。
4. 注册中心端口未注入（旧装配/降级）而任务带 target → skip（fail-closed）。

四条统一走 `TargetMachineUnavailableError`：execution 记 `skipped` + 显式
errorMessage（含机器与原因）、不计 consecutiveFailures、不触发连败熔断、
**绝不落到 hub/local**。catch 链与锁冲突/闸门拦截同族（skipped 落账后 rethrow；
once 任务因此进入既有有界重试链，耗尽转 error + 有声通知——消灭静默死亡）。

### 恢复语义（拍板）

- **不重放不补跑**：skipped 触发即翻篇（claimTask 已刷新 last_triggered_at），
  重新上线不触发任何回填；下一次 cron tick 走正常 claim/admission 路径
  （乐观锁 + running execution 互斥 = 既有 single-writer），旧触发不盲重放。
- 选 `skipped` 而非新造 waiting 状态的理由：现有状态机里 skipped 的语义正是
  「环境不可用/并发冲突，非任务失败」（锁冲突、闸门拦截、看门狗放弃同族）——
  状态集、迁移矩阵、熔断计数、面板渲染全部零改动；waiting 会引入新状态集 +
  消费语义 + UI 渲染 + 恢复路径一整套，超出「最小一致」。

## 验收

- 上传字节一致 / 中枢可寻址 / 超限与不存在报错 / 远端 loopback 全链路。
- scheduler 守卫四类 skip + once 重试链 + 在线正常执行 + 无 target 零变化。
- tsc / eslint / 目标 vitest 全绿；`npm run build:connector` + 闭包闸 +
  anchor-discipline 过。
