---
id: F20261010gshw
title: 写落点求值器影子接线（观察模式）——真实判定路径旁听落账
summary: 求值器 Phase 1（#1381）+ Phase 2（#1411）过 141 例语料 shadow 后的下一步：接进真实判定路径只记录不干预。挂点 abortOnUnsafeBash（唯一看到全部 bash 命令+旧链裁决的位置），双向信息量过滤落 healing_events（errorType=guard_eval_shadow）——真误拦候选（旧链拦+求值器会放，观察期判据核心信号）与 EVAL_GAIN（旧链放+求值器会拦，旧链漏拦面实战发现）；其余形态不落账防台账膨胀。零干预铁律三层（判定链零改动/回调异常吞掉/写入失败仅日志）+ 旁路防抖 10min。配套观察统计脚本（聚合+裁决指引）。
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
status: implemented
merge_pr: 1420
modification_class: new-feature
intent:
  problem: "求值器 Phase 1+2 题库验证（141 例语料）后缺真实考场数据：题库 ≠ 实战，切换决策需要真实判定路径的对照证据"
  expected_effect: "每条真实 bash 命令获得求值器旁听判定（只记录不干预），双向对照落 healing_events；观察期积累真误拦候选（人工裁决）与 EVAL_GAIN（旧链漏拦面）数据，为切换 PR 提供实战证据"
  verify_by:
    type: behavior_check
capability_test: "tests/frameworks/agent/shadow-eval-recorder.test.ts"
change_type: feature
tags: [guard, shadow, evaluator, observability]
causal_links:
  - F20261008gduc（双链统一+熔断降级——求值器家族的 P0 前置）
  - F20261009gwte（写落点求值器方案 v2——影子先行的设计源头）
  - F20261009phs2（Phase 2 窄提取——求值器当前形态）
  - PR #1381（Phase 1 影子三跑）/ PR #1411（Phase 2 处置后四判据全过）
  - issue #1363（cd 豁免灰区——EVAL_GAIN 的高频预期来源）
---

# 写落点求值器影子接线（观察模式）

## 背景

求值器已完成题库验证：141 例语料 shadow 三跑四判据全过（红线逃逸 0/误放 0/回落 19.3%/族内 91.7%，PR #1411）。但题库 ≠ 实战——搭档拍板「影子做好了当然要打开观察，否则不等于白做吗」（2026-10-10）：把求值器接进**真实判定路径**旁听，积累实战对照数据后再决策切换。

本 PR 是 gwte 方案 v2「模块 3 接入与切换」三步走的第一步：**观察模式**（只记录不干预），切换（判据达标后接线替旧链）是后续独立 PR。

## 目标

1. 每条真实 bash 命令经判定链时，求值器并行求值一遍，**只记录不干预**
2. 对照结果结构化落账（healing_events），供观察期聚合与人工裁决
3. 零干预铁律可测试证明（接线前后判定行为逐条一致）

## 非目标

- **不改变任何拦截/放行行为**——影子是旁听不是陪审，判定链零改动
- 不做切换（判据达标+搭档拍板后另 PR）
- 不处理观察数据本身（裁决是人工动作，脚本只聚合呈现）

## 设计

### 挂点：abortOnUnsafeBash（circuit-breaker-helpers.ts）

唯一同时满足「看到全部 bash 命令 + 看到旧链裁决结果」的位置。判定出结果后无论拦否都回调 `onShadowEval({command, oldBlock})`——`oldBlock=null` 表示旧链放行。

回调由 pi-session-factory 构造（`buildShadowEvalHook`，闭包携带 healingRepo sink / otterId / message & conversation id / projectRoot），helpers 层零 healing 依赖（分层：frameworks 内部模块不直接依赖 repo——对齐 onGuardIntercept 先例）。

### 记录器：shadow-eval-recorder.ts（纯函数核 + fire-and-forget 落账）

**双向信息量过滤**（只记有对照价值的形态）：

| 形态 | oldBlock | 求值器 | 落账 | 语义 |
|---|---|---|---|---|
| 真误拦候选 | 拦 | evaluated 会放 | ✅ severity=low | **观察期核心信号**：旧链可能误拦，逐条人工裁决 |
| EVAL_GAIN | 放 | evaluated 会拦 | ✅ severity=low | 旧链漏拦面实战发现（预期高频：#1363 灰区族 cd worktree 后写主仓——旧链豁免整条，求值器按落点判拦）；记录不告警 |
| 双方同判拦 | 拦 | 会拦 | ❌ | 无对照信息 |
| 双方同判放 | 放 | 会放 | ❌ | 无对照信息 |
| 求值器回落 | 任意 | unevaluated | ❌ | 求值器无意见（fail-closed 面不进观察判据） |

**context 字段**（SQL 可聚合，对齐 #1360 结构化事件纪律）：`oldVerdict / evaluatorWouldAllow / evaluatorWouldBlock / targetPaths(≤3) / unevalReason / oldRuleId(指纹分类，放行记 none) / commandHead(脱敏截短 120) / hasWorktreePath`。

**零干预铁律（三层）**：
1. 判定链本体零改动（checkBashCommandSafety 未动）
2. 回调异常吞掉（try-catch in notifyShadowEval）——影子挂了不影响拦截
3. sink.create 失败仅 logger.warn（fire-and-forget，对齐 onGuardIntercept 纪律）

**旁路防抖**：同 otter 同命令 10min 窗内只记一次（#1353 连环拦截台账放大先例的 shadow 侧治理）。healingRepo 缺失时回调不构造（影子静默关，零依赖启动）。

### 观察期判据（预注册）

