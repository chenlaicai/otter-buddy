---
id: F20260817bcst
title: broadcaster-decouple
doc_type: feature

summary: |
  修复 web-only 部署（不配飞书）下流式事件链路整体断流：messageBroadcaster 从
  飞书 bundle 拆出为平台无关进程内总线，由 bootstrap 无条件创建；飞书出站
  （markdown 投递/思考中消息）拆为 FeishuMessageChannel，作为 outbound channel
  在飞书启用时注册到总线。

causal_links:
  from:
    - F20260814qswp

status: implemented
change_type: fix
tags: [im, sse, feishu, architecture]
modules:
  - src/usecases/im/message-broadcaster.ts
  - src/usecases/im/feishu-message-channel.ts
  - src/bootstrap/platforms.ts
  - src/app.ts
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
---

# F20260817bcst: broadcaster 与飞书解耦（issue #281）

## 背景与需求

### 问题描述

`messageBroadcaster`（进程内事件总线）仅在飞书配置存在时创建：`app.ts` 传 `messageBroadcaster: feishu?.broadcaster`。web-only 部署（不配 feishu 段）下：

- POST 发送流的 SSE 响应无任何 streaming 事件（`message-controller.ts:208` 的 `if (this.messageBroadcaster)` 守卫跳过订阅），只剩 finally 兜底的 `stream.end`
- GET `/api/conversations/:id/subscribe` 命中 `:67` 守卫返回 500（"Message broadcaster not configured"）——检视报告称"直接抛错"，实为守卫后 500，断流结论不变
- 前端只能靠轮询兜底，实时性归零

发现路径：PR #278 验证时用隔离实例（无 feishu 配置）复现——最初误判为前端 bug，追到 `app.ts` 装配才定位。

### 根因分析

`MessageBroadcaster` 类混合了两种职责：Web SSE 进程内 pub/sub（平台无关）与飞书出站投递（平台特定），且其生命周期被绑在 feishu bundle 的创建条件上——飞书的"存在与否"决定了 Web 核心功能是否可用。

## 方案设计

- `message-broadcaster.ts` 瘦身为纯总线：subscribe / broadcast / broadcastEvent（Web 分发）+ `registerOutboundChannel`（出站通道注册）。构造只依赖 logger。
- 新 `feishu-message-channel.ts`：`FeishuMessageChannel implements OutboundMessageChannel, OutboundEventChannel`——原 `broadcastToFeishu` / `maybeSendFeishuThinkingMessage` / `resolveSenderLabel` / `shouldBroadcastToFeishu` 逻辑原样迁移（含 F20260812fmdr 的投影/降级与 R5 时间戳 gate）。
- `app.ts` 无条件 `new MessageBroadcaster(logger)`；`createFeishuBundle` 增加总线参数并在飞书启用时注册 channel；`setupFeishu` 的 `messageBroadcaster` 从 bundle 字段改为显式参数（`FeishuBundle` 不再持有 broadcaster）。
- 事件语义保持：broadcast 对出站通道逐个 await（通道内部 catch）；broadcastEvent 对出站通道 fire-and-forget（与旧 thinking 消息路径一致）。

## 验收结果

### 测试结果

- `npx tsc --noEmit` 通过；`npx eslint .` 0 error
- 全量 vitest 101 文件通过（含 tests/usecases/im 13 文件 177 用例——broadcaster/feishu-channel 行为断言全部沿用，仅装配方式改为"总线 + 注册通道"，与生产一致）
- subscribe-sse 测试标注：裸总线（无出站通道）即 web-only 部署形态，subscribe 正常建立、事件到达 SSE 流

### 证据判定
| 需求 | 证据状态 | 判定 |
|------|---------|------|
| web-only 部署流式链路恢复 | **真实实例验证**（隔离端口 3210 + 独立 DB + config 完全无 feishu 段）：GET subscribe 返回 200（修复前 500 "Message broadcaster not configured"）；POST 发送流投递 message.start/agent.idle/error 完整序列（修复前仅 stream.end）；常驻 GET 订阅同步收到全部 streaming 事件；error 事件双通道正常广播 | ✅ |
| 飞书配置存在时行为不变 | FeishuMessageChannel 逻辑逐字迁移 + feishu 行为测试全绿（replyMarkdown/思考中消息/防回环/绑定跳过） | ✅ |
| 事件出站语义保持 | broadcast await 通道、broadcastEvent fire-and-forget 与旧实现一致 | ✅ |

注：验证时 LLM（mimo，生产 config 当前默认）返回 401 Invalid API Key——外部 key 状态变化，与本改动无关；恰好验证了 error 事件路径的双通道广播。终态事件（message.complete）路径由 A 类测试覆盖（subscribe-sse 用例断言 message.complete 到达 SSE 流）。

## 设计决策

- **controller 的 `messageBroadcaster?` 可选性保留**：改为必传会破坏 dispatch-turn-loop 测试刻意构造的无 broadcaster 分支（守卫返回 500 的防御路径仍有效）；真正的保证在 app.ts 装配层（无条件创建）。
- **createFeishuBundle / setupFeishu 参数对象化**：加入总线参数后超 max-params 5 上限，顺手收敛为 options 对象。

## 对抗审视记录（一轮）

独立 agent 对抗审查结论：**"飞书行为不变"逐行等价成立**（broadcast 顺序/异常传播、思考中消息时机、时间戳 gate、投影参数逐字一致；merge 未损失 observability 接线；无"事件先于注册"窗口）。两个真问题已修复：

1. **【中】接口注释承诺的通道隔离不存在**：`broadcast` 逐通道顺序 await，通道在 reply 之外的抛错（manageConnection 查询等）会冒泡中断后续通道——与拆分前 broadcastToFeishu 的冒泡语义一致（等价），但注释谎称"不阻塞其他通道"。修复：注释改为如实描述 + 多通道隔离留待批次 3 在总线层加 try/catch。
2. **【中】web-only 验证未走到 message.complete 且该路径无自动化覆盖**：真实验证因 LLM 401 止步于 error 事件；而 tests/api 的 broadcaster 原是**手写 mock**（绕过真实总线实现）。修复：tests/api/helpers.ts 改用真实 `MessageBroadcaster`（裸总线 = web-only 形态），POST 流 → 生产总线 → SSE complete 链路（tests/api/message.test.ts:150）现在真实走过。

理论边角（接受）：registerOutboundChannel 无去重（当前单一同步调用点，buildApp 复用时才会暴露）；feishu 测试的 `messageChannels[0]["manageConnection"]` 私有访问链在字段改名时响亮失败（非静默）。

## 关联

- issue #281（本 F 文档实现其验收标准）
- issue #282（批次 3 总纲，本改动是其前置地基）
- 发现于 PR #278 验证过程
