---
id: F20261009epoc
title: invoke 生命周期统一世代（epoch）概念：四处「旧世界识别」防御归一
doc_type: feature
change_type: refactor
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
summary: |
  issue #905 架构重构方案：把分散在四处的「识别动作是否仍属于已死的旧世界」
  防御（SimpleLockManager generation / 池 markStale / #904 toolContext 归属 /
  #1241 pid 归属判据）归一为统一的 invoke epoch 概念——invoke 启动时铸造
  epoch token，随 AsyncLocalStorage 传播，锁/池/寄存器/清理钩子只认 token。
  双活从「各处各自应对的意外」变「一处定义清楚的语义」。
  触发条件已满足（第 4 处防御 #1241 于 2026-10-06 合入 main），
  搭档 2026-10-09 拍板启动。
tags: [epoch, invoke-lifecycle, architecture, refactor, dual-live]
modules: [src/frameworks/agent/session-helpers.ts, src/frameworks/agent/pi-session-factory.ts, src/interface-adapters/agent-runtime/, src/frameworks/db/]
causal_links:
  from: [F20261006opid, F20260911pspl]
created_at: 2026-10-09
---

# F20261009epoc - invoke 生命周期统一世代（epoch）概念

## 背景

issue #905（2026-09-13 立案，搭档架构反思触发）。搭档原话（意图锚）：

> 咱们海獭们对于这种极端异常场景，思考到是对的，但感觉解决方式一直是打补丁。
> 我觉得必须要去反思审视架构设计，而不是打补丁。比如说，旧调用被判定死了，
> 那这个为什么旧调用还会活过来？

issue 设定的触发条件：「第 4 处同模式防御出现，或双活真造成生产事故，满足其一才动手」。

**2026-10-09 核实：触发条件已满足**——第 4 处防御（#1241 pid 归属判据，
F20261006opid）于 2026-10-06 合入 main（PR #1312，commit 3bfde911）。
其特性文档「设计取舍」节自述：「pid 列是同族第 4 处『旧世界识别』防御」。

搭档 2026-10-09 拍板「做呀」启动重构。本獭曾评估「不动手」（四处防御各自正确、
9/13 至今零双活事故），搭档决策优先——执行不等于认同，此判断留痕。

需求明确（方向 issue 已定 + 触发条件机械满足 + 搭档拍板），结晶门跳过——
豁免留痕：搭档原话「做呀」为显式启动指令，无模糊面。

## 目标

T1: 引入统一 epoch 概念，四处「旧世界识别」防御归一为一处语义定义
T2: 双活从「各处意外」变「一处定义清楚的语义」——同一套判定，同一种处置
T3: 零行为回归——四处防御的既有拦截面全部保留（红绿测试锁定）
T4: 后续第 5/6 处同模式需求直接消费 epoch，不再各自造轮子

## 非目标

- 不改变任何防御的判定阈值（stealThresholdMs、pid 判据、超时窗口等原样保留）
- 不解决双活本身（单进程 Node 无「杀死 promise」原语，本重构管「识别」不管「消灭」）
- 不动 #1241 的 pid 判据逻辑（它刚从时间戳守卫升级为 pid，是正确的最后一针）
- 不做 fan-out / 并发子链（#895 已关，正交）

## 现状分析（五处防御/裸露面的真实形态，2026-10-09 代码实证）

| # | 防御点 | 位置 | 机制 | 生命周期域 |
|---|---|---|---|---|
| 1 | SimpleLockManager generation | `src/frameworks/agent/session-helpers.ts:120-202` | 锁易主时 generation+1，旧持有者 release 对易主锁 no-op | 进程内锁 |
| 2 | 池 markStale | `src/frameworks/agent/pi-session-factory.ts:416-422` | 换世期间旧 session 出池成孤儿（不 dispose，旧 invoke 活着由 GC 兜底） | 进程内 session 池 |
| 3 | #904 toolContext 归属 | invoke 清理路径 | 旧 invoke finally 清理只逐自己的 | invoke 清理 |
| 4 | #1241 pid 归属判据 | `src/frameworks/db/schema.ts:937` + `migration.ts:1891` | invokes.pid 列，非本进程 pid 的 running = 旧进程遗留 | DB 持久层（跨进程） |
| 5 | **activeSessions 无条件 delete（裸露面，无防御）** | `pi-session-factory.ts:991` finally | `this.activeSessions.delete(sessionKey)` 无条件执行——:975-980 注释自述「A 的 finally delete 删 B 的条目，甚至读到 B 的计数」；stale steal 后旧 invoke 苏醒会删掉新 invoke 的条目，新 invoke 的 abort/steer 入口消失（:1188） | invoke 寄存器（**无归属判定，比 1-3 更危险**） |

