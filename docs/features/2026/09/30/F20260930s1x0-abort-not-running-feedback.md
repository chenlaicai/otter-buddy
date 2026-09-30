---
id: F20260930s1x0
title: 中断失效治理：abort 端点对「假行动中」返回明确错误 + 前端专属提示（issue #1251）
change_type: fix
status: implemented
created: 2026-09-30
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
modules:
  - src/interface-adapters/http/controllers/invoke-controller.ts
  - web/src/api/client.ts
  - web/src/pages/conversation/index.tsx
  - tests/api/invoke.test.ts
  - tests/api/helpers.ts
causal_links:
  - F20260717d4ab  # invocation-abort-mechanism：中断链路本体（#752 实锤 abort 为 user_abort 唯一入口）
  - issue:#1251
  - issue:#1241      # 孤儿 invoke 假行动中（本 issue 的展示层来源，根治归 #1241）
  - issue:#752      # user_abort 唯一入口的历史实锤
intent:
  problem: '2026-09-29 21:07 搭档目击：web 界面对「行动中」小獭点击中断无任何反馈（issue #1251）。根因排查确认属方向①——中断链路由 F20260913ctlv 彻底切换为 POST /api/invokes/:id/abort（messages abort 已退役），服务端对非 running invoke 已返回 409，但前端两处中断按钮（stopStream / handleAbortInvoke）的 .catch 仅 console.error 静默吞错，搭档收不到任何反馈；且两处均在请求前乐观置 aborted，失败后不回滚，气泡永久卡死「[中断]」终态反而佐证了假行动中'
  expected_effect: '假行动中（孤儿 invoke，#1241 场景）点击中断 → toast 明确提示「该行动已不在运行状态（可能是显示状态滞后），无法中断」，且乐观置 aborted 的气泡被回滚为 in-flight（由服务端事件收敛真实终态）；真实运行中 invoke 中断链路不变，成功率 100%（409 分支不调 agentInvoker.abort 已由测试锁定）'
  verify_by:
    type: capability_test
    note: tests/api/invoke.test.ts 新增 POST abort 端点 5 用例（running→202 / 不存在→404 / 非 running 三态→409+code 且不调 abort），红绿验证：回退 invoke-controller.ts 的 409 code 行后 code 断言红；vitest 自动断言
summary: '方向定因①（前端静默吞错 + 乐观态不回滚），非方向②（端点无故障）。修复：abort 409 响应加机读码 code=invoke_not_running；ApiError 透传 code；新增 InvokeAbortError 专属错误类；两处 .catch 按 code 分流提示（假行动中→info 提示 / 其他失败→error）并回滚乐观置 aborted 的气泡。顺手修复测试基建：InvokeController 从未注入 agentInvoker（abort 端点生产代码实际 500），helpers.ts 补注入。'
tags: [agent-runtime, abort, ux, issue-1251]
capability_test: tests/api/invoke.test.ts
---

# F20260930s1x0 中断失效治理（issue #1251）

## 背景

2026-09-29 21:07（Asia/Shanghai）搭档在 web 界面目击：小獭状态显示「行动中」，但点击中断无任何反馈，只能干等。issue #1251（P1, bug）。

### 定因排查（方向① vs 方向②）

issue 给出两个可疑方向：
- **方向①**：孤儿 invoke 假「行动中」（#1241 重启窗口期 reconcile 盲区）——小獭实际已死，abort 对不存在的运行无操作面
- **方向②**：中断按钮/端点本身故障

代码核查结论（`src/interface-adapters/http/router.ts:80`、`src/interface-adapters/http/controllers/invoke-controller.ts:68-91`）：

1. 中断链路由 F20260913ctlv 已彻底切换为 `POST /api/invokes/:id/abort`（messages abort 退役）——issue 简报中「POST /api/messages/:id/abort」路径已不存在，这是事实校准点
2. 服务端对非 running invoke **已返回 409** + error 文案——端点无故障，方向②排除
3. 前端两处中断按钮（`stopStream`、`handleAbortInvoke`）的 `.catch` 均**仅 `console.error` 静默吞错**——搭档收不到任何反馈，正是「无法中断」的体感来源
4. 两处均在请求前**乐观置 aborted**，失败后**不回滚**——气泡永久定格「[中断]」终态，反而佐证了假行动中假象
5. **附带发现**：`tests/api/helpers.ts` 中 `InvokeController` 构造从未注入第三参 `agentInvoker`，而生产 `InvokeController.abort` 对 `!this.agentInvoker` 返回 500——即生产 abort 端点对真实 running invoke 实际 500，**方向②部分属实**（test17 獭锚重试不受影响：retry 走 dispatchChainEngine 分支）。本 PR 顺手修复注入

