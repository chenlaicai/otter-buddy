---
id: F20260831rvfb
title: "恢复流终态反馈 + 服务重启 healing 台账落账（#613）"
summary: |
  Issue #613（8/31 凌晨健康检查发现）：8/30 服务两次重启后恢复流「正在自动恢复」
  发出后无终态反馈——成功路径用户不知恢复结果，且服务重启事件不落 healing 台账
  （P0 级事件对健康检查不可见）。双修复：①恢复完成后按 conversation 发
  「[系统] 恢复完成：N 条中断发言已恢复/M 条未能恢复」终态消息（#604 失败路径
  终态守卫的对称补充，#604 检视建议1「done 路径省略显式系统消息」被本方案覆盖）；
  ②恢复执行时写一条 healing event（errorType='other'，severity 按中断发言数分级），
  让每日健康检查数据源闭环。
change_type: fix
status: active
capability_test: "n/a: 消息文案与 healing event 写入，无 LLM 参与行为"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
---

# 恢复流终态反馈 + 服务重启 healing 台账落账（#613）

## 背景与需求

### 问题现场（8/30，issue #613 正文）

8/30 服务两次重启（22:29 前后 js-yaml ESM 启动报错 → #612 修复）后：
- 恢复成功路径：用户看不到「恢复完成」，开发獭-574 靠自己想起来补报「已恢复。PR #604 的对抗审视和 delta 复核均已完成…」
- healing events 里零记录（8/30 全天仅 1 条 probe-test 探针数据）——服务重启这种 P0 级系统事件没有进 healing 台账

### 修复方案（issue #613 方案 A + B）

- **A. 恢复终态消息**：`resume-interrupted-service` 恢复成功后发终态消息，与失败路径的 `[错误]` 消息对称
- **B. 重启事件入 healing 台账**：恢复执行时（无论成败）写一条 healing event，severity 按中断发言数分级

## 变更文件

| 文件 | 变更 |
|------|------|
| `src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts` | 新增 `buildRestartResumeCompletedMsg(resumed, skipped, failed)` 消息构建函数（三分类统计，#617 检视发现1 修复） |
| `src/usecases/conversation/resume-interrupted-service.ts` | `resumeConversation` 返回 `{resumed, skipped, failed}` 三分类统计（#617 检视发现1：skipped 与 failed 分开，避免「请手动重试」误导 stale 数据）；`resumeItemSafe` 返回三分类 outcome；`resume()` 主流程发终态消息 + 写 healing event；`healingRepo` 注入 deps |
| `src/app.ts` | 装配 `healingRepo: repos.healingEvent` |
| `tests/usecases/conversation/resume-interrupted-service.test.ts` | 新增 8 个测试（终态消息 ×2、stale 统计 skipped ×1、healing 落账 severity low/medium/high ×3、无 pending 不落账 ×1、non-fatal ×1） |

## 方案设计

### A. 恢复完成终态消息

```
resume() 主流程：
  for each conversation:
    result = await resumeConversation(...)  // 返回 {resumed, failed}
  for each conversation:
    sendSystem(buildRestartResumeCompletedMsg(result.resumed, result.failed))
```

消息文案（#617 检视发现1 修复：三分类精确区分，避免「请手动重试」误导 stale 数据）：
- 全部成功：`[系统] 恢复完成：N 条中断发言已恢复。`
- 部分跳过（stale 数据清理/并发窗口跳过）：`[系统] 恢复完成：N 条中断发言已恢复，M 条已跳过（过期/并发，无需处理）。`
- 部分失败：`[系统] 恢复完成：N 条中断发言已恢复，K 条未能恢复（请手动重试）。`

**Why 三分类**：`resumeOne` 返回的 "skipped" 此前被计入 "failed"，终态消息对 stale 数据（participant/message 已失效，消息已 exhausted）显示"请手动重试"——但用户对该数据无可操作路径。三分类让统计与文案一致：skipped=已清理无需处理，failed=真恢复失败可手动重试。

**与 #604 的关系**：#604 的失败路径终态守卫在 `finalizeResumedMessage` 的 done 分支省略了 sendSystem（当时检视建议1 认为旧消息 body 已说明去向）。issue #613 要求成功路径也发终态消息，恢复 done 路径的流内系统消息。**#604 建议1 被本方案方向性覆盖**。

**粒度选择**：按 conversation 汇总统计（N 条/M 条），而非逐条发系统消息——用户关心的是「这次重启恢复了几条、没恢复几条」，单条消息太细。

### B. 服务重启 healing 台账

```
resume() 入口（pending.length > 0 时）：
  recordRestartHealingEvent(pendingCount)
    severity = pendingCount >= 5 ? 'high' : pendingCount >= 2 ? 'medium' : 'low'
    healingRepo.create({
      errorType: 'other',
      severity,
      description: `服务重启导致 ${pendingCount} 条发言中断，自动恢复流程已启动（#613）`,
      context: { interruptedCount: pendingCount },
      ...
    })
```

- errorType 用 `'other'`（healing-event.ts 中没有 `service_restart` 类型，不引入新枚举值——最小变更）
- try/catch 包裹 non-fatal（对齐 `scheduler-service.ts` 的 `notifyTaskErrored` 模式）
- `healingRepo` 为可选依赖（`healingRepo?: HealingEventRepository`），测试不传时不落账

## 与方案的偏差

无。

## 验证

- `npx vitest run tests/usecases/conversation/` —— 16 文件 227 测试全绿（含本特性新增 8 测试）
- 最简实现检查：已确认——无新增依赖，复用既有 `HealingEventRepository` 接口与 `sendSystem` 通道；severity 分级用简单条件表达式而非引入配置；消息构建函数遵循 `retry-policy.ts` 既有模式

## 影响范围

- `ResumeInterruptedService` 公共 API 不变（`resume(): Promise<void>` 签名不变）
- `healingRepo` 为可选依赖，不传的调用方（既有测试）行为不变
- healing 台账新增 `errorType='other'` 事件，不影响现有按 errorType 过滤的查询

## 关联

- Fixes #613
- Refs #604（失败路径终态守卫，本方案的对称补充）
- Refs #599（恢复失败僵尸发言，#604 修复的原始事故）
- Refs #617 检视发现（skipped/failed 三分类区分 + severity≥5 测试锁定——均在本 PR 承载处置）
