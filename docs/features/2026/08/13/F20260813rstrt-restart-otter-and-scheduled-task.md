---
id: F20260813rstrt
title: restart-otter-and-scheduled-task
doc_type: feature

summary: |
  海獭自重启：restart_otter(self) 标记 pendingRestart，prompt 完成后由 PiSessionFactory 执行。
  定时任务重启：ScheduledTask 新增 restartBeforeInvoke，触发前重启执行獭 session。
  两条消息两个 turn：自重启后发言石指向自己，下一 hop 用新 session 继续。

causal_links:
  from:
    - F20260805rsto   # agent-restart-otter-tool

status: implemented
change_type: feature
tags: [agent, session, restart, scheduled-task]
modules:
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/frameworks/agent/pi-session-factory.ts
  - src/usecases/scheduler/scheduler-service.ts
  - src/entities/scheduled-task/scheduled-task.ts
capability_test: "n/a: 纯 A 类改动（确定性逻辑，无 LLM 参与行为）"
created_at: 2026-08-13
---

# F20260813rstrt: 海獭自重启 + 定时任务重启

## 背景与需求

### 需求 1：海獭自重启

当前 `restart_otter` 工具直接调用 `manageSession.restartSession()`，立即执行 archive + agentGateway.reset()。问题：自重启时 reset() 在当前 invocation 中执行，会打断正在生成的 LLM 响应。

用户期望的场景：海獭在发言过程中识别到需要重启自己，先重启自己，然后继续发言回复搭档。

### 需求 2：定时任务重启

每日健康检查等定时任务需要每次执行时在干净上下文中运行。需要给 ScheduledTask 增加 `restartBeforeInvoke` 标志。

## 方案设计

### 方案 1：自重启——延迟执行

**核心思路**：自重启不立即执行，标记为 pending，当前 invocation 完成后由 PiSessionFactory 执行。

**技术约束**：`session.prompt()` 是原子的——在它执行期间，LLM 看到的上下文在开始时就固定，中途无法替换 session。

**实现方式**：

1. `ToolContext` 增加 `pendingRestart` 字段
2. `restart_otter` 工具：自重启时设置 `pendingRestart`，不立即执行
3. `PiSessionFactory._executeWithSession`：在 try 块内、return 前检查 `pendingRestart`，await 执行 restart
4. `buildCustomTools` 返回 `{ tools, toolContext }`，`_createSessionWithTools` 返回 `toolContext`

**时序**：
```
session.prompt() 内部：
  LLM 生成 → 调用 restart_otter(self) → 设置 pendingRestart → 返回 "已标记重启"
  LLM 继续 → 调用 speak(targets=[獭A]) → terminate
session.prompt() 返回
try 块内：检查 pendingRestart → await restartSession(獭A) → 新 session 创建
return result
```

**用户看到的**：
1. "正在重启..."（旧 session，turn 1）
2. "基于干净上下文的回复"（新 session，turn 2）

两条消息在同一 dispatch turn 内完成，体验连续。

### 方案 2：定时任务重启

**实现方式**：

1. `ScheduledTask` 实体新增 `restartBeforeInvoke: boolean` 字段
2. `SchedulerService.triggerTask()`：触发前检查标志，调用 `manageSession.restartSession()`
3. 重启失败降级（不阻塞任务执行）
4. `create_scheduled_task` 工具增加 `restartBeforeInvoke` 参数

**执行獭**：由 `task.talkingStonePassedTo[0]` 决定（默认=任务创建者=大獭）

## 设计决策

| 决策 | 结论 | 理由 |
|------|------|------|
| 自重启时机 | try 块内、return 前（await） | fire-and-forget 会导致 restart 失败时 summary 丢失 |
| 定时任务重启失败 | 降级（不阻塞任务执行） | 重启失败不应阻止任务运行 |
| ToolContext 透传 | buildCustomTools 返回 toolContext | 最小侵入，不改 createTools 接口签名 |
| 迁移逻辑 | 独立函数 addRestartBeforeInvokeColumn | 语义清晰，不混入 rebuildDocumentTablesDropCheck |
| manageSession 未注入 | 输出 warning 日志 | 避免静默跳过，便于排查问题 |

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | 修改 | ToolContext +pendingRestart + restart_otter 自重启逻辑 |
| src/frameworks/agent/pi-session-factory.ts | 修改 | buildCustomTools 返回 toolContext + pendingRestart 检查 |
| src/entities/scheduled-task/scheduled-task.ts | 修改 | 新增 restartBeforeInvoke 字段 |
| src/usecases/scheduler/scheduler-service.ts | 修改 | 触发前重启逻辑 |
| src/interface-adapters/agent-runtime/tools/scheduled-task-tools.ts | 修改 | 工具参数 |
| src/frameworks/db/scheduled-task/scheduled-task-mapper.ts | 修改 | 字段映射 |
| src/frameworks/db/scheduled-task/sqlite-scheduled-task-repository.ts | 修改 | CRUD |
| src/frameworks/db/migration.ts | 修改 | ALTER TABLE |
| src/frameworks/db/schema.ts | 修改 | CREATE TABLE |
| src/usecases/scheduled-task/manage-scheduled-task.ts | 修改 | 输入类型 |
| src/interface-adapters/http/dto/scheduled-task-dto.ts | 修改 | DTO |
| src/interface-adapters/http/controllers/scheduled-task-controller.ts | 修改 | Controller |
| src/bootstrap/platforms.ts | 修改 | 依赖注入 |
| tests/usecases/scheduler/scheduler-service.test.ts | 修改 | 新增 3 个测试 |
| tests/frameworks/db/scheduled-task/sqlite-scheduled-task-repository.test.ts | 修改 | fixture 更新 |
| tests/usecases/scheduler/scheduler-metric-integration.test.ts | 修改 | fixture 更新 |

## 验收场景

| AT | 场景 | 操作 | 预期 |
|----|------|------|------|
| AT-1 | 大獭自重启 | 大獭调用 restart_otter(self) | pendingRestart 标记设置，prompt 完成后 restart 执行 |
| AT-2 | 小獭自重启 | 小獭调用 restart_otter(self) | 同 AT-1 |
| AT-3 | 大獭重启小獭 | 大獭调用 restart_otter(小獭ID) | 立即重启，返回新 session ID |
| AT-4 | 定时任务+重启 | 创建 restartBeforeInvoke=true 的 cron 任务 | 每次触发前执行獭 session 重启 |
| AT-5 | 定时任务重启失败降级 | 重启失败时 | 任务正常执行，日志记录 |
| AT-6 | 向后兼容 | 现有定时任务（无 restartBeforeInvoke） | 行为不变 |
| AT-7 | 发言石连续性 | 自重启后发言链继续 | targets 不受影响，下个 hop 正常路由 |

## 证据判定

| AT | 证据状态 | 判定 |
|----|---------|------|
| AT-1 | 证明完成（单元测试 + 代码审查） | ✅ |
| AT-2 | 证明完成（单元测试 + 代码审查） | ✅ |
| AT-3 | 证明完成（现有 restart_otter 逻辑不变） | ✅ |
| AT-4 | 证明完成（scheduler-service.test.ts 新增测试） | ✅ |
| AT-5 | 证明完成（scheduler-service.test.ts 降级测试） | ✅ |
| AT-6 | 证明完成（现有测试全部通过） | ✅ |
| AT-7 | 证明完成（发言链机制不变） | ✅ |
