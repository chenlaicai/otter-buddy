---
id: F20260913ctlv
title: 对话视图重构：时间线（Timeline）+ 獭实时状态面板 + Session 弹窗
doc_type: feature

summary: |
  搭档 9/10 拍板的数据模型级重构：对话视图从「消息链」升级为「时间线」，
  右侧栏从「参与者列表」升级为「獭实时状态面板」，流式过程从消息气泡内
  挪到獭 session 弹窗。核心变化：invoke 成为一等实体（有生命周期、有边界
  事件、有状态投影），messages 表被 entries 表取代（统一承载发言/yield/
  invoke 边界/系统事件），首 message 空壳消灭。

causal_links:
  from:
    # F20260908rlcp / F20260909smsp 已收编为本档「前身与演进」章节（编号合拢，2026-09-13）
    - F20260901sgpx   # 协作机制 v2 母方案（信号协议目标态）
  supersedes:
    - F20260909smsp   # speak 多 message 模型被 entries 模型取代（收编见前身章节）
    - F20260908rlcp   # 信号机制收敛（含 session 热池）收编——热池部分由 F20260911pspl 取代

status: draft
change_type: refactor
tags: [data-model, ui-architecture, timeline, invoke-entity, session-panel, entry-model, invoke-events, signal-protocol, architecture-convergence, cursor-semantics, rate-limit]
modules:
  - src/entities/conversation/
  - src/usecases/conversation/
  - src/interface-adapters/agent-runtime/
  - src/frameworks/db/conversation/
  - web/src/pages/conversation/
  - web/src/lib/mappers.ts
created_in_conversation: c97f3b93-1ef8-419f-8997-b64ac33be16e
capability_test: "双獭会话全链路：invoke 边界气泡正确渲染 + speak 条目时间序平铺 + yield 特殊气泡 + 右侧栏獭状态实时更新 + session 弹窗完整展示流式过程"
intent:
  problem: "对话视图仍以「消息链」模型组织，speak 拆分后首 message 空壳、流式过程嵌在气泡内、獭运行状态无独立展示——与 steer/followUp 异步协作模型不匹配"
  expected_effect: "中间栏为时间线（发言+invoke 边界+yield+系统事件按时间平铺），右侧栏为獭实时状态面板，流式过程在獭 session 弹窗中完整展示"
  verify_by:
    type: behavior_check
---

# F20260913ctlv: 对话视图重构——时间线 + 獭实时状态面板 + Session 弹窗

## 前身与演进（F20260908rlcp + F20260909smsp 收编，2026-09-13 编号合拢）

本 PR 曾以三个特性编号推进（rlcp / smsp / ctlv），终审拍板合拢为本档。
两个前身特性的完整施工记录见 git 历史（commit 前缀 `[F20260908rlcp]` /
`[F20260909smsp]`）——本章节只保留演进脉络与关键决策。

### 前身一：F20260908rlcp 信号机制收敛（9/8 八轮过堂）

**问题**：信号机制补丁堆叠——一条游标偏差催生五层补丁（busyQueue → 60s 阻尼 →
点火记账 → 用户停机闸门 → 限流熔断），外加 dispatch_attempts 台账独立记账。
搭档「破而后立」拍板整体重构。

**终态模型**（收编后仍为现行语义）：
- 三动作统一：followUp（默认）/ steer（调用方标急）/ abort（session 方法调用）；
  NORMAL/URGENT/HALT 档位概念全系统移除
- 游标新语义：prompt 启动成功即推进到启动时读到的位置（唯一推进点），
  运行期新到消息恒保持未读；markBatchRead 删除
- 退役清单（11 项）：dispatch_attempts 台账、busyQueue、双闸门、60s 阻尼、
  isOtterActive 墙钟窗、50ms 重扫、事件 B、per-otter 锁、GateBanner、
  /signal-trail 端点、steer 销账
- 429 整改：无冻结、快速 failed + 诚实告知；exhausted 分类器补智谱「使用上限」
  文案，告警分态（transient/exhausted）
- steer 崩溃安全（出路 A）：恢复后首次 invoke 前读 jsonl 尾部匹配 msg id 去重

**热池部分已被取代**：rlcp 的 LRU 热池（session-pool.ts，容量 50 + TTL 30min）
被 main 侧 F20260911pspl（PiSessionPool）取代——本 PR 整合轮（a777f3dd）完成
两池合流：以 PiSessionPool 为基座，rlcp 的游标推进/invoke 级语义移植进
InvokeRegister 寄存器，session-pool.ts 删除。整合细节见 git（merge commit）。

