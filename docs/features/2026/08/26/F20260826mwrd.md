---
id: F20260826mwrd
title: Magic Words 本地化重审与獭间信号协议
summary: 删3留2重审用户词表、新建 <signal> 结构化獭间信号通道（objection/blocked/halt）、healing 高危路由、UI 徽章展示。信号从协调通道升格为治理工具。
change_type: feature
capability_test: tests/capability/magic-words-signal.capability.test.ts
tags: [prompt, agent-architecture, signal-protocol, magic-words, system-prompt, ui]
modules: [.pi/SYSTEM.md, src/usecases/signal/, src/interface-adapters/agent-runtime/, src/usecases/healing/, web/src/, api-contract/]
created_in_conversation: 9c9b55ef-a2b7-4ef1-9776-f7032537b51c
from: [F20260810sopt, F20260818cbkr, F20260825hndf]
---

# Magic Words 本地化重审与獭间信号协议

## 背景（意图锚）

搭档原话：

> 「现有的几个词，我不太会用，之前是学习别的项目，但其实不做本地化适配，所以我刚才甚至说我都不知道有这个，而且平时也不影响用。需要再次思考下，magic word 有必要存在，但存在哪几个词分别是什么作用」
>
> 「啪唧这个词……其实可能有 healing event 机制能够记录起来即可，所以不需要的；但是你刚才分析提到的，海獭之间也能用 magic word 来让对方关注，我觉得这个方向值得做」
>
> 「哪些纯 prompt 即可，哪些需要软件系统强约束，这一点需要思考分析清楚」
>
> 「这个 signal，我期望 ui 上也能展示出来然后我能看到」

流程：本方案经两棒头脑风暴（kimi 需求侧 × mimo 工程侧）+ 大獭交叉综合，搭档逐项拍板：删星星罐子 ✅、獭间信号机制方向 ✅、一把全上 ✅、signal UI 可见 ✅。

现状事实（已 grep/读码验证）：
- 现 5 词（绕路了/就这样/停下/严肃点/星星罐子）定义于 F20260810sopt，仿 clowder-ai，纯 prompt 生效，代码零处理（`src/`、`scripts/` 无命中）
- 搭档不知道词表存在，存在感≈0（「装在后座的仪表盘」）
- healing 块管道（`healing-report-parser.ts` + `healing-tools.ts` 的 `interceptHealingReport`）是「LLM 写结构化信令→代码剥离解析入库」的现成先例
- circuit-break（healing_events 累计→自动 restart）与 handoff（token 0.7→自动交接）证明纯代码干预管道可行
- 大獭对运行中小獭**无中断通道**：speak 消息等 yield 才注入，唯一手段 restart_otter（丢上下文）

## 目标

- **T1 用户词表本地化**：5→2（留「停下」「绕路了」，删「就这样」「严肃点」「星星罐子」），词表语义与触发行为重写
- **T2 獭间信号通道**：`<signal type="objection|blocked|halt">` 结构化标记，小獭→大獭可发，代码解析进独立台账，大獭承担程序化裁决义务
- **T3 halt 投递机制**：大獭/搭档可对运行中小獭发出停手指令，在下一工具调用边界注入 reminder，上下文零丢失
- **T4 healing 高危路由**：severity:high 的 healing event 实时上浮提醒大獭，不等每日批处理
- **T5 UI 可见**：signal 在前端以徽章形式展示（含状态机：pending→resolved/dismissed），搭档有肉眼监督权
- **T6 L2 保底**：用户词「停下」获得代码检测层（扫描→LLM 语境确认→halt 打标），防注意力稀释漏判

## 非目标

- **不新增用户侧词**（含「啪唧」——搭档已否，healing 机制覆盖记录需求；候选「上秤」等不进本期）
- **不做小獭→搭档直达信号**：维持大獭单点编排路由，信号拓扑不失控
- **不动 circuit-break / handoff 机制**：现有纯代码干预保持原样
- **不做搭档→大獭 halt**：大獭运行中=正在处理用户消息（或编排动作），该消息自然成为其下一 turn 输入（消息必达），用户可直接等其收尾后再指示——大獭的中断粒度依赖消息必达而非注入机制，与小獭的「下一工具边界」机制不同但能力对等；若未来出现大獭长工具调用阻塞场景，再评估扩展拓扑
- **不做 L3 硬拦截用户词**：「停下」检测后仍经 LLM 语境确认再执行，不字符串硬拦（防「讨论安全词」场景误伤——本特性讨论本身就是反例证明）
- **不改「就这样」「严肃点」的行为语义**：「就这样」行为保留在 R3 弹性约定；「严肃点」根因治理在 companion skill，不在本方案

