---
id: F20260805f149
title: error-handler-projection-fallback
doc_type: feature

summary: |
  修复 error handler 投影降级问题，防止携带 messageId 的 error 事件整体替换 in-flight 占位消息导致丢失 events/seq/ts 等字段。
  核心问题是两个通道的 error handler 仍使用裸 upsertMessage，与 F20260805abpp 第四轮修掉的投影降级同类。
  修法：error handler 在 messageId 存在时也走 upsertTerminalMessage，保留已有投影字段。

causal_links:
  from:
    - F20260805abpp
  to: []

status: development
change_type: fix
tags: [frontend, projection, error-handling]
modules:
  - web/src/pages/conversation/index.tsx
  - .github/workflows/ci.yml
---

# F20260805f149: error handler 投影降级 + CI 缺 web 测试步骤

## 问题描述

PR #141 第五轮对抗检视发现两条建议项，均为存量问题：

### 1. error handler 投影降级

两个通道的 error handler 仍用裸 `upsertMessage`：
- web/src/pages/conversation/index.tsx 常驻通道 ~:514
- web/src/pages/conversation/index.tsx 发送流 ~:715

**风险分析：**
- 后端 error 事件携带真实 messageId（agent-invoker.ts:373）
- 携带 messageId 的 error 会整体替换 in-flight 占位，抹掉 events/seq/ts
- 与 F20260805abpp 第四轮修掉的投影降级同类
- 叠加风险：error 之后再到达 message.failed 时，upsertTerminalMessage 的 existing 已是被抹过的 errMsg，events 不可恢复

**修法：**
error handler 在 messageId 存在时也走 upsertTerminalMessage（err- 随机 id 的兜底路径保持不变）。

### 2. CI 从不执行 web 测试

.github/workflows/ci.yml 步骤含根仓 `npm test` 与 web `npm run build`，但无 `npm --prefix web test`——web 端 vitest（message-stream 等 77 条）在 CI 零覆盖，web 测试红了 CI 照样绿。

**修法：**
ci.yml 在 web build 步骤后加 `npm --prefix web test`。

## 出处

F20260805abpp 第五轮检视记录。
