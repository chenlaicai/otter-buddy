---
id: F20260907ylfs
title: "yield-to-self 合法化：拆 talking-stone 自交禁令，护栏门控消化路径（P3a 批次 ②）"
summary: "獭可以 yield 给自己=任务锚点入箱（任务未完，下轮继续），消化路径唯一=链引擎护栏门控的链续跑（<5 放行/≥3 steer/≥5 拒入+abort+healing）；记账侧与路由共享同一门控结果，pendingClause 自指排除一行不动（方案 B）。"
change_type: feature
modules: ["conversation", "agent-runtime"]
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为——yield 工具 description 是引导文本但门控语义在链引擎静态代码，由单元/集成测试覆盖（F20260907grdr 同口径）"
intent:
  problem: "打断后任务锚点无处安放：小獭被打断时若任务未完成，旧自交禁令（talking-stone.ts:49-51）使其无法把「下轮继续」的锚点入箱，只能丢弃任务或违规自续；打断≠丢弃的对称恢复缺一环"
  expected_effect: "① yield 工具允许 to 含自己（talkingStonePassedTo 落库含 self ID）；② 链引擎 self 不再被静默滤除——护栏计数 <5 时 self 进 nextTargets（链续跑即消化），=3 附 steer 警示，≥5 拒入 + abort + healing；③ 护栏放行的 self hop 记 chainSource（自→自销账），账面不说谎；④ yield 工具 description 含「任务未完可传自己」引导"
  verify_by:
    type: static_only
created_at: "2026-09-07"
created_in_conversation: "449d8f5d-e91e-49c0-ade5-0fbd9b3d0fcb"
---

# yield-to-self 合法化：拆 talking-stone 自交禁令，护栏门控消化路径

## 背景

P3a 打断轻量版三件套之二（③ 梯度护栏 F20260907grdr 已合入，为②提供安全兜底）。

打断≠丢弃的对称恢复：③ 让 URGENT 信号能打断运行中的獭，但打断后若任务未完成，旧自交禁令（「不能把行动权传给自己」）使小獭无处安放「下轮继续」的任务锚点——要么丢弃任务进度，要么无限自链（9/4 事故形态）。② 把 self-yield 合法化为「任务锚点入箱」语义，配合 ③ 的梯度护栏（3 次 steer 警示 / 5 次 abort 链停）实现「合法长任务能续跑、病态自链被截断」。

设计真相源：`p3a-design-full.md`（对话工作区）「② yield-to-self 合法化」节 + 快审处置记录表。

## 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 消化路径 | 方案 B：链引擎内消化 | pendingClause 判据 SQL（sqlite-dispatch-attempt-repo.ts:122 自指排除）是事故换来的资产，一行不动；链引擎是 self-yield 的产生现场，护栏门控即消化 |
| 护栏决策位置 | executeOneHop 内单点（resolveHopOutcomes） | 快审 delta 顺序依赖：recordAttemptSettle（chainSource 回填）先于 processHopResults（路由）执行，两处必须共享同一门控结果——单点计算后投递，分叉在结构上不可能 |
| 记账语义 | 护栏放行的 self hop 记 chainSource（自→自） | 账面不说谎：链真的续跑了（self 进 nextTargets），账面必须反映（否则下轮起跑无触发消息可销账 → 假 pending）；拒入的不记（链未续跑，无消费义务） |
| 崩溃窗口残留 | 不实现，归 #822 | yield 落库后、链续跑前崩溃 → 自指锚点滞留（pendingClause 排除它，静默）；窗口极窄，批次 3 滞留告警覆盖 |
| 死装配清理 | 删 deps.steer 回调 | 检视-838 移交件 A：③ 修复后 steer 走 ChainHopResult.steerText 进程级传递，回调零调用点；① URGENT 注入路径是 signal-router 直调 agentGateway.steerSession，不经链引擎 deps——该回调永不复活 |

## 变更内容

### talking-stone.ts（拆禁令）

- 删除 `validateAndResolve` 的自交校验（resolvedIds 含 self 直接放行）+ 删除 `selfOtterId` 参数（唯一用途就是自指校验）
- 错误提示「不能把行动权传给自己」随之退役；护栏门控在链引擎侧，工具层不拦