**关键取舍**（详见 git 历史中的原 rlcp 文档）：游标启动即推（D1）、台账整体
退役（D2）、SDK followUp 原生排队（D3）、档位移除（D4）、中断纯 abort（D5）、
steer 恢复侧去重（D6）、三因子驱逐（D7）、防重单层化（D8）。

**随退役功能删除的测试**（历史文档快照不回改，指针悬空归 ratchet 管辖——
2026-09-13 终审定案）：F2026090211v4/F20260902u5tr 的 signal-trail 测试、
F2026090326c5 的 K2/K3 收件箱预览测试、F20260903ah68 的 GateBanner 测试。

### 前身二：F20260909smsp speak 消息模型重构（9/9 拍板）

**问题**：一次 invoke 的多次 speak 全 append 为同一 message 的 segments，
UI 按 message.created_at 排序——运行期 steer/用户插话时间序失真
（大獭 speak A → 用户插话 → 大獭 speak B，视觉上 B 永远排在插话后一条 message 里）。

**当时的方案**（多 message 模型）：每次 speak 创建独立 message
（metadata.invokeGroupId 逻辑归组），时间序由 message.created_at 自然承载。

**被 entries 模型取代**：本特性（ctlv）的 entries 表以更彻底的方式实现了同一
目标——speak 本身就是一条独立 entry（invoke_id 关联），时间序由 sequence_num
承载，invokeGroupId 归组不再需要。smsp 上线即被 supersedes，其「speak 时间序
真实呈现」的目标由 entries 模型完整继承（前端时间线按序平铺）。

**保留的决策脉络**：speak 幂等终结语义（F20260810cb01 熔断护栏沿用）、
yield 前完结打开的 speak（窗口状态不外泄）——两者在 entries 语义下继续有效。

## 背景

搭档 9/9 21:56 提出（msg 原话）：
> 既然咱们现在有了steer和followup，conversation和message这个数据模型和流式过程是否可以拆开两部分。中间栏还是消息链还是海獭speak一条、人speak一条、海獭speak一条；然后把海獭的运行状态挪到旁边。

9/10 08:09 拍板（msg 原话）：
> 1. 当触发海獭invoke时，其实可以有一条特殊气泡"xx獭开始行动～"，以及，完成本次invoke再有一条特殊气泡"xx獭先休息一下～"，跟yield气泡类似
> 2. 现在中间栏这个不能叫"消息"了，但叫什么，你也思考一下
> 3. 右侧这个是海獭当前运行状态，是实时的
> 4. 流式过程在右侧，点击海獭弹窗，这个弹窗是海獭自带的全部的session记录（也就是流式过程；speak也在其中就是一次工具调用）
> 肯定不做最小版本，你思考周全，然后咱们往这方面来改！

9/10 08:28 命名确认（msg 原话）：
> ok，叫entry；另外，我看到你说message表，但其实，现在不应该有message表了，我认为应该新增一个entry表，speak发言只是其中一条消息（然后有个字段表示这是speak类型）。因此，你再整理下新版本的数据模型（不要担心兼容性，我认为你先设计好新版数据模型，旧数据总能映射迁移过来的）

## 目标

- T1: invoke 成为一等实体——有生命周期（start → running → end）、有状态投影、有边界事件
- T2: entries 表取代 messages 表——统一承载发言/yield/invoke 边界/系统事件，首 message 空壳消灭
- T3: 时间线（Timeline）——中间栏从「消息列表」升级为「时间线」，条目类型：发言（speak/user）、invoke 边界（start/end）、信号传递（yield）、系统事件
- T4: 右侧栏 = 獭实时状态面板——streaming/休眠 + 当前 invoke 的 tool call 计数 + 耗时 + token 用量
- T5: Session 弹窗——点击獭头像弹出，展示该獭的完整 session 记录（流式过程 + speak 调用 + 工具调用，按时间序）

## 非目标

- Pi session 树结构改动（URGENT 树化是后续版本）
- 消息内容格式变更（speak body 的 markdown/html-card 渲染不变）
- 多模态附件展示变更（AttachmentBlock 不变）
- 记忆/搜索/术语库等独立模块
- 旧数据迁移（先设计新模型，旧数据映射迁移后续单独做）

