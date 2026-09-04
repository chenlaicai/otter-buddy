---
id: F20260904cq30
title: 上下文质量主线：compaction 触发线 300K（质量优先阈值修正）
summary: pi compaction 触发线从"贴窗才压"（1048576−16384≈1032K）修正为 300K 质量线，修正 9/1 #643 之后上下文防线真空区导致的 session 无限膨胀与 LLM 表现退化。
change_type: fix
created_in_conversation: 7b5a13fc-5d21-4977-bec2-68fc1da24ae7
tags: [context-quality, compaction, threshold, long-context, observability]
modules: [src/frameworks/agent/]
from: [F20260903cmpk, F20260901cxmw]
supersedes: []
---

## 背景

搭档原话（意图锚）：

> 「昨天一天，在对话《对话中invoke机制》等，我生气了好几次，我感觉大獭表现蠢蠢的（会瞎说、不诚实、糊弄、听不懂我的纠正），然后我今天一来我看到上下文是 500k，我突然有个想法，是否是因为上下文太长，导致 llm 表现变差了？因为之前几天我一直觉得海獭们很聪明、做事利索」

排查结论（2026-09-04，对话《系统优化》）：

1. **表现退化与上下文规模强相关**。messages.context_tokens 全量数据：大獭 8/28-9/1 均值 60-73K（好体验区，搭档「聪明利索」体感）→ 9/2 均值 114K → 9/3 均值 266K、峰值 743K、80 条消息超 300K（退化区，搭档连续生气）。
2. **膨胀机制**：9/1 10:52 #643（F20260901cxmw）将 handoff 阈值从「128K 一刀切占位」修复为「按模型真实窗口×0.7」——修复方向正确，但 config 中 glm/mimo 窗口均配 1M，阈值跳至 737K。9/3 #770（F20260903cmpk）退役 70% handoff 后，唯一活着的防线是 pi compaction（窗口−reserve：1048576−16384=1032192≈1032K）。**质量拐点（~100-300K）到 1032K 之间成为无人区**，session 无限膨胀、零压缩。《对话中invoke机制》大獭 session（01a05fbe）实测：9/2 早 29K → 9/4 凌晨 538K，1054 次工具调用堆积 1.6M 字符（bash 占 950K）。
3. 长上下文退化为当前代 LLM 的机制本质（注意力 softmax 稀释 + lost-in-the-middle），KV cache 只省成本不救质量。物理窗口是油箱，不是工作区。

同主线兄弟 issue：#776（bash→grep/find/ls 专用工具，削减膨胀源头）、#779（历史图片外置，消灭 97% 体积的图片堆积）。本 issue（#780）解决「膨胀后何时压」。

## 目标

T1: pi compaction 触发线从 1032K 修正为 **300K**（质量优先）
T2: 机制不动——#770 七段压缩钩子（threshold 路径）继续接管摘要算法
T3: 水位 300K 以下会话零感知（现状不受影响）

## 非目标

- **不设预警线/提前收尾提醒**。搭档否决原提案「超线后提醒 LLM 自己 decide 提前收尾」：「这是诱导 llm 别管对错，快速做完收尾，等于是质量失控事故了」。
- **不做长任务豁免/手动 override**。无实际场景（搭档：「目前没有这么大上下文场景（并且咱们的 handoff 和记忆系统无法满足的），暂不考虑」）；长任务正确姿势是子代理分段派工。
- 不改七段压缩算法、不改 keepRecentTokens、不动 #776/#779 的膨胀源头治理。

## 决策记录

| 决策 | 结论 | 依据 |
|---|---|---|
| 触发线取值 | 300K | 搭档拍板。240K 提案被否：「复杂服务简单几次对话就飙到 200k，高频触发压缩得不偿失」；300K 在好体验区（60-90K）3 倍余量之上，且低于实测退化区间起点 |
| 预警线 | 不设 | 诱导 LLM 赶工收尾 = 质量失控事故（搭档原话） |
| 长任务豁免 | 不做 | 无场景；子代理分段是正解 |
| 实现层 | reserveTokens 16K→700K | 触发公式 `contextTokens > contextWindow − reserveTokens`，1M 窗口下 1M−700K=300K。配置级改动，机制零变更 |

## 方案设计

### 改动

**① 触发线注入（config 化，搭档要求）**

`config.yaml.example` 新增 `contextQuality.compactionReserveTokens: 700000`（缺省 700_000）；`config-service.ts` 解析；`model-runtime-registry.ts` applyOverrides 读 config：

```ts
this.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 4 }, compaction: { reserveTokens: getConfig().contextQuality.compactionReserveTokens } });
```

本地 config.yaml 无此字段时走缺省值，**无需手动同步**。

applyOverrides 是 SDK 公开 API（`Partial<Settings>`，settings-manager.d.ts），`Settings.compaction?: CompactionSettings` 字段存在，且 Otter 已有 retry 注入先例——同模式扩展，无新依赖。

