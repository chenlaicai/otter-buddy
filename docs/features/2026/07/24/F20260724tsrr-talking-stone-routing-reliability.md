---
id: F20260724tsrr
title: talking-stone-routing-reliability
doc_type: feature

summary: |
  发言石路由可靠性根治 + speak 尾文本语义优化 + 两个前端 bug 修复：
  1. 小獭声明"传给大獭"实际却传给 user——三层结构根因：上下文里 otter 是
     UUID 无名字、'user' 是参数描述里触手可及的合法 token、发言石目标无成员
     校验（静默错误）。方案：在场成员名册确定性注入、历史消息具名标注、
     speak 目标校验+可用名单反馈、参数描述收紧。
  2. speak 后模型仍产出冗余 assistant text——语义三板斧：返回值伪装系统
     控制信号打破"输入必回应"惯性、明确禁止确认语/总结/解释、告知输出无观众。
  3. 串屏 bug：streamingMap 全局单例，t05 的流式气泡渲染到 t04。
  4. UI：GFM 表格等样式补全、上下文用量挪到消息头部、输入框自动增高。

causal_links:
  from:
    - F20260724skch

status: draft
change_type: fix
tags: [talking-stone, routing, speak, prompt, roster, streaming, ux, markdown]
modules:
  - src/interface-adapters/http/controllers/
  - src/interface-adapters/agent-runtime/tools/
  - web/src/pages/conversation/
  - web/src/styles/
  - tests/

created_at: 2026-07-24
---

# F20260724tsrr 发言石路由可靠性 + Speak 语义静默 + 对话 UX 修复

## 背景与根因

### 问题 1：小獭声明传大獭，实际传给 user

实测：小獭 speak 的 body 写"第4轮回大獭啦"，talkingStonePassedTo 却是 `["user"]`，链条静默终止。小獭自述"没查名单、把主人当 user"只是表层，结构根因三层：

1. **上下文里 otter 是 UUID 不是名字**：dispatch 注入历史用 `[senderId]` 标注，模型在游戏语境思考"大獭"，看到的却是 `8f26856b-...`，name↔ID 映射需自觉调 `get_active_participants` 才能获得
2. **'user' 是参数描述里触手可及的合法 token**："回应用户就传 user"在多獭场景语义模糊——每句话都"给主人看"，宽松理解下永远成立
3. **发言石目标无成员校验**：`isValidTalkingStonePass` 只验非空，声明意图与实际路由不一致时系统零反馈，user 目标被 dispatcher 过滤，链条静默终止

### 问题 2：speak 后仍产出冗余 assistant text

Otter 间的真实交互已由 speak 的 body 承载，speak 之后模型生成的尾文本无观众（不展示），纯属浪费 token 且污染流式事件。根因（模型行为学）：tool result 在上下文中形似用户消息，触发"输入必回应"惯性；RLHF 有用性倾向催生确认/总结；模型不知道"speak 后的输出不会被展示"。

### 问题 3：串屏——t05 流式中打开 t04，大獭"也在说话"

`streamingMap` 全局单例（按 messageId 键控），渲染不按对话过滤，t05 的流式气泡渲染到 t04。后端派发按对话隔离、事件按 messageId 路由，数据未污染，纯显示泄漏。

## 方案设计（确定性优先，不靠模型自觉）

### 路由可靠性（与 skill 信道治理同哲学：重要信息放必达信道）

| 措施 | 位置 | 说明 |
|------|------|------|
| 在场成员名册注入 | message-controller.buildRoster | 每跳派发时上下文前置 `## 在场成员`（`- 大獭 (otterId: …)`、`- 人类操作者（传 'user'…）`）；每跳重建（链中可创建/解散 otter），name↔ID 映射在 speak 决策点确定可得 |
| 历史消息具名标注 | buildMessageWithContext | `[大獭]`/`[小獭]` 替代 `[UUID]`（复用 resolveSenderNames） |
| speak 目标成员校验 | createSpeakTool.execute | 目标 ∈ 在场参与者 ∪ {'user'}；非法返回错误**附可用名单**（`大獭(8f26…)、人类操作者('user')`），静默错误变模型可自纠的即时反馈 |
| 参数描述收紧 | talkingStonePassedTo description | "仅当任务完成、需要人类接管时传 'user'"；明确"传 otterId 不是名字" |

### speak 尾文本语义三板斧

- **description**："speak 之后的任何输出都不会被展示，纯属浪费 token……确认语、总结、解释全部禁止"
- **返回值**：`[系统控制信号]` 前缀打破对话惯性 + "无需也不应回应" + "之后的输出没有观众"
- 不做强制 abort（不够优雅）；确定性兜底备选：事件持久化层丢弃 speaking 后的 assistant_text（本次未实施）

### 前端修复

- **串屏**：StreamingState + conversationId（message.start 记录），渲染按当前对话过滤；支持多对话并行流式
- **GFM 样式**：表格（边框/表头/斑马纹）、标题、引用、链接、hr、删除线 + 用户气泡反色
- **上下文用量**：从气泡下方挪到头部行，与名称/时间/耗时并排
- **输入框**：auto-resize（封顶 140px、发送后重置），修复"永远一行"

### 连带修复

dispatchLoop 补 `.catch`：循环内异常不再让 SSE 静默悬挂（push error 事件 + stream.end 收尾）——由 API 测试超时暴露。

## 改动清单

| 文件 | 改动 |
|------|------|
| `message-controller.ts` | buildRoster/buildMessageWithContext（名册+具名历史）；dispatchLoop .catch |
| `tools/tool-factory.ts` | speak 目标校验+名单反馈；talkingStonePassedTo 描述收紧；speak description/返回值语义三板斧 |
| `web/.../MessageList.tsx` | StreamingState + conversationId；ctx 用量挪入头部行 |
| `web/.../index.tsx` | message.start 记录 conversationId；activeStreamingMessages 按对话过滤 |
| `web/.../MessageInput.tsx` | textarea 自动增高 |
| `web/styles/globals.css` | GFM 全套样式 + 用户气泡反色 |
| `tests/` | speak 校验 3 例；名册/具名历史 1 例；helpers mock 补 getActiveParticipants |

## 验收标准

- [x] 小獭上下文直接可见大獭 otterId，传错被 speak 当场打回并给正确选项
- [x] speak 后尾文本消失或显著缩短（概率性，观察中）
- [x] t05 流式时 t04 不再出现串屏气泡
- [x] 表格等 GFM 元素正常渲染；ctx 与时间并排；输入框多行自动增高
- [x] 全部测试通过（539），构建全绿
