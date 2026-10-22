---
id: F20261022fgbt
title: feature-gates 装配层集成测试（issue #937）——platforms.ts 级门控接线行为验证
summary: tests/bootstrap/feature-gates-bootstrap.test.ts 落地——真实 initPlatforms 装配（真 uc + 真 repos + 内存 DB）断言 resolveFeatureGates 解析结果真实接线到 healingInit/recruitingInit seed 点，覆盖显式配置/DB 存量推断/缺省三态 + recruiting 双门 + 双入口一致性（S1 型回归防线）。
change_type: tests
capability_test: "tests/bootstrap/feature-gates-bootstrap.test.ts 13 用例（17+ 断言）：绿 = 装配接线行为正确；若某 seed 点门控断线（如 gates 解析后未接 ensure 链），对应三态用例将红。回归口径：npx vitest run tests/bootstrap/feature-gates-bootstrap.test.ts"
intent:
  problem: "issue #937（PR #936 检视建议 A1）：F20260915cfgt 门控逻辑只有单元测试（features-config.test.ts 16 用例覆盖归一化），缺 platforms.ts 装配层集成测试——gates 解析结果真实接线到 seed 点的行为级验证。S1（paperTrading 门 raw 值致双入口读值不一致）正是单元绿但装配断线型 bug。"
  expected_effect: "装配断线类回归（解析结果未接 seed / 双门缺一 / 推断失效）在集成测试红灯拦截，不再依赖运行期发现。"
  verify_by:
    type: test
    detail: "tests/bootstrap/feature-gates-bootstrap.test.ts：13 用例 17+ 断言全绿 + tests/bootstrap + tests/frameworks/config 域回归 128/128 绿 + CI 绿"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [tests, bootstrap, feature-gates, tech-debt]
modules: [bootstrap]
---

# feature-gates 装配层集成测试（issue #937）

## 1. 来源

issue #937（P2 tech-debt，2026-09-15 立案，PR #936 对抗审视建议 A1 派生；清账批次关闭标准：四 seed 点 × 三态 ≥12 断言集成测试合入 + CI 绿）。

## 2. 结构变迁（验收口径修订依据）

issue 立案时（9-15）为四 seed 点（healingInit/recruitingInit/dailyReviewInit/seedPaperTradingTasks），此后两门随特性移除：

- **F20260920stkx**：seedPaperTradingTasks 随 paper-trading 能力整体移除
- **F20260917swsh**：dailyReviewInit 随每日复盘任务移除

现存 seed 点 = **healingInit**（gates.selfHealing 单门）+ **recruitingInit**（`apiKey && gates.recruiting` 双门，platforms.ts:737）。原「四 seed 点 × 三态 ≥12 断言」按现存结构映射为：2 seed 点 × 三态 + recruiting 双门补态 + 双入口一致性 + 装配返回面 = **13 用例 17+ 断言**（≥12 达标）。S1 型回归（paperTrading 门 raw 值）载体随门移除，其等价防线由「双入口一致性」用例承接。

## 3. 测试设计

测试文件：`tests/bootstrap/feature-gates-bootstrap.test.ts`。

**装配方式**（issue 建议方案「mock repos + uc」的强化版）：真 `initUseCases` + 真 `initRepositories`（内存 DB）+ fakeAgentGateway + embedding/memoryIndex 轻 stub → 调真实 `initPlatforms`——断言落 DB 行为面（healing 会话/定时任务行创建与否），不是 mock 内部 ensure 模块。

| 用例组 | 覆盖 | 断言数 |
|---|---|---|
| healingInit 三态 | 显式 true（DB 空也 seed）/ 显式 false（存量不推翻显式）/ 未配置+存量推断 true / 未配置+空缺省关 | 7 |
| recruitingInit 双门 × 三态 | 双门开（三对象创建+seed）/ 显式 true 缺 apiKey 不开 / 显式 false 优先 / 推断 true 开 / apiKey 信号推断 / 缺省关 | 8 |
| 双入口一致性（S1 防线） | resolveFeatureGates vs inferDomainActive 同数据同结果（selfHealing/recruiting 各 × 有无存量） | 2 |
| 装配返回面 | weixinPollers 空数组、registry 照常创建 | 2 |

## 4. 实现要点

- **观测面选择**：断言 DB 行（conversations.title='🩺 Self-Healing' / scheduled_tasks.name）+ 返回对象三态（processInboundRecruit/inboundApiKey/getBridgeStatus）——行为级，不耦合内部调用序列
- **三态控制**：显式 = appConfig.features 字段；推断 = 预插 scheduled_tasks active 行（真 SQL 判据，schema 需 conversation_id 外键）；缺省 = 空 DB
- **recruiting apiKey 信号**（resolveFeatureGates.recruitingInfer）：apiKey 存在即推断 true——双门实际由 apiKey 主导，该行为显式钉进用例（「未配置 + apiKey + DB 空 = 开」）
- 双入口一致性用例限定无 apiKey 场景（apiKey 信号是 resolveFeatureGates 独有的设计增强，不算不一致）

## 5. 验证

- `npx vitest run tests/bootstrap/feature-gates-bootstrap.test.ts`：13/13 绿
- `npx vitest run tests/bootstrap/ tests/frameworks/config/`：128/128 绿（域回归无破坏）
- CI 绿（PR #1620）