## 方案设计

### Part 1：Magic Words 词表改版（SYSTEM.md，纯 prompt）

新词表（Magic Words 章节）：

| 关键词 | 触发行为 |
|---|---|
| 「停下」 | 全场急停（吸收原星星罐子语义）：所有海獭停止新增副作用（不发新命令、不写新文件、不 push），当前工具调用收尾后汇报状态，等搭档指示。P0 不可逆风险信号同样适用 |
| 「绕路了」 | 方向重审：停止当前动作，审视方案是否走了捷径/局部最优，画出直达终态的路径 |

删除理由（决策史）：
- **就这样**：日常语篇词，LLM 语义层天然覆盖（R3 已有），词表身份反稀释优先级。处置：词表除名，R3 保留行为描述
- **严肃点**：场景频率极低，搭档要谈正事直接开始谈。死词检验：说不出「必须靠这三个字才能解决」的场景
- **星星罐子**：紧急词首要 KPI 是恐慌时可回忆性——P0 现场人的语言中枢只会调出「停」。防误触满分但买错了东西。搭档拍板删除（对话 2026-08-26），语义并入「停下」

配套：
- **发送端可发现性**（修复「装在后座的仪表盘」）：大獭侧 prompt 增加一条场景教学义务——搭档目击 bug 现场但未用词时，大獭主动提一句（「要不要我标记 healing 台账」）。词表本身在 UI 无需新入口（2 个词规模极小，对话中自然传递）
- 触发条件不变：仅搭档当前指令触发，引用/复述/讨论不触发

### Part 2：signal-parser 与 `<signal>` 通道（核心新增）

**格式**（小獭在 speak body 中嵌入，与 healing 块平级）：

```
<signal type="objection|blocked" severity="low|medium|high">正文：事实依据（文档锚点/file:line/已试清单）</signal>
```

**解析管道**（仿 `interceptHealingReport` 模式，新增 `src/usecases/signal/signal-report-parser.ts` + `src/interface-adapters/agent-runtime/tools/signal-tools.ts` 拦截）：

1. speak 入口拦截：正则抽取 `<signal>` 块，白名单校验 type/severity，截断防滥用（正文 ≤1000 字符）。**鲁棒性（对齐 healing parser 踩坑防御）**：属性值容忍全角/单引号（normalize 后再抽取）；正文含 `</signal>` 字面量时要求反引号包裹或转义写法，parser normalize 对齐 healing 先例；畸形类型显式枚举：无 type / type 白名单外 / 空 payload / 超长 / 属性引号异常 / 正文未闭合——全部进 C2 单测验收
2. 剥离后 cleanBody 照常入库（UI 渲染用徽章替代，见 Part 5）
3. 解析结果写入新表 `signal_events`

**数据模型**（`signal_events` 表，新 schema 字段消费方声明见文末）：

```sql
CREATE TABLE signal_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  from_otter_id TEXT NOT NULL,
  type TEXT NOT NULL,            -- objection | blocked | halt
  severity TEXT NOT NULL DEFAULT 'medium',
  payload TEXT NOT NULL,          -- 信号正文（事实依据）
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | resolved | dismissed
  resolution TEXT,                -- 裁决文本（大獭驳回理由/改派说明）
  resolved_by TEXT, resolved_at TEXT,
  created_at TEXT NOT NULL
);
```

**裁决写路径（审视发现 2 修复）**：新增 `resolve_signal(signalId, status, resolution)` 工具（大獭专用）——裁决动作 = 调用该工具落库（「程序化裁决义务」的代码落点），speak 里的裁决文本仅作展示，不作状态迁移依据。UI 徽章的 resolved/dismissed 渲染以该工具写入的数据为唯一数据源。

