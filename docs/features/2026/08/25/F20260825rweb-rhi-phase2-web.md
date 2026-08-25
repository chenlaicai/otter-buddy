---
id: F20260825rweb
title: RHI Phase 2 Web 面板实施
summary: |
  Epic #393 / Issues #402-#404 的 Phase 2 交付：后端 API（/api/health/overview、
  /signals、/chains、/scan 四端点，RhiController 职责分离）+ 前端页面
  （web/src/pages/health/ 三视图：总览指标卡/信号列表 severity 分组/特性链五态分布，
  TopBar 新增健康面板入口）+ 自然语言日报（每日健康检查 prompt 接入 RHI 信号数据源，
  critical 信号成为日报优先素材）。
change_type: feature
status: development
capability_test: "tests/api/rhi-api.test.ts"
created_in_conversation: 9e709aca-dd74-42fa-9fe1-4e7bbaf24bdb
---

# RHI Phase 2 Web 面板实施

母特性文档：[F20260824rhib](../08/24/F20260824rhib-rhi-health-dashboard.md)。Phase 0：F20260825hmvp，Phase 1：F20260825sgnw。

## 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| Controller 分离 | 新建 RhiController，不动 HealthController（memory 端点） | 职责分离：memory 健康是链路对账，RHI 是仓库健康——同前缀不同域 |
| chains 端点数据源 | RhiScanWorker.buildChainsOnce（新增公共方法） | 复用两阶段 zombie 判定，保证面板链与信号引擎同源（一套逻辑两处实现会漂移） |
| overview 数据源 | health_snapshots 最新快照 + signals 实时计数 | 指标走快照（历史可比），信号走实时（新鲜度） |
| 前端架构 | MPA 新入口 health.html（对齐 memory/settings 模式） | 项目无 SPA router，多页模式是既有约定 |
| 信息层级（首版） | 信号按 severity 分组、链按病态优先级排序（zombie>regressed>stalled>orphan>active） | 量级分布出来后再调排序/折叠参数——搭档指示：先实现一版不推迟 |
| 日报接入 | daily-health-check prompt 增数据源 6（RHI API + [RHI信号] 记忆前缀） | 复用既有每日任务机制，critical 信号经记忆通道天然可检索 |
| 手动扫描端点 | POST /api/health/scan 调 scanOnce | 演示/调试用；worker 每小时自动跑，手动触发不绕过任何去重逻辑 |

## 实现清单

| Issue | 交付物 |
|-------|--------|
| #402 | RhiController（4 端点）+ router 注册 + controllers.ts/app.ts 接线 + SignalRepository/HealthSnapshotRepository 注入 |
| #403 | health.html + pages/health/index.tsx（三视图）+ TopBar health tab + api client RHI 函数与 DTO |
| #404 | daily-health-check.md 数据源清单加 RHI（overview + signals API，[RHI信号] 记忆检索） |

## 验证

- 1576 tests / 133 files 全绿（新增 6 个 API 测试：overview 指标聚合/信号分级计数/空库零值/status 过滤/链分布/手动扫描）
- web `npx tsc --noEmit` + `vite build` 通过（2687 modules）
- RhiScanWorker.buildChainsOnce 复用既有两阶段 zombie 逻辑，无重复实现

## 已知限制

- 链列表截断 TOP 50（全量列表等量级数据出来再定分页）
- Agent 视图（母文档 Issue #10 提及）未实现——依赖 Phase 3 的 Agent 行为层指标（#405）
- 前端无轮询，手动刷新/立即扫描触发——实时性按小时级设计（特性文档非目标：不做实时流）
