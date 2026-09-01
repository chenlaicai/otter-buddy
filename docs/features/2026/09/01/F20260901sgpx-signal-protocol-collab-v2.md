---
id: F20260901sgpx
title: '协作机制 v2：信号协议——yield 升级、invoke 循环与 turn/链引擎退役'
summary: 三獭共创（mimo 树模型 + flash 群体协议 + 大獭裁决）经搭档四轮概念过堂收敛的新协作机制：所有触发统一为信号投递（yield 升级为三档力度 NORMAL/URGENT/HALT），系统只当邮局零语义判断；invoke 从单次调用升级为事件驱动循环；打断决策 fork 隔离零污染；turn 表、链引擎 hop 驱动、发言石独占语义全部退役。
change_type: feature
status: draft
capability_test: "n/a: 纯设计文档（本期无代码改动），实现期由 P1-P4 各阶段的 capability 测试覆盖（见## 验证）"
tags: [agent-architecture, signal-protocol, invoke-loop, collaboration]
created_in_conversation: 52bfdd91-a61e-4323-b1f7-1fe3daaadc32
---

# 协作机制 v2：信号协议

## 背景

搭档原话（意图锚）：

> 「类似于多人群聊，一个人在 doing 状态，然后别人这时候可能 yield 过来了，那么此时就是有两种走向，一个是直接打断，一个是等待这个人干完，然后再处理这个 yield 信号。两种不是二选一，而是就是都有场景需要的。」
> 「之前咱们拆了 speak 和 yield，其实就是把对话中的消息跟触发 invoke 这件事解耦开了。那么现在，其实可以往我想要的这个效果继续改造完善。」
> 「本次不考虑最小改动/兼容性，本次是在思考一种全新的协作机制。」
> 「我觉得，咱们可以搞一个牛逼的协作方案出来的！而不是简单的 steer+queue！」

前置：v1 方案（C-Runtime 中心化准入 + queued turn，见本对话工作区 design-v1.md）已被搭档否定——「引入一个总调度感觉怪怪的、成了单点故障点了」。v2 从零重设计。

共创过程：mimo（树模型侧发散）+ flash（群体协议侧发散）→ 大獭对撞裁决 → 搭档四轮概念过堂（turn / yield 与发言石 / 护栏梯度与全局 / FYI 与 deliverAt / invoke 循环与四档）逐项收敛。

## 目标

- **T1** 统一投递：所有触发（web 消息、獭间 yield、retry、scheduler、resume）收敛为同一信号入口，四入口各自为政的问题根除
- **T2** 频谱式协作：打断/等待/叫停不再是二选一，投递方选力度、接收方自决响应，系统零语义判断（精确表述：**零内容判断**——不读 payload 做路由决策；**行为模式判断**（计数/超时/频率）是护栏职责，二者不矛盾）
- **T3** 注意力卫生：打断决策不污染主上下文（fork 隔离，结论回写一个 bit）
- **T4** 对称恢复：打断 ≠ 丢弃，被打断任务自动降级为待办（yield-to-self）
- **T5** 结构消解：turn 表、链引擎 hop 驱动、发言石独占语义、锁等待——四层间接性退役，状态面更小
- **T6** 人獭同权：用户与獭共用同一套投递协议，差异仅在 UI 默认档位

## 非目标

- 不做多进程/多机分布式调度（当前单进程假设保留）
- 不改 pi SDK（全部基于现有原语组合）
- 不做自动优先级仲裁（「谁更重要」由投递方用档位表达，系统不比较信号间优先级）
- 不做收件箱实体表、不做 deliverAt 延迟投递、不做 FYI 档（三轮过堂已否，见设计取舍）

## 术语表