**程序语义（SYSTEM.md 新增章节「獭间信号协议」）**：
- 小獭义务：对派工有事实依据的异议、卡住需升级时，用 `<signal>` 而非散文；异议必须含文档锚点或 file:line，blocked 必须附已试清单
- 大獭义务：**收到 objection 后下一轮派工必须显式裁决**（resolved+理由 / dismissed+理由），不得悬置；blocked 信号必须当场裁决（改派/给资源/砍需求）
- 滥用防线：空泛异议程序无效（parser 校验 payload 非空且含锚点样式）；同一小獭异常异议率在每日 review 现形；裁决权恒在大獭——信号不阻塞决策权，只消灭「假装没看见」

**为什么不复用 healing_events 表**（决策史）：healing 台账有明确语义边界（系统自愈，每日 Self-Healing 任务聚合分析口径固定）。混入协作协调信号会把「今日 12 条 healing 里 8 条是小獭异议」，台账失真。传输管道模式共享（parser+intercept），语义池独立。两棒分析一致，大獭采纳。

### Part 3：halt 投递机制（架构缺口填补，最高优先级）

**问题**：大獭对运行中小獭无中断通道。speak 消息等 yield 才注入；restart_otter 是核弹（丢上下文）。

**设计**（双段式）：
- **传输层（代码）**：大獭调用新工具 `halt_otter(otterId, reason)`（或搭档的「停下」经 L2 检测确认后转发）→ 系统给目标 otter session 打 halt 标 → 在该 otter **下一个工具调用边界**，经 SDK `tool_call` 扩展事件（`emitToolCall` → `ToolCallEventResult{ block, reason }`）**block 该次调用**，halt 指令作为 block reason / 伪工具结果返回 LLM：「halt 指令（发起者+理由）：不开启新调用，报告进度快照（已完成/进行中/卡点）并 yield 回发起者」。注：pi-session-factory 当前未接 ExtensionRunner，接线是 C1 主要工作量
- **prompt 层**：SYSTEM.md/SMALL_OTTER.md 定义收到 halt block 后的合规动作——不重试被 block 的调用、不开新调用、报告进度、yield 回发起者
- halt 事件落 `signal_events`（type=halt, status=completed），UI 可见（谁在何时停了谁）

**注入点**：SDK `tool_call` 扩展事件（agent-turn-orchestrator 是 turn 级编排，工具边界在 SDK 内部，orchestrator 看不到单次调用）。block 发生在工具执行前（LLM 已决定调用但未执行），当前执行中的调用不打断——这是「上下文零丢失」的成立条件，也是选 block 而非 abort+重注入的理由（abort 会丢失正在构造的响应状态）。

**与用户词合流**：搭档喊「停下」且场上有运行中小獭 → 同一 halt 机制打标全部在场小獭。用户词和獭间信号共享传输层，刹车可靠性只建一次。

### Part 4：healing 高危路由（现有机制增强）

`interceptHealingReport` 现状：severity:high 仅 `logger.warn`。增强：high 事件写入后，向大獭（若在场）下一 turn 注入 reminder（复用 Part 3 的注入管道）。通道不变，加一条分级路由。这就是搭档最初「啪唧」想要的效果——由海獭侧 healing 块 + 代码路由实现，搭档零学习成本。

### Part 5：UI 徽章展示（T5）

**渲染**：`<signal>` 块从 body 剥离后（Part 2 步骤 2），前端在消息原位置渲染内联徽章，仿 html-card 占位渲染模式（`web/src/lib/remark-html-card-index.ts` 先例，新增 remark-signal 扩展或内联组件）。

**样式分档**：
- objection/blocked：常规徽章（`⚡ objection · 未裁决` / `🚧 blocked`），点击展开 payload 正文
- halt：高亮徽章（`⛔ halt → [小獭名] · 已执行`）
- severity high 的 healing 上浮事件：toast/高亮（P2 可选，先保徽章）

**状态机**：pending（橙）→ resolved（绿，显示 resolution 摘要）/ dismissed（灰，显示理由）。数据源：消息 DTO 扩展 `signals` 字段（api-contract），或独立 API `GET /conversations/:id/signals`。实现阶段定，倾向前者（渲染原地性）。

### Part 6：L2「停下」检测保底（T6）