## 方案设计

### 概念表

| 概念 | 定义 |
|------|------|
| **invoke** | 一次獭行动的完整生命周期：触发（信号到达）→ 运行（LLM 执行 + 工具调用）→ 结束（yield/fail/abort）。一等实体，有独立表/记录，承载 tsp（行动权传递目标） |
| **entry**（条目） | 时间线中的一个条目。类型：speak（獭发言）/ user（用户发言）/ invoke_start / invoke_end / yield / system。每个条目有类型、时间戳、内容 |
| **时间线（Timeline）** | 中间栏的展示模型。由 entries 按时间序平铺 |
| **獭状态投影** | 右侧栏的实时数据。从 invoke 生命周期派生：无活跃 invoke = 休眠，有活跃 invoke = streaming（含 tool call 计数/耗时/token） |
| **Session 弹窗** | 点击獭头像弹出。展示该獭的 invoke 列表（类似 Pi 自带的 session 历史记录），点击展开某次 invoke 展示全部 invoke_events（流式过程 + speak 调用 + 工具调用），按时间序 |

### 新数据模型

**1. entries 表（取代 messages + message_segments）**

```sql
CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  sequence_num INTEGER NOT NULL,           -- 会话内全局序号（时间序）
  entry_type TEXT NOT NULL CHECK(entry_type IN ('speak','user','invoke_start','invoke_end','yield','system')),
  
  -- 发言类条目（speak/user）专有
  sender_type TEXT,                        -- 'otter' | 'user' | 'system'
  sender_id TEXT,
  body TEXT,                               -- 发言内容（speak/user/system 有值）
  
  -- invoke 关联（speak/yield/invoke_start/invoke_end 有值）
  invoke_id TEXT REFERENCES invokes(id),
  
  -- yield 条目专有
  yield_targets TEXT,                      -- JSON array，行动权传递目标
  
  -- 通用字段
  turn_id TEXT NOT NULL REFERENCES turns(id), -- 对话轮次分组（与 entry/invoke 正交）
  status TEXT NOT NULL DEFAULT 'completed', -- streaming/speaking/completed/failed/aborted
  source TEXT,                             -- 'web' | 'feishu' | 'weixin' | null
  metadata TEXT,                           -- JSON，扩展字段（含 signal_meta 迁移：consumed 标记等）
  sender_name TEXT NOT NULL DEFAULT '',
  context_tokens INTEGER,
  context_tokens_max INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX idx_entries_conversation_seq ON entries(conversation_id, sequence_num);
CREATE INDEX idx_entries_invoke ON entries(invoke_id);
CREATE INDEX idx_entries_type ON entries(entry_type);
CREATE INDEX idx_entries_status ON entries(status);
CREATE INDEX idx_entries_created_at ON entries(created_at);
```

**消费方声明**：
- `sequence_num`：时间线排序（消费方=前端时间线渲染）
- `entry_type`：条目类型区分（消费方=前端渲染分发）
- `sender_type/sender_id/body`：发言内容（消费方=前端气泡渲染 + FTS 索引 + 记忆索引）
- `invoke_id`：invoke 关联（消费方=Session 弹窗 + 右侧栏状态投影）
- `yield_targets`：yield 条目目标（消费方=前端 yield 气泡渲染 + 信号路由）
- `turn_id`：对话轮次分组（消费方=turn-utils 关闭 turn + resume-interrupted-service 恢复 + orchestrator 轮次管理）
- `status`：条目状态（消费方=前端状态展示 + SSE 关流判据 + 看门狗判活）
- `source`：消息来源（消费方=前端来源标签）
- `metadata`：扩展字段（消费方=各特性按需存储；含 signal_meta 迁移——F20260908rlcp 的 consumed 销账标记等）
- `sender_name`：发送者显示名快照（消费方=前端展示）
- `context_tokens/context_tokens_max`：token 用量（消费方=前端 token 条）

**2. invokes 表（新建）**

```sql
CREATE TABLE invokes (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  otter_id TEXT NOT NULL REFERENCES otters(id),
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','aborted')),
  trigger_entry_id TEXT REFERENCES entries(id),  -- 触发本 invoke 的 entry（事件 A）
  talking_stone_passed_to TEXT,                   -- JSON array，yield 时写入
  started_at TEXT NOT NULL,
  ended_at TEXT,
  tool_call_count INTEGER DEFAULT 0,
  token_usage_input INTEGER,
  token_usage_output INTEGER,
  metadata TEXT                                   -- JSON，扩展字段
);

CREATE INDEX idx_invokes_conversation ON invokes(conversation_id);
CREATE INDEX idx_invokes_otter ON invokes(otter_id);
CREATE INDEX idx_invokes_status ON invokes(status);
```

