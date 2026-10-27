---
id: F20261026hfup
title: 交接落位与派单闭环修复批次：restoreHandoffContext 死键清除 + openMatters 进合成原料 + 未闭环扫描 WAITING_OTTER 停滞口径
summary: M-5f45049e——restoreHandoffContext 强写 ctx.openMatters 静默丢弃（DynamicContext 接口与渲染函数均无该字段，且 D8 后 handoff_* 键在生产无写入方，纯死代码面）；M-12b165a7——跨獭派单「接单≠落位」缺口双因：①collectOpenMatters 产出的 matters 清单只挂档案机械段（buildMechanicalArchive/assembleHandoffArchive），合成路径（buildNarrativeSynthesisPrompt）无 openMatters 参数，新世獭在叙事摘要里看不见悬置事项；②未闭环扫描停滞口径缺 WAITING_OTTER（獭侧接单未落位无日巡盯防，实证=固化獭补 #1467 注记悬置 6 天无人盯）。
doc_type: feature
change_type: fix
intent:
  problem: "M-5f45049e：restoreHandoffContext 强写 ctx.openMatters 静默丢弃（handoff-support.ts:88 四键循环含 handoff_open_matters → targets 含 openMatters，但 DynamicContext 接口与 session-helpers 渲染链均无 openMatters 字段——借用式恢复路径 matters 清单丢失）；M-12b165a7：跨獭派单「接单≠落位」——10-14 裁决指定固化獭补 #1467 注记，悬置 6 天无人盯（大獭 2026-10-20 记档），与幽灵工单同属派单闭环病灶。"
  why_now: "五条流通实证驱动的派单闭环收口批次（与 F20261021gtbf 幽灵工单根因治理互补——那单管「任务过期被照做」，本单管「任务接了没人做」）；#1582 已合入层差注记（不重做），本单修机制面。"
  expected_effect: "新世獭的叙事摘要（七段 §① 下一步）能看到未闭环 matters 清单并逐件对齐，接续面不再漏件；每日 7:30 未闭环扫描盯到 WAITING_OTTER 跨日停滞（与搭档侧同 24h 基准），「接单≠落位」类悬置结构性有声；restoreHandoffContext 不再假装恢复一个接口不存在的字段。"
  verify_by:
    type: unit_test
    note: "MatterSweep 停滞扫描 +2 用例（WAITING_OTTER >24h 命中 / <24h 不命中）；buildNarrativeSynthesisPrompt +2 用例（openMatters 进 §④ 机械供料区且位置在 §⑥ 前 / 缺省向后兼容）；restoreHandoffContext 新测试文件 3 用例（三键恢复消费即删 / open_matters 死键不再查询强写 / manageContext 缺省降级）"
capability_test: "tests/capability/matter-loop/matter-loop.capability.test.ts（档案段供料已有场景②覆盖——本单未改档案段语义，叙事原料新增段为纯 prompt 层，能力测试不扩）"
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
created_at: 2026-10-27
tags: [handoff, matter-loop, scheduled-task, context]
modules: [src/interface-adapters/agent-runtime/handoff-support.ts, src/frameworks/agent/narrative-synthesis-engine.ts, src/interface-adapters/agent-runtime/agent-invoker.ts, src/frameworks/db/matter/sqlite-matter-repository.ts, prompts/scheduled/未闭环扫描.md]
causal_links:
  - F20261006mtlp
  - F20261021gtbf
  - F20261008mlp3
---

# 交接落位与派单闭环修复批次（M-5f45049e + M-12b165a7）

## 背景

两条 matter 同属「派单/交接闭环」病灶域，批次处置：

**M-5f45049e（restoreHandoffContext 强写 ctx.openMatters 静默丢弃）**

- 病灶现场：`handoff-support.ts:88-89`——restoreHandoffContext 循环强写 `keys=['handoff_file_trail','handoff_recency_window','handoff_state_inventory','handoff_open_matters']` → `targets=['fileTrail','recencyWindow','stateInventory','openMatters']`
- 丢弃机制：`sdk-invoke-port.ts:62-77` 的 `DynamicContext` 接口声明了 fileTrail/recencyWindow/stateInventory/healingAlerts/signalAlerts/scheduledTaskAlerts，**无 `openMatters` 字段**；`session-helpers.ts` 的 buildMessageWithContext 渲染链同样无 openMatters 消费段——强写进对象即静默丢弃（`(ctx as Record<string, unknown>)` 绕过类型检查）
- 追加实证（本批排查新发现，比简报定性更宽）：全仓 `rg "set(.*handoff_"` 零命中——**D8 演进后档案走 session.summary 单点写入（agent-invoker.ts:1348 注释明载「不再预写 otter_context 借用式 key」），handoff_* 四键在生产无任何写入方**。restoreHandoffContext 恢复面整体是死代码（F20261006mtlp 原文 §284 行自承「legacy key 消费面保留对称」——写方撤了、消费方保留形成的悬空面）；openMatters 的真实投递路径是 archive 档案段（buildMechanicalArchive/assembleHandoffArchive 的「### 本对话未闭环事情（matters 机械供料）」段，能力测试 matter-loop 场景②已钉死）

