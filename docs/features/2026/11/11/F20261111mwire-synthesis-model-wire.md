---
id: F20261111mwire
title: 合成模型覆盖到达线缆（withModelOverride 按需影子解析）
summary: "#1854（PR #1852 检视 B1）：durable Harness 经 models.getModel(provider,id) 重解析模型，合成副本上的 maxTokens/thinkingLevelMap 覆盖到不了线缆（F20260924swin 显式 max_tokens 自 #1783 迁移后空转，线缆实际走池模板 128000+空表）。修复：withModelOverride(base, override) 用 Proxy 包装 models 源——仅 getModel 命中目标 (provider,id) 时返回覆盖副本，其余成员 bind 底层透传（auth/凭据/流式链路零改动），不改共享底层源（WeakMap 池缓存，就地改会泄漏全 session）；runSynthesisAttempt 每次 attempt 独立包装、随一次性 session 销毁。真端点 smoke 三重实证：capability map attached + effort:none 400 消失（kimi-lty 转为周配额 429）+ F3 兜底实战救场（429→glm 成功）。"
change_type: bugfix
capability_test: "tests/frameworks/agent/synthesis-model-wire.test.ts 3 例：线缆命中（getModel 返回 8192+真值表副本）/不泄漏（非目标委托原样、底层不被改）/单元（透传成员可调、覆盖不落底层）"
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
causal_links:
  from: [F20261111synth, F20260924swin, F20261109pidrx]
  supersedes: []
tags: [session, durable, llm, narrative-synthesis, models]
modules:
  - src/frameworks/agent/durable-model-runtime.ts
  - src/frameworks/agent/pi-session-factory.ts
---

# 合成模型覆盖到达线缆（F20261111mwire）

## 问题（#1854，PR #1852 检视 B1）

durable Harness 的模型解析在请求期发生：`agentChange()` 只传
`{provider, modelId}`（durable-session.ts），`generation.js:138` 经
`runtime.models.getModel(provider, id)` 从 models 源**重解析**——合成模型副本上的
覆盖（maxTokens 8192、thinkingLevelMap 真值）被池模板替换（maxTokens 128000、
空表）。后果：

- F20260924swin 的「显式合成 max_tokens」自 #1783 durable 迁移后空转（PR #1852
  只是把一个空转常量翻倍，检视定谳）；
- 「输入容量 = 窗口 − max_tokens」的预算断言在线缆上不成立。

现状良性（模板 128000 经 clampMaxTokensToContext 自动收缩，远大于 low 档思考 +
正文需求），但机制语义断链——本修复接回。

## 方案

`withModelOverride<T>(base, override): T`（durable-model-runtime.ts）：

1. **Proxy get 委托**：仅 `getModel` 命中目标 `(provider, id)` 时返回覆盖副本；
   其余属性 `Reflect.get(target, prop, target)` + 函数 bind 到底层——auth/凭据/
   streamSimple/completeSimple/fetchDeferred/cancelDeferred（pi-durable harness 对
   models 源的全部使用面，全量 grep 实证）零改动透传。
2. **不改底层**：底层 models 源是 WeakMap 池缓存的共享实例（getModelSource），
   就地修改会泄漏到全部 session——Proxy 只读包装，底层 `getModel` 结果原样。
3. **一次性作用域**：runSynthesisAttempt 每次 attempt 独立包装，随临时 durable
   session（durable-synthesis-*.sqlite）销毁，零跨 session 泄漏。

## 真端点 smoke（2026-11-11，真实 config + kimi-lty，一次性小 prompt）

| 观测 | 结果 |
|---|---|
| `capability map attached` 日志（F1） | ✅ kimi-lty 挂真值表，requestedLevel=low |
| effort:none 400 | ✅ 消失——kimi-lty 报的是**周配额 429**（参数已被端点接受，错误类别变了） |
| F3 兜底实战 | ✅ 429 → glm 重试 → `shadow channel completed`（372 chars） |

附注：kimi-lty 周配额当日已耗尽——生产期换世合成将由 F3 兜底（glm）护住，
kimi 配额恢复后自动回到主模型。

## 影响范围

- 行为变更（有意）：合成请求线缆携带副本值——max_output_tokens=8192（原为模板
  128000 经 clamp）、thinkingLevelMap 真值进请求构造（effort 词表映射）。
- 零改动：聊天路径（不含 runSynthesisAttempt）、models 池缓存、auth 链路。
- 爆炸半径：单 worktree、2 源文件 + 1 测试文件、git 可回滚、仅合成一次性 session。

## 验证

- 红测先行：2 红（线缆命中 + withModelOverride 单元）+ 1 绿（不泄漏反例）→ 实现
  后 3/3；全量 5899+18/5899+18（含需 dist 的 durable-runtime SIGKILL fixture）、
  tsc、lint 通过。
- 真端点 smoke 三重实证（上表）。

## 谱系

F20260924swin（显式 max_tokens 起源）→ #1783（durable 迁移，机制断链）→
F20261111synth（#1852 检视 B1 发现断链并立案）→ 本修复接回线缆。
