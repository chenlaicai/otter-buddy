---
id: F20261026cnsv
title: 海獭执行体并发语义定稿与 lock gap 治理（方案）
doc_type: design

summary: |
  定稿「同一海獭执行体的并发语义」——终结 F20260913ctlv「per-otter 锁退役」与
  F20260920uhuc「锁保留」的文档矛盾；治理 2026-10-26 17:18 Lock acquire timeout
  事故暴露的四层 gap（入口不收敛 / 锁超时裸抛 / steal 纯时长误判 / 失真注释）。
  方案四件套：①设计定稿——锁保留、职责=串行一致性防线；②入口收敛——链调度
  hop 对 running 獭转 followUp 注入；③锁超时兜底降级——等锁超时不再裸抛，转
  followUp 排队；④steal 双条件——「超时 + 持有者不活跃」才强制接管，消灭活任务
  误判。

causal_links:
  from:
    - F20260913ctlv   # 「per-otter 锁退役」清单的提出方（本档定稿其第 8 项由 F20260920uhuc 修订，矛盾就此终结）
    - F20260920uhuc   # 「锁保留」的零基论证方（本档采纳其结论并补实现层对齐）
    - F20260923hspx   # 交接锁旁路 + 「毫秒级短临界区」失真注释的引入方（本档修正注释）
    - F20261020ided   # retry 入口判重的先例（本档把通用 retry API 对齐到同款防线）
  relates:
    - "#599"          # stale-steal 机制的引入 issue（本档把 steal 判定升级为双条件）

change_type: feature
tags: [invoke, concurrency, lock, followup, dispatch-chain, design-finalization]
modules:
  - src/usecases/conversation/dispatch-chain-engine.ts
  - src/frameworks/agent/pi-session-factory.ts
  - src/frameworks/agent/session-helpers.ts
  - src/interface-adapters/http/controllers/invoke-controller.ts

created_at: 2026-10-26
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
capability_test: "n/a: 设计方案文档，无 LLM 参与行为变更；实现 PR 另附能力测试"
---

# 海獭执行体并发语义定稿与 lock gap 治理（方案）

## 背景

搭档原话（意图锚）：

> （2026-10-26 17:19）「我刚才看到系统消息《[错误] Lock acquire timeout for key:
> session:22058eb4-...》，然后我在疑惑，咱们海獭运行执行体走 steer，为啥还有
> 这个报错？理论上不存在了吧」

> （2026-10-26 17:39）「我认为这不是修呀，这是当前实现不符合咱们的设计吧。
> 你先整理下，咱们的设计是什么，然后当前实现是什么，这两个之间还有啥 gap。
> 海獭执行体！我认为当时的设计，应该不再存在这个 lock 了呀」

> （2026-10-26 20:51，对「出并发语义定稿 + gap 治理完整方案」的批复）「ok」

### 事故与 gap 清单（已对抗核验定稿）

2026-10-26 17:18 事故：「写个小说」对话（84c74d5e）中，大獭 09:14:11 起 invoke
27808ddd（改线上 120 章，持续 483.8s）持锁；09:17:39 主笔獭 yield 回大獭触发
链式调度，第二跳 invoke df1b71a6 撞锁等 30.032s 超时，裸 `[错误]` 直达用户。
完整时间线与证据链（entries seq 1847-1855 + log trace t_85aae69e 闭环）见
对话记录；检视獭 Kimi 独立核验报告（19:55）证伪了初版 3 处表述，定稿 5 条 gap：

| # | gap | 锚点 |
|---|-----|------|
| G1 | 设计文档自相矛盾：9/13 退役清单含「per-otter 锁」vs 9/20 零基重推「锁（保：串行模型是消息一致性的根基）」 | F20260913ctlv:60 / F20260920uhuc:209 |
| G2 | 锁实现全运行期持有（本案 483s 实证），与任何一种定位（退役 / 「毫秒级短临界区」注释）都不匹配 | pi-session-factory.ts:754-761 |
| G3 | 入口收敛不完整：yield 链调度（executeOneHop）直调 invokeFn 无 isRunning 检查；通用 retry API 残留缺口。scheduler 与前端 retryOtter 已有防线，不在列 | dispatch-chain-engine.ts:295-326 / invoke-controller.ts:102-112 |
| G4 | 失败交付不完整：30s 慢失败 + 裸技术错误直达 + 失败 hop 无自动续投（yield entry 已持久化，丢的是下游 hop 及时执行） | orchestrator.ts:1103-1118 |
| G5 | stale-steal 纯时长误判：锁持有超 300s 即强制接管，不检查持有者是否存活；本案 483s 正常任务实证「超 300s = 异常」假设不成立，误抢将导致新旧 agent 生命周期并存 | session-helpers.ts:179-204 |