消息入口（agent-invoker 之前的用户消息管道）：
1. 正则扫描用户消息命中「停下」。**匹配定义（实现层明确化）**：消息去除首尾标点/空白后与「停下」完全相等；或「停下」作为片段出现且两侧均为标点/空白/emoji/消息首尾（显式字符类列举，不使用分词组件——分词结果随词典漂移，安全词检测不挂在概率性 NLP 上）。「快停下」「都停下」命中；「停下手头工作」不命中（相邻为文字）
2. **不硬拦**：向当轮 LLM 上下文注入 reminder「用户消息命中安全词『停下』，请确认是安全指令还是讨论/引用；若是指令，按 SYSTEM.md Magic Words 执行（含对运行中小獭发 halt）」
3. LLM 语境确认后执行——保留判断力，防误伤（本特性对话全程讨论「停下」，硬拦必炸）

「绕路了」维持 L1（失效代价低：漏判=多一次方向审视的机会损失，非事故）。

### 新增 schema 字段消费方声明（issue #379 ⑥）

`signal_events` 全部字段的消费方：
| 字段组 | 消费方 |
|---|---|
| type/severity/payload | ① 大獭 reminder 注入（pending→to 大獭的信号在下一 turn 注入提醒，同 halt 管道）② UI 徽章渲染 ③ 每日健康检查任务 signal 对账段（C4 轻量扩展，见改动范围） |
| status/resolution/resolved_by/resolved_at | ① UI 徽章状态机 ② 每日 review（未裁决时长）③ 大獭 prompt 义务的对账依据 |
| from_otter_id | ① 异常异议率统计（每日健康检查 signal 对账段）② UI 展示发起者 |
| halt 行（type=halt） | UI 展示「谁停了谁」；大獭复盘 |

无「先存了再说」字段——每列至少一个消费方。

## 影响范围

| 模块 | 影响 |
|---|---|
| `.pi/SYSTEM.md` | Magic Words 章节重写（5词→2词）+ 新增「獭间信号协议」章节（小獭/大獭义务） |
| `src/usecases/signal/`（新） | signal-report-parser + signal-event-repository |
| `src/interface-adapters/agent-runtime/` | speak 拦截（signal-tools）、halt 注入（orchestrator）、用户消息 L2 扫描、healing 高危路由 |
| `src/entities/signal/`（新） | SignalEvent 实体 |
| `src/frameworks/db/signal/`（新） | sqlite 实现 + migration |
| `api-contract/` | 消息 DTO 扩展 signals 字段 |
| `web/src/` | 徽章组件 + 状态机渲染 |
| SMALL_OTTER.md / BIG_OTTER.md | 信号义务分工（写/裁决） |
| 现有用户 | 「就这样」等删除词行为不变（语义层继续覆盖），零感知 |

## 风险与约束

- **R1 halt 注入时机竞态**：小獭恰好正在长工具调用中，halt 只能等边界——最坏延迟=单个工具调用时长（bash 类可能数分钟）。缓解：halt 打标后 UI 立即显示「halt 已发出，等待边界」，预期管理
- **R2 信号滥用（挡箭牌/逃兵）**：程序防线（锚点校验+裁决留痕+异常率统计）+ prompt 义务双管。残余风险：小獭编造锚点——大獭裁决时核实（get_memory/file 读），可疑即 dismissed 并注明
- **R3 L2 扫描误判**：误报方向（LLM 误判为指令→全场急停）→ 安全失败，指示一来就恢复，可接受；**漏报方向**（「快停下」等变体未命中正则→无 reminder 注入）→ 退化为纯 L1 prompt 检测，与现状等价，无新增风险；变体覆盖列入后续迭代候选
- **R4 UI 徽章与消息原文一致性**：signal 剥离后 API 层需带 signals 元数据，前端不能只靠 body 文本。DTO 扩展方案锁定「渲染原地性」
- **R5 一把全上的集成面**：prompt 改版+新表+新管道+前端同 PR。缓解：分阶段 commit（见验证节），每阶段可独立验证

## 不兼容更新

