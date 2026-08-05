---
id: F20260805rsto
title: restart-noop-domain-session-gap
doc_type: feature

summary: |
  修复「重启獭生」对从未重启过的獭是空操作的严重 bug。根因：系统存在两套断开的 session 模型——agent 层（agent_sessions 表 + pi jsonl，真正的 LLM 上下文，由 CreateOtter/invoke 创建）与 domain 层（otter_sessions 表，封存/链/反面案例账本，仅由 restart 等端点创建）；日常对话从不创建 domain 行，导致 restart 控制器查不到 active session 而整块跳过「封存 + agentGateway.reset」，獭的记忆完整保留。修法：从源头保证「有 agent 会话 ⟹ 有 active domain session」不变量。

causal_links:
  from:
    - F20260709p4q7   # data-model-design：restartOtterLife 设计（封存为反面案例）
    - F20260713o4t8   # domain-otter：triggerRestart 含「注入前情摘要」设计
    - F20260716zq9q   # conversation-session-architecture：handoffSession 设计（已实现但成死代码）
  to: []

status: implemented
change_type: fix
tags: [otter, session, restart, domain-model, invariant, agent-gateway, root-cause]
modules:
  - src/interface-adapters/http/controllers/otter-controller.ts
  - src/usecases/otter/manage-session.ts
  - src/usecases/otter/create-otter.ts
  - src/usecases/otter/dissolve-otter.ts
  - src/frameworks/agent/pi-session-factory.ts
  - src/frameworks/agent/session-restore.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - web/src/pages/conversation/index.tsx
  - web/src/lib/mappers.ts
  - tests/api/otter.test.ts
---

# F20260805rsto: 重启獭生空操作——双层 session 模型断裂

## 背景

2026-08-05 用户在产品中对两只持续对话了一天多的大獭执行「重启獭生」，界面上**完全看不出任何生效迹象**：右侧栏海獭详情弹窗的 Session Chain 没有历史 session、没有当前/历史区分。排查后确认这不是展示问题——**重启在 agent 层面根本没有发生，獭的记忆完整保留**。

## 生产实证（2026-08-05，主库 data/otter-buddy.db + 运行日志）

| 证据 | 内容 | 说明 |
|------|------|------|
| 运行日志 | 两次 `POST /api/otters/:id/restart` 均返回 201（09:52:16 / 09:53:32 本地） | API 本身"成功" |
| 运行日志 | 全程**无** `'Session archived'` info 日志 | archiveSession 成功必打（manage-session.ts:112-118）→ 证明它从未执行 |
| `otter_sessions` 表 | 全库仅 2 行 active，`started_at` 恰为两次 restart 时刻，`previous_session_id` 均 NULL | 没有任何 'restarted'/'archived' 行——前世没被封存 |
| `agent_sessions` 表 | 两獭的 pi session 仍是 **2026-08-04 08:02:47 / 08:09:26** 创建的那两个，未被 upsert | reset 若执行会写入新 pi session id + 新 jsonl 文件 → 证明 reset 从未执行 |
| `messages` 表 | 两獭从 08-04 起持续对话；restart 后 01:52:30 用户发消息、01:52:34 獭回复 | 回复走的是旧 pi session，獭全记得 |

结论：两次重启的唯一效果，是往 `otter_sessions` 各插了一行孤立记录。封存、记忆转换、agent 重置全部未发生。

## 根因分析

### 直接根因：restart 控制器把「无 active domain session」当合法路径静默跳过

`src/interface-adapters/http/controllers/otter-controller.ts:88-96`：

```ts
const active = await this.manageSession.getActiveSession(id);
if (active) {                              // ← 正常聊天过的獭这里恒为 null
  await this.manageSession.archiveSession(active.id, {
    reason: "restart", isNegativeCase: false, summary: body.summary,
  });                                      // 被跳过，连带其中的 reset 丢失
}
const session = await this.manageSession.createSession(id);  // 唯一被执行的动作
```

被跳过的 `archiveSession` 里藏着三件事（manage-session.ts:101-128）：

1. 旧 session 行 UPDATE 为 `restarted`（封存记账）；
2. 该獭所有对话的工作记忆 `working → historical`（manage-session.ts:163-172）；
3. **`agentGateway.reset(otterId)`（manage-session.ts:109）——真正重置 LLM 上下文的一步**。

### 深层根因：两套 session 模型断开，「有 agent 会话 ⟹ 有 active domain session」不变量无人保证

系统里有两套同名不同物的 session：