### dispatch-chain-engine.ts（护栏门控化消化路径）

**新增 `HopOutcome` + `resolveHopOutcomes`（护栏决策单点）**：

- 对本 hop 全部 fulfilled 目标一次完成「行级取数（fetchProducedMessage）+ 护栏门控（checkSelfYieldGuardrail，③ 已有）」，产出 per-target 的 `allowedNext`（已滤 'user'；self 仅护栏放行时含）+ `aborted` + `steerText`
- 消费方两处共享同一结果：`recordAttemptSettle`（chainSource 回填）与 `processHopResults`（nextTargets 路由）——旧版 :314/:417 两处独立 filter 的顺序依赖（快审严重发现 1 的死角根源）在结构上消灭
- 副产品：旧版两处各查一次 getMessageById，合一后每 hop 少一次查库

**两处 filter 的注释更新（领域不变量声明退役）**：

- `recordAttemptSettle` 旧注释「产出消息的 tsp 不应含 sender 自己（领域不变量），filter target 是纵深防御（#792 自链病根）」→ 更新为护栏门控语义：护栏放行的 self hop 记 chainSource（自→自），拒入不记
- `processHopResults` 旧注释「自指守卫：行级 tsp 不含 sender 自己，filter producer 为纵深防御」→ 同步更新为门控消费语义

**结构重构（lint 门禁）**：

- executeOneHop：degraded 槽位收集/补注拆出 `collectDegradedSlots` / `appendDegradedNotes`（#798 发现 2 语义不变）
- resolveHopOutcomes：user 过滤拆出 `filterChainTargets`
- recordAttemptSettle：参数对象化（6→1）+ 共栖污染 warn 判定拆出 `warnIfCoexistPollution`（F20260904schf 语义保留：护栏拒入时 allowedNext 清空是门控决策非降级，不误报）
- 删除死方法 `collectDegradedSlot`（单条收集版，已被批量版取代）

**F20260904schf 保留不变式**：行级取数（读产出消息自身 talkingStonePassedTo 终值，不读 turn 级并集）；#474 保留（只滤 'user'，scheduler 回属主交棒不误伤）。

### platforms.ts（件 A：死装配清理）

- 删除 `createDispatchChainEngine` 的 `steer` 回调注入行（③ 检视修复后零调用点）
- `pi-session-factory.steerSession` 保留——① URGENT steer 注入的依赖（signal-router 直调），本 PR 不动

### tool-factory.ts（yield 工具引导）

- description 与 to 参数 description 的「不能传自己」→「任务未完成需下轮继续时，可以传自己（任务锚点入箱，下轮继续；连续自链受梯度护栏保护）」+ 滥用警示（禁止用它逃避交棒义务）

## 消化路径语义（方案 B 实体）

```
獭 yield 给自己（任务未完，下轮继续）
  → talkingStonePassedTo 落库含 self ID（工具层放行）
  → 链引擎 resolveHopOutcomes 检出 self-yield（tsp 含 hop 目标自身）
      ├─ 计数 <5（护栏 F20260907grdr）→ self 进 allowedNext → nextTargets → 链续跑（下一轮 invoke 即消化）
      │    └─ =3 附 steer 警示（进程级传递，下一 hop 消息前置注入）
      └─ 计数 ≥5 → 拒入（allowedNext 空）+ abort + healing 留痕 → 链停（非惩罚，可被外部重新 invoke）
  → 记账：放行的 self hop 回填 chainSource[self]=产出消息（下轮起跑对它销账，消费义务闭环）
```

自指信号不进路由 pending（pendingClause :122 自指排除保留不动）——重启补扫不会重燃自指锚点，消化只走链内护栏门控。

## 测试

新增 `tests/usecases/conversation/yield-to-self.test.ts`（7 条，动态消息表模拟生产时序，计数跨 hop 真实累计）：