**消费方声明**：
- `status`：右侧栏獭状态投影（running=streaming）+ Session 弹窗状态
- `trigger_entry_id`：invoke 触发源追踪（消费方=Session 弹窗展示触发上下文）
- `talking_stone_passed_to`：yield 目标（消费方=信号路由点火 + 前端 yield 气泡）
- `started_at/ended_at`：耗时计算（消费方=右侧栏耗时展示 + Session 弹窗）
- `tool_call_count`：工具调用计数（消费方=右侧栏实时展示）
- `token_usage_input/output`：token 统计（消费方=右侧栏 token 条 + Session 弹窗）

**3. invoke_events 表（取代 message_events）**

```sql
CREATE TABLE invoke_events (
  id TEXT PRIMARY KEY,
  invoke_id TEXT NOT NULL REFERENCES invokes(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,                -- 'assistant_text' | 'assistant_toolcall' | 'tool_result' | 'error' | 'speak'
  payload TEXT NOT NULL,                   -- JSON（speak 事件的 payload 含 body 引用）
  sequence_num INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_invoke_events_invoke_seq ON invoke_events(invoke_id, sequence_num);
CREATE INDEX idx_invoke_events_type ON invoke_events(event_type);
```

**消费方**：Session 弹窗的流式过程展示（按 invoke_id 关联查询）。

**invoke_events payload 结构**：
- `assistant_text`：`{ content: string }`——LLM 直出文本（非 speak）
- `assistant_toolcall`：`{ toolName: string, toolCallId: string, args: Record<string, unknown> }`——工具调用
- `tool_result`：`{ toolName: string, toolCallId: string, result: unknown }`——工具结果
- `speak`：`{ entryId: string, body: string }`——speak 调用（entryId 指向 entries 表的 speak 条目，body 是发言内容摘要）
- `error`：`{ message: string, code?: string }`——错误事件

**关键区别**：流式过程挂在 invoke 上（不是 entry 上）——entries 表只承载「要进入聊天室的内容」，流式过程只留在 invoke 侧作为某次调用的细节过程记录。speak 在 invoke_events 中也是一条 event（event_type='speak'），与 assistant_text/tool_call 并列。

**4. entry_attachments 表（取代 message_attachments）**

```sql
CREATE TABLE entry_attachments (
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES attachments(id),
  sequence_num INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entry_id, attachment_id)
);

CREATE INDEX idx_entry_attachments_attachment ON entry_attachments(attachment_id);
```

**消费方**：多模态附件展示（不变，仅表名迁移）。

**5. turns 表**

保留不变——turn 是对话轮次的分组概念，与 entry/invoke 正交。

### 旧表映射关系

| 旧表 | 新表 | 映射 |
|------|------|------|
| messages | entries | sender_type/status/sequence_num/created_at/completed_at/source/metadata/sender_name/context_tokens 直接映射；talking_stone_passed_to → invokes.talking_stone_passed_to；turn_id 保留 |
| message_segments | entries.body | segments 合并为单条 body（speak 条目恒 1 条） |
| message_events | invoke_events | message_id → invoke_id；speak 也是一条 event（event_type='speak'），payload 含 entry_id 引用（指向 entries 表的 speak 条目） |
| message_attachments | entry_attachments | message_id → entry_id |
| dispatch_attempts | invokes | 历史参考（dispatch_attempts 已在 F20260908rlcp 中 drop 退役，本映射仅说明语义对应关系，非迁移路径） |

### invoke 生命周期

**invoke 与 hop 的对应关系**：每次 yield 触发一次新 invoke（一条链 = N 个 invoke，每个 invoke 对应一个 hop）。dispatch-chain-engine 的链式 dispatch 中，每个 hop 创建一个 invoke 记录。

**invoke 边界条目的 turn_id 归属**：invoke_start/invoke_end/yield 条目的 turn_id 归入触发 entry 所属的 turn（即 trigger_entry_id 指向的 entry 的 turn_id）。invoke 期间不维护独立 turn——turn 是对话轮次分组，invoke 是獭行动生命周期，两者正交。`tryCloseTurn` 的 getMessagesByTurnId 判据不受 invoke 边界条目影响（它们与 turn 内其他条目同属一个 turn，turn 关闭时机由最后一条终态条目决定）。

