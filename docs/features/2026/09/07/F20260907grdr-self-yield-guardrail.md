---
id: F20260907grdr
title: "梯度护栏：self-yield 连续计数 + 梯度响应（closes #530）"
summary: "P3a 先行件：dispatch-chain-engine 挂载 self-yield 连续计数 + 梯度响应（3次 steer 警示 / 5次 abort + healing 留痕），为 ② yield-to-self 合法化提供安全兜底，同时覆盖 #530。"
change_type: feature
modules: ["conversation"]
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为，steer 文案是注入 LLM 的行为引导文本但由链引擎生成而非 skill 定义"
intent:
  problem: "海獭连续 self-yield 无干预机制，病态自链可无限循环（9/4 事故），且 ② yield-to-self 合法化需要安全兜底"
  expected_effect: "同一獭连续 self-yield 第 3 次时下一 hop 前置注入警示文案（含交棒/分派引导出口）、第 5 次链停（nextTargets 清空）+ healing 留痕（errorType other, severity medium，含 #530 标记）；介入信号（to≠self yield/user 消息/外部指向信号）重置计数；② 合入前护栏为防御性计数（禁令拦截合法产出）"
  verify_by:
    type: static_only
created_at: "2026-09-07"
created_in_conversation: "449d8f5d-e91e-49c0-ade5-0fbd9b3d0fcb"
---

# 梯度护栏：self-yield 连续计数 + 梯度响应

## 背景

P3a 打断轻量版三件套的先行件。为 ② yield-to-self 合法化提供安全兜底——拆旧禁令前必须有新防线（梯度护栏）就位。同时直接覆盖 #530（self-yield 防环第二道防线），比 `maxChainDepth=100` 更精确。

## 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 计数阈值 | 3 次 steer / 5 次 abort | 母方案原案，实测后评估升阈值 |
| 计数范围 | 同会话（跨会话留 P3b） | 跨会话 SQL 性能差 + 语义含糊 |
| system 消息处理 | 透明（不重置） | 防「病态自链+调度心跳交替」逃逸 5 次上限 |
| 介入判据扩展 | 外部信号（大獭重派/用户点名/调度触发）重置 | abort 后重 invoke 不死循环 |
| 挂载点 | dispatch-chain-engine.ts processHopResults | hop 产出消息落库后、链续跑前 |

## 变更内容

### dispatch-chain-engine.ts

1. **计数函数 `countConsecutiveSelfYields(conversationId, otterId)`**
   - 从消息表倒序扫描最近 100 条消息，数连续 self-yield
   - 介入三类：①该獭 to≠self yield ②user 消息 ③外部(sender≠该獭)tsp 含该獭的信号消息
   - 不相关消息透明（不重置计数）
   - 查询失败降级为 count=0（不阻断链路）

2. **梯度响应 `checkSelfYieldGuardrail(conversationId, otterId, messageId)`**
   - 第 3 次：`session.steer(警示文案)` 引导出口（建议交棒/分派）
   - 第 4 次：仅日志（steer 不重复触发）
   - 第 5 次：`doAbort` + healing 留痕（errorType=other, severity=medium, description 含 #530 标记）
   - 所有回调可选，降级为纯日志

3. **processHopResults 挂载**
   - 产出消息 tsp 含 hop 自身目标时触发 guardrail 检查
   - `shouldAbort=true` 时清空 nextTargets 终链

### pi-session-factory.ts

- `activeSessions` entry 扩 `steer?: (text: string) => Promise<void>`
- 新方法 `steerSession(otterId, text): boolean`（复用 circuit-breaker-helpers 的 session.steer 通道）

### platforms.ts / app.ts

- `createDispatchChainEngine` 注入 steer/abort/healingRepo 回调
- `app.ts` 传入 `agentGateway` 以提供 steer/abort 能力

## 验证

- 全量测试：3087 tests passed（246 files）
- 新增集成测试 14 条（self-yield-guardrail.test.ts）：
  - 梯度响应：3 次 steer / 5 次 abort+healing / 4 次仅日志
  - 介入重置：to≠self / user 消息 / 外部信号
  - 透明场景：不相关 system / 不相关外部 otter
  - 降级：无 steer 回调 / 无 healingRepo / 查询失败
  - 边界：正常 yield / tsp 为空 / 同会话边界
- eslint 0 errors（源码 + 测试）
- build 成功

## 回归约束

- 保留 F20260904schf 行级 tsp 取数 + 自指守卫语义不变
- 本 PR 仅含 ③ 梯度护栏，② 拆禁令（talking-stone.ts）是下一个 PR
- ② 合入前，合法 self-yield 路径被 talking-stone 禁令拦截，护栏是「防御性计数」

## 机制预算四问

| 问题 | 回答 |
|------|------|
| 谁需要这个机制？ | ② yield-to-self 合法化后，需要安全兜底防止病态自链循环；9/4 事故后需要比 maxChainDepth=100 更精确的自链检测 |
| 失败后果是什么？ | 无护栏时病态自链可无限循环（9/4 事故），浪费资源且可能阻塞其他任务；② 合法化后合法长任务也可能撞到 maxChainDepth 限制 |
| 后续机制是什么？ | ② yield-to-self 合法化（拆禁令）；① URGENT steer 注入（独立可并行）；实测后评估升阈值或进度豁免（P3b） |
| 退役条件是什么？ | 当 ② 合入且实测验证阈值 3/5 不误杀合法长任务后，可考虑退役或调整阈值；若进度豁免机制上线，护栏可降级为纯观测 |

## Discovered Issues

无。
