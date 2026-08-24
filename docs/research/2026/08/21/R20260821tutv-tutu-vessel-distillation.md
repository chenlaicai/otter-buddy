---
id: R20260821tutv
title: tutu-vessel-distillation
doc_type: research
summary: |
  对外部项目 tutu-vessel（一人公司多智能体社会运行时）的五路并行深度代码分析蒸馏，
  经三轮对抗审视（事实核查/盲点挑战/决策挑战）修正。
  该项目与 otter 技术栈同源（Pi SDK 内核 + SQLite + 六边形架构），真正产品是
  "让 AI 施工队可审计、可复盘、可砍单的组织制度"，419 个 PR 自我狗粮完成。
  核心洞察：球权传递协作模型、ARC budget 软熔断、tool teaching 三信道、harness 版本门、
  "Task 纯镜子"状态机哲学、AST 级架构规则可测试化；盲点补录：evidence find 分层检索引擎
  （负例指标+解释层）、journal 结构化归因、proposal 证据门。反面教训：记忆 related_refs 死字段、
  中文 FTS 检索失效、职责堆积、"机制最小化"宪法名存实亡、承诺面跑在代码前面。
  otter 侧优化项仅作引子（含球权收尾契约、承诺面对账），另行立项。

status: draft
exploration_type: technical
tags: [multi-agent, agent-society, pi-sdk, harness, orchestration, memory, architecture-governance]
causal_links:
  from:
    - R20260811rclo
---

# R20260821tutv: tutu-vessel 多智能体社会运行时蒸馏

## 背景与方法

### 起因

