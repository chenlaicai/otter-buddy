---
id: F20261027cbfp
title: 熔断器滑窗误伤止血：steer 清窗逃生口 + 粘滞黑名单仅 terminate 写入
summary: 近 7 天 54 次 CIRCUIT_BREAK / 239 次门物理拦截的大头是正当工作流被误判（#1653）。两条止血：① 滑窗 steer 清空窗口历史并进入未成熟期（重灌满 windowSize*repeat 前不判定、allow 不清 strike）——响应警告的獭有逃生口，真死循环仍必然 terminate；② 粘滞黑名单仅 terminate 写入——steer 回归纯警告语义，误判不再放大为会话级持续瘫痪。
change_type: fix
created_in_conversation: f26fe9d5-6a2f-485d-a079-b70afd5722f7
causal_links:
  - "#1653（本修复的 issue 载体，含完整案发现场数据）"
  - "F20261020hlbk（#1556，粘滞门引入——本次收窄其写入时机）"
  - "F20260728cbwt（两档制行为范式基线——本次在滑窗路径上修正其逃生语义）"
  - "#1399（签名区分度残余口子，P1 层独立跟踪）"
tags: [circuit-breaker, guard, false-positive]
modules: [src/frameworks/agent/tool-call-circuit-breaker.ts, src/frameworks/agent/circuit-breaker-helpers.ts]
created_at: 2026-10-27
---

# F20261027cbfp：熔断器滑窗误伤止血（#1653 P0）

## 1. 问题与案发现场

完整数据在 #1653（entries 表 18 起用户可见中断、日志层 54 次 CIRCUIT_BREAK、239 次门拦截 / 49 session，被拦工具 TOP：bash 53 / read 52 / grep 27 / update_artifact_status 24——全是探查与状态管理类正当调用；抽验案件 0 起真死循环）。

根因链三环：

1. **滑窗持续态无逃生口**（`tool-call-circuit-breaker.ts` evaluate/checkSlidingWindow）：滑窗命中 steer 后窗口不清空，獭即使响应警告换用新调用，旧记录仍留在 18 条窗口内持续命中 → strike 只能靠 allow 清零但窗口持续命中期间永无 allow → 第 6 次 steer 必 terminate。数学：洗掉旧模式需要 ≥11 次全新签名，strike 预算只有 5。
2. **steer 写粘滞黑名单**（`circuit-breaker-helpers.ts` #1566 引入）：steer 与 terminate 都写 loopBlockedTools → 一次滑窗误报 = 该签名本 invoke 内永久拉黑 → 獭换路径再触发滑窗 → 新签名再拉黑——滚雪球成会话级瘫痪。
3. **签名区分度不足**（放大器，#1399 独立跟踪）：read 无 offset、grep/set_context/workspace_* 等走名称兜底——同名不同参不可区分，正当节奏流极易虚假命中。

## 2. 机制判定（动手前完成，清单七项全未命中）

新增配置字段 / 状态生命周期 / 定时任务 / 信号类型 / 持久化存储 / 决策分支（被记住并影响后续行为）/ 跨模块调用路径——**均未命中**。本次全部是既有机制的语义修正（修法决策树①既有语义内修）：
- P0-1 是滑窗规则的**状态转移修正**（新增的 windowImmature 是纯运行时瞬态标记，不持久化、不跨 invoke）
- P0-2 是黑名单**写入时机收窄**（删除 steer 写入分支，保留 terminate 写入）

Modification-Class: `narrow-fix`（①既有语义内修）

## 3. 修复设计

### P0-1：滑窗 steer 清窗 + 未成熟期（tool-call-circuit-breaker.ts）

- 滑窗 steer（origin=sliding_window）触发时：`callHistory.length = 0` + `windowImmature = true`
- 未成熟期语义（三件事配套，缺一即漏）：
  1. **滑窗判定暂停**——窗口从零重灌，避免残留模式继续命中（死刑链主根因）
  2. **allow 不清零 steerStrikes**——重灌期恰好无滑窗命中全产生 allow，若照旧清零则真循环每轮重灌都洗掉 strike，永不 terminate（第一版实现踩过这个坑，3 个测试红了才暴露）
  3. **成熟条件**：重灌满 windowSize*repeat（18）条即恢复正常判定与 strike 重置
- 连续同签名（B-3 consecutive）不受清窗与未成熟期影响——真卡壳在重灌期也抓得住（该路径独立累计）
- CheckResult 增加 `origin` 字段区分 steer 来源：仅滑窗 steer 清窗，consecutive steer 不清（后者每次 check 都是新事实，清窗无意义）

**行为推演**：
- 误伤场景（read 同文件×18 + grep×18 节奏流）：steer#1 清窗 → 獭换新工具序列 → 重灌 18 条无命中 → 成熟后 allow → strike 清零 → 恢复自由 ✅
- 真死循环（A-B 无限交替）：steer#1 清窗 → 重灌满 18 条（模式完成）→ 再命中 steer#2 → …… → strike 6 > 5 → terminate ✅（终止点从 ~24 次后移到 ~110 次，见取舍）

### P0-2：粘滞黑名单仅 terminate 写入（circuit-breaker-helpers.ts）