| 术语 | 定义 | 区分 |
|---|---|---|
| **投递信号（signal）** | 本文档核心：yield 工具投递的行动权/注意力信号 | ≠ 獭间异议信号（F20260827c2sg 的 objection/blocked 台账，speak 内嵌块体系，两者独立并存） |
| **invoke 循环** | 一獭被信号点火后的执行段：拉未读→LLM→工具→speak/yield→下一棒或收工 | 事件驱动，非 while(true) 常驻 |
| **presence** | 獭的忙闲状态（busy/idle + 起始时间），invoke 开始/结束自动翻转 | 游标（已读到哪）不公开 |
| **yield** | invoke 收尾时投递信号的礼仪动作：`yield(to, opts)` ≡ 信号投递 | 「通行证」独占语义退役 |

## 方案设计

### 三层架构

```
┌─ 协议层（新建，最薄）─────────────────────────┐
│ yield(to, {level, payload, reason?, suggestion?}) │
│ 三档频谱：NORMAL 必处理 / URGENT 必决策 / HALT 物理停 │
│ 收件箱 = seq 游标视图 + 信号元数据（零新表）        │
├─ 执行层（重构，主手术面）───────────────────────┤
│ invoke 循环（事件驱动）│ 打断决策（steer+fork）      │
│ 梯度护栏（软警示→硬中断）│ yield-to-self 对称恢复    │
├─ 物理层（SDK 现成，零新建）─────────────────────┤
│ steer（工具边界注入）│ abort+waitForIdle（物理停）  │
│ createBranchedSession（决策副本）│ navigateTree+summary（合流）│
└──────────────────────────────────────────────┘
```

### 1. 信号协议（协议层）

**判据铁律（搭档确立）**：要求对方行动 → signal（yield）；不要求行动 → speak（纯广播，指名道姓用自然语言 @）。

**yield v2 签名**：

```
yield(to, {
  level,       // 'NORMAL' | 'URGENT' | 'HALT'（默认 NORMAL）
  payload,     // 内容本体
  reason?,     // URGENT 必填：为何打扰（审计留痕）
  suggestion?, // {action: 'interrupt'|'wait', why}——投递方建议，可被无视
})
// to: 獭名 | 獭名[] | 'user' | self（自指合法，拆除 talking-stone.ts:41 自交禁令）
//     数组 = 展开为多条独立信号，各自路由、各自享有档位语义（多獭并行派工——现状核心使用模式，talking-stone.ts:44 recipients 本就是数组）
// HALT 档仅用户/大獭可投（沿用 F20260826mwrd C2 裁决）；小獭投 HALT 由路由器拒绝 + healing 留痕
```

**三档频谱义务矩阵**：

| 档位 | 目标 idle | 目标 busy | 接收方义务 | 物理通道（busy 时） |
|---|---|---|---|---|
| NORMAL | 触发 invoke | 零注入，入箱静默等待 | 干完手头活必处理 | 无（invoke 完成时检查触发新 invoke） |
| URGENT | 直接触发 | 下一工具边界注入决策请求 | 必出结构化结论 {continue\|pivot, reason} | steer（agent-session.d.ts:373） |
| HALT | N/A | abort+waitForIdle | 无（物理停） | abort（agent-session.js:1165-1169）。**投递方限用户/大獭**（C2 裁决继承） |

**存储**：信号 = 消息表一条消息 + 元数据列（signal_level/signal_meta）。收件箱 = 游标视图（seq 粒度）内的未消费信号集。零新表。

**信号路由器**（投递→点火的衔接，P1 核心）：四入口不再直接 invoke，改为写信号入消息表；写入路径上的**同步事件回调**（应用层 emitter——同进程 SQLite 写事务提交后立即 fire）执行路由检查：按目标 presence + 档位选通道（触发 invoke / steer 注入 / abort / 仅入箱）。无轮询、无数据库触发器、不保留链引擎薄层。进程重启后由 resume 扫描 PENDING 信号补路由（崩溃恢复路径，见 §5）。

**人獭同权**：用户输入框 = 同一信号构造器的 UI 皮肤。「插一句」→ NORMAL@目标；「考虑转向」→ URGENT + 系统代填 reason；「停下」（Magic Words）→ HALT。