| | Agent 层（真身） | Domain 层（账本） |
|---|---|---|
| 存储 | `agent_sessions` 表 + `data/sessions/*.jsonl` | `otter_sessions` 表 |
| 内容 | 真正的 LLM 上下文（pi session） | 封存/链/反面案例/摘要的业务记录 |
| 创建点 | `CreateOtter.execute`（create-otter.ts:44）、invoke 路径 `_restoreOrCreateSession`（pi-session-factory.ts:477 → session-restore.ts） | **仅** `POST /restart`（otter-controller.ts:96）、`POST /sessions`（otter-controller.ts:77，前端无调用方）、`handoffSession`（manage-session.ts:218，生产无调用方的死代码） |

`SessionRestore.createSessionAndPersist`（session-restore.ts:135-185）只写 `agent_sessions` + otter config，**从不碰 `otter_sessions`**；invoke 路径对 domain 层只有一处只读调用（agent-invoker.ts:457 `getActiveSession`，用于注入交接摘要）。

于是：一只獭从出生（CreateOtter）到每天对话（invoke），domain 账本上从来不存在 session。**「重启獭生」对任何从未重启过的獭必然空操作**；只有重启过一次的獭（账本上有了行），第二次重启才会真正走 archive + reset + 建链。首次使用即失效，是最恶劣的一类 bug。

### 观测根因：测试把 bug 固化为预期

`tests/api/otter.test.ts:237-249` 有用例「creates new session when no active session exists」，断言 `archiveSession` **不被调用**、返回 201——把 bug 行为写成了预期。且全部 mock ManageSession，永远不接触「invoke 不建 domain session」的真实世界，双层断裂无法被任何测试发现。

## 次生问题（同一链路，修复时一并处理或单独立项）

1. **解散小獭同病**：`dissolve-otter.ts:34-42` 同样的 `if (activeSession)` 守卫——解散未重启过的獭时，封存记账与记忆 working→historical 同样跳过（destroy 会执行，pi session 被删，但账本无记录、记忆层不转换）。
2. **前情摘要注入断链**：restart 的 summary 写到**旧**行的 `summary` 字段；而新 session 的上下文注入（agent-invoker.ts:457-468）只读**新 active 行**的 `handoffSummary`/`summary`（均为 null）。即使本 bug 修复、archive 真正执行，用户填的「前情摘要」也到不了新獭生的上下文——与 F20260713o4t8「triggerRestart 注入前情摘要」的设计不符。
3. **`isNegativeCase` 硬编码 false**（otter-controller.ts:92）：与弹窗文案「封存当前 Session 为反面案例」矛盾，详情弹窗「反面」列恒为「-」。设计意图（重启是否一律算反面案例）需产品确认。
4. **前端不刷新**：`confirmRestart`（web/src/pages/conversation/index.tsx:864-870）丢弃 201 返回的新 session，加载 effect（index.tsx:530）有 `if (!sessions[otter.id])` 守卫，重启后弹窗/卡片显示旧数据直到手动刷新页面——这是用户「看不出生效」的展示层原因。
5. **前端丢链信息**：`mappers.ts:151-162` 的 `mapSessionDTO` 丢弃 `previousSessionId`；`LocalOtterSession.status` 联合类型缺 `'restarted'`，弹窗把 restarted 笼统显示为「归档」，Session Chain 表格只按时间罗列、不渲染链式关系。
6. **`handoffSession` 死代码**：F20260716zq9q 设计的结构化交接（LLM 生成 handoffSummary、双重存储、失败回滚）已实现且有测试，但生产无调用方；token 阈值主动交接未实现。
7. **pi 层 parentSession 指针悬空**：reset 把旧 piSessionId 写进新 session header 作血缘（pi-session-factory.ts:372-374），随即 unlink 旧文件（412-420），指针指向已删除文件；且与 `destroy()`「不删文件保留审计」的策略自相矛盾。

## 修复方案（经对抗审视修正后的最终版）

主修复目标：保证不变量「**有 agent 会话 ⟹ 有 active domain session**」，三处落实：