**r1 审视修正（2026-10-09 方案检视獭-905）**：原方案遗漏第 5 处——它不是「防御」
而是「无防御的裸露面」，issue 建议方案原话「锁/池/寄存器/清理钩子只认 token」
本含此族。epoch 归一必须覆盖它，否则统一概念留了最大的洞。

五处机制中 1-4 各自正确，5 是裸露面。epoch 统一后：**锁/池/寄存器/清理钩子是
invoke 世代内概念，pid 判据是进程世代概念——两者都是「旧世界识别」但作用域
不同**，本方案分别归一而非混为一谈。

## 方案设计

### D1: epoch 数据模型（纯进程内，不持久化）

```
invoke epoch = { invokeId: string, mintedAt: number }
```

**r1 修正（S1）**：砍掉 generation 持久化（原方案拟在 invokes 表加列）。
理由：跨进程「复活」物理不可能（进程死 promise 死），DB 层 pid+bootTs
双判据（invoke-repository.ts:15-16）已兜住跨进程场景；进程内复活的识别
用内存对象身份即够，不需要持久计数器。epoch 是纯进程内值对象。

- **铸造点（r2 订正，delta D-1）**：pi-session-factory.invoke() **入口、锁
  acquire（:710）之前**，经**独立的 invokeEpochStorage ALS** 装配——不与
  otterInvokeStorage（:918 装配，含 identityPrefix 构建）共用通道。顺序：
  ① :705 嵌套检查（读 otterInvokeStorage 外层 store，判据不变）→ 继承
  外层 epoch + 跳锁；② store 无外层 → mintEpoch + invokeEpochStorage.run；
  ③ 锁 acquire 在 run 内读 epoch。r1 版「铸造点=:918」有误——:918 在锁
  之后，照字面实现锁读不到 epoch（死代码）；若把 otterInvokeStorage.run
  上移到 invoke() 入口修序，:705 嵌套检查会读到自置 store → 每个 invoke
  被误判嵌套而跳锁、互斥失效。双 ALS 解：epoch 走新通道早装，身份注入
  ALS（:918）原位不动，嵌套检查（:705）零变化
- **传播**：随 AsyncLocalStorage 到整个调用链——锁 acquire、池操作、寄存器
  操作、清理钩子从 ALS 读 epoch
- **锁世代语义收编**：锁条目记录当前持有者 epoch（对象引用），release 时
  比对「闭包捕获的 epoch 对象 === 锁当前 epoch 对象」（引用相等，不是计数器
  比对）。等价性论证见取舍表「锁 generation 收编」行
- **markStale 语义收编**：池条目记录所属 epoch；markStale 仍是命令式处置
  原语（识别在调用方），但「是否 stale」的判定统一为「条目 epoch 是否是该
  otter 的现役 epoch」。r1 修正（S5）：评估时机=调用方发起换世/steal 的
  那一刻，与现状一致；变的是判定来源（对象身份而非隐式上下文）
- **toolContext 归属收编**：清理钩子只清理 epoch 匹配的条目（行为不变，
  判定来源统一）
- **寄存器归属新增（S4）**：activeSessions 条目标记 epoch，finally delete
  只在「条目 epoch === 本 invoke epoch」时执行——裸露面收口
- **pid 判据不动**：跨进程孤儿识别是进程级问题。pid 列保留为进程世代的
  DB 承载，与 invoke epoch 分层共存（见取舍表）

### D2: 归一接口

新增 `InvokeEpoch` 值对象（纯数据，零依赖，**纯进程内不持久化**——r1-S1）：

```ts
interface InvokeEpoch {
  readonly invokeId: string;
  readonly mintedAt: number;
  /** 进程内 per-otter 单调计数（重启归零），仅用于日志可读性，不参与判定 */
  readonly seq: number;
}
```

判定一律用**对象引用相等**（`entry.epoch === alsEpoch`），不用任何可比较的
标量字段——防止「可比较的 ID 被复制/伪造」类绕过。

