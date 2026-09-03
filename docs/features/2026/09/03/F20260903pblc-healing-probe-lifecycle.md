---
id: F20260903pblc
title: 健康探针 healing 事件无限堆积：写入即 resolved + query 默认过滤
doc_type: feature
summary: |
  修复 #751：F20260827he2f 上线的 healing 健康探针每半小时落一条 open 事件，
  写入后无生命周期管理，open 污染率 50%（10/20），真实事件被心跳稀释。
  双侧修复：①写入侧——探针事件直接落 status=resolved + resolution 标记
  （heartbeat 语义，写入与 resolve 同一 INSERT，无中间态）；②消费侧——
  manage_healing_events query 默认过滤探针（含历史堆积），includeProbe=true
  保留诊断通道。探针对 DB 列完整性的验证能力不变。

causal_links:
  from:
    - F20260827he2f   # 探针引入（本次修复其生命周期断点）

status: final
change_type: fix
tags: [healing, probe, lifecycle, observability, debt-cleanup]
modules:
  - src/interface-adapters/agent-runtime/circuit-break-support.ts
  - src/interface-adapters/agent-runtime/tools/healing-tools.ts
  - src/usecases/healing/constants.ts
intent:
  problem: "健康探针事件以 open 状态堆积 healing 台账（open 池污染率 50%），稀释真实事件"
  expected_effect: "探针落账即 resolved，open 池不再被心跳刷屏；query 默认过滤探针，消费侧诊断不再受探针干扰；诊断通道 includeProbe=true 可查探针本身"
  verify_by:
    type: static_only
    reason: "纯 A 类代码逻辑改动（生命周期状态 + 过滤逻辑），无 LLM 参与——vitest 单测/集成测试覆盖（写入侧 resolved 断言 + 消费侧过滤 6 用例）+ 全量回归 2834 tests + tsc"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
---

# F20260903pblc: 健康探针 healing 事件无限堆积

## 背景与需求

### 问题描述

issue #751：`manage_healing_events(query, status=open)` 返回 20 条，其中 10 条为探针事件（`probe-test` 哨兵标识），从 9/2 02:20Z 起每半小时一条规律堆积。探针是「验证 healing 管道连通」的心跳，不是问题——它以 open 状态进池后无人 resolve、无 TTL、query 无过滤，生命周期断在写入端。

### 影响面

- daily-review / 自愈分析每次都要人工跳过探针
- 真实事件（熔断、退化、重启）被心跳稀释——open 池 50% 是探针刷屏
- 长期抬高台账噪声底噪（dismissed 池已见 8/28-8/30 五条历史堆积实证）

### 根因定位

写入端：`CircuitBreakSupport.probeHealingRepo()`（F20260827he2f 引入）——写路径探针插入 `status: 'open'` 测试记录，注释自述「测试记录会被 autoStaleDismiss 清理（低严重度，7 天后自动清理）」，但实际依赖的 autoStaleDismiss 清理窗口是 30 天（scheduler-service.ts:534 `autoStaleDismiss(30)`），且清理前探针持续以 open 状态占用 open 池。

## 方案设计

issue 推荐方案 1+2 组合（方案 3 迁独立表不采纳）：

1. **写入侧：探针写入即 resolved**——status 直接落 `resolved` + resolution（heartbeat 语义）。写入与 resolve 在同一次 INSERT 完成，不存在「create 成功 + resolve 失败」的中间态。探针对列完整性的验证能力不变（INSERT 仍走全列，列缺失仍被检出）。
2. **消费侧：query 默认过滤探针**——历史堆积的 open 探针（本次修复前产生的）依旧在池中，查询时默认过滤兜底。`includeProbe: true` 保留诊断通道（验证探针是否在正常写入）。

方案 3（迁独立表）不采纳：探针数量级一天 48 条，独立表引入 schema 迁移成本，收益不成比例。

### 哨兵常量抽取

`'probe-test'` 字面量从 CircuitBreakSupport 内联值抽为共享常量 `HEALING_PROBE_SENTINEL`（src/usecases/healing/constants.ts），并配套判定函数 `isHealingProbeEvent()`——防写入侧与过滤侧字面量漂移导致过滤失配。

## 变更内容

| 文件 | 变更 |
|------|------|
| `src/usecases/healing/constants.ts` | 新增 `HEALING_PROBE_SENTINEL` 常量 + `isHealingProbeEvent()` 判定函数 |
| `src/interface-adapters/agent-runtime/circuit-break-support.ts` | 探针事件写入即 `status: 'resolved'` + resolution 标记（notes 注明 #751）；移除误导性的「autoStaleDismiss 7 天清理」注释 |
| `src/interface-adapters/agent-runtime/tools/healing-tools.ts` | query 默认过滤探针（open/resolved/dismissed 全状态池）；新增 `includeProbe` 参数（默认 false）；工具 description 补过滤说明 |
| `tests/interface-adapters/agent-runtime/circuit-break-healing-persist.test.ts` | 新增探针写入即 resolved 断言（status/resolution/resolvedAt + open 池不含探针） |
| `tests/interface-adapters/agent-runtime/tools/healing-probe-filter.test.ts` | 新增 6 用例：默认过滤 open 探针 / includeProbe 诊断通道 / resolved 池过滤 / 混合池真实事件保留 / 全探针池空返回 / errorType 叠加过滤 |

### 过滤范围决策：全状态池而非仅 open

修复后新探针全部落 resolved，但 query 对 resolved/dismissed 池同样默认过滤——探针一天 48 条，resolved 池 50 条展示位会被探针刷掉 100%，真实 resolved 事件同样被稀释。诊断通道 `includeProbe: true` 全状态可用。

## 验证

### 测试

- 定向测试：`circuit-break-healing-persist.test.ts`（新增写入即 resolved 断言）+ `healing-probe-filter.test.ts`（6 用例消费侧过滤）
- 全量回归：vitest 229 files / 2834 tests 全部通过，零失败零回归
- 类型检查：`tsc --noEmit` 通过

### 最简实现检查

已过最简检查——未引入新表、新依赖、新模块；复用 HealingEvent 实体现有 status/resolution 字段语义（resolved + resolution.notes），消费侧复用 findAll 后内存过滤（50 条上限场景，SQL 层过滤无必要）。

### 现存问题处理

issue #751 证据中的 10 条 open 探针历史堆积（e610d88a 等）——本次检查时已被 9/3 晨间健康检查处置（dismissed 池可见 8/28-8/30 五条实证），open 池现存 2 条 guard_intercept 真实事件。历史数据清理不属本次代码变更范围（issue 明确另议）。

## 非目标

- 不清理已堆积的历史探针事件（数据操作，另议）
- 不动 healing parser 的 speak 标记协议
- 不动探针的验证能力（读路径 + 写路径列完整性检查逻辑原样保留）