**信号生命周期**：PENDING（写入消息表）→ DELIVERED（路由动作执行：触发 invoke / steer 注入 / abort）→ CONSUMED（接收方消费或决策完成）。

### 2. invoke 循环（执行层核心）

事件驱动，非 while(true)——每只獭的 invoke 是被信号**点火**的一次函数调用，无活时进程安静：

```js
async function invoke(otter) {
  let next = await trigger.signal;            // 被 yield/signal 点火
  while (next) {
    const unread = pullAndAdvanceCursor();    // seq 游标推进，拉全部未读
    const output = await llmRunWithTools();   // SDK agent run（每工具边界查 steering 队列）
    await speak(output);
    next = pickNext();                        // yield 的 to / 箱内未消费信号
    if (!next) {                              // double-check：完成时检查的竞态兜底
      next = await pickNextWithDebounce(50);  // 50ms 短窗口覆盖信号写入事务提交延迟，窗口内到达则消费
    }
    if (!next) return;                        // 仍空 → IDLE，presence 翻转
  }
}
```

- **点火源**：NORMAL/URGENT 到 idle 獭、HALT 后的 re-invoke、resume（进程重启恢复）
- **完成时检查**：invoke return 前查箱内未消费信号，有则触发新 invoke（NORMAL 到 busy 獭的消化路径——不调 SDK followUp，自己的完成时检查就是同语义实现且不中途注入系统提示）
- **单写者不变量（I1 保留）**：一 session 一时一写指针。锁降级为纯护栏（tryAcquire 即返，不等待），动态交汇场景由信号排队天然消解
- **yield 收束纪律**：invoke 结束必须 yield（收尾礼仪，防任务悬空）。yield(to) ≡ signal.send({to, level: NORMAL})

### 3. 打断决策协议（URGENT 档）

```
① URGENT 信号到达 busy 獭 B（带 reason + suggestion）
② 系统 steer() 注入决策请求（下一工具边界）：
   【决策请求】新信号摘要 + 调用方建议。请收尾当前工具调用后作答：
   {continue: true}（继续手头活，新信号留箱）或 {continue: false}（转向，新消息全量注入重启）
   不作答 = continue
③ B 若开启注意力卫生 → fork 副本决策（createBranchedSession 复制当前分支 root→leaf 路径；
   不用 forkFrom——它全量复制所有 entries 含废弃分支噪声，session-manager.js:1264-1270 vs :1077）
   未开启 → 主 session 内联决策
   决策副本显式超时 120s：超时按不作答处理（=continue）+ healing 留痕——副本是独立 session，
   不受主 session stale 检测覆盖，必须自带超时
   同一边界前后多条 URGENT：按 seq 序逐条决策，后条基于前条结论
④ 出口结构化：{decision: 'continue'|'pivot', reason}
⑤ continue → URGENT 降级 NORMAL 留箱
   pivot → 系统 auto yield-to-self（任务锚点）入箱 → B 围绕新消息重启 invoke
   锚点 schema：{原任务触发信号 seq, 进度摘要（中断时刻生成：已完成步骤/已改文件/下一步）,
   session 分支引用}——恢复消费锚点时进度摘要直接进上下文，无需从对话历史考古
```

- 决策的**过程**树内自由（LLM 任意推理），**出口**必须结构化（flash 裁决，搭档原话「本獭必须给出结论」）
- 注意力卫生开关属接收方（自己的上下文自己管）
- fork 副本保留到对话结束（审计），成本 = 当前分支的同步文件 IO（毫秒级）+ 短决策调用（~100 token）
- abort/re-invoke 路径必须显式 clearQueue()：abort() 只做 agent.abort+waitForIdle 不清队列（agent-session.js:1165-1169），clearQueue 是独立方法（:1135）——HALT 停止与 pivot 重启前清残留 steer 消息，防污染 re-invoke 上下文

