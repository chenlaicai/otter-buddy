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

## Delta 处置记录（2026-10-06，接手獭对抗审视）

**发现 1（严重）：409 回滚机制在 409 场景物理失效**——两处 catch 的旧实现无差别回滚为 streaming + 清空 content，但 409 = invoke 已终态 = `invoke.end` 事件早已发过（或孤儿场景不会再发），「等服务端收敛」的通道物理不存在；气泡永久假 streaming，复刻 issue #1251 本体症状。且 refreshMessages 是增量追加（只拉 newest.id 之后新条目，不更新已有气泡），对账收敛也不可达。附带：非 409 失败回滚清空 content，丢弃已流出内容（乐观置时保留原内容，不对称）。

**修复**：① 服务端 409 响应增加 `invoke_status`（真实终态）；② 前端 409 分支改用 `settleInFlightToTerminal` 按服务端终态直接收敛气泡（等效补发错失的 invoke.end，与 invoke.end 处理器同款规则：仅 in-flight 收敛 + 保留已流出内容）；③ 非 409 失败改用 `rollbackOptimisticAbort` 按请求前快照精确回滚（旧 status==='aborted' 匹配会误伤同 invokeId 历史真实终态气泡）且保留 content；④ 两函数进 message-stream.ts 纯函数库（+10 用例锁定）。

**发现 2（建议）：前端新增行为零测试**——分流提示/回滚/收敛行为无测试锁定，验收断言「前端按 code 分流 toast」裸奔。修复：随发现 1 落地为纯函数测试 10 用例（web 全量 625 用例绿）。

**更新取舍记录**：「不自动刷新/重查」在 delta 后修正为「409 场景不需拉取——服务端直接告知终态，前端本地收敛」；非 409 场景维持不拉取（invoke 仍在跑，SSE 事件会接管）。

## Delta2 处置记录（2026-10-06，delta 复核不通过后二次修复）

**复核发现（严重）：delta 修复的核心机制在主流路径死链**——两处入口在发 abort 请求前已把 in-flight 气泡乐观置 'aborted'（终态），而 settleInFlightToTerminal 只匹配 isInFlight(current)——409 回来时恒零匹配，服务端真实终态被静默丢弃：completed 显示成「已中断」、failed 被掩盖成 '[中断]'（失败信息丢失）。整个 invoke_status 透传链在主流路径是死代码。

**修复**：
- settleInFlightToTerminal → settleInvokeToTerminal，匹配集改为**快照 ∪ 当前 in-flight**：快照命中覆盖乐观置位后的气泡（初版死链根因）；并集当前 in-flight 覆盖请求期间迟到的同 invoke 气泡（409 后无未来 end 收敛它）
- content 规则：保留已流出内容；乐观 '[中断]' 占位在终态非 aborted 时按真实终态换文案（completed→''、failed→'[未完成]'，与 invoke.end 处理器同款）
- rollbackOptimisticAbort（复核建议 3）：状态恢复快照原值（streaming/speaking 都还原，不再硬编码 streaming）
- 测试：+端到端语义锁定（乐观置位 → 409/非 409 catch → 收敛/回滚接缝序列），纯函数层缺陷无法通过（初版死链在此测试下必红）
- React 时序代码核实：allMessagesRef 在 useEffect 同步 = 同步代码里乐观置位后立刻读 ref 拿到的是置位前状态，快照语义正确（index.tsx:98-100）

**复核指出的文档论据过时已修正**：初版处置记录「refreshMessages 增量追加不更新已有气泡」论据基于 merge 前旧代码；#1292 合入后 refreshMessages 已是窗口快照+mergeMessages——但拉取对账仍拿不到真实终态（entries.status 是死字段恒 'completed'，真实终态在 metadata.invokeStatus，send-entry.ts:453-458），服务端 409 直接下发终态仍是正确方向。

**范围外观察（复核提出，未在本 PR 处置）**：mergeMessages + entries.status 死字段组合——本地收敛的 aborted/failed 气泡会在切 tab 触发 refreshMessages 时漂成 'completed'。既有行为，建议与 #1241 一并评估建 issue。

## 关联

- issue #1251（本修复关闭对象）
- issue #1241（孤儿 invoke reconcile 根治，后续）
- F20260717d4ab（invocation-abort-mechanism：中断链路本体，#752 实锤 abort 为 user_abort 唯一入口）
- issue #752（user_abort 唯一入口历史实锤）