- **真误放（人工裁 BLOCK）> 0 → 停止切换回炉**——求值器会放的命令被人工确认该拦，说明 fail-closed 面有实战缺口，题库验证不足以背书
- 确认误拦（人工裁放行）累计——量化求值器切换收益
- EVAL_GAIN 聚合——按 oldRuleId 分组看旧链漏拦面分布（none=旧链无规则可拦的形态）
- 判据线沿用 gwte 预注册四项（红线 0/误放 0/族内 ≥90%/回落 ≤50%），观察期数据是「实战版」语料来源

### 观察统计：scripts/shadow-eval-report.mjs

`node scripts/shadow-eval-report.mjs [--db <path>] [--days N]`——聚合真误拦候选（已裁决/未裁决/确认误拦/真误放）+ EVAL_GAIN 按 ruleId 聚合 + 判据红线实时提示 + 未裁决清单（人工裁决工作面）+ 裁决操作指引（resolution 写「确认误拦：<理由>」或「真误放：<理由>」）。畸形 context 容错跳过（#1368 json_extract 同型教训：日跑生产库必须抗畸形数据）。

## 设计取舍

**挂点选 abortOnUnsafeBash 而非 checkBashCommandSafety 内部**：判定函数内挂点会把观察逻辑混进安全判定本体（一处都不该动）；abort 层已判完、语义上是「判定结果的消费端」，影子作为第二消费者零侵入。代价：wait 工具的 until 校验路径（tool-factory.ts:606 直调 checkBashCommandSafety）不经影子——until 命令是 wait 元命令参数不是 bash 工具调用，量小且形态单一，观察期不覆盖可接受（如实声明，非盲区）。

**双向过滤而非全量落账**：全量落账=每天数百条无信息记录（绝大多数命令双方同判放行），台账膨胀淹没真信号；双向过滤后每天预期 0-20 条（拦截本来是小概率+求值器会拦的更少）。代价：观察期无法计算「双方一致率」——可接受，判据只关心分歧面。

**EVAL_GAIN 记录不告警**：观察期的使命是收集求值器「会放」侧的可靠性证据；「会拦」侧收益是切换 PR 的论据，不需要实时人工看——聚合呈现即可。

**projectRoot 用 process.cwd() 而非 session 级注入**：与 onGuardIntercept/projectRoot 透传链同源（挂点同处、同一守卫判定参数），不一致反而引入双源漂移。

**errorType 复用 healing_events 而非新表**：#1360 结构化事件先例 + manage_healing_events 工具链可直接消费（batch_resolve 收尾）+ 零 schema 变更（error_type 无 CHECK 约束）。观察期结束随 issue 归口收尾，生命周期走既有通道。

## 机制识别检查点（troubleshooting 决策树）

无命中：不新增配置/状态/定时任务/信号处理/存储结构（healing_events 既有表扩展 errorType 值域）/决策持久化/跨模块调用协议（回调注入是既有 attachGuards 参数模式扩展）。判定：既有机制内的观察通道补位 → new-feature（新增独立观察机制，无既有语义修改）。

## 改动范围

```
src/frameworks/agent/shadow-eval-recorder.ts        （新增 ~210 行：纯函数核 + 落账）
src/frameworks/agent/circuit-breaker-helpers.ts     （+3 处：options 类型/透传/notifyShadowEval 调用点）
src/frameworks/agent/pi-session-factory.ts          （+buildShadowEvalHook 构造，attachGuards 透传）
scripts/shadow-eval-report.mjs                      （新增 ~100 行：观察聚合报告）
scripts/shadow-report-selftest.mjs                 （新增：报告口径自证，CI 外开发自检）
tests/frameworks/agent/shadow-eval-recorder.test.ts （新增 14 例）
tests/frameworks/agent/shadow-eval-zero-impact.test.ts（新增 2 例：判定链基线+挂载对照）
docs/features/2026/10/10/F20261010gshw-*.md         （本文档）
```

## 验证

| 验证项 | 结果 |
|---|---|
| 影子记录器单测 | 14/14（三态投影/双向过滤/防抖窗/fail-safe/context 口径/零干预接线集成） |
| 零干预对照 | 2/2：判定链基线（9 命令族含 #1360 修复面、#1381 负门、#1240 heredoc 负门、kill 族）与挂影子前后 abort 行为逐条一致 |
| agent 目录全量 | 55 文件 1431/1431 |
| 全仓 | 354 文件 5297/5297（基线 5266 + 新增 31） |
| eslint | 0 error（复杂度拆函数达标） |
| 报告脚本自证 | 合成 7 例（含畸形 context/窗外）聚合口径全部核对通过 |

## 影响范围

- **生产行为**：拦截/放行判定零变化（测试证明）；新增 healing_events 写入（errorType=guard_eval_shadow，预期日增 0-20 条，防抖 10min）
- **性能**：每条 bash 命令多一次求值器纯函数调用（词法解析微秒级，语料 141 例全量 <100ms）+ 极少量 DB 写（异步 fire-and-forget，不阻塞判定）
- **观察期运维**：`node scripts/shadow-eval-report.mjs` 拉聚合；裁决经 manage_healing_events 逐条处置

## 风险与遗留

- **wait until 路径不经影子**（设计取舍声明，量小可接受）
- **防抖缓存进程内**——主进程重启后窗重置（可接受：防抖是防刷屏不是精确去重）
- **观察数据裁决是人工动作**——脚本已给逐条清单与操作指引，但裁决节奏由大獭/搭档定；未裁决堆积时判据无法出结论（报告会如实显示未裁决数）
- **切换仍是后续独立 PR**——观察期数据达标 + BC-1/BC-3 呈搭档拍板后才接线

## 下一步

1. 合入后观察期开始（真实命令自然积累）
2. 每日（或隔日）跑 shadow-eval-report 拉聚合，真误拦候选人工裁决
3. 裁决积累足量后出终局观察报告 → 呈搭档拍板切换
