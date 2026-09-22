---
id: F20260922abfx
title: 中断归因 abort 自身错误过滤漏匹配：Request aborted（无 was）变体
summary: 'isAbortOwnError 的正则只匹配 Request was aborted 写法，生产现场 SDK 实际抛出的另一种写法 LLM API error: Request aborted（无 was）漏过滤，被误判为底层 API 错误，导致用户中断消息附上误导性的「底层错误」段；修复为正则放宽覆盖全部已知变体。'
change_type: fix
capability_test: tests/usecases/conversation/agent-turn-orchestrator/exit-classifier.test.ts
created_in_conversation: ad1578ad-008f-4c20-b210-b50aa3f6de77
intent:
  problem: '用户主动中断时，SDK abort 副作用错误（Request aborted 变体）未被 isAbortOwnError 过滤，中断归因消息错误地附上「底层错误：LLM API error: Request aborted」段，把主动中断写得像异常现场'
  expected_effect: '全部已知 SDK abort 错误变体（有/无 was）被识别为 abort 自身产物，纯主动中断走简洁文案「[搭档中断] 搭档中断了当前发言。」；真实 API 错误（429 等）仍如实归因'
  verify_by:
    type: static_only
    note: 纯字符串匹配逻辑，由 vitest 用例静态锁定（含修复前失败证据），无 LLM 场景
tags: [bugfix, conversation, interrupt-attribution]
modules: [src/usecases/conversation/agent-turn-orchestrator/exit-classifier.ts, tests/usecases/conversation/agent-turn-orchestrator/exit-classifier.test.ts]
---

# F20260922abfx 中断归因 abort 自身错误过滤漏匹配修复

## 问题

搭档现场（2026-09-22）：点击中断后系统消息为
`[chen中断] 当前发言未能开始（114 次工具调用），底层错误：LLM API error: Request aborted，chen中断了等待。`

该文案是「有底层 API 错误」档（retry-policy.ts buildUserAbortBody 第一分支），但本次中断是纯主动中断——`Request aborted` 是 abort 动作自身的 SDK 副作用，不是中断前已存在的底层错误。错误归因让消息读起来像异常现场。

## 根因

exit-classifier.ts `isAbortOwnError` 的过滤正则 `/Request was aborted/i` 只匹配一种写法。生产现场 SDK 抛出的实际文案是 `Request aborted`（无 was），漏匹配 → classifyExit 将其归为 `api_error` 底层错误 → buildUserAbortBody 走啰嗦归因档。

文案口径本身（确证事实 + 附原文，不归因断言）是 F20260913ctlv 搭档拍板的设计，本次不动；动的只是过滤器盲区。

## 修复

正则放宽为 `/request\s+(?:was\s+)?aborted/i`，覆盖两种已知变体（`Request was aborted` / `Request aborted`，含 `LLM API error:` 前缀形态）。

## 设计取舍

- 机制识别检查点：全部未命中（一行正则收窄误报面，既有语义内修，无新机制）。Modification-Class: narrow-fix。
- 误匹配风险评估：`request\s+(?:was\s+)?aborted` 语义上只可能描述 abort 动作的产物，真实 API 错误（429/连接拒绝等）不会含此文案——放宽不引入误过滤。已有测试用例「真实 API 错误 → false」锁定该侧边界。
- 最简实现检查：正则可选分组是最小改动，无需新依赖/新函数。已过最简检查。

## 验证

- 修复前失败证据：`git stash -- src/` 后复跑，新增用例 2 个失败（`Request aborted` 与 `LLM API error: Request aborted` 均返回 false / underlyingError 被误判为 api_error）
- 修复后通过：exit-classifier + retry-policy 等 agent-turn-orchestrator 目录 5 个测试文件 75 用例全绿