**merge 语义**（检视发现 3）：applyOverrides 走 deepMergeSettings 部分合并——仅覆盖显式注入的字段。本方案只注入 `reserveTokens`，`compaction.enabled`（默认 true）与 `keepRecentTokens`（默认 20000）保留 SDK 默认或用户 settings.json 配置值，不做全面接管。

**② 假水位线删除（搭档审计拍板）**

40 天运行日志实查（2026-07-27 至今）：token-warning 日志 1278 次（8月 679 + 9月 593）**零下游消费**；且 config `circuitBreaker.tokenWarningThreshold: 50000` 与硬编码 `TOKEN_WARNING_THRESHOLD: 100_000` 是两个值两条独立路径，配置项形同虚设。上下文水位域曾有两条假线一个真空，本次收敛为**唯一真相源**：

- 删 `config.yaml.example` 的 `tokenWarningThreshold` + `config-service.ts` 解析 + `CircuitBreakerConfig` 字段
- 删 `circuit-breaker-helpers.ts` 的 `TOKEN_WARNING_THRESHOLD`/`checkTokenWarning`（及其在 buildInvokeResult 的调用点）
- 熔断器（94 次真实战果）与 degenerate 检测（538 次检测）不动
- 观测路径不变：水位数据每消息落 DB（messages.context_tokens）

```
触发线验证：contextWindow(1_048_576) − reserveTokens(700_000) = 348_576 ≈ 340K 触发
```

> 注：300K 为标称值，实际触发 340K（整数好算的 reserveTokens 700K）。误差在退化区间起点（实测 266K 均值已退化，340K 已在其上）与 240K 提案之间，可接受；如需精确 300K 可用 reserveTokens=748_576，无实质收益。

### 机制链路（不变，列出供审视核对）

1. 每次 LLM 响应前 pi 检查 `shouldCompact(contextTokens, contextWindow, settings)`
2. 超 340K → threshold compaction → Otter 的 `session_before_compact` 钩子（#770）用七段合成替换默认摘要
3. 压缩后保留最近 ~20K tokens（keepRecentTokens 默认），回落至安全水位
4. metrics `agent_compaction_total{reason=threshold}` 记录触发

### 已知边界（记录，不处理）

- 全局 reserveTokens 对小窗口模型（未来若加 200K 窗口模型）会产生负触发线（恒触发）。届时需按模型区分（Otter config 层注入 per-model reserve）。当前 mimo/glm 均 1M，无此问题。
- compaction 摘要合成本身是一次 LLM 调用（readOnly session），300K 触发时单次成本 ~340K input——比 9/3 之前每轮 500K+ 全量重算便宜（cacheRead 命中后更甚），且换来后续所有轮次的上下文瘦身。

## 影响范围

- 所有 otter session（big/small）：水位超 340K 时触发压缩（此前要到 1032K）
- 高频长任务（如 Self-Healing daily-review）：从「永不压缩」变为「可能每日 1-2 次压缩」，压缩期间该 session 暂停响应（合成耗时 ~10-60s，#770 有 60s 超时降级）
- 无 schema 变更、无 API 变更、无 UI 变更

## 风险与约束

- R1: 压缩信息损失——七段合成质量决定。已有 #767（截断摘要拒绝落盘）+ #770 降级链路兜底
- R2: 首次上线后存量长 session（如本对话大獭 538K）会在下轮 invoke 触发压缩——预期行为，但需观察首压体验
- R3: settings.json 用户配置与代码注入的 merge 语义见§方案设计——partial merge，仅 reserveTokens 被接管

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 配置化 vs 硬编码 | config.yaml contextQuality.compactionReserveTokens（缺省 700_000） | 硬编码在 registry | 搭档要求可调；生效点仍是 applyOverrides，pi 公式不动 |
| 假水位线处置 | 删除（两条） | 保留/接告警 | 1278 次日志零消费，观测走 DB；保留 = 维护而成本无收益 |

## 验证

- V1: 单测——shouldCompact 以 reserveTokens=700K、contextWindow=1048576 在 340K 边界触发/不触发
- V2: 集成——现有 session 水位超线的 invoke 触发 `agent_compaction_total{reason=threshold}` 且七段钩子接管
- V3: 现状回归——水位 <300K 的会话零压缩行为（metrics 无新增）

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| config/config.yaml.example | 修改 | 新增 contextQuality.compactionReserveTokens；删 circuitBreaker.tokenWarningThreshold |
| src/frameworks/config-service.ts | 修改 | 解析 contextQuality；删 tokenWarningThreshold 字段/解析 |
| src/frameworks/agent/model-runtime-registry.ts | 修改 | applyOverrides 读 config 注入 reserveTokens |
| src/frameworks/agent/circuit-breaker-helpers.ts | 修改 | 删 TOKEN_WARNING_THRESHOLD/checkTokenWarning 及调用点 |
| src/frameworks/agent/tool-call-circuit-breaker.ts | 修改 | 删 CircuitBreakerConfig.tokenWarningThreshold |
| tests/frameworks/agent/compaction-threshold.test.ts | 新增 | 340K 边界 8 用例 |
| tests/frameworks/agent/context-tokens.test.ts | 修改 | 假水位线删除回归锁（导出不存在断言） |
