---
id: F20261014rmqt
title: "配额看板功能移除"
summary: "F20261012qtbc 配额看板上线后 GLM/MiMo 字段映射错误（上线即不可用）、Kimi 登录态存 Session Storage 无法持久化采集，搭档确认功能价值低于维护成本，整体移除。"
change_type: refactor
capability_tags: [quota, health-panel]
intent:
  problem: "配额看板（F20261012qtbc）上线后三家全不可用：GLM/MiMo 字段映射与真实响应不符、Kimi 登录态存 Session Storage 不落盘无法持久化采集；搭档确认不再需要该功能"
  expected_effect: "健康面板恢复为 4 个 Tab（总览/警报/进行中的事/用量效率），配额相关代码全部移除"
  verify_by:
    type: behavior_check
created: 2026-10-14
created_in_conversation: 11806e11-1cac-4d00-b263-badff1a80f2b
tags: [quota, health-panel, removal]
modules: [src/frameworks/quota, src/usecases/quota, web/src/pages/health]
causal_links:
  - F20261012qtbc   # 配额看板初版（本特性将其移除）
---

# 配额看板功能移除

## 背景

F20261012qtbc 实现了三家控制台（GLM/Kimi/MiMo）token 余量统一展示，2026-10-12 合入（PR #1445）。上线后发现以下问题：

1. **GLM/MiMo 字段映射错误**：归一化代码按静态逆向猜字段名，与真实响应结构不符，导致上线后 GLM 只显示「剩 —」、MiMo 直接「采集失败」
2. **Kimi 登录态无法持久化**：Kimi 网页登录态存 Session Storage（不落盘），Chrome profile 关窗即焚，无法像 GLM/MiMo 那样「一次登录长期采集」
3. **搭档确认不再需要**：2026-10-13 17:35，搭档明确表示「那算了。你把这个功能整个移除吧，我不需要」

## 下线缘由（搭档拍板）

| 问题 | 根因 | 处置 |
|---|---|---|
| GLM/MiMo 上线即不可用 | 字段映射未首登冒烟锁定 | 已修（PR #1458），但搭档已决定移除 |
| Kimi 无法自动采集 | 登录态存 Session Storage 不落盘，开放平台无配额查询 API | 需单次登录后 token 落盘或 CDP attach 抓包，搭档不愿配合 |
| 维护成本 | 三家控制台页面结构随时可能改版，需持续维护字段映射 | 功能价值低于维护成本 |

## 移除范围

| 层 | 移除内容 |
|---|---|
| 前端 | 健康面板「配额」Tab、QuotaBoard 组件、API client 配额接口 |
| 后端 | GET /api/quota、POST /api/quota/login 端点 |
| 服务层 | QuotaService 采集编排、QuotaBrowserSession 浏览器会话 |
| 领域层 | GLM/Kimi/MiMo 归一化纯函数、配额类型定义 |
| 测试 | quota 域全部单测（归一化 12 + 服务 12 + 前端 4） |

## 保留

- 本特性文档（记录「做过但移除」的完整决策轨迹）
- `data/quota-browser/` 本地浏览器 profile（不进 git，可手动删）

## 相关 PR

- #1445：配额看板初版（已合入，已移除）
- #1458：字段映射修复（已关闭，未合入）
- #1464：功能移除（本 PR）

## 教训

1. **首登冒烟必须在交付前完成**：字段映射类功能上线前必须用真实账号验证，不能留「待首登锁定」的尾巴
2. **登录态持久化是硬门槛**：Session Storage 类登录态无法自动采集，功能设计阶段就该识别并排除
3. **API 可用性前置调研**：Kimi 开放平台无配额查询端点，应在方案阶段确认而非上线后才发现
