---
id: F20260820i333
title: mention-parsing-server-side
doc_type: feature

summary: |
  将 @提及解析从前端正则移至服务端，支持多 @、无尾随空格、标点分隔、NFC 归一化。
  解析失败/目标退场时返回显式 feedback，不再静默回退默认派发。

causal_links:
  from:
    - F20260728htar

status: development
change_type: bugfix
tags: [conversation, mention, parsing, sse, feishu]
modules:
  - src/usecases/conversation/mention-parser.ts
  - src/usecases/conversation/send-message.ts
  - src/interface-adapters/http/controllers/message-controller.ts
  - src/interface-adapters/feishu/message-processor.ts
  - web/src/pages/conversation/MessageInput.tsx
  - web/src/pages/conversation/index.tsx
capability_test: n/a
created_in_conversation: e4699fad-2edc-4521-bf70-3927be33270f
---

# F20260820i333: @提及解析服务端化 + 失败显性化

## 背景与需求

### 问题描述

**Issue #333**：用户多次感知"@了某獭但没触发"。排查发现以下场景静默失效：

1. **前端正则脆弱**：`/ @(\S+)\s/` 要求名字后必须有空白符，@在消息末尾直接发送即失配；名字后紧跟标点会被 `\S+` 吞进名字；多个 @ 只取第一个
2. **服务端静默降级**：显式目标校验失败时静默退默认派发，仅 info 日志，用户无感知
3. **别名不识别**：名字精确匹配（NFC 归一化），简称/别名不支持
4. **飞书通道完全不解析**：`talkingStonePassedTo: []` 硬编码

### 影响范围

- Web 前端 @提及解析
- 飞书通道 @提及解析
- 所有对话的消息派发目标解析

## 设计方案

### 架构变更

**解析位置**：前端 → 服务端（`mention-parser.ts`）

**解析策略**：
1. 有显式目标（前端已解析传入）→ 直接校验
2. 无显式目标且消息体含 `@` → 服务端解析 + 校验
3. 无显式目标且无 `@` → 跳过名册查询，走默认派发（避免 N+1 性能回退）

### 新增 `mention-parser.ts`

纯函数模块，支持：
- 多 @ 提及（全局扫描，非 first-match）
- 无尾随空格（@ 在消息末尾）
- 标点分隔（中文标点、英文标点）
- NFC 归一化（兼容 NFD 编码）

### 修改 `send-message.ts`

重构 `resolveUserTargets`：
- 无 `@` 时跳过参与者名册查询（避免每条消息 N 次 DB 查询）
- 有 `@` 时才查名册、做解析
- 解析失败/目标退场返回 feedback 字符串

### SSE `mention.feedback` 事件

- `message-controller.ts`：SSE 流推送 `mention.feedback` 事件
- `index.tsx`：接收后 toast 提示用户
- `message-processor.ts`：飞书通道通过 replyText 发送 feedback

### 前端 `MessageInput.tsx`

`extractMentions` 函数替换原有 `/@(\S+)\s/` 正则：
- 全局扫描（支持多 @）
- 标点分隔（不吞标点进名字）
- 无尾随空格（@ 在消息末尾）

## 测试

### 测试覆盖

- `mention-parser.test.ts`：17 个纯函数测试用例
  - 单 @、多 @、末尾 @、标点分隔
  - 有效/无效名字、混合有效无效
  - NFC 归一化、英文名字、空文本
  - 只有 @ 无名字、@ 后跟空格
- `send-message.test.ts`：28 个测试全通过（含原有显式目标校验测试）
- 全量测试：1285 个测试用例通过

### 向后兼容性

- API 行为变化：消息返回值新增可选 `mentionFeedback` 字段
- SSE 新增 `mention.feedback` 事件类型
- 非 breaking change（可选字段，前端兼容处理）

## 取舍与决策

### 解析位置：前端 vs 服务端

**选择服务端**：
- 飞书通道复用同一套解析逻辑
- 前端正则难以覆盖所有边界（中文标点、NFC）
- 服务端解析可利用参与者名册做精确匹配

### N+1 性能优化

**策略**：先检查消息体是否含 `@`，无则跳过名册查询

**权衡**：每条消息多一次 `String.includes('@')` 检查（O(n)），但避免了 N 次 DB 查询

### feedback 传递方式

**当前**：duck typing（`in` 操作符检查 `mentionFeedback`）

**已知局限**：`Message` 类型未扩展此字段，未来重构可能 strip。跟踪 issue 待后续处理。
