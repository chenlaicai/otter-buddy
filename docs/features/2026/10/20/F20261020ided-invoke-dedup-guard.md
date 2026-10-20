---
id: F20261020ided
title: invoke 判重去重——同獭 running 时重试/再派工前置拒绝
doc_type: feature

summary: |
  修复「[错误] Lock acquire timeout for key: session:<otterId>」裸技术错误直达用户。
  现场（2026-10-20 14:19，对话 0401284f）：前端 116ms 内对同一 retry 端点双击，
  retryByOtter 无 running 判重各自放行 → 第二个 invoke 撞 session 锁 30s 超时，
  裸错误落 invoke_end 推给用户；failTerminal 无条件发 error 事件，前端额外造一条
  otter 气泡（DB 无 entry，刷新后消失，表现为实时/历史渲染不一致）。
  修法：①retryByOtter 判重（库行 running / SDK isRunning → 409）；②failTerminal
  收窄 error 事件——invoke_end 落账成功即跳过，落账失败才发 error 兜底。

causal_links:
  from:
    - F20260913ctlv   # invoke 只读查询/重试链路的引入方（本次在其 retryByOtter 补判重）

change_type: feature-update
tags: [invoke, dedup, concurrency, retry, sse, ux, tech-debt]
modules:
  - src/interface-adapters/http/controllers/invoke-controller.ts
  - src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts
  - tests/interface-adapters/http/invoke-retry-dedup.test.ts

created_at: 2026-10-20
created_in_conversation: 3e928c99-db1c-4683-94d0-8fe831bf6303
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
---

# F20261020ided invoke 判重去重

## 背景

### 现场（2026-10-20 14:19-14:20，对话 0401284f）

搭档报告：「偶尔会遇到报错 某獭发言：[错误] Lock acquire timeout for key: session:c22e8bf6…。
然后刷新下页面，发现这一条好像又变成系统消息了。」

排查固定证据（access log）：

```
14:19:39.743  POST /api/otters/c22e8bf6/retry  (requestId 699601d0, userId=web-ui) → 200
14:19:39.746  trace t_6db8df…  Agent invocation started → invoke 79368389
14:19:39.859  POST /api/otters/c22e8bf6/retry  (requestId 1aa23fac, userId=web-ui) → 200
14:19:39.861  trace t_a12760…  Agent invocation started → invoke ed9b0e79
14:20:11.155  ed9b0e79 撞锁 30s 超时 → failTerminal → invoke_end = 「[错误] Lock acquire timeout…」
```

### 根因链（两层）

**根因 1 · 判重缺失**：`retryByOtter`（invoke-controller.ts）的设计语义是「该獭最近一次
非 completed invoke 作为重试目标」，**没有检查该獭是否已有 running invoke**。两个请求
各自独立通过校验、各自 createInvoke，第二个撞锁超时——锁机制忠实拦截了重复并发，但
用了一条用户看不懂的裸技术错误。

**根因 2 · 渲染不一致**：`failTerminal`（orchestrator.ts）无条件连发两个 SSE 事件：
- `emitInvokeEnd(failed, endBody)` → 前端插入居中条 invoke_end（DB 有 entry，刷新后仍在）
- `emitEvent('error')` → 前端 error 处理器额外造一条 otter 气泡（**DB 无对应 entry，
  刷新后气泡消失**）——这就是「刷新后变成系统消息」的真面目：气泡本来就没落库。

### 搭档裁决

- 「我理解这种可能是 ui 误点，那咱们就要做好判重去重机制就行」——判重去重为根因修复
- 「一个 yield 应该只触发一次调用」——本次事故与 yield 链无关（前端 retry 双击），
  但判重层兜底对所有「同獭并发 invoke」场景有效

## 方案

### F1 · retryByOtter 判重（invoke-controller.ts）

判重语义三层（与既有 abort/retry 窗口竞态裁决一致）：