### 4. 梯度护栏（通用原则：先软干预再硬中断）

self-yield 自链病态（獭不停给自己派活）：

| 触发 | 动作 |
|---|---|
| 连续 self-yield 第 3 次 | steer 注入警示：「你已连续给自己派活 3 次，有崩坏趋势，注意收束」——抓回注意力，不打断 |
| 连续 self-yield 第 5 次 | 强制中断 + healing 留痕 |

**「连续」的精确定义**：同一 otter 的 self-yield 链长，中间无 to≠self 信号消费介入——A→A→A→B→A 中 B 消费后链重置，末尾 A 从 1 数起。重置条件：消费了 to≠self 的信号，或被 URGENT 打断决策。计数跨任务累计、从消息表重建（进程重启不归零，崩溃恢复后护栏仍生效），存 otter 上下文元数据（非对话内容）。

推广：所有自增强循环类病态（连续失败重试、信号风暴）适用同型护栏。

### 5. 定时任务与崩溃恢复

- **粗调度**（每日摘要等）：保留 scheduled_task，fire 时包装为 NORMAL 信号投递（调度器降级为信号入口之一，与 web/retry 同权）
- **预约发送**：发送方自行调度，不是信号属性
- **崩溃恢复**：信号在消息表（持久），invoke 状态从 session 文件判断——resume 泛化已有能力，收件箱重启不丢

### 6. 合流（fork 分支的未来用法，本期不实现）

同獭自我分支：fork 分支干活 → navigateTree 回分叉点 + 废弃分支摘要。跨獭合流：speak + 未读自然接收（现路径）。分支结论的合流回执 = NORMAL 信号（接收方要据产出行动）。

### 7. UI 展示

- presence 徽标（busy/idle+时长）——投递方选力度的依据
- 信号轨迹（投递记录：谁→谁、档位、状态）——审计与可解释性。展示语义规范：busy 目标的 NORMAL 在 DELIVERED 态显示「排队待消化」而非「已送达」，CONSUMED 才显示「已处理」——消除「它收到了在处理」的误读
- 「一轮」= UI 从消息图派生的活动段分组（信号触发→静默），非数据库实体
- URGENT 决策过程 = 原消息流内一条轻量系统提示（「⏸ 收到打断询问 → 选择继续/转向」），不新开消息槽

## 影响范围

| 模块 | 影响 |
|---|---|
| DispatchChainEngine | 消解：hop 驱动入 invoke 循环，链深度上限/turn 关闭逻辑随之退役 |
| turn 系统（tryCloseTurn/turn 表/turn 粒度游标） | 退役：完整性降为消息粒度；游标换 seq 粒度（last_read_seq） |
| talking-stone.ts | 独占语义退役；名字路由能力保留并入信号路由；自交禁令拆除 |
| session-helpers.ts 锁 | 降级纯护栏：tryAcquire 即返，30s 等待/超时报错/steal 全部退役 |
| 四入口（web/retry/scheduler/resume） | 统一改投信号，不再直接 invoke |
| messages 表 | 加 signal_level/signal_meta 元数据列 |
| conversation_participants | last_read_turn_number → last_read_seq（迁移） |
| UI | presence/信号轨迹/决策提示/活动段分组 |

## 风险与约束

- **R-手术面**：invoke 循环完全替代链引擎驱动是最大手术——P2 阶段需灰度验证（新旧并存开关），回滚路径必须预留
- **R-并发**：多入口并发投递依赖 SQLite 事务串行化；invoke 完成时检查与信号到达的竞态（检查后瞬间到达的信号）需「完成时检查后短窗口重扫」兜底
- **R-兼容期**：turn 表退役前需 UI 派生视图先上线（读路径切换后才拆写路径）
- **R-fork 成本**：大 session 高频 URGENT 的复制成本，实测后决定是否加频率护栏
- **R-长工具延迟**：URGENT 注入最坏延迟 = 当前工具调用时长（长 bash）；stale timeout 安全网保留