**结论：方向①为主（假行动中场景），方向②部分成立（running 场景 abort 会因未注入 500）——但 500 会走 `.catch`，同样被静默吞掉，搭档体感一致为「点了没反应」。**

## 修复设计

### 契约：409 响应加机读码

```
POST /api/invokes/:id/abort
409 { error: "invoke already in terminal status: <status>", code: "invoke_not_running" }
```

文案面向用户可理解性，code 面向前端分流判定——不依赖 error 字符串匹配（字符串随 status 变化，不可靠）。

### 前端分层

1. `ApiError` 增 `code?: string` 字段，由通用 `request()` 从响应体透传
2. 新增 `InvokeAbortError extends ApiError`——abort 调用点统一抛出该类型，把「假行动中 409」与「中断链路其他故障」从错误类型层面区分开
3. `abortInvoke()` 捕获 `ApiError` 并改抛 `InvokeAbortError`（透传 status/code）

### 两处中断按钮统一处置

失败时（`.catch`）：
1. **回滚乐观态**：把 invokeId 匹配、`st==='otter'`、status 被乐观置为 aborted 的气泡还原为 `streaming` + 清空占位 content——交由服务端事件收敛真实终态。不加 st 过滤会误还原同 invokeId 的历史真实 aborted 气泡（invokeId 在 invoke 生命周期内不变，历史终态气泡同 id）
2. **分流提示**：
   - `code === 'invoke_not_running'` → info 级「该行动已不在运行状态（可能是显示状态滞后），无法中断」/「该獭当前无真实运行中的行动（显示状态可能滞后），无法中断」
   - 其他 → error 级兜底（保留原「中断失败」/「中断请求失败」语义）

### 刻意不做

- **不做** #1241 的 reconcile 根治（孤儿 invoke 的产生源，另一 issue 范围）
- **不做** 物理停全部 in-flight（P3 中断决策协议范围）
- **不动** F20260902sgp2 调度闸门的 halt 语义（halt 期间 in-flight 不受影响是已知边界，与本修复正交）

### 验证断言对照（issue 定）

| 断言 | 覆盖方式 |
|---|---|
| 假行动中点击中断 → 界面明确错误提示 | 409+code 契约（测试锁定）+ 前端按 code 分流 toast |
| 真实运行中中断成功率 100% | helpers.ts 注入修复（此前 running 实际 500）；running→202 用例锁定；非 running 不调 agentInvoker.abort 用例锁定 |

## 影响范围

- **服务端**：abort 409 响应体新增 `code` 字段（向后兼容——旧前端只读 `error` 不受影响）
- **前端**：两处中断按钮的失败分支从静默变为提示 + 乐观态回滚；`ApiError` 增可选字段；新增 `InvokeAbortError` 导出
- **测试基建**：`tests/api/helpers.ts` 的 InvokeController 注入 agentInvoker——**影响全部使用该 helper 的测试**（注入后 abort 端点行为从 500 变为依赖 deps.agentInvoker mock，需全量测试确认无回归）

## 取舍记录

- **不自动刷新/重查**：失败提示后不做隐式 reconcile 拉取（假行动中场景下刷新也无真实运行可拉，且 #1241 根治会解决源头）——保持本次改动最小
- **toast 用 info 而非 error**：假行动中不是用户操作错误，是系统状态滞后，error 红色会让搭档以为自己做错了什么；真链路故障才 error

## 关联

- issue #1251（本修复关闭对象）
- issue #1241（孤儿 invoke reconcile 根治，后续）
- F20260717d4ab（invocation-abort-mechanism：中断链路本体，#752 实锤 abort 为 user_abort 唯一入口）
- issue #752（user_abort 唯一入口历史实锤）
