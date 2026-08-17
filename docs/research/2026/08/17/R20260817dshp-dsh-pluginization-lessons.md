---
id: R20260817dshp
title: dsh-pluginization-lessons
doc_type: research
summary: |
  调研 DeepSeek Harness（2026-08-13 preview）"一切皆插件"架构对 otter 的可借鉴性。
  核心拆解：插件化按组合粒度分三形态——进程级组合 / per-agent 组合（otter 已有雏形：otterType 工具白名单）/ 运行时热插拔；三诉求（能力可选、高频迭代、控制变量）落在前两种。
  经三轮对抗审视（架构挑战 6.5/10 十题 → 事实核查 19 项 → 盲点挑战七题，用户逐题裁决）：
  采纳五项（无特权核心目标、port 三角色范式、离线模型可见内容比对、otter-type 工具路由、config 能力块），
  拒绝四项机制（Cordis 运行时/分层 patch/waterfall/依赖图，含重估锚点），已知局限三条。
  与已锁定的批次3设计 R20260817arnt 互证无冲突，A4/A5 排批次3 之后另立 PR。

status: draft
exploration_type: technical
tags: [architecture, pluginization, harness, ports, agent-runtime, composability]
modules:
  - src/usecases/ports/agent-invoke-port.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/frameworks/agent/pi-session-factory.ts
  - src/frameworks/agent/session-helpers.ts
  - src/usecases/otter/create-otter.ts
  - src/bootstrap/platforms.ts
  - src/bootstrap/types.ts
causal_links:
  from:
    - F20260814mtrc
    - R20260817arnt
---

# R20260817dshp: DeepSeek Harness "一切皆插件" 对 otter 的可借鉴性分析

## 背景

### 起因

2026-08-13 DeepSeek 开源了 DeepSeek Harness（`dsh`），主打"一切皆插件"（everything is a plugin）。用户提问：传统插件化（包括 otter 既有设想）是"固定主流程中打孔"，dsh 似乎更进一步——这套更极端的插件化是否可以借鉴？

用户给出了三个动机，本质都指向"灵活系统 / 积木式系统"的好处：

1. **能力可选**：AI 时代很多模块/能力对不同用户是可选的，需求因人而异
2. **高频迭代**：同一模块会被高频调试改进，模块独立则改进互不牵连
3. **控制变量**：harness 效果需要真实调试看效果反馈优化，能单变量替换是很好的机制

本研究回答：dsh 的"更进一步"究竟是什么、otter 需不需要它、该借什么。

### 调研范围

- **dsh 侧**：官方仓库（github.com/deepseek-ai/deepseek-harness）、架构文档、官方公告、社区评价（HN / yage.ai / The Register 等）
- **otter 侧**：src 分层与接缝现状摸底（ports / bootstrap / agent-runtime / 配置面 / skill 系统 / 通信方式），既有决策（F20260814mtrc 可观测性、issue #282 批次3总纲、#281 broadcaster 解耦）

---

## 一、DSH 调研结论

### 1.1 项目概况

- DeepSeek AI 官方开源，MIT 协议，TypeScript，2026-08-13 前后 developer preview（monorepo 布局经二手来源，未从官方直接核实）
- 底层是 **Cordis 元框架**（koishi 社区血统），设计论文《A Programming Paradigm for Spatiotemporal Composability》
- 官方明示 preview 阶段会有破坏性兼容变更

### 1.2 "一切皆插件"的覆盖面与内核

官网明示以下全部是插件，可混搭/替换/扩展：**models、tools、skills、sessions、sandboxes、storage、loops（agent 循环本身）、scheduling、UI**。

内核只剩一个：Cordis 插件运行时（挂载/卸载/依赖管理）。架构文档原话 "There is no privileged core to patch"——连 agent loop 也只是 `core/agent-loop` 插件对 `Agent` 接口的默认实现，可整体替换。核心包本身都是插件：

