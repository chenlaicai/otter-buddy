---
id: F20260904schf
title: 信号链自链循环修复：出处取数行级化（滤 self 兜底）——aggregatedTargets 退役
summary: 长 invoke 期间 open turn 共栖外来信号，tryCloseTurn 的 turn 级 tsp 并集被链引擎误作行级 yield 出处 → chainSource[自己]=自己产出消息 → 下一 hop 自点火（9/4 晨事故实锤：同批信号反复点火 2-4 轮、解散检视獭积压信号连环唤醒大獭五轮）。修复：链引擎出处取数改读产出消息自身的 talkingStonePassedTo 行级终值（completeMessage 先落库后关 turn，行级值因果局部），aggregatedTargets 退役为 deprecated；自指守卫（producer 过滤）纵深防御；并行 invoke 错记/漏记族同锅修复。
change_type: fix
capability_test: "tests/usecases/conversation/self-chain-regression.test.ts（7 用例：事故回放×2 + 并行错记/漏记×2 + 正当场景保全×2 + 查库失败降级×1）"
created_in_conversation: 52bfdd91-a61e-4323-b1f7-1fe3daaadc32
tags: [signal-protocol, dispatch-ledger, self-chain, turn-aggregation, incident-fix]
modules: [src/usecases/conversation/dispatch-chain-engine.ts]
---

## 背景

2026-09-04 02:54-02:59（+0800），检视獭-swp4 解散前后，其积压信号触发大獭 4+1+1+1+1 五轮连环唤醒。三獭根因分析（大獭+mimo+glm，对撞零分歧）实锤：

- **病灶 A**（`turn-utils.ts` tryCloseTurn）：聚合 turn 内全部消息的 tsp 并集，不分「消费进来的输入信号」与「本 otter 产出的输出消息」。
- **病灶 B**（`dispatch-chain-engine.ts` recordAttemptSettle）：出处回填把 turn 级并集当行级 yield 出处，不滤 self → `chainSource[大獭]=大獭自己的产出消息`（脏账）。
- **病灶 C**（processHopResults）：nextTargets 不滤 self → 下一 hop 自点火。
- **触发条件**：`ensureActiveTurn` 对 open turn 直接复用——大獭 invoke 长达 30-50 分钟，streaming 期间到达的信号（tsp=[大獭]）共栖同一 turn，invoke 结束时聚合含 [大獭]。
- **同锅病**：并行 invoke 多目标时，先完成者拿 `closed:false` 空聚合 → yield 丢失 → 假 pending → 补扫重复点火；最后完成者拿全 turn 并集 → 把同伴 yield 记自己名下。
- **账本自盲**：脏行 (M_自己, 自己) 是自指对，pending 反连接 SQL 天然排除 → 账面永远健康。

设计层定性（glm）：**设计层缺口非实现走样**——hopf 规定回填落位却从未定义 aggregatedTargets 的语义契约；turn 聚合（展示层概念）被路由层借用而无接口契约。这是信号协议三日内第三起同谱系事故（v1 批量点火 → v2 热循环 → v3 自链循环），共同病根：借用上层机制产物当真相源而不写输入契约。

**设计原则（本修复的锚）**：一条消息 M 构成目标 T 的触发信号，当且仅当 M 自己 settle 后的 talkingStonePassedTo 包含 T——出处是行级事实；聚合视图永远只能是优化，不能成为语义来源。

## 改动

`src/usecases/conversation/dispatch-chain-engine.ts`（唯一生产文件）：