**M-12b165a7（跨獭派单「接单≠落位」follow-up 缺口）**

- 实证锚：10-14 裁决指定固化獭补 #1467 注记（大獭回签 PR #1467 comment 6160667395），悬置 6 天无人盯，大獭 2026-10-20 记档「接单≠落位，与幽灵工单同属派单闭环病灶」
- 机制缺口双因：
  1. **接续面漏件**：`agent-invoker.ts:1165` collectOpenMatters 产出的 matters 清单只传给 buildMechanicalArchive / assembleHandoffArchive（档案段），**合成路径 buildNarrativeSynthesisPrompt 的 NarrativeSynthesisInput 无 openMatters 参数**——叙事摘要（新世獭理解前世的唯一叙事来源，appendPromptHeader 原文）里看不见悬置事项，「固化獭补注记」这类接续指令在七段 §① 下一步里结构性缺席
  2. **盯防面缺口**：未闭环扫描（F20261008mlp3 P3 已升格为 matter_sweep 确定性查询）停滞口径只有 OPEN 全捞 + WAITING_PARTNER 24h 阈，**无 WAITING_OTTER**——獭侧「接单未落位」没有日巡盯防，悬置 6 天无声正因此

## 修法（narrow-fix——机制识别检查点逐项全否）

**Modification-Class**：`narrow-fix`（修法决策树①——既有机制语义内修，机制识别检查点逐项全否，不涉净新增机制）。

检查点逐项：新增配置字段/枚举/开关 ❌｜新增状态生命周期 ❌（复用既有五态）｜新增定时任务/后台进程 ❌（复用每日 7:30 未闭环扫描）｜新增信号类型/消息格式 ❌｜新增持久化存储 ❌｜新增决策分支 ❌（SQL 停滞 WHERE 子句扩一态，复用既有 24h 基准——与既有 WAITING_PARTNER 阈同构，非新策略分支）｜新增跨模块调用路径 ❌（openMatters 数据源 collectOpenMatters 已存在，只接到既有的第二个消费方 buildNarrativeSynthesisPrompt——与「collectOpenMatters → assembleHandoffArchive」同型同构）。→ 修法决策树①（既有机制语义内修），不涉净新增机制，与简报「优先最小修法，派单落位复用 scheduler/matters 机制不另造框架」口径一致。

**修 1（M-5f45049e）**：restoreHandoffContext 撤除孤立的 `handoff_open_matters` 键——keys/targets 从 4 键收编回 3 借用式键。不做全死面清扫（其余三键同为无写入方死代码，但简报边界=openMatters 一条；全面清扫另立单），特性文档记档悬空面全貌。

**修 2（M-12b165a7 接续面）**：openMatters 进合成原料——
- `narrative-synthesis-engine.ts`：NarrativeSynthesisInput 增 `openMatters?: string` 字段（与档案段同名同源）；appendMechanicalSections 在 §④ 预取数据区追加「### 本对话未闭环事情（matters 机械供料——§① 下一步必须逐件对齐：续办/等谁，不漏件）」段（位置：§④ 后、§⑥ 前——机械供料区内聚）
- `agent-invoker.ts:1267` 附近：buildNarrativeSynthesisPrompt 调用点传 `openMatters: openMattersText`（同一供料源，与档案段共用 collectOpenMatters 产出——单源双投递，无双写）
- 连带对齐：formatPrefetch 补 recentUserMessages 空态显式分支（原实现 §④/§⑥ 双处渲染 recentUserMessages 且空态口径不一致——§④ 缺失时整个字段静默缺席违反自身「无数据明说"无"」注释约定，§⑥ 有空态文案；对齐为 §④ 渲染 + 显式空态，单源不双写）

**修 3（M-12b165a7 盯防面）**：未闭环扫描停滞口径升格 WAITING_OTTER——
- `sqlite-matter-repository.ts` stalledOpen：WHERE 子句扩 `OR (state = 'WAITING_OTTER' AND updated_at <= ?)`（与 WAITING_PARTNER 同 24h 基准——接单后当日干活不算停滞，跨日未动才算，对称语义）
- `prompts/scheduled/未闭环扫描.md`：停滞定义与口径段同步补第三条（「接单未落位」语义声明，2026-10-27 升格补入记档）

**刻意不做**（与简报边界对齐）：不重做 #1582 已合入的 #1467 层差注记；不做守卫判定逻辑；不另造派单落位框架（结构化派工单带 createdAt/status 的数据层治理是治本方向，F20261021gtbf 残余记档已声明「需单独论证」，本单不推）；restoreHandoffContext 其余三键死面不全扫。

## 影响范围