```
信号到达（事件 A/C）
  → invoke 记录创建（status=running, started_at=now）
  → 时间线插入 entry（type=invoke_start, body="🦦 xx獭开始行动～"）
  → LLM 运行期（speak 条目陆续创建，invoke_id 关联）
  → invoke 结束：
    - completed（yield）→ invoke 更新 tsp + status=completed → 时间线插入 entry（type=yield, yield_targets=[...]）+ entry（type=invoke_end, body="🦦 xx獭先休息一下～"）
    - failed → 时间线插入 entry（type=invoke_end, body="🦦 xx獭行动失败"）→ invoke status=failed
    - aborted → 时间线插入 entry（type=invoke_end, body="🦦 xx獭被中断"）→ invoke status=aborted
```

### 时间线条目类型与渲染

| entry_type | 数据源 | 渲染 |
|------------|--------|------|
| speak | entries 表（entry_type=speak） | 消息气泡（otter 侧，无流式过程嵌入） |
| user | entries 表（entry_type=user） | 消息气泡（user 侧） |
| invoke_start | entries 表（entry_type=invoke_start） | 居中特殊气泡（「🦦 xx獭开始行动～」） |
| invoke_end | entries 表（entry_type=invoke_end） | 居中特殊气泡（「🦦 xx獭先休息一下～」/「行动失败」/「被中断」） |
| yield | entries 表（entry_type=yield） | 居中特殊气泡（「→ 交给 xx」） |
| system | entries 表（entry_type=system） | 居中特殊气泡（同现有 system 消息） |

### 右侧栏獭状态面板

每只獭一个卡片：
- 状态：🟢 streaming（有活跃 invoke）/ ⚪ 休眠（无活跃 invoke）
- 当前 invoke 信息（streaming 时展示）：tool call 计数、耗时、token 用量
- 点击头像 → Session 弹窗

数据源：invokes 表（当前 invoke）+ entries 表（最近一条 speak entry 时间）。

### Session 弹窗

点击獭头像弹出，展示该獭的 invoke 列表（类似 Pi 自带的 session 历史记录）：
- 每条 invoke 一行：时间 + 状态 + 耗时 + tool call 计数
- 点击展开某次 invoke → 展示该 invoke 的全部 invoke_events（流式过程 + speak 调用 + 工具调用，按时间序）
- speak 在 invoke_events 中也是一条 event（event_type='speak'），与流式过程并列

数据源：invokes 表 + invoke_events 表（按 invoke_id 关联）。

### 首 message 空壳消灭

speak 拆分的「首 message」概念彻底移除：
- invoke 开始时不再调用 `sendMessage.start()`——改为创建 invoke 记录 + invoke_start entry
- speak 工具创建独立 entry（entry_type=speak，invoke_id 关联，无 tsp）
- yield 时更新 invoke 记录的 tsp + status=completed，创建 yield entry + invoke_end entry
- fail/abort 时更新 invoke 记录 status + ended_at，创建 invoke_end entry

### SSE 事件适配

**SSE 事件完整映射**（新增 + 适配 + 保留）：

| 旧事件 | 新事件 | 说明 |
|--------|--------|------|
| message.start | entry.start | speak entry 创建时广播 |
| speak.intermediate | entry.speak | speak entry body 落库信号 |
| message.complete | entry.complete | speak entry 完结时广播 |
| message.failed | entry.failed | entry 失败时广播 |
| message.retry | entry.retry | entry 重试时广播 |
| message.aborted | entry.aborted | entry 中止时广播 |
| system.message | entry.system | 系统条目创建时广播 |
| （新增） | invoke.start | invoke 创建（otterId, conversationId, invokeId, startedAt） |
| （新增） | invoke.end | invoke 结束（invokeId, status, endedAt, toolCallCount, tokenUsage） |
| （新增） | entry.yield | yield 条目创建（invokeId, targets） |

invoke_events 内的流式过程事件（assistant_text/tool_call/tool_result）不再广播 SSE——它们只在 Session 弹窗中展示，不进聊天室时间线。

### 前端变更