## 目标

- T1 并发语义定稿：形成唯一权威语义，终结 G1 的文档矛盾，后续实现以此档为准
- T2 消灭「busy 獭被直接 invoke 撞锁」：yield 链等所有入口收敛到「running → followUp 排队注入」（G3）
- T3 锁冲突不再慢失败裸抛：等锁超时路径兜底转 followUp，裸错误仅剩「followUp 也不可用」的异常态（G4）
- T4 steal 误判治理：强制接管从「纯时长」升级为「时长 + 持有者不活跃」双条件（G5）

## 非目标

- 不重做 dispatch-chain 引擎与信号路由器架构（F20260913ctlv 已定型的部分不动）
- 不改 pi SDK 内部 followUp/steer 队列实现（SDK 语义直接采用）
- 不处理跨獭并发（不同獭并行执行是设计特性，与本案无关）
- 不改交接（handoff）锁语义——F20260920uhuc/F20260923hspx 已定义交接冻结窗口，
  本档只确认主 invoke 锁与交接锁的共存关系，交接路径本身不重构
- 不在本轮实现「失败 hop 自动续投」（T3 兜底降级后该场景理论消失；若实现后仍有
  残留场景，另立议题）

## 方案设计

### D1｜语义定稿：锁保留，职责 = 同獭串行一致性防线（终结 G1）

**决策：采纳 F20260920uhuc 零基重推结论——per-otter session 锁保留。**
F20260913ctlv 退役清单第 8 项「per-otter 锁」自本档起废止（历史文档不可改，
以本档 causal_links 终结矛盾）。

定稿语义（唯一权威表述）：

```
同一海獭执行体，任意时刻至多一个 invoke 在运行（串行不变式）。
层间分工：
  1. 主防线——调度入口：目标 running 时新任务不直接 invoke，转 followUp
     注入当前 session 的 SDK 原生队列（续轮消化，不打断、不丢轮）
  2. 兜底防线——session 锁：等锁超时后不再裸抛，自动降级为 followUp 注入
  3. 完全失败——锁 + followUp 双不可用（池状态异常）：快速失败 + 人话错误
  4. 僵尸清理——steal：仅当「超阈值 且 持有者不活跃」才强制接管
```

锁保留的零基论证（引用 9/20 结论并确认）：session 池复用（LRU 热池）与
activeSessions 生命周期管理需要互斥点；完全去锁要求重写 session 生命周期归属
模型，风险大于收益；入口收敛完成后，锁退化为「几乎不排队的兜底串行保证」，
持有期长不再构成体验问题（等锁场景在主防线处已被消灭）。

### D2｜入口收敛：executeOneHop 对 running 目标转 followUp（治 G3 主缺口）

`dispatch-chain-engine.executeOneHop` 在调用 `invokeFn` 前增加分支：

```
目标獭 factory.isRunning(target) === true
  → factory.followUp(otterId, hopPrompt)   // hopPrompt = 链引擎为该 hop 构造的派工指令
    ├─ true  → 本 hop 以「已投递（delegated）」结算，链引擎内存循环终止，
    │          后续链路由发言链机制自然延续（followUp 续轮的 yield 同样触发
    │          行级 talkingStonePassedTo 读取 → 下一 hop 调度，与用户消息
    │          followUp 消化后的链延续同构）
    └─ false → 降级直接 invokeFn（与 signal-router:206 降级语义一致，覆盖
               isRunning 判定与实际状态间的竞态窗口）
```

依据：signal-router 对 running 獭的生产语义即 isRunning → followUp
（signal-router.ts:220-248），SDK followUp 语义「run only after the agent would
otherwise stop」（pi-agent-core/dist/agent.d.ts:97）——续轮在当前 invoke 的
prompt() 内 drain，产出发言正常走 entries 管道，发言链 hook 对 drain 续轮生效
（生产实证：用户消息 followUp 注入后的 speak/yield 均正常落链）。