## 不兼容更新

[Incompatible] turn 表退役、链引擎消解、发言石独占语义退役、锁等待行为变更——涉及核心调度链路重写，需按迁移路径分阶段灰度，每阶段可回滚。

## 设计取舍（含全部被否方案——四轮过堂的精华）

| # | 取舍 | 决策 | 替代方案 | 理由（否决依据） |
|---|---|---|---|---|
| 1 | 调度中枢 | 去中心化（信号+邮局） | v1 C-Runtime 中心化准入 | 搭档否：单点感、协调税；每条消息过中枢裁决催生伪问题（queued turn 与主链谁先） |
| 2 | 收件箱 | 游标视图+元数据 | 实体表 | mimo 否：游标已是收件箱视图，实体表重复建模 |
| 3 | 频谱档位 | 三档 NORMAL/URGENT/HALT | 四档（含 FYI） | 搭档否：不要求回应就纯 speak——「yield 的本意就是要让对方行动起来」 |
| 4 | 延迟投递 | 砍掉 deliverAt | 信号带时间属性休眠 | 搭档否：定时是调度器的事不是信号属性；「不急」是 payload 措辞不是路由逻辑 |
| 5 | turn | 退役 | 保留薄层管理 | 搭档否：「留了只是增加复杂度」；五项职责全有接棒者（完整性→消息状态机，游标→seq，聚合→to 直指，卡死检测→信号 DELIVERING 监控，UI→派生视图） |
| 6 | 发言石 | 独占语义退役，yield 成收尾礼仪 | 保留通行证语义 | 频谱模型下投递不需要先获得石头；「必须指定下一棒」纪律保留（防悬空） |
| 7 | 决策位置 | fork 副本（卫生档）/主内联（快档），开关属接收方 | 一刀切 fork | 搭档关切注意力卫生（「我不想污染上下文的注意力」）；但 fork 有复制成本，接收方自选 |
| 8 | 决策输出 | 出口结构化 {decision, reason} | LLM 自然语言 | flash 裁：结论被机器执行（continue=续跑/pivot=重组重启），解析散文=系统做语义判断，违反三方分立 |
| 9 | NORMAL 到 busy 獭 | 零注入+完成时检查触发新 invoke | SDK followUp 中途注入提示 | 搭档否中途注入：「上下文会被系统提示打满」；followUp 物理语义本就是跑完后交付（d.ts:383），完成时检查是同语义自实现 |
| 10 | 锁等待 | tryAcquire 即返，信号排队替代 | 30s 等待+超时报错 | 现状 30s 超时报错伤害用户；排队语义由收件箱天然提供 |
| 11 | 护栏 | 梯度（3 次软警示→5 次硬中断） | 一刀切 8 次上限 | 搭档设计：先 steer 注入警示抓回注意力，LLM 有机会自愈，再强制中断兜底 |
| 12 | invoke 形态 | 事件驱动函数段 | while(true) 常驻循环 | 无活时进程安静；轮询浪费；「点火-执行-return」与信号模型天然契合 |
| 13 | 多目标派工 | yield(to) 接受数组，展开为多条独立信号 | 单数 + LLM 自觉多次调用 | 审视发现（flash）：数组是现状核心使用模式（talking-stone.ts:44），单数签名是契约缺口；LLM 拼多次调用无守护（多派少派无人拦截） |
| 14 | HALT 权限 | 仅用户/大獭可投（继承 F20260826mwrd C2） | 全獭开放 + 事后审计 | 审视发现（flash）：物理中断不可逆，事后审计拦不住上下文破坏；工具白名单拦得住 halt_otter 工具名拦不住 level 字段，权限必须内建 yield 语义 |
| 15 | 点火衔接 | 写路径同步事件回调（应用层 emitter） | 轮询 / 数据库触发器 / 保留链引擎薄层 | 审视发现（mimo）：四入口改投信号后「谁触发 invoke」是架构空白；同进程写事务提交后回调零延迟零轮询，resume 补扫覆盖崩溃窗口 |