- 行为变化：
  - 合成 prompt 在会话有 open matters 时多一段机械供料（段入固定段预算实测基线——两遍组装机制自动重算裁剪预算，大 session 合成不超窗；collectOpenMatters 上限 50 件截断保护，极端情况供料 ≤ 数千字符）
  - 每日 7:30 未闭环扫描可能新增 WAITING_OTTER 停滞提醒（此前该类悬置无声——这是本单的目的性变化，非回归面）
  - restoreHandoffContext 不再查询/删除 handoff_open_matters 键（生产本就无写入方，行为零变化；若有历史残留键则不再被消费——残留键无害留存，与其他历史 context key 同待遇）
- 不修改：matters 表结构、状态机、archive 档案段语义、matter-loop 能力测试断言面
- 历史兼容（「丢了哪些旧契约」负面向验收）：buildNarrativeSynthesisPrompt 缺省 openMatters 的旧调用（测试/mock）输出零变化（条件段）；stalledOpen 返回值结构不变（同 MatterSweepStall，state 枚举值扩面非结构变化）；restoreHandoffContext 三键恢复语义不变

## 验证

- 新增单测 7 用例：
  - `tests/usecases/matter/matter-sweep.test.ts` +2：WAITING_OTTER >24h 命中（waitingOn/stalledHours 断言）/ <24h 不命中
  - `tests/frameworks/agent/unified-handoff-engine.test.ts` +2：openMatters 进合成 prompt 且位置在 §④ 后 §⑥ 前 / 缺省向后兼容无该段
  - `tests/interface-adapters/agent-runtime/handoff-support-restore.test.ts`（新文件）+3：三键恢复消费即删 / handoff_open_matters 死键不再查询强写（钉死 M-5f45049e 修法）/ manageContext 缺省降级
- 全量 vitest：438 files / **6962 passed / 6 skipped 零失败**（基线 6955 → +7 即本批新增）
- tsc / eslint（七改动文件）零错误
- matter-loop 能力测试不扩（档案段语义未改；叙事原料段为纯 prompt 层，LLM 行为面由七段模板规则 1「机械供料数据直接用」约束）

## 残余记档

1. **restoreHandoffContext 三键死面**（handoff_file_trail/recency_window/state_inventory）：D8 后同为无写入方的悬空恢复面，本单只撤 handoff_open_matters（简报边界）；全面清扫（或重估借用式 key 机制存废）建议另立单——清扫前需确认无在途旧版写入路径（如降级分支）
2. **「接单≠落位」治本方向**：结构化派工单（task brief 带 createdAt/status 数据层治理）F20261021gtbf 已记档为「需单独论证」，本单的扫描盯防是止血不是治本——盯防能让悬置有声，不能让派单自带截止
3. **幽灵工单与派单闭环的互补关系**：F20261021gtbf 管「任务过期被照做」（换世时效核验），本单管「任务接了没人做」（接续面供料 + 盯防面停滞）——两单合观构成派单闭环双壁
4. **openMatters 档案段与合成原料段双投递**：同一 collectOpenMatters 产出供两个消费方（档案段=新世必读静态面；合成原料=七段 §① 对齐面），单源无双写；未来若档案段裁撤（纯叙事路径），合成原料段不受影响

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| M-5f45049e 修法 | 撤孤立死键（narrow-fix） | 补 DynamicContext.openMatters 字段+渲染段（复活借用式投递） | D8 后 archive 段已是唯一真实投递路径（能力测试钉死）；复活借道 otter_context 是第二投递通道=双写风险，且键无写入方——补接口是复活死机制，撤键是承认现实 |
| restoreHandoffContext 死面范围 | 只撤 openMatters 一键 | 四键全扫（整体下线恢复面） | 简报边界=openMatters 一条；其余三键若有未发现的旧版写入路径（降级分支等），全扫会引入本单未验证的行为面——记档另立单 |
| openMatters 进合成原料 | prompt 机械供料区新增条件段 | 只改档案段措辞提醒 LLM 关注 | 档案段在 session.summary（新世首轮注入），但七段摘要是「新世理解前世的唯一叙事来源」——§① 下一步的原料里无 matters 清单，LLM 无义务也无能力从档案段反向回填下一步对齐；供料进原料区是确定性对齐 |
| WAITING_OTTER 停滞阈 | 与 WAITING_PARTNER 同 24h 基准 | 独立阈值（如 48h） | 无依据区分獭侧与搭档侧的停滞容忍度；同基准语义对称（跨日未收尾），阈值常量集中 STALL_THRESHOLD_HOURS 单点，后续有实证再分 |
| 扫描升格载体 | 改 stalledOpen SQL + prompt 口径同步 | 新开 matter 类型或新扫描工具 | matters 五态已覆盖「獭处理中」语义（WAITING_OTTER 等待方=认领獭，transition-matter.ts:120 认领语义既有）——缺口在扫描口径不在数据模型 |