1. **recordAttemptSettle 出处回填行级化**：fulfilled 时改读 `getMessageById(produced).talkingStonePassedTo`（行级终值），不再消费 `r.value.aggregatedTargets`；`Promise.resolve()` 包装使 mock 返回 undefined 等非 Promise 值时仍安全（API 测试依赖此宽容性）。附带观测：行级出处为空但聚合目标非空时打 warn（turn 共栖污染被拦截的可观测信号）。
2. **processHopResults 下一跳行级化**：同上，改读行级 tsp；**自指守卫** `id !== targets[i]`（producer 过滤）——行级 tsp 含 sender 自己是领域不变量违例，纵深防御兜底（上游异常写入自指行也不得回到自己名下）。
3. **查库失败降级**：`fetchProducedMessage` 私有方法收口（查库异常 → warn + null → 无出处不路由、无回复提取），链路不阻断（硬约束 1 同款）；markBatchRead 的 getMessageById 同样补 `.catch` 降级（#792 回归测试暴露的隐性抛穿点）。
4. **InvokeFnResult.aggregatedTargets 标记 @deprecated**：字段保留（agent-invoker/orchestrator 透传零改动），注释禁止新代码消费。

消解的旧契约：`:186` 自指防环测试旧注释「自指唯一终止保障是链层幂等去重（烧满 maxDepth）」——修复后自指 yield 一轮终止，契约升级。

## 测试

新增 `tests/usecases/conversation/self-chain-regression.test.ts`（事故形态回归，验收判据）：

| 用例 | 锁定的形态 |
|---|---|
| 自指行级 tsp 异常 → 一轮终止 | 病灶 B+C 串联（自链循环） |
| aggregatedTargets 含自己污染 → 行级为准不回填脏账 | turn 共栖污染（本次事故主路径） |
| 先完成者空聚合 → 行级 yield 不丢 | 并行错记族·漏记半（假 pending） |
| 后完成者全 turn 并集 → 零外溢 | 并行错记族·错记半 |
| A、B 同 yield C 各记一条 | hopf 多源记账不回退 |
| #474 yield 回属主 | 小獭→属主交棒不被滤 |
| 行级查库失败 → 降级不抛 | 硬约束 1（记账/出处失败不阻断链路） |

既有测试修正（测试语义升级，非放宽）：
- `dispatch-chain-engine.test.ts`：mock getMessageById 按 messageId 分发行级 tsp（生产行为的正确模拟）；自指防环断言从 `≤10 次` 收紧为 `[worker]` 恰 1 次。
- `dispatch-turn-loop.test.ts`：旧「互传死循环」实为自指 yield（旧 bug 行为），改真互传乒乓 otter-x↔otter-y（合法信号流仍被 maxChainDepth=2 截断）；「无目标」测试改用本地无 yield stub。

## 验证

- 全量 2963 tests 绿（237 文件）+ tsc 0 error + eslint 0 error（2 个 no-console warning 为 main 原有，`git stash -u` 基线复跑证据在案）
- **pre-existing 声明**：无（3 个初期失败均为本次改动引入，已全部修复：SSE 第 5 事件 = `.catch` 挂 undefined mock、触顶测试 stub 行级化、无目标测试 stub 泄漏 tsp）
- **最简实现检查**：已过——链引擎消费侧改（2 处取数点 + 1 个收口方法）vs completeMessage 源头改（反向分层：路由不变量下沉消息层，且 orchestrator/scheduler/resume 等 7 处消费方需联动）。mimo 方案 B + glm 取数点修正，三獭对撞收敛的最简形状
- 消费方影响核查（mimo 枚举 + 大獭验证）：orchestrator.ts:231/402 透传不消费值零影响；scheduler-service:601 / resume-interrupted:282 无信号共栖（行级=turn 级并集等价）；signal-router:377 有 damp 闸门；message-controller:391 仅注释
- Not for scope：glm #4 INSERT OR REPLACE 审计覆盖（retry 抹前情链）不影响功能，另行 issue；P2（dissolve 出站清算 aborted 墓碑）独立 PR

## 关联

- Issue: #792（根因 + 修复计划）
- 根因分析：对话 52bfdd91（三獭收敛报告，工作区 rootcause-final.md）；实锤 fact 3507ebbd
- 前序事故文档：F20260902sgp2（v2 路由器）、F20260903damp（调度闸门）、F20260904swp4（#783 S4a 换轨）
- P2 待办：dissolve 事务内为该獭出站信号补 `status='aborted', source='dissolve'` 墓碑（glm 最小方案，复用现有终态，无 schema 变更）