## 验证

**capability 测试**（tests/capability/）：

1. 插话不打断：busy 獭收到 NORMAL → 不注入、当前 invoke 完整跑完 → 完成时检查触发新 invoke 消费
2. URGENT 决策：busy 獭收到 URGENT → 工具边界收到决策请求 → fork 决策 → pivot 后旧任务以 yield-to-self 存续、新消息全量进上下文
3. URGENT 不作答兜底：决策请求无响应（含 fork 副本超时 120s）→ 按 continue 处理 + 留痕
4. HALT 存续：abort+clearQueue 后 yield-to-self 在箱、锚点三元组 {原信号 seq, 进度摘要, 分支引用} 完整
5. 护栏梯度：连续 self-yield（无 to≠self 消费介入的链）第 3 次收到警示注入、第 5 次强制中断；进程重启后计数从消息表重建不归零
6. yield 收束：invoke 无 yield 结束 → 系统检测 + 留痕（收束纪律的守护）
7. 人獭同权：用户三档操作走同一信号路径（UI 皮肤验证）
8. 崩溃恢复：投递后进程重启 → 信号仍在、按档位恢复路由

**回归**：现 30s 锁超时场景在新模型下重放——两线撞同一獭 = 第二条 NORMAL 入箱，无报错无等待。

## 迁移路径（每阶段独立可验证、可回滚）

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | messages 表加 signal 元数据列；yield 写入带档位 | 信号可查询可审计 |
| P1 | 信号路由器：invoke 内按档位选通道（触发/steer/abort）；四入口改投信号 | 插话不再触发锁超时报错 |
| P2 | invoke 循环替代链引擎 hop 驱动（灰度开关，回滚路径） | 全链路回归通过；链引擎可整体下线 |
| P3 | 打断决策协议（steer 请求+fork 副本+结构化出口）+ yield-to-self + 梯度护栏 | URGENT 全场景通过 |
| P4 | turn 退役（UI 派生视图先行→写路径拆除）+ 游标 seq 迁移 | turn 表可删，历史 UI 不劣化 |

## 改动范围（预估）

| 文件/模块 | 操作 | 说明 |
|---|---|---|
| src/usecases/dispatch/ | 重写 | 链引擎消解 → 信号路由器 + invoke 循环 |
| src/interface-adapters/agent-runtime/ | 重写 | yield v2 签名、点火逻辑、完成时检查 |
| src/frameworks/agent/session-helpers.ts | 简化 | 锁降级 tryAcquire 即返 |
| talking-stone.ts | 退役/吸收 | 名字路由并入信号路由，自交禁令拆除 |
| src/entities/（messages/participants） | 迁移 | signal 元数据列、last_read_seq |
| UI 层 | 新增 | presence 徽标、信号轨迹、决策提示、活动段分组 |

## 决策史

- 2026-09-01 本对话：三獭共创两轮发散+对撞（mimo 树模型/flash 群体协议/大獭裁决），搭档四轮过堂砍除 turn 表、发言石独占、FYI 档、deliverAt、锁等待，确立「协议只编码义务不编码温度」判据、梯度护栏原则、yield=收尾礼仪定位。v1（C-Runtime 方案，工作区 design-v1.md）作废。
- 2026-09-01 双獭对抗审视（mimo 实现可行性 / flash 协议完备性，SDK 锚点独立核验）：10 项发现全部修订——多目标数组签名、HALT 权限继承 C2、护栏「连续」精确定义、任务锚点 schema、零判断二分（内容/行为）、决策副本超时 120s+seq 序决策、abort 后 clearQueue、createBranchedSession 替代 forkFrom、invoke 完成时 double-check 竞态兜底、信号路由器点火衔接（写路径事件回调）。
