---
id: F20260907mmcl
title: "多模态注入例外收口：带附件消息过信号路由器"
summary: "消灭信号路由器最后一个绕过分支——带附件注入（图片/文档）的消息从此走信号路由器闸门+台账，请求内存中的临时载荷退役。"
change_type: feature
capability_test: "n/a: 纯后端调度路径变更，无 prompt/skill 层改动"
created_in_conversation: 449d8f5d-e91e-49c0-ade5-0fbd9b3d0fcb
created_at: 2026-09-07T09:45:00+08:00
tags: ["signal-protocol", "multimodal", "injection", "dispatch-ledger", "gate"]
modules:
  - src/usecases/conversation/signal-router.ts
  - src/interface-adapters/http/controllers/message-controller.ts
  - src/usecases/conversation/agent-dispatch-service.ts
  - src/app.ts
from: ["F20260902sgp2", "F20260827mmdu"]
supersedes: []
intent:
  problem: "带附件注入（图片/文档）的消息绕过信号路由器，直连 dispatchTurnLoop，丢失闸门+台账保护"
  expected_effect: "带附件消息与纯文本消息同一闸门/台账语义；retry 后多模态载荷不丢失"
  verify_by:
    type: static_only
    reason: "纯后端调度路径变更，3070 单测全绿验证链路，无 LLM 行为可采样"
---

# 多模态注入例外收口

## 背景与问题

信号协议 v2（F20260902sgp2）后，五入口（web/IM/retry/scheduler/招聘）已全部过信号路由器闸门 + 派发台账记账。唯一例外：**带注入载荷的消息**——

- `message-controller.ts` L247：`if (this.signalRouter && !injection)` — injection 存在时走直连链 dispatchTurnLoop
- `agent-dispatch-service.ts` L52：同款 `!injection` 分支

**根因**：注入载荷（InjectionPayload：图片 base64 + 文档文本块）存在于 HTTP 请求内存中，信号路由器从消息表重建内容时拿不到它。

## 方案设计

### 核心思路：载荷持久化

用户消息落库时附件已持久（message_attachments 关联表）。信号路由器的 invokeTarget 调链前，从触发消息的 attachments 重建 InjectionPayload——复用 retry 路径 `loadRetryInjection` 同款模式。

### 数据流

```
用户发送消息（含附件）
  ↓
sendMessage: validateAndBuild 校验 + 消息落库（attachments 持久化）
  ↓
signalRouter.routePendingSignals()
  ↓
routeTarget → invokeTarget(attachmentIds)
  ↓
invokeTarget: attachmentInjection.buildInjectionPayload(attachmentIds)
  ↓
executeChain(content + documentBlock, images)
```

### 变更点

| 文件 | 变更 |
|------|------|
| `signal-router.ts` | 新增 `attachmentInjection` 可选依赖；`invokeTarget` 加 `attachmentIds` 参数，从附件重建注入载荷；`QueuedSignal` 快照 `attachmentIds` |
| `message-controller.ts` | 移除 `!injection` bypass，带附件消息从此过信号路由器 |
| `agent-dispatch-service.ts` | 移除 `!injection` bypass，IM 入口同理 |
| `app.ts` | 传 `attachmentInjection` 给 SignalRouter 构造函数 |

### 降级设计

- `attachmentInjection` 未装配 → 多模态消息降级纯文本（与 Phase 1 前行为等价）
- 注入载荷重建失败 → warn 日志 + 降级纯文本，不阻断链路
- 信号路由器未注入 → 保留直连链降级路径（灰度回滚面）

### busyQueue 场景

信号被 busyQueue 拥塞时，入队快照 `attachmentIds`。消化时传给 `invokeTarget`，重建注入载荷。content 的 documentBlock 在 invokeTarget 内追加（不在入队时拼接——避免快照内容膨胀）。

## 验证

- ✅ TypeScript 编译通过（0 errors）
- ✅ 全量测试通过：3070 tests / 245 files（含 6 个新增 #826 用例）
- ✅ eslint src/ tests/：0 error（2 warning 为 main 既有 no-console）
- ✅ npm run build：成功
- ✅ 新增测试覆盖：图片注入重建、documentBlock 追加、无附件跳过、重建失败降级、未装配降级、busyQueue attachmentIds 快照+消化链路
- ✅ 已过最简检查：复用现有 `AttachmentInjectionService.buildInjectionPayload`，不新增依赖

## 检视处置记录（检视-829，2026-09-07）

检视发现 2 严重 + 4 建议，全部处置：

| 发现 | 处置 |
|------|------|
| 严重 1：5 个 eslint error（复杂度/参数数/断言风格/unused） | ✅ 拆 rebuildInjection + mergeDocument、attachmentIds 并入 ledger 对象、attachmentIdsOf 辅助函数、测试改副作用断言 + 补消化链路断言 |
| 严重 2：behind main | ✅ rebase onto main（#819 先合） |
| 建议 1：retry 路径多模态收口不完整（otter 消息 attachments 恒空，retryPayload 丢弃） | ✅ 同 PR 修复：controller 反查同 turn user 消息附件 ID，retryAttachmentIds 显式传递，retrySignal 消费重建 |
| 建议 2：双读盘（router 在位时 validateAndBuild 白建） | ✅ 同 PR 修复：新增 validateForSendOnly，router 在位时仅校验不组装 |
| 建议 3：busyQueue 消化链路无断言 | ✅ 补 drainBusyQueue 驱动 + executeChain images 断言 |
| 建议 4：附件被删静默降级无日志 | ✅ rebuildInjection 内 injection 为空时 info 留痕 |

## 最简实现检查

已过最简检查：
1. 仓库已有实现：`AttachmentInjectionService.buildInjectionPayload` 可直接复用
2. 不新增外部依赖
3. 变更范围：5 个源文件 + 1 测试文件（重构后 invokeTarget/rebuildInjection/mergeDocument 职责单一）