通用 retry API（`POST /api/invokes/:id/retry`，invoke-controller.ts:102-112）
对齐 F20261020ided 的 retryByOtter 判重：库行 running 或 SDK isRunning → 409
「忙碌中」。前端已走 retryOtter（有判重），该端点属残留 API，对齐后两个入口
防线一致。

**记账语义声明（审计取舍）**：followUp 注入的 hop，其续轮产出 entries 的
invoke_id 归属当前运行的 invoke（无独立 invoke 边界事件）。时间线呈现为「该獭
继续发言」，功能正确性（发言可见、链延续、行动权流转）不受影响，审计粒度变粗
是接受的代价——换取的是不打断运行中任务、不丢轮、不撞锁。

### D3｜锁超时兜底降级：等锁超时不再裸抛，转 followUp（治 G2/G4）

`pi-session-factory.invoke()` 取锁超时路径改造：

```
等锁 timeout（30s 保留）
  → this.followUp(otterId, message)   // followUp 从 poolMeta 取引用，无需持锁
     ├─ true  → 返回「queued」型结果（不落错误事件；该消息将在持有者
     │          invoke 的 drain 续轮被消化）
     └─ false → 池状态异常（锁被占但 session 不 streaming）→ 快速失败，
                错误文案人话化（「目标海獭状态异常，消息未能送达，请稍后
                重试」）+ healing event 落账，替代裸 `[错误] Lock acquire
                timeout for key: ...`
```

等锁时长维持 30s：入口收敛后真实撞锁仅剩竞态窗口与交接持锁两个场景——竞态
窗口内持有者通常毫秒级放锁；交接持锁（uhuc 设计：窗口内 invoke 锁排队，换世
后消化）依赖等待而非注入（followUp 注入即将 dispose 的旧世会丢消息），30s
等待是正确行为。交接锁超时对齐约束沿用 uhuc「对抗审视严重发现 1」既有决策。

### D4｜steal 双条件：「超阈值 且 持有者不活跃」才强制接管（治 G5）

`session-helpers.ts` steal 分支（:179-204）升级：

```
持有超 stealThresholdMs（300s）
  → 检查持有者活跃度（注入 isActive 回调：查该 otter 的 SDK isRunning /
    invokes 表 running 行——两者任一为活即视为活跃）
     ├─ 活跃   → 不 steal，继续等待（活的长任务合法，本案 483s 实证）
     └─ 不活跃 → 维持现行为：generation += 1 接管
```

实现注：session-helpers 不直接依赖 DB/SDK——通过构造注入 `isActive` 回调
（与现有 stealThresholdMs 同层的依赖注入），生产装配处（pi-session-factory）
提供实现。时长阈值 300s 维持不变：双条件后它只是「触发检查的时机」而非
「充分判死条件」。

### D5｜文档与注释修正（治 G1 残留 / 失真注释）

- 本档即并发语义定稿文档（causal_links 已关联三方）
- 9/23 引入的「invoke 池复用，毫秒级短临界区」注释（pi-session-factory.ts:438）
  在实现 PR 中修正为 D1 定稿表述
- F20260913ctlv / F20260920uhuc 均为历史文档不改动（铁律），矛盾由本档终结

## 影响范围

| 路径 | 影响 |
|------|------|
| yield 链调度（多獭协作主路径） | 行为变更：busy 目标从「撞锁报错」→「followUp 排队」 |
| 用户消息信号路径 | 不变（已是 followUp 语义，D2 是向其对齐） |
| scheduler | 不变（已有 isExecutorBusy + 路由器防线，经核验不在缺口内） |
| 交接（handoff） | 不变（等锁排队语义恰好是 uhuc 设计要求） |
| HTTP retry API | 行为变更：通用端点补 409 判重 |
| 长任务（>300s） | 行为变更：不再可能被 steal 误抢 |
| 前端 | 无需改动（错误场景减少；409 文案沿用 retryByOtter 既有格式） |

## 风险与约束

- **R1 hop 结算语义**：followUp 注入的 hop 以「delegated」结算，链引擎的
  recordAttemptSettle 需新增该终态（台账可读，区别于 completed/failed）——
  实现时确认台账 schema 对新终态的兼容性
- **R2 竞态窗口残留**：isRunning 检查与 invoke 之间的窄窗口由 D3 锁兜底覆盖，
  理论闭环；e2e 需覆盖「检查通过后立即撞锁」场景验证降级路径