- 删除 `result.action === "steer" ||` 分支，仅 terminate 写 loopBlockedTools
- #1556 的事故场景（30 连发垃圾 fact、报警后复又发作）仍被兑住：该场景必然走到 strike 涨满 → terminate → 写黑名单 + abort，后续同签名调用照拦
- 语义对齐：steer = 警告（可纠正），terminate = 判决（物理截断）——警告不再有物理后果

## 4. 设计取舍

1. **真循环终止点后移**（约 24 次 → 约 110 次调用）：清窗机制让真循环每重灌一轮（18 条）才命中一次 steer，strike 6 次需 ~108 条。接受理由：真循环每条调用都在产生可观测日志与 token 消耗（非静默挂死），而误伤是直接砍断正当任务（10-27 实现獭 168 次调用被断，工时实损）。且 per-event 超时（600s）与 maxConsecutiveIdentical（同签名 6 次即 steer）仍在兜底——多数真循环（同签名连发型）走 B-3 路径不受影响，只有「跨工具交替型」真循环终止点后移。
2. **第一版方案（防抖计数）被否**：曾实现 callsSinceWindowReset 计数防重触发，但重灌期 allow 清零 strike 导致真循环永不 terminate（3 测试红）。改为「未成熟期 allow 不清 strike」配套后才闭合。教训：逃生口与防逃逸必须同时设计，单修一头即漏。
3. **为什么不直接调大阈值/调高 maxRepeatAfterWarning**：治标——误伤根源是窗口残留（结构问题），调参数只改变死刑链长度不改变必死性。
4. **#1566 门本身保留**：物理截断对「报警后复又发作」场景（#1556 发作 2）仍是唯一可靠防线，只是写入时机从 steer 收窄到 terminate。删门属过度矫正。

## 5. 验证

### 失败证据链（troubleshooting 5a 固化）

- 修复前失败输出：`tests/frameworks/agent/tool-call-circuit-breaker.test.ts` 新增用例「steer 后獭改换全新调用序列应恢复自由」红——`expect(terminated).toBe(false)` 收到 true（死刑链复现：獭已换全新调用序列仍被 terminate）。运行记录：`npx vitest run -t "F20261027cbfp"` 1 failed。
- 修复后通过：同用例绿（12 次新序列调用全部 allow、无 terminate），全仓 439 文件 6988 测试全绿，`tsc --noEmit` 零错误。

### 行为断言（可机械验证）

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 误伤逃生 | read 同文件×18 + grep×18 → steer 后改用 12 个全新工具 | 全部 allow，无 terminate（PASS：vitest F20261027cbfp 用例 1） |
| 真循环仍断 | A-B 无限交替 ≤130 次 | 必出现 terminate（PASS：用例 2 + 更新版「滑窗 steer 被持续无视」用例） |
| steer 不拉黑 | 同命令 3 连发触发 steer | loopBlockedTools.size === 0（PASS：helpers 新用例 + hard-block 新用例） |
| terminate 仍拉黑 | 同命令连发至 strike 涨满 | Map 写入且门拦截同签名（PASS：hard-block 用例） |
| #1556 场景不回退 | create_linked_resource 9 连发（6+3） | abort 发生 + Map 写入 + speak/yield 放行（PASS：hard-block 更新用例） |
| 全量回归 | npx vitest run | 6988 passed（439 文件） |

### 既有测试调整记录（断言未减弱，时点断言随行为语义更新）

- 「滑窗 steer 被持续无视也会升级为 terminate」：能力断言保留（仍必 terminate），新增终止点后移断言（>20 次）——旧行为（20 次内断）正是死刑链本身。
- 「detects sliding window cross-tool alternating loop (AC-8)」：首命中检测能力保留（18 次内必 steer），后续连发 steer 断言改为 allow（清窗后的预期行为）。
- loop-tool-hard-block 两个用例：从「steer 即写 Map」更新为「terminate 才写 Map」——P0-2 的语义变更本体，负向用例（steer 阶段 Map 空）与 #1556 场景（terminate 后粘滞）双向覆盖。

## 6. 影响面与遗留

- **行为变化**：滑窗路径的 steer 频率下降（每 18 条一次而非每 check 一次）、真循环（跨工具交替型）终止点后移约 4.5 倍、门拦截量预期大幅下降（steer 写入路径已断——239 次拦截的写入源消失）。
- **不影响**：同签名连发检测（B-3）、per-event 超时、output guard、编排守卫、speak/yield 豁免。
- **遗留（不在本 PR）**：签名区分度（read 无 offset、名称兜底族）→ #1399 P1 层跟踪；观测补强（terminate/门拦截时写入窗口签名多样性到 healing event）→ #1653 P2。
- **文档影响**：本 PR 不使任何已合入文档失效（F20261020hlbk 的门机制描述中「steer/terminate 均写」一节由本文档第 3 节修正说明覆盖，历史文档不回改）。

## 7. 最简实现检查

已过：方案零新增文件、零新增依赖、零配置面变化；P0-2 是纯分支删除（-3 行）；P0-1 净增约 20 行（含注释）。未采用更重的方案（参数多样性判定、签名粒度改造）——那是 #1399 与 P2 的领地，本 PR 只做止血。
