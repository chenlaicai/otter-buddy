---
id: F20260829cach
title: LLM prompt 前缀缓存命中率修复：时间戳日粒度化 + 派发链分钟级补偿 + 1h TTL 启用
summary: |
  搭档发现 GLM cache 命中率 92%，显著低于同事的 97%。全量分析最近 20 个 session 的
  1328 次 LLM 调用（session JSONL 真实 usage），实测总体命中率 92.3%，归因：
  ① identity-builder 注入的分钟级时间戳每次 invoke 重建，位于 system prompt 前部，
  一变即打断整个前缀缓存（invoke 边界 gap≤5min 组占 miss 17.3%，均值 32K tok/次）；
  ② 缓存 TTL 用 SDK 默认 5min，未启用 1h 长留存（gap>5min 组占 miss 47.9%）。
  修复：时间戳改日粒度（日内 system prompt 稳定）；派发链在 user message 注入分钟级
  当前时间（零缓存成本保新鲜度）；config 开关启用 PI_CACHE_RETENTION=long（1h TTL，
  已实测 GLM anthropic 兼容端点接受 ttl 字段）。预期命中率 92.3% → 96%+。
change_type: fix
status: active
capability_test: "n/a: 纯机制层改动（时间戳格式/env 注入），deterministic，由单测覆盖"
created_in_conversation: eecf065a-aec3-4c3a-8aa8-ccf86ad4d857
causal_links:
  from:
    - F20260825m422a
---

# LLM prompt 前缀缓存命中率修复

## 背景

搭档对比同事系统（97%），发现本系统 GLM cache 命中率仅 92%，要求排查是否存在隐晦设计导致缓存浪费。

## 数据分析（A1 事实优先）

数据源：`data/sessions/*.jsonl`（pi-coding-agent 持久化，含每次 LLM 调用的真实 usage：
input / cacheRead / cacheWrite）。分析最近 20 个 session、1328 次调用：

| 未命中来源 | 未命中 tok | 占 miss | 可修性 |
|---|---|---|---|
| invoke 边界 gap>5min（TTL 过期） | 2,975,639 | 47.9% | 1h TTL 可救 |
| invoke 边界 gap≤5min（TTL 内仍失效） | 1,077,987 | 17.3% | 时间戳是主因，可修 |
| invoke 内部（工具循环增量） | 1,937,020 | 31.2% | 理论下限 |
| 冷启动（session 首调） | 223,272 | 3.6% | 不可避 |

关键证据：
- 同分钟内的 invoke 边界缓存复用率 95-99%，跨分钟立刻掉到 0-30%（分钟级时间戳嫌疑的直接证据）
- invoke 首调未命中均值 32K tok（gap≤5min 组），远超正常增量——时间戳变 → system prompt 前缀失效 → 身份文案+工具定义（约 15.5K tok）+ 对话历史全部重算
- 长工具循环中段命中率 98-99%（`before_agent_start` 只在 prompt() 边界触发，循环内 system prompt 不变），反证破坏源在 invoke 边界
- cacheWrite1h 字段全程为 0——1h TTL 从未启用

## 根因

### 根因 1：分钟级时间戳每 invoke 重建（主犯）

- `identity-builder.ts:78-80`：身份前缀含 `## 当前日期时间 - 今天是 YYYY-MM-DD HH:MM`，
  `new Date()` 每次调用都变
- `pi-session-factory.ts:396`：每次 invoke 调 `buildIdentityPrefix()` 重建（历史决策 F20260810piab：
  system role 不被 session 持久化，必须每次注入——决策本身正确，错在时间戳跟着变了）
- `model-runtime-registry.ts:268`：identityPrefix 拼在 system prompt 前部（SDK base 之后、
  身份文案之前）——前缀一变，后面所有稳定内容全部作废

### 根因 2：缓存 TTL 未启用 1h 长留存

- pi-ai 的 anthropic-messages 适配器支持 `cache_control.ttl="1h"`（cacheRetention="long"），
  但触发条件是调用方传参或环境变量 `PI_CACHE_RETENTION=long`——两处都没配
- gap 5-60min 的 invoke 边界有 1.67M tok 未命中本可用 1h TTL 救回

## 修复方案

| # | 改动 | 位置 | 说明 |
|---|---|---|---|
| 1 | 时间戳日粒度化 | identity-builder.ts | `## 当前日期时间` 只含 YYYY-MM-DD，日内 system prompt 逐字节稳定。跨天首次 invoke 缓存断一次（可接受） |
| 2 | 派发链注入分钟级时间 | dispatch-chain-engine.ts | `## 当前时间`（YYYY-MM-DD HH:MM）注入每条派发消息首部（名册之后、任务之前）。随 user message 持久化、位于历史末尾——每 invoke 都是全新内容，不占缓存前缀。补偿①的新鲜度损失，#422 的日期锚点语义不弱化 |
| 3 | 1h TTL 开关 | config-service.ts + app.ts | config 新增 `llm.cacheLongRetention`（缺省 true），app.ts 启动时注入 `PI_CACHE_RETENTION=long`（尊重外部显式设置）。SDK getProviderEnvValue 读 process.env 生效 |

### 时间戳拆两处的取舍

- 全放日粒度：实现最简，但「现在几点」分钟级感知丢失（排期/看盘/超时判断场景受损）
- 全放分钟级在 user message：system prompt 完全稳定，但首轮 invoke（无历史时）若 SDK
  把首条 user message 纳入缓存断点之后的历史区，仍安全；风险在后续轮次首条 user message
  也在缓存前缀内（anthropic-messages 在最后一条 user message 打 cache_control 断点）——
  时间戳在首条 user message 里会打断「tools 定义 → 历史 → 首条消息」的缓存链
- **选定方案（日粒度 system + 分钟级派发消息）**：system prompt 日内稳定 + 分钟级新鲜度
  在每轮消息的「当前任务」前的稳定位置注入。时间戳位于消息前部（名册后、历史/任务前），
  名册+时间戳合计每轮重算成本 <200 tok，可忽略

## 验证

- GLM 端点 ttl 兼容性：直连 `open.bigmodel.cn/api/anthropic/v1/messages` 带
  `cache_control:{type:"ephemeral",ttl:"1h"}` 的请求实测 200 通过（响应含 thinking 正常输出）
- 单测：`tests/frameworks/agent/identity-prefix.test.ts`（日粒度格式 + 同日两次构建逐字节一致）、
  `tests/usecases/conversation/dispatch-chain-engine.test.ts`（两条路径均注入 `## 当前时间`、
  位置断言）、`tests/frameworks/config-service.test.ts`（cacheLongRetention 缺省 true / 显式 false）
- 全量 2020 测试通过，lint/tsc 干净

## 预期收益（按真实 usage 回放）

| 场景 | miss | 命中率 |
|---|---|---|
| 现状 | 5.46M | 92.3% |
| 仅修时间戳 | 4.55M | 93.6% |
| 时间戳 + 1h TTL | 2.88M | 96.0% |

剩余 miss 主体为工具循环增量（31.2%，理论下限）与冷启动（3.6%，不可避）。

## 风险与回滚

- GLM 端点若对 ttl 字段隐性降级（不报错但忽略），收益退化为仅时间戳项（+1.3pt）——上线后观察
  JSONL 的 cacheWrite/cacheRead 分布即可确认
- 回滚：`llm.cacheLongRetention: false` 关 TTL；时间戳改动无配置开关（语义正确性不依赖配置）