五处防御/裸露面改造为消费同一接口：
1. SimpleLockManager：锁条目记录持有者 epoch 对象；release 闭包捕获本
   invoke 的 epoch，比对「锁当前 epoch 对象 === 闭包 epoch 对象」——
   引用相等替代 generation 计数器。**等价性论证**见取舍表
2. 池：`poolEntry.epoch`；markStale 仍是命令式处置原语（识别在调用方），
   变的是判定来源（对象身份而非隐式上下文）
3. toolContext 清理：`entry.epoch === als.currentEpoch` 才清理
4. **寄存器（r1-S4 新增）**：activeSessions 条目标记 epoch，finally delete
   只在 `entry.epoch === 本 invoke epoch` 时执行——裸露面收口
5. pid 判据：不动（进程世代 ≠ invoke 世代）

### D5: 嵌套 invoke 的 epoch 归属（r1 新增，S5；r2 订正 delta D-3）

嵌套 invoke（`pi-session-factory.ts:705-708` 的 ALS 旁路）**不铸造新
epoch，继承外层 epoch**。继承机制（r3 订正，E-1：判据唯一化）：
**mint/继承的分支判据锁死到 :705 嵌套检查（otterInvokeStorage）**——
判嵌套 → 跳锁 + 读 invokeEpochStorage 继承外层 epoch；判非嵌套 →
**必铸新对象并遮蔽式 run**（invokeEpochStorage.run(e_new)，即使该
store 里残留可读的外层 epoch 也被遮蔽）。等价性由此全称成立：
「每次取锁必持新铸对象 ≡ 每锁位单调计数」语义——同键跨 steal 的
前后持有者永不共享 epoch 对象（r2 版曾用「invokeEpochStorage 可读性」
作 mint 判据，与 D4 流程图的 :705 判据二义，且非对称失效下可建出
带窗口的实现——E-1 订正）。（r1 版「嵌套不共键所以无窗口」论证
不成立，见取舍表订正）。

**诚实声明（r2，delta D-3b）**：#896 嵌套旁路**当前无活触发路径**，系
防御性保留（:695-700 注释自述：压缩合成改走影子通道、handoff pre-invoke
已退役）——D5 是面向未来嵌套路径的防御性设计，非当前热路径。

理由：

- 嵌套 invoke 与外层共享 session/池条目，赋予独立 epoch 会让外层的清理
  钩子把嵌套资源误判为「旧世界」（F20260912nlb896 已证生产形态）
- 嵌套串行安全由 ALS 链保证（外层 await 内层，不存在并行执行）
- ~~嵌套的寄存器 sessionKey 与外层不同（嵌套有独立 messageId）~~
  **r2 订正（delta D-3a）**：messageId 是可选参数（pi-session-factory.ts:802/:1174），
  裸 otterId 共键场景存在（:977-980 自述）——同键时嵌套与外层共享 epoch，
  finally delete 无法区分内外层条目。边界声明：与现状持平（今天的无条件
  delete 同样不区分），非回归；同键嵌套清理语义留锁定测试用例划定边界

**嵌套 + stale steal 混合场景**（r1-S3 可达变体）：外层被 steal 后嵌套仍在
跑——嵌套继承的是外层 epoch（已失效），其 finally delete 比对时条目已被
新 invoke 重写（epoch 不同）→ delete 跳过 ✓。嵌套继承设计天然兼容。

### D3: 迁移策略（红绿锁定 + 降级面显式声明，r1-S2 修正）

- 每个防御点先写「旧行为锁定测试」（红），再改实现（绿）
- **降级面显式分面**（不再笼统「各回各旧机制」）：
  - 锁：epoch 缺失 → 回退 generation 计数器（保留为锁内部实现细节，
    不作为公共概念暴露）——锁是热路径，不能 fail-loud
  - 池/寄存器/清理钩子：epoch 缺失 → **拒绝操作并 warn 计数**（fail-loud）——
    这些场景 epoch 缺失意味着铸造点没执行，是真 bug 不是边缘情况
  - 降级观测：warn 计数打点（pi-session-factory.ts:1024 同模式），
    降级发生 = epoch 关键路径失效信号，不允许静默（r1-A2）
- T1（归一）与 T3（零回归）的关系修正：降级面内行为可能不同于现状
  （fail-loud vs fail-soft），这是有意取舍——「双轨并存 = 根因复制」
  的优先级高于「降级面完全等价」
- 一个 PR 原子切换（双轨并存 = 根因复制，#1189 守卫重设计的教训）