**中间栏（时间线）**：
- `TimelineEntry` 类型：`{ id, entryType, senderId?, body?, yieldTargets?, invokeId?, status, seq, ts, ... }`
- invoke 边界条目：居中渲染，无气泡，带图标+文字
- yield 条目：居中渲染，「→ 交给 xx」
- speak/user 条目：消息气泡（无流式过程嵌入，无 events 字段）

**右侧栏**：
- 獭卡片列表：头像 + 名字 + 状态指示器 + 当前 invoke 信息（streaming 时）
- 点击头像 → 打开 Session 弹窗

**Session 弹窗**：
- 全屏 modal，按时间序展示该獭的完整 session 记录
- 每条记录：时间戳 + 类型（流式/speak/工具调用）+ 内容
- 支持滚动加载（分页）

## 影响范围

- 数据模型（entries 表取代 messages + message_segments，invokes 表新建，invoke_events 取代 message_events）
- invoke 生命周期（全链路追踪）
- SSE 事件流（事件名适配 + invoke.start/end 新增）
- 前端渲染（中间栏时间线 + 右侧栏状态面板 + Session 弹窗）
- 信号路由（invoke 创建/结束的事件触发 + tsp 承载在 invoke 记录上）
- FTS 索引（messages_fts → entries_fts）
- 记忆索引（message_id → entry_id）
- 测试（全链路测试更新）

## 风险与约束

| 风险 | 缓解 |
|------|------|
| entries 表取代 messages 表影响面大（FTS/记忆/附件/信号路由全链路） | 逐一定位适配，先跑通核心链路再迁移外围 |
| invoke 表新增导致 migration 复杂 | 新建表（不改存量表结构），旧数据迁移后续单独做 |
| Session 弹窗数据量大（长 session 的 invoke_events） | 分页加载 + 按需展开 |
| yield 展示依赖 invoke 记录（completed 时 tsp 非空） | 确保 yield 时正确更新 invoke 记录 + 创建 yield entry |
| 历史消息兼容 | 旧 messages 表保留不删，新逻辑仅影响新 invoke |

## 不兼容更新

- [Incompatible] entries 表新建（migration）
- [Incompatible] invokes 表新建（migration）
- [Incompatible] invoke_events 表新建（migration）
- [Incompatible] entry_attachments 表新建（migration）
- [Incompatible] messages/message_segments/message_events/message_attachments 表退役（旧数据保留，新写入走新表）
- [Incompatible] 首 message 不再创建（sendMessage.start 在 invoke 开始时不再调用）
- [Incompatible] SSE 事件名适配（message.start → entry.start 等）
- [Incompatible] 前端 LocalMessage 类型废弃，改用 TimelineEntry

## 设计取舍

| # | 取舍 | 决策 | 替代方案 | 理由 |
|---|------|------|---------|------|
| D1 | invoke 实体化 | 新建 invokes 表 | 从 entries 表派生（无独立表） | invoke 有独立生命周期（start/end/状态/token 统计），派生查询复杂且不可靠 |
| D2 | entries 表统一 | 单表承载所有条目类型 | 分表（speak_entries/yield_entries/...） | 时间线需要统一排序（sequence_num），分表排序复杂；条目类型差异通过 entry_type + 可选字段承载 |
| D3 | 首 message 空壳 | 消灭（invoke 记录承载 tsp） | UI 层过滤不渲染 | 空壳是数据模型缺陷，UI 过滤是补丁；消灭后数据模型更干净。speak 和 yield 是并行工具，tsp 属于 invoke 不属于 speak entry |
| D4 | yield 展示 | 独立 yield entry | 从 invoke 记录派生（无独立 entry） | yield 有时间戳，需要时间线条目占位；从 invoke 派生会丢失 yield 的独立时间戳 |
| D5 | 流式过程展示 | Session 弹窗（从气泡内挪出） | 保留在气泡内 | 气泡内嵌流式过程导致气泡臃肿；弹窗按需查看更干净 |
| D6 | 右侧栏数据源 | invokes 表 + entries 表 | 新增独立 otter_status 表 | invokes 表已有状态和统计，无需额外投影表 |
| D7 | 旧数据迁移 | 先设计新模型，旧数据映射迁移后续单独做 | 本方案一并迁移 | 搭档明确「不要担心兼容性，先设计好新版数据模型」；旧数据迁移是独立工作量 |

## 机制预算四问