| 层 | 条件 | 处置 |
|---|---|---|
| ① | invoke 库行 status='running' | 409 `otter_invoke_running` |
| ② | DB 终态 + `AgentInvoker.isRunning(otterId)` | 409 `otter_invoke_running` |
| ③ | 两者皆否（含 aborted/failed 终态、SDK 层空闲） | 放行（中断后立即重试合法） |

②层存在的原因：abort 终态化是异步收敛的——用户点中断后 SDK 层可能还在跑（库行已
aborted），此时重试同样该被拒；但 SDK 层已停、库行 aborted 的「中断后立即重试」是
合法操作（④号测试固化），不得误拦。

### F2 · failTerminal 收窄 error 事件（orchestrator.ts）

`emitEvent('error')` 改为仅在 `invokeEndEntryId` 为空（invoke_end 落账失败）时发射：
- invoke_end 落账成功 → 居中条已承载错误文案（实时/历史同源同文案），error 事件跳过，
  前端不再额外造气泡
- 落账失败 → error 事件兜底发射，保证用户可见

### 设计取舍

机制识别检查点（issue 驱动未经 RA，动手前判定）：

| 项 | 判定 | 理由 |
|---|---|---|
| 新增配置/设置项 | ✗ | 无新配置 |
| 新增状态机/持久化字段 | ✗ | 判重查询走既有 getInvokes/isRunning |
| 新增事件/信号通道 | ✗ | 复用既有 409 + code 约定（abort 端点同款） |
| 新增角色/权限边界 | ✗ | 无 |

结论：全部为既有语义内修正（修法决策树①），**不涉及净新增机制**。

后续机制（④退役条件）：若未来 invoke 创建入口更多（如 IM 侧 retry），判重可下沉到
createInvoke 用例层做唯一兜底；当前仅 web-ui retry 一个入口，controller 层判重已足够，
不提前下沉。

### 最简实现检查

已过最简检查：判重 = 一次 getInvokes（既有查询，无新依赖）+ 一次 isRunning（既有
谓词）；error 收窄 = 一个 if 条件。无更少代码的等价方案。

## 验证

### 失败用例固化（troubleshooting 步骤 5a）

`tests/interface-adapters/http/invoke-retry-dedup.test.ts`：

| # | 场景 | 修复前 | 修复后 |
|---|---|---|---|
| ① | 库行 running 时 retry | 放行（→ 撞锁超时） | 409 otter_invoke_running |
| ② | DB 终态 + SDK isRunning 时 retry | 放行（→ 同上） | 409 otter_invoke_running |
| ③ | DB 终态 + SDK 空闲时 retry | 放行 | 放行（不误拦） |
| ④ | 用户中断后（aborted + SDK 停）立即 retry | 放行 | 放行（不误拦） |

修复前失败输出：①②红（判重缺失，`expected undefined to be defined` 方向）；
修复后 4 条全绿。

### 回归

- `tests/interface-adapters/http/` + `tests/usecases/conversation/`：88 文件 904 条全绿
- 全仓：408 文件 6481 条全绿
- lint：0 error 0 warning；tsc --noEmit：0 error

### 预期 vs 实际对照

- 预期：retry 双击场景第二个请求在 controller 层被 409 拒绝，不再触达锁层
- 预期：failTerminal 正常路径不再产生无 DB 落账的 error 气泡，实时/历史渲染一致

## 影响范围

- `invoke-controller.ts retryByOtter`：新增 2 个 409 分支（行为变更仅对「running 时
  重复 retry」场景——该场景此前必然以锁超时失败收场，409 是更早、更清晰的失败）
- `orchestrator.ts failTerminal`：error 事件发射收窄（invoke_end 落账成功时不再发射）——
  前端 error 处理器的 toast 提示在正常路径下不再出现（错误文案由居中条承载）；
  落账失败的异常路径 toast 保留

### 负面向验收

本次变更破坏的旧契约 / 绕过的既有保护：**无**。error 事件收窄未绕过任何保护——
invoke_end 落账失败时 error 兜底仍在；判重 409 未绕过锁机制——锁仍是最后一道防线，
判重只是把用户可见失败前移并友好化。
