---
id: F20260818a3mv
title: model-visible-parity-tool
doc_type: feature

summary: |
  实现 A3 模型可见内容重建比对工具（R20260817dshp 采纳项，issue #289 第一项，PR-C 前置）。
  动机：批次3 PR-C（编排上提，全案最高风险）的验证面只有指标契约（答"行为统计没漂"），
  缺"模型看到的东西没变"的逐字段证据。
  主机制：本地录音网关——伪 anthropic 端点，SDK 全链路照常发真实请求，wire 级请求体
  （system+messages+tools）即模型可见输入的最终真相；规范化（tmpDir/UUID/时间戳编号替换）
  后快照，支持 capture/compare 两模式供重构前后比对。

causal_links:
  from:
    - R20260817dshp

status: implemented
change_type: feature
tags: [testing, capability, agent, refactor-safety]
modules:
  - tests/capability/helpers/model-visible.ts
  - tests/capability/model-visible-parity.capability.test.ts
  - tests/capability/helpers/boot.ts
capability_test: tests/capability/model-visible-parity.capability.test.ts
---

# F20260818a3mv: A3 模型可见内容重建比对工具

## 背景与需求

### 问题描述

R20260817dshp（dsh 插件化借鉴研究）裁决的 A3：重构/换 provider 前后，需要能证明"到达模型的完整输入逐字段等价"。批次3 PR-C（AgentInvoker 编排上提）动工在即，现有验证面只有 F20260814mtrc 指标语义契约——它是统计性的，答不了"模型看到了什么"。

### 根因分析

模型可见输入的三部分获取难度不同：

| 部分 | 落盘情况 |
|------|---------|
| 消息序列 | session JSONL 有（但需复现 stripHistoricalThinking 等内存变换） |
| system prompt | **不落盘**（每次 invoke 动态拼装：SDK base + otter_configs + 身份前缀） |
| tools schema | **不落盘**（每次 invoke 由 tool-factory + otterType 门控生成） |

从 session 文件重建必然缺后两者，且要复现 SDK 内部变换——脆弱。

### 数据实锤

- pi-session-factory.ts 注释明示"system prompt 不被 session history 持久化……每次都构建"
- pi SDK ModelRuntime 走 provider 注册表发真实 HTTP，不认 pi-ai faux provider（实测报 "No API key found for faux"）

## 方案设计

### 技术方案

**录音网关（wire 级捕获）**：本地 HTTP 服务器伪扮 anthropic 端点。boot 时 llm 配置整体替换为指向它（provider=anthropic + 假 key + apiBaseUrl），SDK/pi-ai/AgentSession 全链路照常运行。网关做两件事：记录每个请求体（就是 wire 级模型可见输入最终真相，含全部内存变换后的形态）；按脚本回放 anthropic SSE 响应驱动确定性对话。

**方案迭代史（首版 faux 捕获被否）**：最初方案是给 pi-ai faux provider 安装录音工厂（factory 收到的 Context 即完整输入）。实测被 SDK 鉴权层拦死——agent 链路不经过注入的 Models 对象。改走网关后反而获得更高保真：捕获的是真实发出的字节，连"内存变换是否正确反映到 wire"都覆盖了。

**规范化**：tmpDir 路径、UUID、ISO 时间戳按首次出现序编号替换（`<TMP>`/`<UUID:n>`/`<TS:n>`，编号制保持 tool_use↔tool_result 配对）；剔除非确定性字段。快照带 formatVersion 与场景标识，防拿错场景比对。

**工作流**：
```
基线分支: A3_SNAPSHOT_CAPTURE=path npx vitest run --config vitest.capability.config.ts tests/capability/model-visible-parity.capability.test.ts
重构分支: A3_SNAPSHOT_FILE=path （同命令）——diff 为空 = 模型所见零漂移，非空则逐路径报差异
```
默认模式（无环境变量）跑结构健全性 + 规范化确定性自检，CI 常规价值。

### 目标

- T1: wire 级捕获模型可见输入全集（system + messages + tools）
- T2: capture/compare 快照工作流可用，差异定位到字段路径
- T3: 不引入任何生产代码改动（boot.ts 仅测试辅助扩展）

### 成功标准

- 同代码两次运行 compare 通过（确定性成立）
- 篡改基线一个字能精确定位差异路径

## 验收标准

### 验收场景
| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | wire 捕获完整性 | 跑测试默认模式 | 2 次请求：system 非空、34 工具含 speak、消息含两轮输入与累积上下文 |
| AT-2 | capture/compare 工作流 | capture 后立即 compare | 逐字段等价通过 |
| AT-3 | 差异定位精度 | 篡改基线 system 一字后 compare | 报 `$[0].system[0].text` 级路径差异 |

### 能力测试映射
| 验收场景 | 能力测试文件 |
|---------|-------------|
| AT-1/2/3 | tests/capability/model-visible-parity.capability.test.ts |

## 实现细节

### 代码修改
- `tests/capability/helpers/model-visible.ts`（新增）：RecordingGateway（http 服务器 + anthropic SSE 回放）、canonicalizeRequests、diffCanonical、快照 IO
- `tests/capability/model-visible-parity.capability.test.ts`（新增）：两轮 speak 收尾确定性场景 + 三模式断言
- `tests/capability/helpers/boot.ts`：BootOptions 增 `recordingGatewayUrl`——提供时 llm 整体替换为指向网关的伪端点

### 逻辑变更
生产代码零改动。boot 的网关注入发生在 resolveTestConfig 之后、detectLlm 之前，llmAvailable 判定照常走真实配置路径。

### 已知边界
- compaction 场景未覆盖（两轮短对话不触发；触发后 compaction summary 本身也是模型可见内容，会被如实捕获）
- 网关回放的是 anthropic-messages 协议；换 openai-responses provider 做实验时需扩展回放格式
- waitForOtterMessage 多轮场景必须锚定**当轮** user 消息 seq（本次踩坑两次：锚第一轮 user 会误匹配第一轮 otter 的 completed）

## 验收结果

### 测试结果
- 能力测试 3/3 通过（默认模式）；capture→compare 工作流通过；负向篡改测试定位到字段路径
- A 类全量 1231 用例通过

### 证据判定
| 需求 | 证据状态 | 判定 |
|------|---------|------|
| wire 级捕获完整性 | 证明完成 | ✅ |
| capture/compare 工作流 | 证明完成 | ✅ |
| 差异定位精度 | 证明完成 | ✅ |

## 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 捕获点 | wire 级网关 vs faux Context vs session JSONL 重建 | 网关唯一覆盖 system prompt + tools schema 且免复现内存变换；faux 被 SDK 鉴权层否决；JSONL 重建缺两部分 |
| 确定性 | 录音网关脚本回放 vs 真 LLM 多次采样 | 比对逐字段等价要求确定性，真 LLM 输出不可比 |
| 快照存放 | 仓库外文件（环境变量指定路径）vs 仓库内 | 基线属特定重构工作流临时产物，不进仓库；格式带版本与场景标识防误用 |