- **R3 followUp 注入的 hop prompt 格式**：链引擎派工指令与用户消息的上下文
  呈现差异（drain 注入是否需要前缀说明「这是链式派工」）——实现时以实测
  续轮的模型理解为准，必要时加一行注入前缀
- **R4 交接窗口**：交接持锁 + 新 hop 到达 → 等 30s 锁超时 → followUp 此时
  session 状态取决于交接进度，可能落入「快速失败」分支——频率极低（交接窗口
  5-60s），失败有人话文案 + healing 落账，可接受；不为此加复杂度

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|----------|------|
| 锁去 vs 锁留 | 留（D1） | 完全去锁，纯靠入口收敛 | 9/20 零基论证：串行是消息一致性根基；去锁需重写 session 生命周期模型；收敛后锁仅剩兜底职责，持有期长不再是问题 |
| 主防线位置：入口检查 vs 锁内排队 | 入口收敛（D2） | 拉长锁等待让所有调用方排队 | 锁 waiter 不应承担调度职责（30s 干等即本案事故）；followUp 是 SDK 原生排队，无新机制 |
| busy 时注入方式：followUp vs steer | followUp | steer（打断当前任务） | 链式派工不构成「打断当前任务」的理由；steer 保留给用户显式标急（ctlv 语义不变） |
| 锁超时处理：裸抛 vs 降级注入 | 降级 followUp（D3） | 直接抛错但改文案 | followUp 无需持锁即可用，降级成本近零；裸抛丢轮的代价（本案实证）远大于降级复杂度 |
| steal 判定：纯时长 vs 双条件 | 时长 + 活跃（D4） | 拉长阈值至 10 分钟 | 拉长阈值治标：任何固定阈值都存在合法长任务越过它；活跃检查直接对准「僵尸」定义本身 |
| followUp hop 的 invoke 记账 | 归属当前 invoke（粒度变粗） | 为 drain 续轮伪造独立 invoke 边界 | 伪造边界需改 SDK 事件流或注入合成事件，复杂度高收益低；审计粒度换功能正确性 |

**机制识别检查点**：本方案不涉及净新增机制——无新增配置字段/状态生命周期/
定时任务/信号类型/持久化存储/跨模块调用路径；D2/D3 为既有机制（followUp、锁）
的调用路径扩展，D4 为既有 steal 分支的判定条件收紧，D5 为注释修正。机制预算
四问跳过（判定依据：followUp 队列为 SDK 既有机制且生产在用；「delegated」
结算终态为台账既有枚举的扩展，非新状态生命周期——若实现时发现台账枚举封闭
需破例，升级为机制新增重新过门）。

**大版本重构判断**：非大版本重构——锁保留、架构不动，属「入口收敛补全 +
既有机制语义对齐」，9/20 已完成锁去留的零基重推，本档引用其结论。

## 验证

- 单测：①executeOneHop 对 isRunning=true 目标走 followUp 且 delegated 结算；
  followUp=false 降级 invokeFn；②锁超时转 followUp 成功路径不落错误事件；
  followUp=false 路径落人话文案 + healing；③steal 双条件：超阈值但持有者
  活跃 → 不接管；不活跃 → 接管（generation 语义不变）；④通用 retry 端点
  running → 409
- e2e（复现本案）：invoke A 持锁长任务运行中触发 yield 链 hop → 断言无
  Lock timeout 错误、hop 消息经 A 的 drain 续轮消化、链延续（下一 hop 正常
  调度）、发言落 entries
- 回归：signal-router 用户消息路径既有测试全绿；交接（uhuc/hspx）既有测试全绿；
  scheduler 既有测试全绿（确认未被波及）

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/usecases/conversation/dispatch-chain-engine.ts | 修改 | executeOneHop 增加 isRunning → followUp 分支 + delegated 结算终态 |
| src/frameworks/agent/pi-session-factory.ts | 修改 | 锁超时降级 followUp；修正 :438 失真注释 |
| src/frameworks/agent/session-helpers.ts | 修改 | steal 双条件（注入 isActive 回调） |
| src/interface-adapters/http/controllers/invoke-controller.ts | 修改 | 通用 retry 端点补 409 判重（对齐 retryByOtter） |
| tests/（若干） | 新增 | 验证节所列用例 |

实现 PR 另行发起，本档为方案定稿与实现依据。
