---
id: F20260906rdi4
title: 'RHI 健康池两 repo 纳入 Repositories DI 注册惯例'
summary: SignalRepository 与 HealthSnapshotRepository 自 RHI Phase 0 起在 app.ts 直实例化（4 处），绕过 bootstrap/repositories.ts 的注册惯例（对照其余 15 个 repo 全部注册）。本次纳入注册（rhiSignal / healthSnapshot 两字段，命名与 signalEvent 獭间语义池显式区分），app.ts 消费侧 4 处改引用。纯重构无行为变更，挂靠时机已过期（Phase 3 核心件已落地），清仓 6/19 批收尾由搭档拍板直接做掉。
change_type: refactor
capability_test: 'n/a: 纯重构无行为变更，由全量 3043 测试（唯环境既有 weixin-cold-start 失败与本改动无关，主目录 main 同样失败）+ tsc/eslint 干净守护'
created_in_conversation: e9b71eec-679e-4380-947d-8e641c4b90d5
tags: [rhi, dependency-injection, repositories, refactor, issue-clearing]
modules:
  - src/bootstrap/types.ts
  - src/bootstrap/repositories.ts
  - src/app.ts
---

# F20260906rdi4: RHI 健康池两 repo 纳入 Repositories DI 注册惯例

## 背景

issue #447（PR #444 对抗审视建议发现 4）指出：SignalRepository / HealthSnapshotRepository 在 app.ts 直接 `new` 后传入消费侧，未纳入 `bootstrap/repositories.ts` 的 Repositories DI 对象——当时其余 10 个 repo 全部注册（现已 15 个），属绕过项目注册惯例的技术债。

原挂靠理由是「Phase 3 自进化闭环开工前顺手做」。核实发现 Phase 3 核心件（#405/#406/#407）已随清仓批次全部合入，**挂靠时机过期**；搭档 2026-09-06 拍板批 6 收尾直接做掉。

## 变更

### 1. 注册（repositories.ts + types.ts）

```ts
rhiSignal: new SignalRepository(db),        // RHI 健康信号池
healthSnapshot: new HealthSnapshotRepository(db),  // health_snapshots 表
```

**命名决策**：不叫 `signal`——Repositories 已有 `signalEvent`（signal_events 表，F20260826mwrd 獭间结构化信号台账）。RHI 的 SignalRepository 操作 `signals` 表（健康信号池），两个「信号」是不同语义池。取名 `rhiSignal` 并在字段注释中显式声明区分，防止后续消费侧拿错。

### 2. 消费侧（app.ts，4 处直实例化改引用）

| 位置 | 原代码 | 改为 |
|------|--------|------|
| createRhiScanWorker 内 :149 | `new HealthSnapshotRepository(deps.db)` | `deps.repos.healthSnapshot` |
| createRhiScanWorker 内 :154 | `new SignalRepository(deps.db)` | `deps.repos.rhiSignal` |
| initControllers 依赖 :413 | `signalRepo: new SignalRepository(db)` | `repos.rhiSignal` |
| initControllers 依赖 :414 | `healthSnapshotRepo: new HealthSnapshotRepository(db)` | `repos.healthSnapshot` |

同步删除 app.ts 中两个已无引用的 import。

### 3. 明确不做（范围边界）

- **SignalPipeline / HealthReport 构造器内部自建**（signal-pipeline.ts:44、health-report.ts:47）：用例内部 `this.repo = new X(db)` 是内聚设计，不经 app.ts 组装面；issue 范围明确为「repositories.ts + app.ts + controllers.ts 消费侧」，不扩科。
- **controllers.ts**：其 deps 已是引用传递（`signalRepo: SignalRepository` 类型约束），app.ts 改从 repos 传入后自动归位，无代码改动。

## 验证

- `tsc --noEmit`：干净
- `eslint`（3 个改动文件）：干净
- 全量 vitest：**3043 tests，3042 passed**——唯一失败 `tests/bootstrap/weixin-cold-start.test.ts` 为环境既有失败（主目录 main HEAD 同样失败：测试读本地真实 DB 的已登录微信账号 weixin-mtmdzg66 触发告警分支，与 DB 路径无关的冷启动断言被真实数据干扰），非本改动引入。

## 后续

- 合入即关闭 #447（PR 带 Closes #447）
- 认领协议已走：otter-claim 评论 [5556665143](https://github.com/chenlaicai/otter-buddy/issues/447#issuecomment-5556665143)，回读通过