**invoke 实体（新建表）**：
① 谁需要——右侧栏状态面板（实时状态）、Session 弹窗（invoke 关联记录）、时间线（边界条目）
② 失败后果——invoke 状态不准 → 右侧栏显示错误状态（用户可感知）
③ 后续机制——invoke 状态迁移（running→completed/failed/aborted）、token 统计、tool call 计数
④ 退役条件——invoke 概念被更高层抽象取代（如 URGENT 树化的 branch 实体）

**entries 表统一（取代 messages + message_segments）**：
① 谁需要——时间线（统一排序）、前端渲染（统一类型分发）、FTS/记忆索引（统一入口）
② 失败后果——条目类型混淆 → 渲染错误（用户可感知）
③ 后续机制——条目类型扩展（新类型加入 CHECK 约束）、排序规则
④ 退役条件——展示层整体重做（如 VR/AR 界面）

## 验证

| 编号 | 场景 | 预期 |
|------|------|------|
| AT-1 | 单 speak + yield | 时间线：invoke_start → speak 气泡 → yield 条目 → invoke_end |
| AT-2 | 多 speak + yield | 时间线：invoke_start → speak A → speak B → yield → invoke_end |
| AT-3 | 忙时插话 | 时间线：speak A → 用户条目 → speak B 按时间序平铺 |
| AT-4 | fail | 时间线：invoke_start → speak A → invoke_end(failed) |
| AT-5 | abort | 时间线：invoke_start → speak A → invoke_end(aborted) |
| AT-6 | 右侧栏状态 | 獭 streaming 时显示 tool call 计数 + 耗时；休眠时显示「休眠中」 |
| AT-7 | Session 弹窗 | 点击獭头像弹出 invoke 列表，点击展开某次 invoke 展示全部 invoke_events（流式 + speak + 工具调用） |
| AT-8 | 历史兼容 | 旧 messages 表数据原样可读（不迁移），新逻辑仅影响新 invoke |
| AT-9 | 首 message 不再创建 | invoke 开始时不创建空壳 entry，invoke_start entry 直接承载 |
| AT-10 | FTS 索引 | entries 表 body 进 FTS，搜索正常 |

## 改动范围（预估）

| 文件 | 操作 |
|------|------|
| src/entities/conversation/invoke.ts | 新建（Invoke 实体） |
| src/entities/conversation/entry.ts | 新建（Entry 实体，取代 Message） |
| src/frameworks/db/schema.ts | entries + invokes + invoke_events + entry_attachments 表 |
| src/frameworks/db/migration.ts | 新表创建 + 旧表保留 |
| src/frameworks/db/conversation/sqlite-entry-repository.ts | 新建（取代 sqlite-conversation-repository 的消息部分） |
| src/frameworks/db/conversation/sqlite-invoke-event-repository.ts | 新建（取代 message_events 部分） |
| src/usecases/conversation/send-message.ts | 重写（sendMessage → sendEntry，首 message 消灭） |
| src/interface-adapters/agent-runtime/agent-invoker.ts | invoke 创建/结束 + SSE 事件适配 |
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | speak/yield 适配（invoke_id + tsp 承载在 invoke） |
| src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts | invoke 生命周期管理 |
| src/interface-adapters/http/dto/message-dto.ts | 重写（MessageDTO → EntryDTO） |
| web/src/lib/mappers.ts | LocalMessage → TimelineEntry |
| web/src/pages/conversation/index.tsx | 时间线渲染 + SSE 事件适配 |
| web/src/pages/conversation/MessageList.tsx | 时间线条目渲染（speak/invoke 边界/yield/系统） |
| web/src/pages/conversation/RightPanel.tsx | 獭状态面板重写 |
| web/src/pages/conversation/SessionModal.tsx | 新建（Session 弹窗） |
| tests/ | 全链路测试更新 |

## 彻底切换施工记录（2026-09-11）

结构性迁移说明（BYPASS_HISTORICAL_DOC_LINT 触发的记录）：

- 依赖旧 messages UI 路径的测试文件已删除或重写；其中
  `tests/interface-adapters/agent-invoker-guard-bounce.test.ts`（F20260902gbnc 的 capability_test 指向）
  按 invoke 状态机语义重写（GB-1~GB-5 能力断言保持，mock 面从 SendMessage 切到 SendEntry）。
- 熔断/重试族新增 `tests/interface-adapters/agent-invoker-circuit-retry.test.ts`（invoke 状态机语义）。
- 历史文档 F20260902gbnc 保持原样不改（快照原则）；capability_test 指针经重写后继续有效。
