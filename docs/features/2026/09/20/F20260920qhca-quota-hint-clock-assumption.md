---
id: F20260920qhca
title: checkModelQuotaHint 时钟假设标注
summary: 为 checkModelQuotaHint 的 24h 窗口判断补充时钟假设注释（#719 建议处置选项 1）——当前单机同源时钟成立，多进程部署时需改 nowMs 注入。纯注释级改动，无行为变化。
change_type: fix
capability_test: "n/a: 注释级改动，无行为变化"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [tech-debt, defensive]
modules: [src/interface-adapters/agent-runtime/tools/tool-factory.ts]
---

# checkModelQuotaHint 时钟假设标注

## 背景

Issue #719（PR #716 对抗审视建议发现 2）：`checkModelQuotaHint` 用 `Date.now() - Date.parse(e.createdAt)` 判 24h 窗口。`Date.now()` 是本地进程时钟，`Date.parse(e.createdAt)` 是 DB 写入时间——若两时钟有偏差（分布式部署 / DB 时钟回拨），窗口判断可能不准。

## 现状评估（2026-09-20 核实）

- 当前单机 SQLite 部署：同进程写同进程读，时钟必然同源，**无实际风险**
- 代码现状与 issue 立项时（9/2）一致：`Date.now()` 直用仍在（tool-factory.ts:287，行号随 #1054 合入后微移）

## 改动

采用 issue 建议处置**选项 1（注释标注时钟假设）**，不动代码行为：

- `checkModelQuotaHint` 头注释新增「时钟假设」段：声明单机同源时钟前提、多进程部署时的迁移方向（nowMs 注入接口，与 scheduler 时钟注入模式对齐）

选项 2（nowMs 注入接口）不做的理由：当前部署形态下无消费方，提前实现是 YAGNI；注释已锚定迁移方向，届时有真实需求再实现。

## 已知边界

- 本改动是纯注释，时钟偏差防护的实际需求（多进程/远端 DB）出现时，需按注释指引实现注入接口

## Modification-Class

`docs-config`（纯注释级改动，无逻辑变更）