- [Incompatible] SYSTEM.md Magic Words 词表缩减为 2 词——依赖「星星罐子」的旧 prompt 语义全部失效（已确认无代码依赖，仅 prompt 层）
- 其余均为新增，无破坏性变更

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 星星罐子存废 | 删，语义并入「停下」 | 保留作 P0 专用词 | 紧急词 KPI=可回忆性>唯一性；两词语义全等是纯冗余。搭档拍板 |
| signal 载体 | 独立 `<signal>` 通道+独立表 | 复用 healing_events | healing 台账语义边界（自愈分析口径）不可污染；传输管道模式才共享 |
| signal 格式 | ASCII 枚举 type + 中文正文 | 中文关键词（异议/卡住） | 消费方含代码，ASCII 可 schema 校验；LLM 生成侧无记忆负担，不需要自然性红利 |
| 停下 的 L2 形态 | 检测+reminder 注入，LLM 确认 | L3 硬拦截 | 语境判断防误伤（讨论/引用场景真实存在）；失效方向安全 |
| halt 注入粒度 | 工具调用边界 | turn 边界 | turn 边界=等 yield，回到原问题；调用边界是「不打断执行中操作」的最细安全粒度 |
| 用户词规模 | 冻结 2 词 | 扩充（上秤/翻账本等） | 词表越短注意力权重越高；新需求先走信号通道验证，词表只做最终收敛 |
| signal UI 数据源 | 消息 DTO 扩展 signals 字段 | 独立 REST API | 渲染原地性（徽章在消息流原位）；实现阶段如遇 DTO 膨胀再评估独立 API |
| objection 是否阻塞大獭决策 | 不阻塞，只强制裁决义务 | 阻塞（未裁决不得改派） | 决策权恒在大獭（编排者职责）；信号消灭的是「装没看见」不是「不听话」 |

## 验证

**分期 commit 计划**（一把全上，内部有序）：
1. **C1 halt 管道**（地基，动 orchestrator）：signal_events 表+halt 工具+边界注入+落账。验收：集成测试——模拟小獭长循环，大獭 halt，断言下一边界收到 reminder 且进度快照 yield 回来；单测：halt 打标/清除/竞态
2. **C2 signal-parser**：拦截+解析+入库+大獭义务 reminder。验收：parser 单测（正例/畸形块/超长/白名单外 type 拒收）；端到端：小獭发 objection→signal_events pending→大獭下轮 reminder 注入
3. **C3 healing 高危路由 + L2 停下扫描**：复用 C1 注入管道。验收：high healing→大獭 reminder；用户消息含独立词「停下」→reminder 注入（讨论语境→无 halt）
4. **C4 SYSTEM.md/BIG/SMALL 改版 + UI 徽章 + 每日健康检查 signal 对账段**：prompt 层+前端+定时任务 prompt 扩展（悬置异议检测/异常异议率，消费方闭环）。验收：capability 测试（小獭知道写 signal、大獭知道裁决义务——golden 场景集）；前端快照测试（徽章三态+点击展开）；**收口闸：tests/capability/magic-words-signal.capability.test.ts 全部 it.todo 转真实测试，grep 'it.todo' 零命中**
5. 全链路手测剧本（发现 8 修复，极简定义）：
   - **剧本 A·halt**：小獭长循环运行中 → 大獭 halt_otter(小獭, 理由) → 预期：小獭下一调用被 block、报告进度快照、yield 回大獭；session 未重启、上下文保留（对话历史可查）
   - **剧本 B·用户词合流**：小獭运行中，用户发独立成词「停下」→ 预期：L2 reminder 注入 + 运行中小獭 halt 打标 + 全场无新增副作用动作
   - **剧本 C·objection**：小獭被派工与历史决策冲突的任务 → 发含锚点 objection → 预期：signal_events 落 pending、大獭下轮 reminder、大獭 resolve_signal 裁决后徽章变绿
   - **剧本 D·blocked**：小獭环境故障卡住 → 发含已试清单的 blocked → 预期：派工台账一等状态、大獭当场裁决
   - **剧本 E·healing 高危路由**：小獭写 severity:high healing 块 → 预期：大獭下一 turn 收到提醒，无需等每日批处理

**capability golden 场景**（加入 tests/capability/）：
- 大獭对运行中小獭 halt，小獭正确停手并快照（不炸 session、上下文保留）
- 小獭对错误派工发 objection（含锚点），大獭下轮显式裁决
- 用户消息讨论「停下」一词（如「这个词叫停下」），不触发急停
- healing high 事件 5 秒内到大獭 reminder

## 改动范围

