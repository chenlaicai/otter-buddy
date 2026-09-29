---
id: F20260929wap1
title: 浮动獭面板历史消息倒序渲染（双重 reverse）+ invoke_start 行动边界不可见
summary: 搭档实测发现面板里 429 告警显示在用户消息 hi 上方。根因是 AssistantPanel 历史加载把已正序的 entries API 返回又 reverse 了一次（双重反转，时间线倒序）；同时面板过滤掉 invoke_start 边界且流式渲染缺 invoke.start 处理，重开面板看不到大獭行动中状态。修复为删除多余 reverse + 历史/流式两路径渲染行动边界（居中状态条）。
change_type: fix
tags: [web-assistant, floating-assistant, entry-order, sse]
modules:
  - web/src/components/FloatingAssistant/AssistantPanel.tsx
from: [F20260924wast, F20260928waf1]
created_in_conversation: 480589fd-5813-400a-9b07-8e7d5707fb34
---

# 浮动獭面板历史倒序渲染 + 行动边界不可见（F20260929wap1）

## 问题现象（搭档实测反馈 2026-09-29 08:25）

1. 面板消息流中，429 系统告警显示在用户消息「hi」的**上方**（时间线颠倒）
2. 大獭行动中时，面板内没有任何「行动中」状态可见（重开面板后尤其）

## 根因

**双重 reverse**：entries API 本身返回正序——entry-controller.ts:45 将 DESC 取数 `items.reverse()` 转 ASC 后下发（curl 实测 seq 1→4 顺序正确）。AssistantPanel.tsx 历史加载误以为返回倒序，又做一次「倒序转正序」的 `[...entries].reverse()`（旧 :66），双重反转把时间线反成倒序。

**行动边界不可见**：面板 filter 只留 user/speak/system 三类（旧 :66 注释「invoke 边界一期略」），invoke_start 被丢弃；流式渲染 handlers 也没有 `invoke.start` 处理（SSE 契约 events.ts:36）。发送时仅靠「思考中…」占位气泡兜底，重开面板后行动中状态完全不可见。

## 修复

AssistantPanel.tsx 三处：

1. 历史加载：删除多余 reverse，直接按 API 返回序渲染；filter 增加 invoke_start
2. 流式渲染：handlers 增加 `invoke.start`（契约事件名，非 entry.invoke_start——tsc 会拦），渲染为居中状态条
3. system 消息渲染元素补 `data-testid="assistant-panel-system-msg"`（e2e 可断言）

行动边界渲染形态：与 system 同款居中小字（10px stone-400），如「🦦 大獭开始行动～」——轻量，与面板纯文本定位一致。

## 失败用例证据（修复前红 → 修复后绿）

e2e：web/e2e/floating-assistant-panel-order.spec.ts（mock entries 四条时间线 + POST 开户 handler）

**修复前**（09-29 09:0x，1 failed）：

```
Error: expect(received).toBe(expected)
Expected: "assistant-panel-user-msg"
Received: "assistant-panel-otter-msg"
```

（第一条渲染的是 seq 4 的獭消息而非 seq 1 的用户消息——时间线倒序的直接指纹）

**修复后**：1 passed → 全量 e2e 30/30 passed（10.4s）。

## 影响范围

- 仅面板展示层（AssistantPanel.tsx 单文件），不触数据层/契约/后端
- invoke_start 历史渲染为已完成的行动边界（非实时状态）；「思考中…」占位逻辑不变
- 完整对话页渲染不受影响

## 消息组织结构说明（搭档问询的顺带回答）

数据层完全同源（同一 entries 时间线）；面板与完整对话页的区别只在展示裁剪：面板拉最近 30 条、渲染 user/speak/system/invoke_start 四类、纯文本；完整页全量渲染含 invoke_end/yield 等全部类型与富内容。

## 关联

- from: F20260924wast（浮动獭一期，历史加载 reverse 引入点）、F20260928waf1（前轮面板修正）
- 同对话期 PR #1201（kind 折叠）修复了侧栏分组；本 PR 修面板内部，两者独立互补