### D4: epoch 的铸造与传播路径（r2 订正 delta D-1：双 ALS）

```
pi-session-factory.invoke() 入口（嵌套检查之后、锁 acquire :710 之前）
  → 嵌套判定（唯一判据 :705 读 otterInvokeStorage，r3-E-1）
      判嵌套 → 跳锁；读 invokeEpochStorage 继承外层 epoch（不 mint）
      判非嵌套 → mintEpoch()（seq = 进程内 per-otter 计数器 +1，纯内存）
                 → invokeEpochStorage.run(e_new, ...)  ← 遮蔽式：即使
                    store 残留可读外层 epoch 也被遮蔽（r3-E-1）
      → 锁 acquire（:710）读 invokeEpochStorage epoch
      → 池操作读 epoch
      → _executeWithSession（:918 otterInvokeStorage.run 原位不动，
        身份注入 ALS 不受重构牵连）
          → 寄存器操作读 epoch
          → 清理钩子读 epoch
          → 嵌套 invoke 递归上述判定
```

**r2 设计决策（D-1/D-2 互锁的显式解）**：epoch 用**独立 ALS**
（invokeEpochStorage）传播，不把 otterInvokeStorage.run 上移。三个理由：

1. **顺序**：:705 嵌套检查必须先于 mint（嵌套不 mint）；锁 acquire 必须能
   读到 epoch（锁先于 :918）——独立 ALS 使两者同时满足且互不污染；
   上移 otterInvokeStorage.run 会让 :705 读到自置 store，互斥失效（地雷）
2. **等价性全称成立（r3-E-1：遮蔽式 run）**：mint/继承分支锁死到 :705 判定后，「共享 epoch 对象且抢锁」在一切失效组合下不可达：
   - 正常嵌套：判嵌套 → 跳锁继承（不抢锁，无窗口）
   - 非对称失效（otterInvokeStorage 断、invokeEpochStorage 存）：判
     非嵌套 → 铸 eB + 遮蔽式 run（残留 eA 被覆盖）→ 抢锁；后续 steal
     后旧 release 持 eB，锁位新持有者持 eC（≠eB）→ 引用不等 no-op ✓
     （实现注释注意：关键对是首跳「外层 eA vs 遮蔽铸的 eB」——只要
     遮蔽成立，eB 及后续铸币永不与任何存活旧对象重合；eB/eC 第二跳
     只是同一不变式的自然延伸，锁定用例应优先锁首跳）
   - 反向失效（otterInvokeStorage 存、invokeEpochStorage 断）：判嵌套
     → 跳锁；读 epoch = undefined → 池/寄存器/清理 fail-loud（D3）、
     锁回退 generation 兜底（D3）✓
   r2 版曾考虑「嵌套检查改读 invokeEpochStorage 同源同判」消窗，
   但那会把嵌套判据从「身份 ALS」变为「epoch ALS」，判定面变宽
   （读不到身份 ALS 但 epoch 存在的场景会被误判嵌套而跳锁）；
   遮蔽式 run 不动嵌套判据（:705 零变化）即达全称等价，严格更优
3. **改动面**：identityPrefix 构建（:898-910，含 DB 查询）留在原位，
   不上移、不受锁时序牵连——锁临界区语义不变，重构不扩大热路径改动面

**r1 版因果倒置订正（D-2；r3-E-1 再订正）**：r1 版取舍表把窗口关闭归功于
「嵌套继承外层 epoch，release 同 epoch 故无窗口」——反了，共享对象恰是
窗口成因。r2 版改述为「继承的判定与锁路径互斥于装配时序」但未指定
唯一判据（两套机制不能同真）；r3 订正：**判据唯一化到 :705 嵌套判定
+ 判非嵌套必铸新对象遮蔽式 run**（见 D4 理由 2）——「共享 epoch 对象
且抢锁」在任何失效组合（含非对称失效）下不可达，等价性全称成立。

**R1 概率下调**（r1-A3）：otterInvokeStorage 已横跨全执行（:918）且 SDK
回调在消费（model-runtime-registry.ts:116/124），传播断裂现实概率低——
降级测试聚焦铸造点错位而非 SDK 内部。**r2 补充**：双 ALS 后新增一条
传播链（invokeEpochStorage），断裂面多一条——但断裂后果是 fail-loud
（池/寄存器/清理钩子）或 fail-soft 回退（锁），与 R1 同面板，已由 D3 覆盖。