| 文件/目录 | 操作 | 说明 |
|---|---|---|
| `.pi/SYSTEM.md` | 修改 | Magic Words 章节重写+獭间信号协议章节 |
| `.pi/prompts/identity/BIG_OTTER.md` / `SMALL_OTTER.md` | 修改 | 信号义务分工（如路径存在；否则并入 SYSTEM.md） |
| `src/entities/signal/signal-event.ts` | 新增 | 实体 |
| `src/usecases/signal/signal-report-parser.ts` | 新增 | 解析器（仿 healing-report-parser） |
| `src/usecases/signal/signal-event-repository.ts` | 新增 | 仓库接口 |
| `src/frameworks/db/signal/sqlite-signal-repository.ts` | 新增 | sqlite 实现+migration |
| `src/interface-adapters/agent-runtime/tools/signal-tools.ts` | 新增 | speak 拦截+signal 管理工具 |
| `src/interface-adapters/agent-runtime/`（orchestrator/invoker 相关） | 修改 | halt 边界注入（SDK tool_call 扩展事件 + pi-session-factory 接 ExtensionRunner）+pending signal reminder+healing 路由+L2 扫描 |
| `prompts/scheduled/daily-health-check.md` | 修改 | C4 增加 signal 对账段（悬置异议/异常异议率，消费方闭环） |
| `api-contract/` | 修改 | 消息 DTO signals 字段 |
| `web/src/lib/` + `web/src/pages/conversation/` | 新增/修改 | signal 徽章渲染（remark 扩展+组件+状态机） |
| `tests/` | 新增 | parser/管道/capability 测试 |

## 后续动作

方案完成 → 对抗审视（检视獭，异模型）→ 修订定稿 → 呈搭档终审 → code-implementation 分期 C1-C4 实现。

## 审视决策史（第一轮，检视獭-492/kimi）

8 项发现全部处置，逐条决策树判断：

| # | 发现 | 判断 | 处置 |
|---|------|------|------|
| 1 | halt「注入 reminder」与架构事实错位（orchestrator 是 turn 级，工具边界在 SDK；SDK 语义是 block 非 reminder；ExtensionRunner 未接线未提） | 更好 | **接受并修订**：Part 3 改写为 SDK tool_call 扩展事件 block 语义 + 拓扑说明；pi-session-factory 接线标为 C1 主要工作量 |
| 2 | 裁决写路径缺失（状态迁移无代码落点，「程序化义务」纸面化） | 更好 | **接受并修订**：新增 resolve_signal 工具定义（裁决写路径小节），UI 数据源唯一化 |
| 3 | L2「独立成词」实现层无定义；R3 只覆盖误报未覆盖漏报 | 更好 | **接受并修订**：Part 6 显式字符类匹配定义（不用分词）；R3 补漏报退化路径 |
| 4 | it.todo 无强制兑现闸（todo 永不红） | 更好 | **接受并修订**：C4 验收加收口闸（grep it.todo 零命中） |
| 5 | 每日 review 消费方声明悬空（对账任务无创建计划） | 更好 | **接受并修订**：改动范围补 daily-health-check.md signal 对账段（C4），消费方表更新 |
| 6 | signal 属性/正文转义鲁棒性未定义 | 更好 | **接受并修订**：Part 2 解析管道补 normalize 规则+畸形类型显式枚举（进 C2 单测） |
| 7 | halt 拓扑未覆盖「搭档→大獭」（能力倒挂质疑） | 部分接受 | **修订**：拓扑显式声明含搭档→小獭/大獭→小獭、排除搭档→大獭；**反驳「倒挂」**：大獭运行=正在处理用户消息，该消息必达其下一 turn，中断粒度依赖消息必达而非注入机制，机制不同但能力对等（非目标补行闭环） |
| 8 | 「剧本 A-E」引用悬空 | 更好 | **接受并修订**：验证节补 5 剧本极简定义（前置→操作→预期） |

简报误述记录：「C1 halt 依赖 C2 表」矛盾不存在（检视獭已验证 C1 建表），编排者简报信息失真一条，采纳检视结论。

### Delta 复核处置（R1，检视獭-492 第二轮）

R1 属实，根因确认：第一轮处置的多处编辑调用因其中一段 oldText 失配**原子性失败**（Part 3/Part 6/R3 三段未应用），而执行者只补了独立成功的段落、未验证失败批次的完整性，又在决策史写了「已修订」——claim-before-verify 违规，编排者认领。本轮已补齐全部四处：Part 3 传输层+注入点（SDK block 语义+ExtensionRunner 接线说明+block-vs-abort 取舍）、Part 6 匹配定义（显式字符类）、R3 漏报退化行、非目标拓扑排除行。以本轮 diff 为准。
