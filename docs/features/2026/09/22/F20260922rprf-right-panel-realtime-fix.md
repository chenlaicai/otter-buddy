---
id: F20260922rprf
title: 右侧栏实时渲染修复（invoke 状态收敛 + 参与者变更实时刷新）
doc_type: feature

summary: |
  修复右侧栏两个实时渲染问题：①大獭发言完右栏仍显示「运行中」（SSE invoke.end 事件
  断连窗口丢失，且 applyInvokeEnd 乱序防御会丢弃无 prev 的 end 事件）；②解散/创建/重启
  小獭后右栏不刷新（F20260913ctlv 停发 tool.result SSE 后旧钩子失效）。
  修复：SSE 重连后补偿拉取 invoke 状态收敛；invoke.event（tool_result 类）按工具名
  触发参与者列表刷新。

causal_links:
  from:
    - F20260811dsrt
    - F20260913ctlv

change_type: fix
tags: [bugfix, realtime-update, SSE, right-panel]
modules:
  - web/src/pages/conversation/index.tsx
capability_test: "n/a: 纯前端 UI 状态同步逻辑（A 类），无 LLM 参与行为"
created_in_conversation: 9c674ed5-5ba4-4d24-8f01-99da6b57a7a2
---

# F20260922rprf: 右侧栏实时渲染修复

## 预注册（troubleshooting 步骤 1）

- 预期根因方向：右侧栏「运行中→休息中」状态不同步 + 「中断报错」是 SSE `invoke.end` 事件未到达前端；「解散小獭后不刷新」是 SSE 无参与者变更事件通道（F20260913ctlv 把 tool.result 停发 SSE 后，旧刷新钩子失效）
- 验证标准：能找到 invoke.end 发射点未覆盖某路径，或前端 invoke.end handler 有早期 return 导致状态不更新
- 反例方向：若事件正常到达，则根因在前端状态管理（applyInvokeEnd 乱序防御或 React 状态未更新）

**预期 vs 实际对照**：预期命中。两个根因均确认——①常驻 SSE 断连重连窗口内 invoke.end 丢失，且 `applyInvokeEnd` 乱序防御（无 prev 或 invokeId 不匹配则忽略）会丢弃迟到事件；②`tool.result` 停发 SSE 后 `refreshParticipantsAfterDissolve` 无触发点。

## 问题现象

1. 大獭发言完，右侧栏仍显示「运行中」；点击「中断」报错；刷新页面后才发现实际是「休息中」
2. 解散小獭后，右侧栏仍显示已解散的小獭，需刷新页面才消失

## 根因分析（附 file:line）

### 问题 1：invoke 状态不收敛

- `invoke.end` SSE 事件是右栏状态收敛的唯一数据源（后端发射点：`src/interface-adapters/agent-runtime/agent-invoker.ts:485`；前端消费点：`web/src/pages/conversation/index.tsx:662`）
- 常驻 SSE 通道（`GET /api/conversations/:id/subscribe`）断连重连期间，后端发射的 `invoke.end` 会丢失——前端无断连后补偿拉取机制
- `applyInvokeEnd`（`web/src/lib/invoke-tracker.ts:81`）乱序防御：`if (!prev || prev.invokeId !== data.invokeId) return states`——若 `invoke.start` 未到达（重连后新 invoke 已切换），`invoke.end` 被静默丢弃，右栏永久卡在「运行中」
- 用户此时点「中断」，`handleAbortInvoke` 调用 `api.abortInvoke`，但后端 invoke 已终态，返回错误 → 前端报「中断失败」

### 问题 2：参与者列表不刷新

- F20260811dsrt 的修复依赖 SSE `tool.result` 事件检测 `dissolve_otter`
- F20260913ctlv 后 `tool.result` 不再广播 SSE（`src/usecases/conversation/agent-turn-orchestrator/event-mapping.ts:56`：「tool.result / assistant_text / assistant_toolcall 不再广播，仅落 invoke_events」）
- `refreshParticipantsAfterDissolve`（`index.tsx:235`）仍在，但常驻 SSE handlers 里没有 `tool.result` 处理器——**没有事件触发它**
- `invoke.event` SSE 事件（Session 弹窗通道）携带 `tool_result` 类事件， payload 含工具名，是替代触发点

## 修复方案（修法排序①：既有机制语义内修）

| 问题 | 修复 | 文件 |
|---|---|---|
| invoke.end 丢失 | SSE `onprogress`（含重连成功）时补偿调用 `api.listInvokes` 拉取最新 invoke 状态，与本地 `invokeStates` 合并收敛（幂等：existing 同状态跳过） | `web/src/pages/conversation/index.tsx` |
| 解散/创建/重启不刷新 | 常驻 SSE `invoke.event` handler 中，检测 `eventType === 'tool_result'` 且 `payload.name` 为 `dissolve_otter`/`create_otter`/`restart_otter` 时调用 `refreshParticipantsAfterDissolve` | 同上 |
| 函数语义扩展 | `refreshParticipantsAfterDissolve` 从仅处理 `dissolve_otter` 扩展为处理三种参与者变更工具 | 同上 |

**机制识别检查点**：全部未命中（无新增配置/状态生命周期/定时任务/信号类型/持久化存储/决策分支/跨模块调用路径）——在既有 SSE 事件通道与既有 API 内补数据流，走修法排序①。

## 变更范围

- `web/src/pages/conversation/index.tsx`（+38 行，-4 行）

## Verification（bugfix 硬规则）

**失败用例证据**：
- 修复前：常驻 SSE 无 `tool.result` 处理器（grep `tool.result` 于 `index.tsx` 常驻 handlers 段无命中）；`applyInvokeEnd` 乱序防御丢弃无 prev 的 end 事件（`invoke-tracker.test.ts:74` 用例「无 start 记录时忽略」佐证）
- 修复后：58 个前端测试文件 518 个测试全部通过（`npx vitest run`）；`invoke-tracker.test.ts` 17 个测试全绿

**最小复现路径**（修复前）：
1. 打开对话，让大獭发言，发言结束后右栏仍显示「运行中」
2. 点击「中断」→ 报错「中断失败」
3. 刷新页面 → 右栏显示「休息中」
4. 创建小獭后解散 → 右栏仍显示该小獭，刷新后才消失

**修复后预期**：
1. 大獭发言结束（yield）后右栏立即收敛为「休息中」
2. SSE 断连重连后自动拉取最新 invoke 状态，不卡「运行中」
3. 解散/创建/重启小獭后右栏立即更新

## 已知边界

- SSE 补偿拉取在每次 `onprogress`（含 15s keep-alive 心跳）触发——`syncInvokeStatesFromServer` 幂等且只在状态有差异时更新，无额外请求风暴
- `invoke.event` 的 `tool_result` 检测依赖 `payload.name` 字段（后端 `mapToInvokeEventInput` 已保证携带）

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 大獭
