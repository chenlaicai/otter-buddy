---
id: F20260828mpps
title: 对话消息分页尺寸调优
doc_type: feature

summary: |
  对话消息分页尺寸调优：首屏加载 100→30 条，向上翻页 50→20 条。agent 对话单条消息内容量大（工具调用、长报告），旧尺寸首屏负载过重。增量刷新（after 游标）与未读定位 expand 的批量不动。

causal_links:
  from: ["F20260803vmsg"]
  to: []

capability_test: "n/a: 分页批量参数调整，无 prompt 行为变更，通过 web 全量 vitest 验证（33 files / 287 passed）"

status: implemented
change_type: feature
tags: [web, conversation, pagination, performance]
modules:
  - web/src/pages/conversation/index.tsx
---

# F20260828mpps: 消息分页尺寸调优

## 背景

搭档反馈：agent 对话每条消息内容量大（多工具调用、长报告、卡片），首屏拉 100 条负载过重，打开对话加载偏慢。F20260803vmsg 建立的双向游标分页机制本身运行正常，本调整只动批量参数。

## 需求原话

> 太多了，因为其实agent对话的每一条消息的内容量都不少。你改成首次30，每次20

## 变更

| 位置 | 旧值 | 新值 | 说明 |
|------|------|------|------|
| index.tsx:266 首屏 `listMessages(convId, N)` | 100 | 30 | 进入对话拉取的最新消息数 |
| index.tsx:378 翻页 `listMessages(activeId, N, oldest.id)` | 50 | 20 | 滚动到顶后加载更早历史的批量 |

**不动的部分**（有意保留）：
- `refreshMessages` 的 after 游标批量（:324，仍 100）——拉的是用户即将要看的新消息，降低会造成新消息显示不全
- 未读大量超窗时的 `expandMessage(unread, 'both', 25)`——未读定位语义，与分页尺寸无关

## 验证

- web 全量测试 33 files / 287 passed（无测试断言旧数值，无需适配）
- tsc --noEmit 干净

## 取舍

- 未给两个数字抽常量：仅两处字面量、语义不同（首屏 vs 翻页），抽常量收益低于噪音；若未来第三处消费再抽
- 未读 expand 的 25 与翻页 20 数值不同属历史原因，语义独立，不强求对齐