## 影响范围

| 模块 | 影响 | 风险 |
|---|---|---|
| session-helpers.ts（SimpleLockManager） | generation 计数器 → epoch 对象比对 | 中：锁是热路径 |
| pi-session-factory.ts（池+寄存器） | markStale/activeSessions 判定换 epoch | 低：语义等价 + 裸露面收口 |
| invoke 清理路径 | toolContext 归属判定换 epoch | 低：语义等价 |
| ~~DB schema~~ | ~~invokes 表加 generation 列~~ **已砍（r1-S1）** | — |
| ALS 装配 | invoke() 入口 mint + invokeEpochStorage.run（r2 双 ALS，见 D4） | 低：既有 otterInvokeStorage 已实证横跨全执行；新通道仅锁/池/寄存器/清理读取 |

## 风险与约束

- **R1 ALS 传播断裂**：概率低（既有 otterInvokeStorage 实证横跨全执行，
  r1-A3），降级策略显式分面（D3）+ warn 计数观测，不静默
- ~~R2 generation 持久化竞态~~ **已砍（r1-S1）**——无 DB 热路径变更
- **R3 锁热路径性能**：epoch 对象引用比较 vs generation 数字比较，开销同量级
- **R4 重构期间新防御点接入**：冻结期声明——本 PR 合入前，新的「旧世界识别」
  需求一律走 epoch 接口
- **R5 ~~双 ALS 非对称失效残留窗口~~ 已消除（r3-E-1：遮蔽式 run）**：
  r2 版曾声明的非对称失效窗口（otterInvokeStorage 断但
  invokeEpochStorage 存 → 误继承 + 抢锁 → 同对象跨 steal）在 r3
  判据唯一化后**不可达**：mint/继承分支锁死到 :705 判定，判非嵌套
  必铸新对象并遮蔽式 run（残留外层 epoch 被覆盖）——任何失效组合下
  「共享 epoch 对象且抢锁」均不可达，等价性全称成立（逐情形验证见
  D4 理由 2）。r2 版「后果面与现状 generation 机制同级」论断有误
  （窗口内 epoch 在场，generation 兜底不介入，实为严格劣于现状的
  互斥破坏）——该错误随窗口消除一并失效。遗留：反向失效（判嵌套
  但 epoch 读不到）走 D3 fail-loud/fail-soft 面处置，非互斥问题

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| pid 判据是否收编 | 不收编，分层共存 | epoch 覆盖 pid | 进程世代（pid）与 invoke 世代（epoch）是两层概念：跨进程孤儿识别需要 DB 持久判据，invoke epoch 是进程内概念。混为一谈会让进程内机制依赖 DB 往返 |
| ~~generation 持久化~~ | **已砍（r1-S1）** | ~~invokes 表加列~~ | 跨进程复活物理不可能（进程死 promise 死），pid+bootTs 已兜住跨进程场景；进程内识别用对象引用即够，无需持久计数器。原方案的「重启后必须高于崩溃前」论证不成立——重启后旧 invoke 的 promise 已死，没有可比对的对方 |
| ALS vs 显式传参 | ALS | 每层显式传 epoch | 显式传参改动面大 5-10 倍，ALS 是 Node 标准实践；既有 otterInvokeStorage 已实证横跨全执行（r1-A3） |
| 锁 generation 收编 | epoch 对象引用替代计数器 | 两套并存 | **等价性论证（r1-S3，r2 订正 D-2）**：锁 generation 的本质是「锁位易主事件计数」——steal 时 +1，旧持有者 release 对易主锁 no-op。epoch 收编后：steal = 新 invoke（新 epoch 对象）接管锁位，旧 invoke 的 release 闭包持有旧 epoch 对象，引用不等 → no-op。**等价性成立的条件（r2 订正）**：同键跨 steal 的前后持有者（含嵌套链）不共享 epoch 对象——注意不是 r1 版的「每个 invoke 的 epoch 唯一」（嵌套继承恰恰共享外层对象）。窗口封闭机理（r3-E-1 判据唯一化）：mint/继承分支锁死到 :705 嵌套判定——判嵌套→跳锁不 mint；判非嵌套→必铸新对象遮蔽式 run 后抢锁。「共享 epoch 对象且抢锁」在任何失效组合下不可达。~~嵌套继承外层 epoch 意味着不会产生窗口~~ **r1 版因果倒置已订正（D-2）**：嵌套共享同一 epoch 对象恰是该窗口的成因形态，窗口真正被时序互斥封闭。非对称失效窗口已消除——R5 r3 改写为不可达证明。r1-S3 指出的「同一身份跨 steal 再持锁位」分叉场景：正常变体被因果律（重启递归前提是上轮已释放，agent-invoker.ts:1872）挡住；降级混合态变体由 D3 降级面声明覆盖 |
| 原子切换 vs 渐进 | 原子（一个 PR） | 分四 PR 逐点迁移 | 渐进期双轨并存 = 同一概念两套判定，恰是 #905 要消灭的病 |
| 降级策略 | 分面降级（锁 fail-soft / 其余 fail-loud） | 全 fail-soft | r1-S2：笼统 fail-soft = 隐性双轨（旧机制常驻保留，恰是取舍表定性为病的形态）。分面后：锁保留内部 generation 兜底（热路径不能挂），其余 fail-loud + warn 计数（epoch 缺失 = 真 bug） |