1. **CreateOtter 出生建账**（create-otter.ts）：agent 创建成功后，用实体层纯工厂 `buildNewSession()`（entities/otter/otter-session.ts）直接经已有 `repo` 建首世 session 并打日志。**不注入 ManageSession**——会形成 `CreateOtter → ManageSession → ManageConversation → CreateOtter` 静态组装环（main.ts:285-289，TDZ 直接起不来）。回滚链：session 建行失败 → `agentGateway.destroy` → `deleteOtter`（FK `otter_sessions.otter_id REFERENCES otters(id)` 且 foreign_keys=ON，顺序不可颠倒；createSession 是单条原子 INSERT，失败无行，无需 deleteSession）。
2. **启动一次性迁移**（frameworks/db/otter/backfill-session-ledger.ts，main.ts 启动序列中 reconcileOrphans 之后执行）：为「agent_sessions 有行、otter_sessions 无 active 行」的存活獭批量补登记首世。幂等，每次启动跑。覆盖存量数据，上线即全部生效。
3. **invoke 兜底**（agent-invoker.ts buildDynamicContext）：`getActiveSession` 为 null 即补登记——与 pi 层 `createdNew` 无关（存量健康獭走 restoreExistingSession 永远不会 createdNew，挂在 SessionRestore 会漏掉它们，且 frameworks 层持 raw db 写 domain 表是层级违规）。此处每次 invoke 本来就查一次 getActiveSession，零额外读放大；web/飞书/定时任务全部汇入本 invoker。并发补登记撞 conflict 按良性处理（重读一次，仍无则降级）。

### 随主修复一并处理

- **前情摘要注入接通**（原次生问题 2）：`ManageSession.createSession(otterId, { summary })` 支持把摘要写入**新行**；restart 控制器传入用户填的 summary——buildDynamicContext 读新行 `summary` 注入新獭生上下文（旧行仍保留摘要作为封存档案）。
- **删除 `POST /api/otters/:id/sessions` 端点** + 前端 `createSession` 死函数 + 对应测试：不变量建立后健康獭恒有 active session，该端点恒 409，失去存在意义。
- **测试修正**：otter.test.ts 中「无 active session 时跳过 archive」的用例保留但改注释定性为防御分支（生产应不可达）；新增 CreateOtter 建账/回滚、backfill 幂等、restart 全链路（archive→reset→建链）回归测试。

### 已确认的取舍

- **restart 会阻塞在 pi 锁上**（reset 需等 in-flight invoke 完成，最长数分钟 HTTP 挂起）：用户拍板接受——同步语义最正确，实现简单。这是修复新引入的行为（空操作时代反而秒回）。
- 补登记的 session `startedAt` 为补登记时刻，与真实对话历史不符：可接受（评审 #9，可延后改进为取 agent_sessions.created_at 近似）。
- restart archive 与 createSession 非原子：中间态由 invoke 兜底自愈，可观测性靠日志。

### 另行立项（不在本 bugfix 范围）

- 前端：重启后刷新 sessions、Session Chain 链式展示、restarted 状态显示（原次生问题 4、5）；
- `isNegativeCase` 产品语义确认（原次生问题 3）；
- handoffSession 接入或删除；pi 层「reset 删旧文件 vs destroy 留审计」策略统一（原次生问题 6、7）——注意「封存为反面案例」语义下，账本行留着而证据 jsonl 被 unlink，二者目前自相矛盾。

## 验证方式

1. 集成测试：新建獭 → 发一条消息 → POST /restart → 断言 ①`otter_sessions` 旧行 status='restarted'、新行 `previous_session_id` 指向旧行 ②`agent_sessions` 行被 upsert 为新 pi session id ③旧 jsonl 按策略处理 ④记忆层 working→historical 已执行；
2. 生产复现路径回归：对一只从未重启过、有对话历史的獭执行重启，确认 `agent_sessions` 行变化 + 日志出现 `'Session archived'` + 下一轮对话无旧上下文；
3. 存量数据：修复上线时跑一次兜底补登记（方案 A 第 2 条在 invoke 时自然完成，或写一次性迁移脚本）。

## 对抗审视记录（2026-08-05，独立评审 agent，逐行核实代码）

**事实核查**：文档全部指控成立（restart 跳过、archive 三副作用、双层创建点清单、 dissolve 同病、测试固化、前端不刷新等），未发现伪造或错位；确认不存在第三条 otter_sessions 创建路径；确认 CreateOtter 全部调用方（POST /otters、ManageConversation、create_otter 工具）都过 CreateOtter.execute。

**抓到的方案缺陷（初稿方案 A）与处置**：