1. 合法 self-yield：护栏计数 0 → 放行进 nextTargets，链续跑即消化
2. 护栏放行的 self hop 记 chainSource（自→自）：下轮起跑对产出消息销账
3. 护栏拒绝（≥5）：不进链不记账 + abort + healing，链停（端到端真实计数）
4. 拒入 hop 的产出消息无消费义务（账面无假 pending）
5. 混合链：worker self-yield 与大獭并行目标共存，护栏只门控 self
6. steer 警示注入混合链：hop2 多目标都收到前置注入（含 self 续跑者）
7. 计数跨 hop 真实累计：第 3 跳生成 steer 注入第 4 跳、第 5 跳拒入链停

改造存量测试（语义随 ② 反转）：

- `speak-tool.test.ts`「传给自己仍然被拒绝」→「yield 给自己合法放行，tsp 含自身 ID，终止 loop」
- `dispatch-chain-engine.test.ts`「自指回声防环：链终止于本轮」→「护栏放行链续跑（无消息表服务时降级 0 永放行，maxChainDepth 兜底）」
- `self-chain-regression.test.ts`「自指守卫拦截一轮终止」→「护栏梯度门控 5 跳链停（端到端真实计数）」——F20260904schf 事故回放升级为 ② 新契约回归
- `self-yield-guardrail.test.ts`（③ 的 14 条）：死装配 steer mock 清理；3 处 `if (invoked.length > 1)` 死代码断言转正为真实测试（件 B）——self 链真实续跑，第二跳真实被唤醒并收到注入文案，invokeFn 第二跳返回 tsp=[] 收链

## 验证

- 全量测试：3094 tests passed（247 files，含 7 条新增 + 存量语义反转改造）
- eslint：0 errors（src + tests 全目录；5 warnings 均为 cost-output-collector 的存量 no-console，非本 PR 引入）
- build：成功（worktree 复用主仓 bge-m3 模型）
- tsc --noEmit：0 错误

### 最简实现检查

已过最简检查：消化路径复用 ③ 已实现的护栏（checkSelfYieldGuardrail / countConsecutiveSelfYields），本 PR 零新增计数逻辑；门控单点化（resolveHopOutcomes）是顺序依赖的结构性要求（快审 delta），非过度建设——比「两处各自判断 + 共享变量传递」更少可移动部件；死装配清理净删代码（deps.steer 字段 + 注入行 + mock）。

## 已知残留

- **崩溃窗口残留**（设计声明，归 #822）：yield 落库后、链续跑前进程崩溃 → 自指锚点滞留消息表（pendingClause 排除它，静默不重燃）。窗口极窄（invoke 返回后到 processHopResults 之间），批次 3 滞留告警覆盖
- **阈值 3/5 与合法长任务的张力**（③ 已声明）：连续多轮「下轮继续」的合法长任务会撞 5 次上限——abort 只停链不销状态（可被外部重新 invoke 续跑），steer 警示在第 3 次给出交棒/分派引导出口；实测后评估升阈值或进度豁免（P3b）

## 回滚

本 PR 全部改动可回滚：恢复 talking-stone 自交禁令（工具层拦截）即回 ③ 合入前状态；护栏门控回退为滤 self 即回 F20260904schf 行为。dispatch-chain-engine.ts 同时含 ③ 的护栏代码（F20260907grdr），回滚时注意不要伤及（本 PR 对护栏函数零改动，只改其调用编排）。

## 机制预算四问

| 问题 | 回答 |
|------|------|
| 谁需要这个机制？ | 被打断（URGENT 信号/外部介入）但任务未完成的小獭——需要把「下轮继续」的锚点入箱而不是丢弃任务；合法长任务需要受保护的续跑通道 |
| 失败后果是什么？ | 无此机制：打断=丢弃任务进度（打断≠丢弃的对称性断裂）；病态自链（9/4 事故）只有 maxChainDepth=100 兜底，浪费资源 |
| 后续机制是什么？ | ① URGENT steer 注入（独立 PR，②合入后开工）；批次 3 滞留告警（#822）；P3b 跨会话计数/进度豁免/结构化出口 |
| 退役条件是什么？ | 若实测发现合法长任务频繁撞 5 次上限，升阈值或引入进度豁免（护栏参数化）；若 P3b fork 副本决策上线，「下轮继续」可能被结构化 {continue} 取代——届时 self-yield 语义收窄为纯锚点 |

## Discovered Issues

无。