## 机制识别检查点

- □ 新增配置字段/枚举/开关 —— **无**
- ☑ 新增状态生命周期 —— epoch（铸造→存活→失效）
- □ 新增定时任务/后台进程 —— 无
- □ 新增信号类型/消息格式 —— 无
- ~~☑ 新增持久化存储~~ **已砍（r1-S1）**——epoch 纯进程内不持久化
- □ 新增决策分支（结果被记住） —— epoch 判定是纯运行时临时分支，无持久化消费
- ☑ 新增跨模块调用路径 —— ALS 传播链

命中两项 → 机制预算四问必答（见下）。

## 机制预算四问

① **谁需要它**——agent-runtime 层（锁/池/寄存器/清理四组件）和未来的
「旧世界识别」需求方。具体角色：维护 invoke 生命周期的獭（不再需要为每种
防御各写一套世代判定），以及搭档（架构反思的直接诉求）。

② **失败后果**——epoch 传播断裂（ALS 丢失）时：锁回退 generation 计数器
（fail-soft，热路径不挂）；池/寄存器/清理钩子 fail-loud + warn 计数
（r1-A2：降级不允许静默）。最坏情况 = 锁回到现状，其余组件报错暴露——
不会比现在的四分散状态更差。

③ **后续机制**——epoch 创造的新状态里可能出错的：(a) ALS 上下文在铸造点
错位 → 降级 warn 计数暴露；(b) 嵌套继承语义被误改 → D5 节 + 锁定用例；
(c) 未来有人绕过 epoch 直接写第 6 处防御 → 本 PR 的架构注释 + 检视层把关。

④ **退役条件**——当 invoke 生命周期被整体重做（如转向 event-sourcing 或
actor 模型），epoch 作为中间抽象应随之退役。信号：invoke 不再是一等实体
（invokes 表被替代）时，epoch 自然死亡。

## 重对抗门

本方案净新增机制（检查点命中三项）→ 方案落盘后召检视獭审查
「这个机制在系统演化史中是治本还是治标」，四问答案为审查材料。

## 验证

1. **红绿锁定**：每个防御点先写旧行为锁定测试（红），改实现后转绿——
   证明 epoch 归一后行为等价
2. **降级路径测试**：锁 epoch 缺失回退 generation（fail-soft）；
   池/寄存器/清理钩子 epoch 缺失 fail-loud + warn 计数断言
3. **寄存器归属测试**（r1-S4）：stale steal 后旧 invoke finally delete
   不删新 invoke 条目（锁定裸露面修复）
4. **嵌套继承测试**（r1-S5）：嵌套 invoke 继承外层 epoch；嵌套 + steal
   混合场景 finally delete 正确跳过
5. **pid 判据共存测试**：#1241 的孤儿清理行为不变（regression lock）
6. **同键嵌套清理边界测试**（r2，delta D-3a）：裸 otterId 共键场景嵌套与外层
   共享 epoch，finally delete 无法区分内外层条目——锁定用例划定现状持平边界
   （known-boundary 标注，非回归验证）
7. **非对称失效用例**（r3，E-1）：模拟 otterInvokeStorage 断裂但
   invokeEpochStorage 存活的非对称场景，断言判非嵌套路径铸新 epoch 并遮蔽
   残留外层值（等价性不可达证明的行为锁定）