用户要求对 [terrenceeLeung/tutu-vessel](https://github.com/terrenceeLeung/tutu-vessel) 做基于真实代码的深入分析，评估 agent 架构、设计、能力设计的优劣势，蒸馏可学与须规避的内容。这是继 clowder-ai（R20260811rclo）之后第二个系统性对标的外部 agent 项目。

### 调研方法

浅克隆至 `/tmp/tutu-vessel`，五个并行分析 agent 分维度深挖真实代码（非仅文档），各自独立输出 review 报告后交叉汇总：

1. 架构分层与运行时核心（六边形执行、执行链路、持久化）
2. 多智能体社会设计（身份/角色/技能/通信/任务/调度）
3. 记忆与上下文系统（数据模型、检索、评分、裁剪）
4. Pi 扩展、工具体系、可观测性、测试与工程化
5. 设计哲学与演化史（文档体系、愿景换代、砍单审计）

成文后经三轮对抗审视（事实核查 / 盲点挑战 / 决策挑战，见文末对抗审视记录），修正了行号引用、数量偏差、三处对 otter 现状的过时认知，并补录盲点章节（第七章）。

### 项目速览

| 维度 | 数据 |
|------|------|
| 定位 | "一人公司的操作系统"：1 个人（Captain）+ 3 个 crew（first-mate 大副 / chief-engineer 轮机长 / reviewer 质检兔） |
| 规模 | ~5.1 万行生产 TS，346 个测试文件，47 个 Feature 文档 + 31 ADR + 24 AHD（审视核对后数字） |
| 技术栈 | Node 24 + TypeScript + better-sqlite3 + Fastify + socket.io + **Pi SDK**（与 otter 同源）+ React/Vite Web 前端（~26.8k 行） |
| 开发方式 | **自我狗粮**：每个 feature 由项目自己的施工群（grill → 立卡 → 施工 → 验收）开发，419 个 PR 即产品 proof |

---

## 一、组织与协作模型（最核心的洞察）

### 1.1 一句话模型

**事件唤醒 + 球权传递 + 任务板作为唯一结晶**。crew 之间不是消息广播，而是"持球—传球"：每个 run 必须以恰好一次 `vessel_send_message` 收尾（传球、关闭或上升三者之一），**只回"收到"的乒乓无效**（`crew-capabilities/universal/a2a-contract.md`："确认收到"不是选项——接了就干，不接就退或升）。这条"反问式传球非法"规则直接对抗 LLM 的确认偏倚——有立场就做，没立场不传。

### 1.2 通信铁律：纯文本输出不投递

agent 的自然语言输出**不进入任何信道**，唯一出口是 `vessel_send_message` 工具（`world-rules.md` "通信铁律：最重要的一条"）。配套：

- `to: string[]` 即球的目的地，同质性不变量 all-crew XOR `["captain"]`（`packages/pi-extension/src/vessel-send.ts:22-27`）
- `Idempotency-Key: tool:{toolCallId}` 幂等（`vessel-send.ts:54`）
- 消息落库时 mention 触发 pending invocation job，由调度器批式唤醒被 @ 的 crew

**洞察**：每个社会行为都是显式、可审计、可重放的工具调用。这比"agent 说话自动广播"的模型在治理上高一个量级——不存在"说了什么但没留痕"的路径。

### 1.3 ARC budget：软熔断的典范

每个 "episode"（captain 发话后开的弧）最多 20 次 crew 互相唤醒（`src/domain/communication/episode-policy.ts:1` `DEFAULT_MAX_ARC_INVOCATIONS = 20`）。耗尽时：

- mention 被 blocked
- 回执带收敛提示："Converge: summarize and hand off via @captain; a captain reply resets the arc"（`episode-policy.ts:63`）
- **captain 回话即重置预算**（`beginEpisodeForChat`：sender 为 captain 才重开弧，`episode-policy.ts:18-23`）

**洞察**：不禁止对话循环，只在预算边缘给出收敛引导。用"预算上限 + 收敛提示 + 人类介入重置"代替硬编排。

**适用边界（第三轮审视修正）**：ARC budget 计数的是**多 agent 互唤风暴**；otter 的痛点是**单海獭输出退化**（mimo 复读），otter 已落地的退化熔断（PR #303：带污重试→restartSession+前情摘要注入、二级上限、healing_events 状态载体）更对症。ARC 对 otter 的增量只剩"用户回话即重置预算"的弧语义（otter 对话弧天然以用户发话为界，基本已具备）。另注：预算按 conversation 独立计数，跨施工群风暴无全局上限——但受 (crew, conversation) 串行不变量约束，风暴上界是 crew 数 × 20，非无界。

### 1.4 身份是"crew × 场合"的函数

组装 prompt 时（`src/domain/identity/harness-assemble.ts:100` `assembleAppendPrompt` 纯函数，同输入同字节以服务 KV cache，注释见 `:2-5`）：

- DM 会话**绝不注入**施工群职责卡——"组职责卡绝不进 DM——上升/上板语义与 DM 契约互斥"（`harness-assemble.ts:22, 94-95`）
- 花名册**从数据渲染**而非手写，自动补 captain 和 first-mate 并标注默认承接人（`:61-73`）
- 同一个 chief-engineer 在 DM 和施工群里是两个不同的角色投影，互不泄漏

**洞察**：多 agent 系统的身份不是一张静态卡，而是坐标（人 × 场合）的函数。会话契约按坐标注入避免了"在私聊里带着施工接力语义说话"的串场问题。

### 1.5 Task 纯镜子：状态机哲学

- 状态机 `todo → in_progress → in_review → ready_to_land → done/cancelled`（状态集 `src/domain/task/task.ts:9-16`，转移表 `TASK_TRANSITIONS` `:84-92`），**系统零卡驱动行为**——"板是镜子：系统不替任何人推卡"
- **状态只编码"现在谁该干什么"，历史归事件表**。废除 rework 状态的论证（`task.ts:4-8`）堪称典范："它与 in_progress 对『现在谁该干什么』回答一字不差，编码的是历史（提案被拒），而历史在 proposals 表已有真相源"
- 机制守卫承载社会规则：approver ≠ assignee（self_review 禁止，`task.ts:231-235`）；closeout 必须携带 40-hex merge commit 证据，非 git task 显式豁免——"非 git task 不发明假检查"（`task.ts:174-193`，应用层先验注释 `:171-172`）
- 一 Task 一专属施工群（`task.ts:152-162` 守卫），全生命周期在群里以球权接力推进

### 1.6 调度器：只做三件事，对"该谁干"零发言

1. **合并去抖**：同一 (crew, conversation) 已有 pending job 时新触发只 promote 唤醒等级（`decidePendingInvocationJob`，`invocation-job.ts:81-124`）
2. **公平轮转选批**：按 crew 轮转逐个取队头，同一 attention point 已 busy 不再发第二个 run（`dispatch-policy.ts:31-52`）——**"一个 crew 在一个会话里串行思考，不同 crew 并行"**这个简单不变量替代了复杂的并发协调
3. **超期/失败裁决**：stale claim 5 分钟回收（`dispatch-invocations.ts:7`）；失败时有 newer pending 则 supersede 而非盲重试

唤醒分级由 sender kind 决定：captain=3 > assign=2 > a2a=handoff=1（`invocation-job.ts:8-13`）——唤醒的"档位"本身就是组织语义。

**洞察**：这是对"反强编排、工具优先"理念贯彻得相当彻底的实现——调度器不决定谁干（花名册+SOP 决定）、不决定何时干（mention 门铃决定）、不决定干多少（预算只封顶不驱动）。自治边界由三层共同划定：契约层（球权契约文本）+ 预算层（arc budget）+ 事实层（system 消息只播报不对话）。口径限定见第六章对比表。

---

## 二、工具与能力体系

### 2.1 Tool teaching 三条腿（全仓最亮的设计）

每个工具一份 markdown（frontmatter `tool: name` + 三节），经 `scripts/generate-tool-teaching.mjs` 生成 `tool-teaching.generated.ts`，注册期织入工具 def。三条信道各司其职（`packages/pi-extension/src/tool-response.ts:1-14`）：

| 信道 | 目标问题 | 投放位置 |
|------|---------|---------|
| `promptSnippet` | 何时用 | system prompt |
| `description` | 参数与返回 | 工具 schema |
| `response`（`buildToolResponse` 模板：摘要 + Next action + Result fence） | 本次结果 + 下一步找谁 | **每次调用都进上下文** |

**洞察**："response 即教学"——Next action 是状态相关的（不是静态文案），每次工具返回把 SOP 下一步递到嘴边。用最高频信道做行为塑造，比堆 system prompt 划算得多。

防漂移机制是双 fail-loud（`tool-teaching.ts:11-34`，类型级 `description?: never` + 运行时检查，禁止第二 carrier 复活；md 缺失该工具也抛错）。另有 harness 对账测试：SOP 文本不得引用已废除的状态；`vessel_list_tasks` 的 status enum 必须与 `TASK_TRANSITIONS` 状态机全集一致——源自 F046 事故（prompt 与代码漂移）的防再发门。**把"prompt 与代码漂移"当一类真实 bug 来管理。**

### 2.2 Harness 版本门：能力文本是"固件"

`crew-capabilities/harness.json`（version 4）清单化所有工具教学/角色卡/SOP/契约。`scripts/check-harness-version.mjs`：能力文件有 diff 而 version 未 bump ⇒ CI 红（比对基准 merge-base；浅克隆显式报错而非静默跳过——"静默跳过 = 门上开洞"）。run 派发时把当前 harness 版本盖进 run 记录（`execute-run.ts:44-49`），行为异常可归因到具体版本，服务滞后 main 不归错桶。

### 2.3 服务端角色驱动权限

权限不在工具层自我约束，而在服务端裁权：`conversation-commands.ts:29-30` 的 FM guard（create_conversation 仅 captain/first-mate）；bind_project 限 captain 或 participant。工具全员可注册，调用时服务端按 actor 裁决。

---

## 三、记忆与上下文系统

### 3.1 三层存储架构

1. **真相层：Markdown 文件**（`crews/<crew_id>/memory/<id>.md`，YAML frontmatter + body，tmp+rename 原子写）
2. **索引层：SQLite FTS5** 投影 + 溯源链接表
3. **事件层**：`memory.created/updated/deleted/recalled` 事件带 idempotency_key 进 events 表

`content_hash` 对规范化内容摘要，rebuild 时逐条校验；文件为权威全量重建 SQLite 投影且保留运行时指标。写入侧 provenance 由服务端盖章（`MemorySourceStampResolver`：没有经过认证的活跃 Run 拒绝写）——**LLM 报什么 run_id 不算数，防伪造**。这是 event-sourcing-lite 的严肃设计。

### 3.2 亮点设计

- **溯源结构化可反查**：`source_conversations: {conversation_id, cursor_from, cursor_to}[]` 落独立表，支撑"这段对话沉淀出了哪些记忆"的反向查询
- **价值评分闭环到执行结果**：frequency(0.3)/relevance(0.2)/recency(0.3, 30 天半衰期)/trace(0.2) 四信号；trace 信号用记忆被召回后那个 run 的**工具成功率**度量——记忆效用闭环到执行结果，多数记忆系统缺失这一环。且只有 episodic 会判 stale，semantic/procedural 永不衰减（符合认知科学分类）
- **上下文裁剪分层降进而非一刀切**（`build-unread-digest.ts` + `src/application/context/assemble-invocation-context.ts:160-234`）：head 3 + tail 5 + 中段省略，省略段给四层补偿（task-journal 锚点/聚合事实/frequent-terms/observed-files），块尾附**参数预填好的可执行召回链**（`vessel_get_conversation_context(message_id=...)` → `vessel_get_task_journal` → `vessel_search_conversation_history(query=...)`）
- **记忆是纯 pull 模型**：prompt 组装不自动注入任何记忆，agent 必须主动调 `vessel_search_memory`——避免"注入错记忆污染上下文"

### 3.3 反面教材（重点记录，供规避）

1. **`related_refs` 是死字段**：schema 里让 LLM 填 `"memory:mem_001"`，但全链路只存储、序列化，**从未被任何检索、遍历、ranking 或渲染消费**（第三轮审视全仓 grep 确认无反例）。没有 link 表、没有双向边、没有"召回一条带出邻居"。制造了"有关联能力"的假象。`topics` 字段同理（search 过滤条件仅 crew_id/日期/type/domain，`sqlite-memory-query.ts:43-60`）。**口诀：schema 里任何字段必须先回答"谁消费它"。**
2. **中文检索是坏的**：`memory_fts` 用 `tokenize='unicode61'`（`schema.sql:521-526`），整段连续汉字当一个 token，中文查询无法命中。讽刺的是消息历史专门建了 CJK bigram 投影（v126 迁移，F037）——长期记忆没享受同等待遇——中文多智能体系统自己的记忆搜不到中文内容。反证 otter jieba+trigram 双表的价值。
3. **效用评分不进排序**（第三轮审视校准）：检索排序 = 裸 bm25，唯一修饰是 stale 降权 ×0.5（`sqlite-memory-query.ts:66-73`）。value_score **通过生命周期门间接生效**（驱动 episodic 的 stale↔active 双向转换，smoke-phase-e 有"stale→active 恢复"验收），但不参与检索排序；stale 只标不删，无 GC 路径（DELETE 仅按 id 或全量 rebuild）。
4. **静默失败**：search 里 `catch { return [] }` 把 SQL 错误吞成零结果（`sqlite-memory-query.ts:74-75`），对 LLM 表现为"没有记忆"。
5. **纯 pull 写入的代价**：记忆写入完全依赖 LLM 自愿调用工具，record 层有全部素材却不做提炼——"不写就永远没有"，系统对"该记而没记"零感知。

**总评**：长期记忆子系统"工程纪律很强（溯源/幂等/可重建/hash 校验做到准生产级）、记忆智能很弱（关联/语义检索/效用排序停在 schema 占位或最简实现）"。注意限定：tutu 检索智能真正强的一块在**会话历史检索**（evidence find，见第七章盲点补录），不在长期记忆。上下文组装是全仓最成熟的子系统。

---

## 四、架构治理与工程化

### 4.1 架构规则可测试化

11 条规则（`src/tooling/architecture/rules.ts:1-12`）由 `analyze-imports.ts` 用 **TS compiler API 做 AST 级 import 分析**强制，亮点规则：

- `application-private-cross-module`：application 模块间只能走 `public.ts` 门面
- `pi-runtime-boundary`：Pi 适配器禁触 sqlite/socket/bootstrap（防运行时反向耦合）
- `application-concrete-dependency`：正向约束 application **必须**可以 import ulid/node:crypto 白名单——务实地承认 use-case 层需要基础设施，不装纯

配合 **phase 切片推进**（phase-a~h 每个重构切片一个验收测试 + negative fixtures）和 **legacy-baseline.json 只减不增**（防"重构期间又欠新债"）。这是把架构治理当 feature 做的范本。

### 4.2 fail-closed 与诚实归因

- credential 两级 gate 的 verdict 走 fd3，区分"真凭据状态"vs"gate 自身 infra 故障"（`pi-crew-executor.ts:92-108`），spawn 成功无 pid 也按失败处理——"绝不谎报 credential 状态"
- 遥测三条纪律：span 命名跟 OTel GenAI 语义约定；只带 ID 与计数绝不带消息正文；每次发射吞掉自身异常——"遥测坏了，业务写路径必须照常完成"
- span 诚实性：Captain 网页发消息用纯域操作名，不谎报 `gen_ai.tool.name`
- 稳定码诊断：log 只出 coordinate + stable code，raw exception 不进 server log

### 4.3 度量自身流程（review metrics，F045）

对 crew 产出的检视报告（code/design/fm-acceptance/proposal-decision 四家族）做结构化摄取 → `review_*` 事实表 → 聚合"交付卡"（每 task：检视轮次、finding 密度/severity/outcome 桶、净交付行数、escape）。`REVIEW_PARSE_VERSION` 作为重放开关——解析演进不需要数据修复脚本。归一不了的动词落 `unmapped` 桶绝不静默丢弃。**用运行时数据度量自己的 AI 协作流程质量（review 发现率、返工、escape），这是真正的"agent 流程 SRE"。**

### 4.4 测试与验证

四层：vitest 单测（use-case 全是纯函数 + mock ports）；架构验收测试；e2e smoke 分档（mock spawner 验证调度恢复的确定性档 / fixture child 进程模拟 Pi 死法 / real-Pi 档"未 build 即抛可执行指引，绝不静默回落 fake"）；能力评测（checked-in fixture 经真实 handler 跑六指标 lexical eval，"经 handler 而非 SQL 层，防契约与实现分叉"）。

### 4.5 AGENTS.md 的协作纪律

作者不能批准自己的变更，无第二审查者就停在 ready-for-review；修 bug 先复现根因 + 先写失败回归测试；7700 端口是 Captain 活运行时——"Killing 7700 aborts every in-flight run, including your own. Ask the Captain and wait for an explicit yes"。

---

## 五、设计哲学与演化史

### 5.1 自我命名：harness 不是 gateway

ADR-022 专开宪法级讨论："网关是无状态中介；vessel 是整栋办公楼 + 行政系统。**Crew 住在 vessel 里，不是路过 vessel。**"随之的机制/内容切面：内核只拥有"感知组装的机器"，能力（工具/SOP/岗位说明）是流经的稿件——日常能力增长 = 填槽位，不改装订机。

**双门设计漏斗**：门 1"能力归 crew，治理归 vessel"——任何"系统要不要帮 crew 做 X"，默认答案 = 做成工具让 crew 自己调，内核永不长代理行为；门 2"开新工具前先问现有工具组合能否表达"。有判例记录：Nudge 功能死于门 1（系统不代喊人），ask_captain 死于门 2（mention 已覆盖）。

### 5.2 四条设计公理

1. **机制最小化，SOP 承重**——机制只做文本做不到的四件事：唤醒、路由、持久、隔离
2. **嘴只在当前会话**——无任何跨会话消息路径
3. **事实留言，观察按铃**——system 只播报已发生的事实，判断性话语只来自 crew
4. **task 纯镜子**——系统零卡驱动行为

外加 SYSTEM-MAP 的 15 条不变量（`docs/SYSTEM-MAP.md:78-93`），最见性格的："System reports facts; Crew provide judgment"（#8）、"Identity is not transcript"（#9，身份 = 岗位说明书 + Crew Memory，Pi session 只是可替换的载具）。

### 5.3 愿景换代：一次自我政变（最有戏剧性的演化事件）

v0.2 愿景是"crew 平级协作社会"——PRD 堆了平级公理、著述生态、mentor 冥想核验、记忆法庭、瞭望员、Mission 三层聚合。2026-07-01 CVO 要求"大幅砍掉多余的、过度设计的、没接线的"，产出 33.6k LOC 逐子系统追入口的审计 + 15 条砍单。审计结论诚实得罕见：**"这一个月的代码几乎零浪费"、过度设计集中在"承诺面"而非代码面**——那两个月的社会上层建筑零行代码，处决零成本。v0.3 改为"一人公司 + 幕僚长 + 施工队"，peer 公理废除。

### 5.4 理念与现实的脱节（经代码验证）

1. **"机制最小化"名存实亡**：宣称机制只做四件事且"数得过来"，现实是 5.1 万行内核、delivery cursor 结算语义、cold-path 分层摘要细到"BMP 外 CJK Extension B+ 不进 bigram"。"零跨会话通信"公理下藏着一整套事实上的跨会话上下文工程（session chain、handoff 续接、journal 召回链）——handoff 续接就是"无自主唤醒"公理上开的口。**机制在长大，只是每次都披着 ADR 的合法外衣。宪法条文更像方向感而非不变量。**
2. **文档治理自我违反**：ADR-022 明文"glossary 零实现句"，现行 CONTEXT.md 却塞满 F037-P3-CR-02 级实现细节。squash hash 写进 ROADMAP 索引，多处自认"状态滞后"。"docs 是真相源"在文档规模失控时反成阅读负担和漂移温床。
3. **流程重量落回一个人**：31 ADR + 15 不变量 + 架构门 + CAP-N 验收链的重流程，隐含前提是施工队几乎免费（LLM）且 captain 有耐心逐 phase 真机验收——人肉瓶颈迹象已现。
4. **职责堆积（第三轮审视重写，原表述"过度叠甲"误诊）**：单机 SQLite 应用上了两级 credential gate + fd3 verdict + 14 步生命周期状态机。审视指出：对以 LLM 为主要劳动力的系统，防御密度本身是合理的——LLM 会幻觉参数、伪造 run_id、半途死掉是日常事件而非边缘情况，fail-closed guard 换取排障时间数量级下降（这与 4.2 节"值得学"是同一判断，不矛盾）。**真问题是职责堆积**：`PiCrewExecutor` 单文件承载 credential/spawn/事件消费多重职责，9 轮 F 整改在同一文件叠甲；单方法 use-case 类 + 双文件门面导致 270 行组合根是全库最脆点。且叠甲是可逆的——F041 拆除 failure_category 准入依赖（"分类缺失的代价是少一句话，不是整条不可见"，`terminal-run-notice-queries.ts:9-14`）是制度化的拆甲判例。
5. **数据化不彻底**：`communication.ts:15-22` 把 captain↔first-mate DM 入口硬编码进 domain；`task.ts:148` 硬编码 `conversation.type === 'software'`——号称 manifest 数据驱动，第二类能力组出现就要改域代码。
6. **reviewer 单点（第三轮审视加限定）**：**运行时**独立审查视角确实只有一个 crew，无多 reviewer 交叉。但**开发流程**上有外部跨模型 review + cloud review 交叉（F029 反思胶囊明载捕获 credential/Git race/handoff trust boundary 等真实缺陷）。crew 间没有信任/偏好建模（全仓 grep 确认无反例）——名字是第一公民了，但公民之间只有规则没有关系。

---

## 六、对比定位：tutu-vessel 与 otter 的路线差

同技术栈（Pi SDK + SQLite + 分层架构）下的两条路线：

| 维度 | tutu-vessel | otter-buddy |
|------|-------------|-------------|
| 组织形态 | 放射状：1 captain + 3 crew，球权接力 | 平权海獭社会 + 用户，第一公民是实体 |
| 制度工程 | 极致：版本门/CI 对账/反思胶囊/砍单审计/自我狗粮 | F/R 文档体系 + sync 校验，轻量 |
| 记忆（长期记忆） | 工程强（溯源/幂等/重建）智能弱（死字段/中文坏/裸 bm25） | 关联有链、hybrid 检索 + 加权 RRF 重排更精致 |
| 会话历史检索 | **evidence find 更精致**：分层召回计划 + 负例指标 + 解释层（见第七章） | hybrid 检索，缺负例指标与解释层 |
| 行为塑造 | tool teaching 三信道制度化（模板+类型级防复活+对账测试） | 信道分层原则 + 已有隐式实例（dispatch-guard 纠错指令），缺制度化 |
| 熔断 | ARC budget（多 agent 互唤软熔断） | 退化熔断已落地（PR #303：restartSession+摘要注入/二级上限/healing_events），对症单 agent 输出退化 |
| 反编排 | 调度器含唤醒分级/公平轮转语义（编排性残留） | **调度面更薄**：yield 由 LLM 决定行动者，orchestrator 有代码级自我设限宪法（`orchestrator.ts:8-10`：attemptDriver 仅限"重执行当前轮"，防扩写成流程引擎） |
| 验证 | fixture/mock 分档 smoke + real-Pi 验收 | 真实模型能力测试层（A/B 分层）更强调真 LLM |

> 反编排一行的口径（第三轮审视确立）：按"机制是否替 agent 做决定"衡量——otter 的行动者选择权在 LLM（yield），系统只校验；tutu 的调度器做唤醒优先级排序和轮转选批。原文"tutu 反编排更彻底"是印象分，方向写反了，已纠正。

---

## 七、盲点补录（第三轮审视发现，五路分析遗漏）

### 7.1 Evidence Find：会话历史检索引擎（全仓最大遗漏）

与长期记忆并列的一整套检索子系统，文档原文只用一行带过：

- **分层召回计划**：`entity_exact > fts_and > cjk_bigram > fts_relaxed > fts_or > substring`，bigram 只做候选生成，exact 需 truth 连续同序验证（`src/domain/communication/evidence-find-policy.ts:24-40`）
- **锚抑制纯状态机**：链式去重、到达序无关、多链命中判"桥"合并、锚满 defer 不撒谎（`evidence-anchor-policy.ts:1-15`）
- **tokenizer 校准方法论**：不手写 Unicode 近似，而是探测部署环境 FTS5 unicode61 生成码点表（差分证伪 47/1492 不一致），配 differential contract 测试（`src/tooling/evidence-tokenizer-calibration.ts:1-13`）——对 otter jieba/trigram 双表维护有直接方法论价值
- **六指标 lexical eval 含负例指标**：`forbidden_hit_at_5`、`cross_conversation_leakage_at_5`（`src/tooling/evidence-eval.ts:44-48`）+ 前端 "search-why" 检索解释层（`packages/web/src/components/search-why-presentation.ts`）——otter 的 hybrid 检索评估体系（R20260811rclo 起的 P0-1 可观测性方向）缺的正是负例指标和解释层

### 7.2 Journal 系统：结构化归因（不只是"补偿锚点"）

`src/domain/task/journal.ts`：五种 kind 含 `historical-bug-found` 结构化块——发现者按 schema 填 feature_id 归因 + P1-P3 定级 + 可选 finding_id 指认"本该抓住它的检视意见"；**journal_id 由持久层时间位铸造、produced_in_run_id 由请求链注入，caller 均不可传不可覆盖**（服务端盖章）。这正是 otter"记忆 entries 必须有链"的落地形态：事后归因用结构化 schema 而非文本暗号。

### 7.3 Proposal 交付证据门

`src/domain/task/proposal.ts:11-26`：无 delivery_record（ci_status 或显式豁免）的 pending 提案 **approve 被域拒绝**，必须重交。"无证据不可批、豁免须显式"——比 closeout 的 merge commit 检查更前置的一道门。

### 7.4 Session chain 与 delivery cursor 完整机制

`session-chain.ts`：seal 三因（handoff/crash/captain_archive）、changed_files 与 transcript_path 随链记录、冲突显式抛错。`delivery-cursor.ts:25-38`：只有 settled outcome（completed/explicit_user_abort）才推进 cursor，candidate ≤ current 拒绝推进——**崩溃恢复语义单调不回退**。原文只把它当"宪法 hypocrisy 证据"，机制本身对 otter 会话续接有参考价值。

### 7.5 Web 前端与拆甲判例

26.8k 行 React 前端（原文近乎全忽略）：ReplayCapsule（run 重放/审计 UI）、CabinLookout（review metrics 看板）、每会话/每 crew token 用量日历、Composer 草稿持久化、确定性 avatar 分配（hash 替代 fallback，修"所有 crew 撞脸"）。Terminal Run Notice 的拆甲判例已并入 5.4-4。

### 7.6 治理微机制群

- `project-skills/ad-hoc-decision/SKILL.md` 三车道判定（领域测试→停手上设计桌 / 结构测试→五行卡继续 / 其余自由）："无痕的好决策等于不存在，无痕的坏决策是地雷"
- 反思胶囊固定三段式 What Worked / What Failed / **Trigger Missed**——第三段是元认知层（当时漏了什么触发信号）
- onboard wizard：installation 级单一 credential、多 provider（OAuth/device-code/masked key）、无需重启下次 run 即生效——otter LLM key 运维的现成模式

---

## 八、启示（引子——具体优化另行立项）

以下仅登记方向，不做方案，后续单独开 F/R（第三轮审视后重排）：

1. **球权收尾契约**：tutu 的"每 run 恰好一次收尾 + 乒乓非法"表述直接对症 otter speak+yield 拆分后的收尾协议痛点（PR #310 刚合、PR #358 no_yield 内容丢失刚修）——把收尾协议从工程修复提升为契约文本。
2. **承诺面↔已接线对账**：tutu 用 33.6k LOC 审计才发现"承诺面跑在代码前面"；otter 有本土实证（Self-Healing v4 三轮定稿，接线仍在进行）。可做 lint 级对账：F 档声称的机制 ↔ 代码符号存在性。
3. **evidence find 检索方法论**：负例指标（forbidden_hit/leakage）+ 检索解释层 + tokenizer 差分校准，补 otter hybrid 检索的评估体系。
4. **Tool teaching 制度化**：otter 已有隐式实践（dispatch-guard/talking-stone 的纠错指令就是"response 即教学"活例），要学的不是引入三信道，而是**制度化**——统一模板 + 类型级防第二 carrier + 与代码对账。
5. **能力文本版本门**：otter 已有 manifest `version` + lint 一致性校验，真正缺的是 tutu 式两件——"改了能力文件必须 bump version"的 CI 门 + run/message 盖 prompt 版本戳（运行时归因）。
6. **ARC budget 弧语义（降级保留）**：otter 退化熔断（PR #303）已对症落地且更贴题；ARC 仅"用户回话即重置预算"的弧语义可参考，非独立优化项。
7. **记忆字段消费性审查**：schema 字段先答"谁消费它"——tutu `related_refs` 死字段是 otter"记忆≠数据堆"原则的反面教材。
8. **架构规则可测试化 + 流程度量**：批次3 拆解前评估 AST import 分析 + baseline 只减不增；otter 已事实用 AI 团队开发，review metrics 式流程度量是当下问题不是远期方向。

---

## 对抗审视记录

### 第一轮：事实核查（2026-08-24）

**总体**：机制/内容性断言 ≈95% 属实，无捏造；file:line 引用 ≈35% 精确、50% 漂移、15% 指错区域；数量断言过半有小偏差。

**已修正**：`context-builder.ts` 文件名错误 → `assemble-invocation-context.ts`；`task.ts` 四处行号（状态机 9-16/84-92、rework 4-8、self_review 231-235、closeout 174-193）；`harness-assemble.ts:35-37` → 22/94-95、纯函数 → :2-5/:100；`episode-policy.ts:48-52` → :63；`invocation-job.ts:107-137` → :81-124；`communication.ts:19` → :15-22；数量：346 测试文件（原 402）、47 F 档（原 48）、24 AHD（原 23）、~5.1 万行（原 5.6 万）。全链路否定断言（related_refs 死字段/topics 不可滤/value_score 不进排序/无 GC/catch 吞错/unicode61）全部 grep 验证属实。

### 第二轮：盲点挑战（2026-08-24）

**盲点**（用户拍板：独立成章，已补第七章）：evidence find 检索引擎（最大遗漏）、journal 结构化归因、proposal 证据门、session chain/delivery cursor、web 前端、Terminal Run Notice 拆甲判例、治理微机制群。

**校准**（已回写）："评分不算数"→"经生命周期门间接生效但不进排序"；长期记忆 vs 会话检索的强弱需分开表述；"过度叠甲"补拆甲判例；风暴上限 = crew 数 × 20 非无界；reviewer 单点区分运行时/开发流程。

### 第三轮：决策挑战（2026-08-24）

发现三处对 otter 现状的过时认知，均已修正：

1. **熔断对比行事实错误**：otter 熔断已于 PR #303（F20260818cbkr，2026-08-18）落地，非"观察期"；ARC budget 场景不对症（多 agent 互唤 vs 单海獭退化）。
2. **"无版本管理"立论过强**：otter 有 manifest version + lint，缺的是 bump 门与 run 盖戳。
3. **"tutu 反编排更彻底"方向写反**：otter 有代码级反编排宪法（orchestrator.ts:8-10）、yield 由 LLM 决定行动者；tutu 调度器含编排性语义。按"机制是否替 agent 做决定"口径重写对比表。

**用户拍板记录（2026-08-24）**：
- ARC budget 引子：降级重写（仅借鉴用户回话重置语义）✅
- 反编排对比行：按口径重写 ✅
- 引子补录：球权收尾契约 + 承诺面↔已接线对账 + evidence find 检索方法论（三项全补）✅
- 盲点内容：新增独立章节（第七章）✅

---

## 参考文件

### tutu-vessel 仓库（/tmp/tutu-vessel，浅克隆可能已清理）

- `crew-capabilities/` — harness.json 清单、tools/*.md 工具教学、universal/software 角色卡与 SOP、a2a-contract.md 球权契约
- `packages/pi-extension/src/` — vessel-crew-ext.ts / tool-teaching.ts / tool-response.ts / vessel-send.ts / register-write-guard.ts
- `src/domain/` — task/task.ts 状态机、communication/episode-policy.ts ARC budget、communication/evidence-find-policy.ts + evidence-anchor-policy.ts 检索引擎、identity/harness-assemble.ts 身份组装、scheduling/dispatch-policy.ts、session/session-chain.ts + delivery-cursor.ts、task/journal.ts + proposal.ts
- `src/application/context/` — build-unread-digest.ts / assemble-invocation-context.ts 上下文分层裁剪
- `src/application/memory/` + `src/adapters/outbound/persistence|filesystem/` — 三层记忆存储
- `src/tooling/` — architecture/（11 条规则 + AST 分析 + phase 验收 + legacy-baseline）、evidence-eval.ts、evidence-tokenizer-calibration.ts
- `scripts/` — generate-tool-teaching.mjs / check-harness-version.mjs / check-line-caps.mjs
- `packages/web/src/` — ReplayCapsule / CabinLookout / search-why-presentation.ts / terminal-run-notice-queries.ts
- `docs/` — vision.md（v0.3）、ADR 系列、2026-07-02 愿景 pivot 砍单审计、SYSTEM-MAP.md、CONTEXT.md
- `AGENTS.md` / `PLAYBOOK.md` — AI 协作纪律与 onboard 流程

### Otter 关联

- R20260811rclo — clowder-ai 召回机制对比（前一外部对标）
- PR #303（F20260818cbkr）— 退化熔断已落地的对照依据
- CC 记忆 `reference_tutu_vessel.md` — 本次蒸馏的指针
