---
id: F20260921rctr
title: RHI 三端点响应 snake_case → camelCase 契约对齐，DTO 收口 api-contract
summary: /api/health/signals 响应全 snake_case、overview metrics 键与 trends distributions 内层 snake_case，与同组 camelCase 端点割裂且前端手写 DTO 绕过契约层（#448）；本 PR 三端点 + triageSignal 写路径统一显式序列化为 camelCase，RHI DTO 单一真相源收口到 api-contract/api/rhi.ts（client.ts 改 re-export），字段集保持现状不做量级调整（YAGNI）
change_type: refactor
capability_test: "n/a: 纯命名/结构迁移零行为变化，由 tests/api/rhi-api.test.ts + web health 域 64 用例回归覆盖"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
causal_links:
  from: [F20260825rweb, F20260829hviz, F20260917trig]
tags: [api-contract, rhi, health, dto, camelCase, refactor]
modules:
  - api-contract/api/rhi.ts
  - src/interface-adapters/http/controllers/rhi-controller.ts
  - web/src/api/client.ts
  - web/src/pages/health/
---

# RHI 三端点响应 snake_case → camelCase 契约对齐（#448）

## 背景

PR #444 对抗审视建议发现 5（检视獭WEB）指出：`/api/health/signals` 返回 snake_case（signal_type/file_path/feature_id/...），同组 overview/chains 端点 camelCase——同组 API 命名不一致；且 `web/src/api/client.ts` 手写 RhiSignalDTO 绕过 api-contract 契约层（@contract/api）。issue 建议时机「真实数据积累、前端视图细化时一并做」——处置队列/复发卡视图（F20260917trig）已上线，条件成熟。

## 现状核实（2026-09-21，基于 main e0db8bf8）

- **signals()**：`...s` 展开 DB 行（snake_case）直接透传 + camelCase 补充字段混搭；`evidence_detail: undefined` 显式置空防泄漏
- **triageSignal()**：`record` 直传 repo 行（snake_case）——与 client.ts 声明的 camelCase RhiSignalDTO **类型不符**（`...s` 透传时代 tsc 检不出，本次显式序列化后原类型谎言暴露并修正）
- **overview()**：metrics 键 = OVERVIEW_KEYS（DB 存储键，snake_case）直出
- **trends()**：series 点位键 + distributions 键均 DB 存储键直出（change_types/file_hotspots/chain_states/skip_reasons）
- **chains()/chainDetail()**：已是 camelCase（不涉及，仅 DTO 迁入契约层）
- **web 外消费者排查**：全仓 grep `/health/signals|/health/trends|/health/chains|/health/overview`——agent 工具（rhi-signal-tools.ts）直接注入 SignalRepository 不走 HTTP；e2e/golden/selftest 无 RHI 消费；**web/src/api/client.ts 是唯一 HTTP 消费者**，已同步改写 → 对外无破坏性影响面

## 方案设计

### 1. api-contract/api/rhi.ts（新建，契约单一真相源）

- `RhiSignalDTO`（全 camelCase，18 字段含处置状态机四字段）
- `RhiSignalEvidenceDetailDTO` / `RhiSignalEvidenceDetailCommitsDTO`（evidenceDetail 结构显式化——原 client.ts 内联匿名类型）
- `RhiOverviewDTO`（metrics 值类型不变，键由 DB 键变 camelCase 投影）
- `RhiTrendPointDTO`（totalCommits/bugfixCount/bugfixRatio/compliantCommits）
- `RhiTrendsDistributionsDTO`（changeTypes/skipReasons/modules/fileHotspots/chainStates）
- `RhiTrendsDTO` / `RhiChainCommitLiteDTO` / `RhiChainDTO` / `RhiChainDetailCommitDTO` / `RhiChainDetailDTO`（从 client.ts 迁移）
- `api/index.ts` 追加 `export type * from "./rhi"`（type-only，符合目录语义约定——无 value 导出）

### 2. 后端 rhi-controller.ts