| # | 评审发现 | 定级 | 处置 |
|---|---------|------|------|
| 1 | 兜底条件挂在 `createdNew=true` 覆盖不了存量健康獭（它们走 restoreExistingSession），生产事故那两只獭恰好是这形态——按原方案修完依然空操作 | 阻断 | 兜底条件改为「domain 无 active 即补」，位置改到 AgentInvoker |
| 2 | CreateOtter 回滚缺 `agentGateway.destroy` + FK 删除顺序，照做会产生新脏数据/回滚失败 | 阻断 | 回滚链写死：destroy → deleteOtter；单条原子 INSERT 失败无行故无需 deleteSession |
| 3 | CreateOtter 注入 ManageSession 成静态环（TDZ 起不来） | 阻断 | 实体层纯工厂 `buildNewSession` + CreateOtter 复用已有 repo 直接建行 |
| 4 | 兜底放 SessionRestore 是层级违规 | 应修 | 移至 AgentInvoker（见上） |
| 5 | POST /sessions 修复后恒 409 | 应修 | 端点 + 前端死函数 + 测试一并删除 |
| 6 | 修复后 restart 阻塞在 pi 锁上（in-flight invoke 可达数分钟），HTTP 长挂起——修复新引入的延迟面 | 应修 | 用户拍板：接受阻塞（同步语义最正确） |
| 7 | 补登记与 restart createSession 竞态 409 + 「已封存无 active」中间态 | 应修 | conflict 按良性处理；中间态由 invoke 兜底自愈 |
| 8 | restart 摘要注入断链确认成立 | 应修 | 随主修复接通（summary 写入新行） |
| 9 | 补登记 startedAt 语义不准 | 可延后 | 接受，后续可取 agent_sessions.created_at 近似 |
| 10 | 每对话一獭导致 otter_sessions 行数膨胀、前端开始显示 Session #1 | 可延后 | 另行评估 |
| 11 | 「封存为反面案例」但证据 jsonl 被 reset unlink，账本与证据自相矛盾 | 可延后 | 并入另行立项的 pi 层文件策略统一 |

## 对抗审视记录·第二轮（PR 检视，2026-08-05，独立评审 agent）

聚焦全链路完整性与「假实现」检测。结论：主链路真实闭环（restart→archive→reset→建链→summary 注入逐环核实），无阻断合并项；抓到 5 个应修，全部在本 PR 内修复：

| # | 评审发现 | 处置 |
|---|---------|------|
| 1 | **restart 竞态 409**：archive 内 reset 等 pi 锁（可达数分钟）期间，invoke 兜底抢先建行 → restart 的 createSession 撞 conflict → 用户见 409，但 archive+reset 已执行、summary 丢失 | 控制器新增 `tryAdoptBackfilledSession`：conflict 时认领既有新行 + `setSessionSummary` 补写前情，按 201 返回；配集成测试模拟该竞态 |
| 2 | 文档承诺的端到端测试未交付（根因在所有层被 mock 时不可见） | 新增 `restart-flow.integration.test.ts`：真 sqlite + 真 CreateOtter/ManageSession/OtterController，仅 seam pi 层；含首世建账、全链路、**事故形态回归**（存量獭 backfill 后 restart）、竞态认领四用例 |
| 3 | agent-invoker 测试 mock 缺 `createSession`——兜底分支抛 TypeError 被裸 catch 吞掉，测试假绿 | mock 补齐；新增兜底三用例（补登记+summary 注入 dynamicContext / conflict 重读 / 失败降级不阻塞对话） |
| 4 | 两处顺序 load-bearing 但无顺序断言：create-otter 回滚（destroy→deleteOtter）、控制器 restart（archive→createSession） | 各加 `invocationCallOrder` 断言 |
| 5 | 兜底内层 catch 无日志——兜底坏掉的唯一表现是原 bug 静默复发 | 补 warn 日志 |
| — | 附带修正：回滚注释的 FK 论证不准确（真正约束是 agent_sessions.otter_id FK，非 otter_sessions） | 注释修正 |

可延后项（评审确认）：Session Chain 表 active 行显示前情摘要的语义混淆（随前端立项）；历史文档中 POST /sessions 残留引用（时点文档不改）。

## 决策记录

- 2026-08-05：用户操作中发现「重启后看不出任何生效迹象」，排查确认为空操作 bug。用户定性「这是严重 bug」，要求基于真实代码完整分析并写清文档。
- 2026-08-05：对抗审视（上表）后修正方案。**用户拍板一**：存量獭补账用「启动时一次性迁移」（懒补有坑——对话前点 restart 仍空操作一次）。**用户拍板二**：接受 restart 阻塞在 pi 锁上（异步化引入「已返回成功但重置未完成」窗口期，复杂度高）。
- 2026-08-05：技术拍板（架构师）：解环用纯工厂方案（不注入 ManageSession）；兜底放 AgentInvoker 而非 SessionRestore；删除 POST /sessions 端点；回滚顺序 destroy → deleteOtter。