| 包 | 职责 |
|----|------|
| core/session | append-only SessionEvent 日志 |
| core/system-prompt | prompt 段与 tool schema 组装 |
| core/tools | 作用域工具注册 + 守卫执行管线 |
| core/agent | Agent 接口、注册表、agent/* 事件 |
| core/agent-loop | 默认驱动实现（可整体换掉） |
| llm/llm | 消息/流词汇 + 模型适配 seam |

### 1.3 关键机制

- **可逆 effect（reversible effects）**：注册即 effect，插件卸载时自动 unwind，无需重启进程。这是论文的"时间可组合性"（temporal composability）
- **声明式依赖**：插件间依赖一等公民
- **三域事件**：Session 事件（durable facts）/ Agent 事件（观察或拦截进行中的工作）/ Capability 事件（把策略和适配器挂到 seam）。其中 6 个是 waterfall 链（监听器须 `next()` 委托）：`agent/pre-step`、`agent/request`、`llm/stream`、`tools/pre-execute`、`tools/execute`、`tools/post-execute`
- **Capability seam 三角色**：每个可换能力拆为接口声明 / 实现 / 消费方三角色。换实现即改变产品形态——如 fs 与 subprocess 实现共享 execution world，指向远程沙箱时 Bash/PTY/LSP 一起迁移
- **分层组合**：bundle 顺序 → profile 自带 `cordis.patch.yml` → home 级 patch → `--patch` CLI overlay，上层可整行覆盖下层任意 config row，不改源码重组系统
- **"Model-visible means logged"**：到达模型请求的任何内容必须可从 session log 重建，有运行时断言

### 1.4 与传统"打孔式"插件化的本质区别

1. **没有特权宿主**：VS Code / Claude Code 有硬编码的 agent loop / 模型接入 / UI 宿主，插件只能在其上打孔；dsh 中 loop、模型适配、session log 本身都是可整体替换的插件
2. **时间可组合性**：卸载即精确回滚、进程不重启——为"agent 以最少人工监督持续修改系统"的场景设计
3. **依赖声明真实可用**
4. **配置即组合**：分层 patch 替换任意 config row

### 1.5 社区评价与批评（采纳评估的重要输入）

- **正面**：append-only log 全量记录模型所见（chain-of-trace，可 inspect/resume/fork/replay）受好评；Armin Ronacher（Pi 作者）被多方二级来源转述称这是首个让他想重新审视自家选择的设计——但其 HN 一手评论实为褒贬并存（赞 cleanup/effect 机制，批跨插件 DI "a lot of footguns"），引述时按二手转述对待
- **批评三条**：
  1. developer preview，插件契约会破坏性变更
  2. Cordis 约束（尤其是 reversible effects）实践难以精确遵守，热载/卸载 footgun 多
  3. **最尖锐的结构性批评**（yage.ai）："如果不需要运行时热插拔，它试图解决的绝大多数难题直接消失"——整套可逆 effect/时空可组合性可能是为不必要的需求付出的复杂度

---

## 二、概念拆解：三种插件化形态

> 本节初稿是"组合时 vs 运行时"二分法，第一轮对抗审视挑战 1 指出其遮蔽了 otter 已有的中间形态（per-agent 组合，有代码实证），已修正为三形态。

| | 进程级组合 | per-agent（实例级）组合 | 运行时热插拔 |
|---|---|---|---|
| 机制 | 启动时按配置/清单装配可替换部件 | 每次**创建 agent 实例**时按类型/配置组合能力集 | 可逆 effect，卸载即精确回滚、不重启进程 |
| 解决的问题 | provider 可替换、模块独立 | **不同獭不同能力集**；同进程内对照组 | agent 持续修改运行中的系统，不停机 |
| 代价 | 接口设计 + 装配纪律 | 类型→能力映射的声明式维护 | 论文级复杂度，社区公认 footgun 多 |
| otter 需要吗 | **需要**（诉求②高频迭代） | **需要且已有雏形**（诉求①③） | **不需要**（单机自托管，restart_otter 已有重启路径） |

**关键事实**（对抗审视发现的现状遗漏）：otter 已经存在 per-agent 组合的雏形——`src/usecases/otter/create-otter.ts:44-48` 传递 otterType 到 context，`session-helpers.ts` 的 `getOtterToolNamesForType(otterType)` 按 otter 类型做工具白名单过滤。大獭/小獭拿不同工具集，这不是进程级装配也不是热插拔，是第三种形态，且已在运行。

**诉求映射**：

- 诉求①能力可选：单用户多獭系统里，"不同用户不同需求"的本体是"**不同獭不同需求**"——落在 per-agent 组合
- 诉求②高频迭代：落在进程级组合的接缝（port 三角色化后，换实现不动消费方）
- 诉求③控制变量：两条路——per-agent 组合让两只獭同进程各挂一套能力集对照（比 forks 多进程便宜）；进程级 config 能力块让"换 provider 跑一轮"成为配置操作

**判断**：dsh 真正"更进一步"的部分（Cordis 内核、时间可组合性）解决的是 otter 没有的问题。按反投机基建原则（与 F20260814mtrc 拒绝 OpenTelemetry 同一逻辑），**拒绝机制本身，借鉴思想**。

---

## 三、Otter 现状对照

### 3.1 已有接缝

- `usecases/ports/` 8 个 port + im/memory 域 4 个 gateway：模型接入（ModelPool + config `llm.models[]`）、记忆检索（SearchEngine + EmbeddingGateway）、Workspace（WorkspaceGateway）、otter 配置（OtterConfigProvider）均为接口化可替换
- **per-type 工具过滤**（第一轮审视补充）：`session-helpers.ts` 的 `getCodingToolsForOtterType` / `getOtterToolNamesForType` 按白名单为各 otterType 过滤工具集——能力分发的雏形，但是硬编码函数而非声明式
- skill 系统是仓库内唯一的 manifest 式插件机制：`.pi/skills/*/SKILL.md` 目录约定 + `prompts/skills/manifest.yaml` 路由契约 + `scripts/lint-skills.mjs` 校验
- 可观测性（F20260814mtrc）：AgentMetrics 指标语义契约 + TraceContext，已为"重构行为不变性"提供证据基线

### 3.2 硬连接（对照 dsh 的覆盖面逐项看）

| dsh 覆盖的能力 | otter 现状 | 性质 |
|---|---|---|
| agent loop | AgentInvoker 1196 行，退出分类/重试/终态防护全在 interface-adapters"倒置的第四层" | 无接缝，#282 问题1 |
| tools 注册 | tool-factory `createTools()` 基础数组 24 个工具硬编码枚举（L735-764）+ 3 处条件注入 + **硬编码 per-type 白名单函数**——有分发接缝但非声明式，无注册表 | 半接缝，A4 对象 |
| sessions | pi-session-factory 997 行绑死 pi-coding-agent SDK，frameworks→interface-adapters 依赖倒穿 | 无接缝 |
| models | ModelPool + 配置，多 provider/alias | **已可替换** |
| storage | bootstrap/types.ts 聚合具体 `Sqlite*Repository` 类而非接口 | 半硬连 |
| UI / IM 通道 | MessageBroadcaster 混合 Web 回调 + Feishu 投影逻辑；platforms.ts 直接 new Feishu 全家桶 | #281 在解 |
| 组合机制 | 手写工厂无容器；能力开关仅 feishu/recruiting 两个可选块 | config 面窄 |

### 3.3 关键洞察

otter 已经自发走在插件化的路上：#282 的 port 体系统一、编排上提，本质上就是在给 dsh 视角下的"特权核心"（agent loop、tools、session）建接缝；per-type 工具过滤则是 per-agent 组合的既有雏形。本研究不是提出新方向，而是给 #282 的设计文档补充目标语义与范式参照。

> **快照时点说明**：3.1/3.2 现状摸底取自 2026-08-17 上午（批次3 动工前），文中行号坐标均为快照时点值。当日批次3 已推进：#283 完成 broadcaster 解耦（"UI/IM 通道"行的 #281 已闭合）；R20260817arnt 设计锁定 + PR-A（#285）合入。**已被 PR-A 改变的现状**：①ports/ 计数 8→11（新增 agent-tools / otter-tool-client / sdk-invoke-port）；②"storage"行"聚合具体 Sqlite* 类"半句已消除——组合根现已声明接口（Repository port），实现替换仍是后话。3.2 表中"agent loop 无接缝 / sessions 无接缝"两行将由 PR-B/C/D1/D2 依序消除（tool-factory 行的工具数 24 与条件注入数未变，行号坐标已漂移）。本研究的增量价值相应后移至：A3 离线比对工具（服务剩余 PR 的验证面）、A4/A5（批次3 后的组合时/per-agent 插件化）、以及三形态图景与已知局限作为长期参照。

---

## 四、采纳评估

### 4.1 采纳清单

术语说明：dsh 的 Service Definition / Provider / Consumer 三角色在 otter 语境用**既有术语**落地——port（接口，usecases 所有）/ 实现（adapter，frameworks 或 interface-adapters）/ 消费方（usecase）。不照搬 dsh 词汇表（dsh 处于声明破坏性变更的 preview 期，术语语义可能被其作者修正；范式参照，非契约）。

| # | 借鉴项 | 内容 | 服务的诉求 | 落点 |
|---|---|---|---|---|
| A1 | **无特权核心**（目标语义） | port 体系的设计目标从"命名收敛"升级为"每项能力都处于可替换接缝之后"，包括现在视为核心的 agent 编排、工具集、session 管理 | 能力可选、高频迭代 | #282 设计文档的目标定义；**作为目标语义写入，但"可替换性验证"不是 #282 的验收标准**（#282 是还债批次，见 4.2 R5） |
| A2 | **port 三角色范式**（dsh 谱系，otter 术语） | 每个可换能力统一为：port（usecases 定义接口）/ 实现（adapter）/ 消费方三角色。直接消解 AgentInvokePort 双定义、ModelPoolLike 复制接口、三套命名并存 | 高频迭代 | #282 设计文档"port 命名统一约定"一节的答案 |
| A3 | **模型可见内容重建比对**（验证手段，非运行时不变量） | dsh 需要运行时断言是因为其 session log 本身是可替换插件；otter 的 session 记录由 pi SDK 保证"所见即所记"，otter 的增量是一个**离线、测试期的重建比对工具**：重构/换 provider 前后，比对到达模型的完整输入是否逐字段等价 | 控制变量 | 批次3 各 PR 的验证面设计（测试工具，不建运行时断言设施） |
| A4 | **otter-type 级声明式工具路由** | 把 `getOtterToolNamesForType` 硬编码白名单升级为 manifest 路由（对齐 skill 系统形态），工具集从代码常量变为声明式配置。**验收条件：现有各 otterType 的工具集逐 type 等价**（挂能力测试），否则落地即隐性改变每只獭的能力集。**三条设计要求**（第三轮审视追加）：①manifest 必须带等价 lint（工具名存在性 + 逐 type 集合快照比对）——skill 系统的教训是真相源分裂必致静默腐烂，「逐 type 等价」须从一次性验收升级为持续不变量；②危险工具（restart_otter 等）在 manifest 中需**显式 opt-in** 而非默认继承——声明式配置的修改心理门槛低于改代码，权限分层必须显式；③manifest/config 引入能力集版本号（实验记录或 metric label），工具集变更即版本变更 | 控制变量、能力可选 | **#282 之后另立独立小 PR**（见 R5；拆解完成后做注册表是纯增量，成本更低；lint 成本计入 A4 范围） |
| A5 | **config 能力块约定** | 现有 `feishu` / `inbound.recruiting` 可选块模式推广为统一约定；关键可实验 provider（至少 SearchEngine / EmbeddingGateway）支持 config 选块——"换一个 embedding provider 看召回效果"从改装配代码变为改配置 | 控制变量 | 独立小改动，按实验需求排期 |

### 4.2 拒绝清单（含理由）

| # | 拒绝项 | 理由 |
|---|---|---|
| R1 | Cordis 运行时（可逆 effect / 热插拔） | otter 无"不停机持续修改系统"场景；单机自托管 + restart 机制已够；社区公认 footgun 多。投机基建 |
| R2 | profiles/bundles 分层 patch 体系 | 为"不改源码重组任意 config row"设计；otter 的组合粒度是 otter 实例（per-agent）+ 少量进程级能力块，config.yaml + A4 manifest 路由足够覆盖三个诉求，无需分层 patch 机器 |
| R3 | waterfall 拦截链事件 | 为运行时拦截设计的重机制，#281 只需普通事件总线做 broadcaster 解耦。注：这不是原则性排除——waterfall 本质是 middleware 模式（机制而非编排），未来若出现多个拦截点的场景（如 self-healing 泛化），它是候选形态之一 |
| R4 | 声明式插件间依赖图（**带重估锚点**） | otter 装配规模（手写工厂 ~10 个 bootstrap 模块）远未到需要依赖解析的规模；组合根手工排序即可维护。**重估锚点**：bootstrap 装配项显著膨胀（如 >40）或出现第一例初始化顺序 bug 时重估本决策 |
| R5 | 插件化改造混入 #282 还债批次 | #282 是技术债批次（拆倒置层、统一 port），验收标准是"重构行为不变"；若同时背上 manifest 注册表等新功能，出 bug 时无法区分拆解引入还是新功能引入——恰好破坏 A3 要保的控制变量；也与"一个 PR 一件事"的范围聚焦原则相抵。#282 只做**不妨碍未来插件化的还债**（接口形态对齐 A2 范式） |

### 4.3 待决问题

1. ~~pi-session-factory 拆解的编排/适配分界线~~ **已由 R20260817arnt 回答**（定稿补记）：编排逻辑上提 AgentTurnOrchestrator，pi-session-factory 拆 identity-builder + model-runtime-registry、主文件 <600 行、消费 agent-tools port 消除倒穿（其 Q3/D4，PR-D2 实施）。分界结论与本研究 A1/A2 目标语义一致
2. **A4 的 manifest 粒度**：每个工具一条 vs 按能力组一条（检索类/派工类/系统类）？粒度影响实验设计——按组开/关做对照实验更贴近假设粒度，逐工具则更精细

（初稿待决问题 3「A3 实现深度」已在审视中裁决：离线比对工具，不做统一 SessionEvent 抽象；初稿待决问题 4「config 能力块 schema」已升格为采纳项 A5。）

3. **软能力是否进同一路由图景**（第三轮盲点1）：otter 一半的能力是 prompt 资产（per-type system prompt、skill 路由、记忆配置），"不同獭不同需求"的最大差异面恰恰在软能力（检视獭 persona、小獭精简 prompt）。A4 manifest 只路由 24+3 个代码工具——prompt/skill 路由是否与工具同表声明，还是"给 LLM 看的软路由"与"硬路由"两种范式各自演进？留给 A4 设计时回答
4. **manifest 变更的生效语义**（第三轮盲点5）：otter_type 存于 DB，存量獭/进行中 session/历史指标都锚定在 type 字符串上。A4 验收只覆盖落地时等价——之后新增/重命名/删除 type 时存量数据的 fallback、变更如何传播到运行中 session（下次 invoke 生效？需 restart？）需要定义

### 4.4 已知局限（第三轮审视追加）

1. **指标可比性在工具路由变更点断开**：AgentMetrics 全部指标以 `otter_type` 为 label；A4/A5 落地后同一 type 的工具集随 manifest/config 变化，token/outcome 时序基线在变更点断裂。A3 离线比对只验证"模型输入逐字段等价"，不回答"变更后指标还可不可以和历史比"——做对比实验时必须以能力集版本号（A4 设计要求③）切分基线，不能跨变更点直接比
2. **权限模型的信任前提**：per-type 路由本质是权限系统（小獭只能重启自己就是权限差异），本档将其作为能力配置处理，显式前提是单机自托管、用户即管理员、无多租户攻击面。若未来出现多用户部署，此前提失效，需重审
3. **谱系参照的时效**：dsh 处于声明破坏性变更的 preview 期，A2/A3 借鉴的范式锚定在 2026-08 快照上。**重审锚点**：dsh 发布稳定插件契约或架构文档重大修订时，重审 A2/A3 的谱系参照是否仍成立（otter 落地用的是自己的术语，风险仅限范式有效性，不涉术语迁移）

---

## 五、落地路径

> 定稿补记（2026-08-17 晚）：本研究三轮审视期间，批次3 已独立推进——#283（broadcaster 解耦，原 #281）合入、设计文档 R20260817arnt 锁定、PR-A（#285）合入。**两边结论互相印证、无冲突**：R20260817arnt 的 port 后缀约定（gateway=外部系统、repository=持久化、port=本系统服务）与本研究 A2 三角色范式同构；其"明确不做"清单未混入工具路由，与本研究 R5 裁决一致。路径更新如下：

1. ~~#281 broadcaster 解耦~~ **已完成**（#283 / F20260817bcst）
2. **批次3 七个 PR（A 已合入，B/C/D1/D2/E/F 按设计执行）**：验收仍是"重构行为不变"（R5 边界）；**A3 离线重建比对工具建议在 PR-C（编排上提，全案最高风险）动工前就位**，作为其验证面补充；指标语义契约继续作守恒锚
3. **批次3 之后**：A4（otter-type 级工具路由，含三条设计要求与 lint）与 A5（config 能力块）各自另立小 PR，纯增量工作；控制变量实验框架按证据强度分层：**归因级实验走 B 类 capability 测试的 forks 隔离**（同基线克隆，唯一变量可控）；同进程 per-agent 对照（两只獭各挂一套能力集）只适用于粗粒度方向性观察——每只獭的 persona/记忆/历史 session 是不可控差异，混杂对照产不出可归因结论

**结论（清单式，替代原"八成好处/两成复杂度"的不可证伪表述）**：

- 覆盖三个诉求的字面需求：能力可选（A4 per-type 路由）、高频迭代（A2 接缝 + A1 目标语义）、控制变量（A3 比对 + A4/A5 配置化变量 + per-agent 对照）
- 新增概念仅四个：port 三角色范式、otter-type 工具路由 manifest、config 能力块约定、离线重建比对工具
- 不引入任何新运行时设施（无容器、无依赖解析、无事件拦截链、无热插拔）

---

## 调研来源

- [GitHub: deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) · [architecture.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [官方公告](https://deepseek.com/harness/en/) · [The Register 报道](https://www.theregister.com/ai-and-ml/2026/08/14/deepseeks_innovative_harness_treats_everything_as_a_plug-in/5288095)
- [yage.ai 深度分析](https://yage.ai/share/dsh-deep-analysis-en-20260813.html) · [HN 讨论](https://news.ycombinator.com/item?id=49285244)
- otter 侧：issue #282（批次3总纲）、issue #281、F20260814mtrc（指标语义契约）、src 现状摸底（2026-08-17，见 3.1/3.2 坐标）

## 对抗审视记录

### 第一轮：架构挑战（2026-08-17，独立 agent，架构自洽性 6.5/10）

十项挑战，用户逐题裁决，全部接受修正：

| # | 挑战 | 裁决 | 处置 |
|---|------|------|------|
| 1 | 二分法遮蔽 per-agent 组合形态（代码实证：create-otter.ts / session-helpers.ts per-type 白名单） | 接受 | 第二节改为三形态；A4 改 otter-type 级路由；R2 理由重写 |
| 2 | "换 provider 变成配置操作"超出采纳清单实际覆盖 | 接受 | 待决问题4 升格为 A5（config 能力块），实验型 provider 走可选块 |
| 3 | R3 引用"反强编排"误用用户决策（该原则约束 agent 行为控制，不约束实现机制选型；self-healing 已有拦截管线先例） | 接受修正理由 | R3 删该引用，保留拒绝结论，补"waterfall 是未来候选形态"注记 |
| 4 | A1+R4 组合的尾部风险：接缝增长后手写组合根装配出错无重估锚点；VS Code 类比对第一方接缝无证据力 | 接受 | R4 加重估锚点（装配项 >40 或首例初始化顺序 bug），删类比 |
| 5 | A3 增量高估：otter 的"所见即所记"由 pi SDK 保证，otter 不该为不属于自己的不变量付运行时断言成本 | 接受 | A3 降级为离线重建比对工具；待决问题3 就地裁决 |
| 6 | A4 混入 #282 是范畴错误（还债 vs 新功能），破坏控制变量且违反范围聚焦原则 | 接受 | A4 出舱另立（#282 后）；新增 R5；A1 目标语义写为 #282 非目标边界 |
| 7 | "八成/两成"量化不可操作化，会成为决策史中不可证伪的锚 | 接受 | 结论改为清单式可验证陈述 |
| 8 | 现状摸底遗漏 per-type 工具过滤接缝（事实修正） | 接受 | 3.1/3.2 修正；A4 补"逐 type 等价"验收条件 |
| 9 | 风险评估不对称：preview 期不稳定性拒了机制却豁免了思想；dsh 术语不应固化为 otter 命名约定 | 接受 | A2 用 otter 既有术语（port/实现/消费方），注明 dsh 谱系 |
| 10 | 待决问题1 问错了问题（接口存废是 A2 自然推论，真问题是编排/适配分界线） | 接受 | 待决问题1 改写 |

### 第二轮：事实核查（2026-08-17，独立 agent，19 项核验：16 项完全属实，无方向性错误、无捏造来源）

otter 侧 9 项 100% 经代码验证（行数、port 数量、per-type 白名单、依赖倒穿、forks 池配置等全部属实）。dsh 侧 10 项经官方来源核验，官网/架构文档原话逐词属实（"一切皆插件"覆盖面、"There is no privileged core to patch"、"Model-visible means logged" 运行时断言、三角色官方术语、waterfall 机制、yage.ai 批评原话）。修正 5 处：

| # | 错误 | 更正 |
|---|------|------|
| 1 | createTools 硬编码枚举写 23 个 | 实为 **24 个**基础数组（tool-factory.ts:737-761）+ 3 处条件注入；A4 验收基线计数随之修正 |
| 2 | waterfall 清单漏列 | 官方共 6 个，补 `agent/request` |
| 3 | 分层组合次序不准确 | 更正为 bundle 顺序 → profile 自带 cordis.patch.yml → home patch → --patch overlay |
| 4 | Ronacher 引述列为正面评价 | 一手 HN 评论褒贬并存（赞 cleanup 机制、批跨插件 DI），降级为"二手转述"并如实标注 |
| 5 | 坐标/表述小偏差 | create-otter.ts 补全路径（L44-48）；pnpm monorepo 标注未从官方核实；skill 数确认为 9 个 |

### 第三轮：盲点挑战（2026-08-17，独立 agent，7 项盲点，用户逐题裁决全部接受）

| # | 盲点 | 裁决 | 处置 |
|---|------|------|------|
| 1 | 软能力（prompt/skill/记忆）在三形态图景中无位置——otter 一半的能力是 prompt 资产，A4 只覆盖代码一半 | 接受，补待决问题 | 待决问题 3：A4 manifest 边界，prompt/skill 路由是否同表声明 |
| 2 | per-type 工具集变化冲击指标基线：otter_type label 的时序基线在变更点断裂，实验污染自己的度量基座 | 接受 | 已知局限 1 + A4 设计要求③（能力集版本号） |
| 3 | per-type 路由本质是权限系统，声明式 manifest 比硬编码更易无意识修改危险工具的分发 | 接受 | 已知局限 2（信任前提）+ A4 设计要求②（危险工具显式 opt-in） |
| 4 | A4 复刻 skill 系统真相源分裂教训：manifest 与代码注册名漂移是静默腐烂，「逐 type 等价」是一次性验收非持续不变量 | 接受 | A4 设计要求①（等价 lint，成本计入 A4 范围） |
| 5 | manifest 变更对存量獭/存量 session 的生效语义未定义（落地时等价 ≠ 落地后每次变更安全） | 接受，补待决问题 | 待决问题 4：生效语义与 type 增删改的 fallback |
| 6 | 同进程 per-agent 对照混杂变量（persona/记忆不可控），无法归因，「比 forks 便宜」但不单变量 | 接受，修正表述 | 第五节：归因级走 forks 隔离，同进程对照仅方向性观察 |
| 7 | 本研究锚定 dsh preview 期快照，无重审机制（R4 有锚点，本研究自身没有） | 接受 | 已知局限 3 + 重审锚点（dsh stable 契约或架构重大修订时重审 A2/A3 参照） |

## 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 借思想 vs 借机制 | 借思想、拒绝机制 | 三个诉求落在进程级 + per-agent 组合两种形态；运行时热插拔是无场景的投机基建 |
| 插件化形态 | 三形态（进程级 / per-agent / 运行时），otter 取前两种 | per-agent 组合已有代码雏形，是"能力可选"在多獭系统的本体 |
| 与批次3的关系 | A2 范式进 #282；A4/A5 另立 PR；A1 只做目标语义不做验收 | #282 是还债批次，混入新功能破坏控制变量与范围聚焦（R5） |
| A3 形态 | 离线重建比对工具，非运行时不变量 | "所见即所记"由 pi SDK 保证；otter 只需比对工具，不为不属于自己的不变量付钱 |
| 术语 | otter 既有术语（port/实现/消费方），dsh 谱系注记 | dsh 是 preview 期项目，范式参照非契约，术语不可固化外部词汇表 |
| 事件机制 | 普通事件总线，不引入 waterfall | waterfall 为运行时拦截设计，#281 用不上；机制本身不被原则排除，多拦截点场景出现时重估 |
| 依赖管理 | 拒绝，带重估锚点 | 反投机 ≠ 永不投机，有触发条件才做 |