8. **全量回归**：agent 域 + session 域测试全绿

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/frameworks/agent/invoke-epoch.ts` | 新增 | InvokeEpoch 值对象 + invokeEpochStorage 独立 ALS（r2 双 ALS，见 D4） |
| `src/frameworks/agent/session-helpers.ts` | 修改 | SimpleLockManager generation → epoch 对象比对（内部保留 generation 兜底） |
| `src/frameworks/agent/pi-session-factory.ts` | 修改 | 池 markStale + 寄存器 activeSessions 归属换 epoch；invoke() 入口 mint + invokeEpochStorage.run（嵌套检查后、锁 acquire 前）；:918 otterInvokeStorage 原位不动 |
| invoke 清理路径（toolContext 归属处） | 修改 | 归属判定换 epoch |
| ~~DB schema/migration~~ | ~~修改~~ **已砍（r1-S1）** | — |
| 对应测试文件 | 新增/修改 | 红绿锁定 + 降级 + 寄存器归属 + 嵌套继承 + 共存 |

## 未决问题

1. ~~generation 的粒度：per-otter 还是全局单调？~~ **已砍（r1-S1）**——
   seq 仅日志可读性，per-otter 进程内计数即可
2. epoch 是否暴露给工具层（如 circuit-breaker 用 epoch 判定「这批调用属于
   哪一代」）？——本期不做，留 Phase 2 评估
3. ~~epoch 对象是否冻结（Object.freeze）防运行时篡改？~~ **实现期定：冻结**
   （invoke-epoch.ts mintEpoch 内 Object.freeze，值对象语义完整性）

## 实现记录（2026-10-09，实现獭-905）

### 红绿测试清单（方案验证节 8 条 → 测试落地）

| 方案用例 | 测试落地 | 红绿形态 |
|---|---|---|
| case 1 红绿锁定 | 既有锁定测试全量保留：simple-lock-manager.test.ts（锁互斥/#599 steal no-op/超时/double release）、nested-invoke-lock-bypass.test.ts（#896 锁旁路 3 例走公共入口零变化）、pool-hit-path.test.ts（池命中/ctlv 刷新/readOnly 绕过） | 改造前后均绿（行为锁定）；直接调内部方法的用例补 withEpoch 上下文模拟公共入口铸造 |
| case 2 降级路径 | invoke-epoch.test.ts「case 2」describe：epoch 在场 steal no-op（引用比对）/ epoch 缺失回退 generation（fail-soft）/ 正常接力不误吞 | 绿 |
| case 3 寄存器归属 | invoke-epoch.test.ts「case 3」：stale steal 后旧 invoke finally delete 不删新条目（epoch 不匹配跳过）+ 归属自己正常删除 | 绿；变异验证 2 回退红（2 例精准失败，见下） |
| case 4 嵌套继承 | invoke-epoch.test.ts「case 4」：嵌套继承外层 epoch（同一对象不 mint，走公共 invoke() 锁路径断言）+ 嵌套+steal 混合 finally delete 跳过 | 绿；变异验证 2 覆盖 |
| case 5 pid 共存 | tests/bootstrap/invoke-pid-reconcile.test.ts 原样全绿（回归锁定，零改动） | 绿 |
| case 6 同键嵌套边界 | invoke-epoch.test.ts「case 6」：裸 otterId 共键嵌套共享 epoch → finally delete 执行（known-boundary 标注：与旧行为持平非回归） | 绿（锁定现状持平） |
| case 7 非对称失效 | invoke-epoch.test.ts「case 7」：otterInvokeStorage 断 + invokeEpochStorage 残留 → 判非嵌套 + 铸新 epoch 且锁/执行期 ALS 读到的都是新对象（≠残留 eA，遮蔽首跳断言） | 绿 |
| case 8 全量回归 | agent 域 + interface-adapters + bootstrap：123 文件 1967 测试全绿；全仓 352 文件 5260 测试全绿 | 绿 |

### 变异验证（亲跑，双向）

1. **锁收编回退**（session-helpers.ts epoch 判定改 `if (false && …)` 禁用）→
   invoke-epoch.test.ts 12 例**全绿不红**。这不是测试缺口而是等价性实证：steal 在
   同一锁条目对象上 generation+1，zombie 闭包捕获的世代号必然失配（条目删除重建
   后 zombie 闭包引用旧对象、新条目不可达）——epoch 引用比对与 generation 计数器
   在锁语义上行为等价，正是方案取舍表「锁 generation 收编」行等价性论证的机械
   实证。判别性用例（锁条目删除重建后 zombie 迟到 release）已入 case 2，锁定该
   世代链行为无论走哪条判定都不得释放新持有者的锁。
2. **finally delete epoch 匹配回退**（_deleteActiveSessionIfOwned 改回无条件
   delete）→ case 3 + case 4 混合场景 2 例**精准变红**（其余 10 例绿），恢复后
   全绿。裸露面收口行为被测试锁定。

### 验证数字（实跑）

- 全仓：352 文件 / 5260 测试全绿（vitest run）
- tsc --noEmit 零错误；eslint 改动文件零告警
- 变异验证 2 例红绿双向亲跑（见上）

### 实现要点与方案对齐

- **invoke() 入口（r3-E-1 判据唯一化）**：:705 嵌套判定读 otterInvokeStorage（判据
  零变化，代码原位）；判嵌套 → 跳锁 + 继承（invokeEpochStorage 随 ALS 链自然传播，
  无需显式动作）；判非嵌套 → mintEpoch + 遮蔽式 invokeEpochStorage.run(e_new)，锁
  acquire 在 run 内读 epoch（作为第三参显式传给 SimpleLockManager.acquire）。实现
  注释写明「关键对是首跳（外层 eA vs 遮蔽铸的 eB）」防后人只锁第二跳。
- **:918 otterInvokeStorage.run 原位不动**（identityPrefix 构建不上移）。
- **锁（session-helpers.ts）**：条目增加 holderEpoch，acquire 第三参可选 epoch；
  release 闭包双轨判定——generation 先判（旧版行为），epoch 在场时追加引用比对。
  epoch 缺失 = 纯 generation 路径 = 旧版行为（D3 fail-soft，锁是热路径）。
- **寄存器（activeSessions）**：条目携带 epoch；set 收敛到 _registerActiveSession
  （epoch 缺失拒绝注册 + warn）；finally delete 收敛到 _deleteActiveSessionIfOwned
  （epoch 匹配才删，S4 收口）。
- **池（poolMeta）**：条目携带 epoch；冷启动入池时写入（缺失 → 拒绝入池 + warn，
  不带病入池）；池命中时 epoch 随所有权转移到命中它的 invoke（#904 语义保持：
  现役合法持有者可逐，stale 旧 invoke 不可）。
- **清理钩子（_evictPooledIfOwned，#904）**：归属判定从 toolContext 引用比对换
  epoch 引用比对，签名去掉 toolContext 参数；epoch 缺失拒绝 evict + warn（D3）。
- **降级分面（D3）**：锁 fail-soft（generation 兜底保留）；池/寄存器/清理钩子
  fail-loud（拒绝操作 + _warnEpochMissing 限频 warn 打点，:1024 同模式，同 site
  1 次/分钟防热路径日志洪水，首次必打）。
- **pid 判据不动（D1）**：DB 层零改动，invoke-pid-reconcile.test.ts 回归锁定。

### 实现偏差（与方案文字的差异，代码现状为准）

1. **_evictPooledIfOwned 签名**：方案未指定参数形态，实现去掉了 toolContext 入参
   （判定换 epoch 后不再需要），调用点（:997 finally 内）同步单参化。
2. **markStale 判定来源**：方案 D1 说「是否 stale 的判定统一为条目 epoch 是否该
   otter 的现役 epoch」——实现保持 markStale 为命令式处置原语（识别在调用方，
   方案同一句已声明），池层 markStale 调用点（stale steal 场景 :795）零变化，
   epoch 携带在 poolMeta 上供归属判定消费。行为面与方案一致。
3. **模块位**：任务书疑虑 [agent] 是否黑名单——实查 module-tags.ts 在
   MODULE_BANNED_TAGS（agent 已除名，F20260924mseu），改用 [session]（锁/池/寄存器/
   invoke 生命周期均在其语义域）。

### 已知边界（锁定测试划定）

- 同键嵌套清理（case 6）：裸 otterId 共键场景嵌套与外层共享 epoch，finally delete
  不可区分（与旧无条件 delete 持平，非回归）——彻底区分需嵌套计数，超出本 PR。
- 既有单测直接调内部方法（_acquirePooled/_evictPooledIfOwned）的用例，更新为
  withEpoch 自建 epoch 上下文（模拟公共入口铸造职责）；公共 invoke() 路径零变化
  （锁旁路 3 例未动一字绿过）。