- 模块级 `metricKeyToCamel()`：snake_case DB 键 → camelCase 响应键（`_x` → `X`），overview metrics / trends series 点位 / distributions 键三处共用
- `serializeSignal(s: SignalRecord): RhiSignalDTO`：signals() 与 triageSignal() 共用——显式字段映射，不再 `...s` 透传。**顺带移除** `created_at/resolved_at`（从未进 DTO，前端零消费）与 `evidence_detail: undefined` 的补丁式写法
- evidenceDetail 的 `safeParseJson` 降级语义保留（坏 JSON → null 不阻断列表）
- 返回类型锚定 `RhiSignalDTO`（import type from @contract/api/rhi）——序列化漂移编译期可见

### 3. web/src/api/client.ts

- 手写 RHI DTO 定义全删（约 120 行），改为 `export type { ... } from '@contract/api/rhi'` re-export + 局部 import type 供请求函数使用

### 4. 前端消费点改写（snake_case → camelCase，tsc 逐一暴露）

| 文件 | 改动 |
|---|---|
| pages/health/index.tsx | `s.signal_type` → `s.signalType`（bug_recurrence 过滤） |
| RecurrenceCard.tsx | `file_path/feature_id/signal_type` 访问 |
| TriageQueue.tsx | `first_seen/feature_id/file_path/suggested_action` 访问（含排序 comparator） |
| HotspotHeat.tsx | `distributions.file_hotspots` + recharts `dataKey="total_commits"/"bugfix_ratio"`（dataKey 必须与序列化键同步，否则图静默变空） |
| VerdictPanel.tsx | `metrics.total_commits` ×2、`distributions.change_types/chain_states`、series `bugfix_ratio/compliant_commits`、Sparkline props 类型 |
| 测试 fixture | VerdictPanel.test / RecurrenceCard.test / TriageQueue.test / TrendSparkline.test 的对象字面量键 |
| tests/api/rhi-api.test.ts | overview metrics 断言、trends series/distributions 断言改读 camelCase 键 |

## 取舍

| 决策 | 理由 |
|---|---|
| 字段集保持现状（不做量级调整） | issue 原文「届时 overview/chains 也会按真实量级调整字段」不在本 PR 范围——YAGNI，命名对齐与结构变更分开审 |
| DB 列名/schema 不动 | 只动 API 序列化层；DB 键继续 snake_case（SQLite 惯例），投影在 controller 边界完成 |
| triageSignal 一并序列化 | client.ts 声明 record: RhiSignalDTO 但实发 DB 行——类型谎言，同 PR 收口避免半改 |
| created_at/resolved_at 不再透传 | 从未进 DTO、前端零消费（grep 实证），`...s` 透传的隐性噪音 |
| chains/chainDetail 不改行为 | 已是 camelCase，仅 DTO 迁入契约层 |
| 通用 camelCase 转换 vs 显式映射 | metricKey 用通用函数（键空间封闭且稳定：OVERVIEW_KEYS/TREND_KEYS/distribution 键）；signal 字段用显式映射（契约字段一目了然，新增字段必须显式进 DTO） |

## 兼容性声明

三端点（signals/overview/trends）+ triageSignal 响应**字段名全部变化**（snake_case → camelCase）。**web 前端是唯一 HTTP 消费者且已同步改写**（全仓排查：agent 工具走 repo 直连、e2e/golden 无 RHI 消费）——对外破坏性影响面为零，但若有仓外脚本直连这些端点会受影响（本机信任域内无此情况，本地服务 API）。

## 验证

- 后端全量：**3634/3634 通过**（264 文件）
- web 全量：**510/510 通过**（57 文件）
- tsc：根 + web 双侧 0 error（显式序列化后原 triageSignal 类型谎言被编译器当场暴露——修复）
- ESLint：根（src/api-contract）+ web 双侧 0 errors
- 消费面回归：tests/api/rhi-api.test.ts 37/37（overview/trends 断言改 camelCase）；web health 域 64/64（含 fixture 全量换键）

## 已知边界

- `metricKeyToCamel` 为通用正则转换——若未来 DB 新增含连续下划线或非 [a-z0-9] 段的指标键，投影语义需复核（当前键空间封闭：OVERVIEW_KEYS/TREND_KEYS/distribution 五键）
- api-contract 变更后 `tests/api-contract/` 无独立测试目录（grep 确认）——契约层由双端 tsc 编译期锚定
