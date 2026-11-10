---
id: F20261110mjinv
title: 麻将 SDK 直调补齐 durable invoke 身份
summary: 麻将每次獭唤醒生成并传递独立 currentInvokeId，同时保留无 conversationId 的纯 session 直调，修复 durable prompt 拒绝后静默退回规则代理的问题。
change_type: bugfix
capability_test: "n/a: 确定性适配器参数契约修复，由麻将网关行为测试验证，不涉及生成式能力面"
intent:
  problem: "麻将 SdkOtterGateway 未传 currentInvokeId，durable prompt 在模型调用前拒绝，唤醒最终退回规则代理"
  expected_effect: "每次麻将唤醒都有独立 invoke 身份，durable 能进入正常 prompt 路径；无 conversationId 的纯 session 语义不变"
  verify_by:
    type: behavior_check
created_at: 2026-11-10
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
causal_links:
  - F20261109pidrx
  - F20261110grdls
tags: [mahjong, durable, invoke-identity, regression]
modules:
  - src/usecases/mahjong/room/otter-adapter.ts
  - src/usecases/ports/sdk-invoke-port.ts
  - src/frameworks/agent/pi-session-factory.ts
  - tests/usecases/mahjong/room/room-service.test.ts
---

# 麻将 SDK 直调补齐 durable invoke 身份

## 问题与边界

`SdkOtterGateway.invoke` 原来只在存在 `conversationId` 时传 options，且 options 内没有 `currentInvokeId`。生产麻将装配恰好使用无 conversationId 的纯 session 直调，因此 durable `prompt()` 必然抛出 `Durable prompt requires currentInvokeId`；上层重试后退回规则代理，使真实獭决策不可用。

本次只在既有调用边界补齐身份，不放宽 durable 的 fail-closed 门禁，不让麻将写入对话 entry，也不改变规则代理对真实模型异常、非法回复和超时的既有兜底。

## 实现

- 每次 `SdkOtterGateway.invoke` 使用 `randomUUID()` 生成独立 `currentInvokeId`，并传给 `SdkInvokePort`。
- `conversationId` 存在时继续透传；不存在时仍省略，保持纯 session 直调。
- 两处 `InvokeOptions` 的 `conversationId` 类型改为可选，对齐实现早已支持的 `options?.conversationId ?? ""` 纯 session 路径；不引入空字符串伪造对话身份。
- durable 对缺失 invoke ID 的拒绝逻辑不变。

## Verification

### 失败用例证据（bugfix）

复现命令：

```bash
npx vitest run tests/usecases/mahjong/room/room-service.test.ts -t '纯 session 直调也为每次唤醒传独立 currentInvokeId' --reporter=verbose
```

修复前：1 failed；`expect(seen[0]?.currentInvokeId).toEqual(expect.any(String))` 收到 `undefined`。该断言直接检查传入 SDK 端口的 options，不通过规则代理兜底间接推断。

修复后：同一测试通过；完整 `room-service.test.ts` 为 1 file / 10 tests passed。测试连续调用两次，断言 ID 非空且不同，并断言无 conversationId 时仍保持 `undefined`。

### 仓库检查

- `npx tsc --noEmit`：通过。
- 目标 ESLint：通过。
- `npm run check`：通过（build、全量 ESLint、schema、双形态 smoke、脚本/端口/OtterBar 探针）。
- `npm test -- --reporter=dot`：456 files / 5854 tests passed，包含真实 durable SIGKILL 重开与 unsafe 工具不重放回归。
- `lint:docs`、`lint:tests`、`lint:intent`、`lint:date-bombs`、`lint:evidence-anchors`、`lint:criteria`：通过；intent 仅存量 warning。
