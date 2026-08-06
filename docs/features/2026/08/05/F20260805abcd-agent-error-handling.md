---
id: F20260805abcd
title: agent-error-handling
doc_type: feature

summary: |
  Agent 错误处理与 Kimi Provider 支持：修复 LLM API 错误时错误触发 speak 重试、
  添加 kimi-coding provider 支持、修复 Self-Healing 对话重复创建（CAS 模式）。
---

# F20260805abcd: Agent 错误处理与 Kimi Provider 支持

## 问题描述

### 问题 1：LLM API 错误时错误触发 speak 重试
当 LLM API 调用失败时（如 Kimi model ID 配置错误），系统显示的错误信息是误导性的：
```
[系统] 重试后仍未调用 speak 工具
```
真实的 API 错误被吞掉了，用户看到的是 speak 重试失败的信息。

### 问题 2：Kimi API Invalid request Error
Kimi API 返回 "Invalid request Error"，原因是 `provider: "anthropic"` 导致 SDK 用 Anthropic 模板继承了错误的 `thinkingLevelMap`、`compat`、`headers`，发送了 Kimi 不支持的 `output_config: { effort: "xhigh" }`。

### 问题 3：Self-Healing 对话重复创建
并发启动时，两个进程都读到 settings 为空，各自创建对话，导致重复。

## 根因分析

### 问题 1 根因
pi-coding-agent SDK 在 LLM API 调用失败时，会自动重试，但最终返回空响应而不是抛出异常。`session.state.errorMessage` 包含了真实的错误信息，但 otter-buddy 没有检查它。

### 问题 2 根因
在 `models-factory.ts` 的 `loadCustomProvider` 中，当 modelId（"k3"）不在 ANTHROPIC_MODELS 中时，会使用第一个 Anthropic 模型（claude-fable-5）作为模板。这导致继承了错误的 `thinkingLevelMap`、`compat`、`headers`。

### 问题 3 根因
TOCTOU (Time-of-Check-to-Time-of-Use) 竞态条件。`ensureHealingConversation` 先检查 settings，如果没有就创建对话。但检查和创建之间没有互斥保护，两个并发执行流都可能在检查时读到空值。

## 修复方案

### 修复 1：添加错误检测
在 `PiSessionFactory._executeWithSession` 中添加 `_checkSessionError` 方法，检查 `session.state.errorMessage`，如果有错误则抛出异常。异常会被 `agent-invoker` 捕获，调用 `handleInvokeError` 报错。

### 修复 2：添加 kimi-coding provider 支持
- 修改 `config-service.ts` 白名单添加 `kimi-coding`
- 修改 `models-factory.ts` 添加 `kimi-coding` provider 支持
- 在 `_registerRuntimeModel` 中同时设置 API key 到 alias 和 provider

### 修复 3：使用 CAS 模式修复 TOCTOU
使用 CAS (Compare-And-Swap) 模式：
1. 先写入临时值占位
2. 再二次确认值是否是自己写入的
3. 如果不是，说明另一个进程抢先了，等待其完成后读取结果

## 测试

- 启动系统
- 发送消息给大獭
- 验证 Kimi API 正常工作
- 验证错误信息正确显示
- 验证 CAS 模式的行为

## 相关文件

- `src/frameworks/agent/pi-session-factory.ts`
- `src/frameworks/llm/models-factory.ts`
- `src/frameworks/config-service.ts`
- `src/usecases/healing/ensure-healing-conversation.ts`
- `src/usecases/recruiting/ensure-recruiting-conversation.ts`
- `tests/usecases/healing/ensure-healing-conversation.test.ts`
