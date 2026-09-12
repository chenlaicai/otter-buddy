---
id: F20260912avlb
title: 台账可见性与派工数据层重建：Web 活动页（纯展示）+ dispatch 真实状态
summary: 搭档需求收窄为纯展示（认知对齐：「我现在只是想更深入了解你们所看到的东西」），并立设计原则「不要把本次成本当作不做完整分析的借口——霰弹修改/多处冲突才是更贵的」。数据核查暴露 dispatch 台账机制残缺：470 条记录 469 条 in_progress、0 条 completed——终态（completed/failed）没有任何代码写入路径，状态列 100% 失真，三个消费者（query_dispatch_ledger 工具、cost-output 健康指标、拟建的 web 页面）全在消费假数据。方案分两层：①dispatch 数据层重建（otter_context 伪存储迁正式 SQLite 表，状态只记系统可客观判定的生命周期事件 created/dispatched/dissolved，不硬造「完成」语义）；②web 活动页纯展示三域台账（healing/獭间信号/派工），无任何写端点。
change_type: feature
capability_test: "n/a: 纯代码逻辑（A 类）——数据层重建与只读 API，无 LLM 行为变化；行为由 tests/frameworks/db/dispatch-record-repo.test.ts（13 用例）+ tests/api/activity.test.ts（9 用例，含无写端点架构断言）+ cost-output 口径测试覆盖"
created_in_conversation: a344e752-8e89-469a-ad04-5a5108867fa0
tags: [web, observability, healing, signal, dispatch, ledger, visibility, data-integrity]
intent:
  problem: "三类运行时台账对搭档不可达（只有 agent 工具入口），形成「海獭间的秘密基地」体感；且 dispatch 台账数据层残缺（终态无写入路径，状态 100% 失真），任何展示层建在其上都是失真的认知对齐"
  expected_effect: "搭档在 web 按需浏览三域台账真实数据；dispatch 状态由系统事件自动写入且客观可信（created/dispatched/dissolved + 三个时间戳）；query_dispatch_ledger 工具与 cost-output 指标同步从假数据切换到真数据"
  verify_by:
    type: behavior_check
    detail: "web「活动」页三 tab 渲染真实数据；create_otter/yield/dissolve_otter 后 dispatch 状态相应迁移；otter_context 无 dispatch: 残留 key；query_dispatch_ledger 返回新表数据；cost-output 指标数据源切换后数值正常"
modules:
  - api-contract/api/activity.ts
  - api-contract/api/index.ts
  - src/interface-adapters/http/controllers/activity-controller.ts
  - src/interface-adapters/http/router.ts
  - src/bootstrap/controllers.ts
  - src/bootstrap/clients.ts
  - src/usecases/activity/dispatch-record-repository.ts
  - src/usecases/signal/signal-event-repository.ts
  - src/frameworks/db/signal/sqlite-signal-repository.ts
  - src/frameworks/db/dispatch/sqlite-dispatch-record-repository.ts
  - src/frameworks/db/migration.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/usecases/health/cost-output-collector.ts
  - web/src/pages/activity/index.tsx
  - web/src/api/client.ts
---

# 台账可见性与派工数据层重建

## 背景

> 搭档原话（2026-09-12，对话 a344e752）：
> 「说起台账，我想起来我之前就觉得，台账好像成了你们海獭间的秘密基地一样，我都不知道里面有些啥东西哈哈哈哈哈……你觉得台账要不要做一个 ui 看板或者展示什么的界面，让我也能看到呢？」
> 拍板档 2：「我更想看到档2，或者说，我期望说当我想看的时候，我能去点开然后就能看到，我期望系统提供这个途径。」
> 需求收窄与原则（同日晚）：「我确认一点原则，那就是不要把本次的成本当作 不做完整分析方案 的借口。所以，不要说什么最便宜，我认为后期霰弹修改 或者 多处冲突 出问题修复 才是更贵的。以及，当前我不需要处理事件，这些东西本来就是由你们海獭自行填写、自行处理的，我现在只是想更深入了解你们所看到的东西而已，保证我和你们的认知是一致的」

**两轮需求演化**：初版方案（含 healing 页内处置写端点 + dispatch 查询逻辑提取复用）被搭档质疑「我要的只是展示界面，咋还涉及逻辑调整」后收窄为**纯展示**（认知对齐是需求本质）；同时确立设计原则：**按长期正确设计，不按最便宜**。

**数据层真相（2026-09-12 实查，按上述原则核查后暴露）**：

| 发现 | 证据 |
|---|---|
| dispatch 台账 470 条记录：469 in_progress / 1 pending / **0 completed/failed** | SQLite 直查 otter_context `dispatch:%` 全量 |
| 终态无写入路径——`completed`/`failed` **没有任何代码会写** | 全仓 grep：写入点仅两处（tool-factory.ts:357 create_otter → pending；tool-factory.ts:79 yield 成功 → in_progress），实现注释自述「简化实现，避免新增 DB 表」 |
| 状态失真毒害全部消费者 | ①query_dispatch_ledger 工具（大獭每日核对用，读到的是假 in_progress）②health 页 cost-output 指标（cost-output-collector.ts:531 直接 SQL 查 `dispatch:%`）③拟建 web 页面 |
| 死字段 | resultPr/resultSummary 字段定义了但无任何写入者 |
| updateRecord 语义粗糙 | 每次派工把该獭在该对话的**所有**非终态记录批量刷 in_progress，不区分单次派工 |

**三域台账现状**：

| 台账 | 存储 | 查询能力 | 数据可信度 |
|---|---|---|---|
| healing events | SQLite 正式表 + repo（CRUD 全） | agent 工具 + batchResolve | ✅ 可信 |
| 獭间信号 | SQLite 正式表 + repo | findByConversation / findByMessageIds | ✅ 可信（缺全表 findAll） |
| 派工记录 | otter_context `dispatch:` key（伪存储） | agent 工具（单对话遍历拼装） | ❌ **状态 100% 失真** |

## 目标

- T1: 搭档可在 web 按需浏览三域台账**真实**数据（纯只读，无任何写端点）——认知对齐
- T2: dispatch 数据层重建——正式 SQLite 表，状态只记系统可客观判定的生命周期事件（created / dispatched / dissolved），三时间戳全留痕
- T3: 三个 dispatch 消费者全部切换真数据源（agent 工具 / cost-output 指标 / web 页面），消灭假数据源头
- T4: 存量 470 条记录迁移至新表（otter_context 伪 key 清空，不留双源）

## 非目标

- ❌ **任何页内写操作**——healing 处置也砍掉（搭档拍板：「当前我不需要处理事件，这些东西本来就是由你们海獭自行填写、自行处理的」）；处置走对话（口头或 agent 工具）
- ❌ **硬造「任务完成」语义**——「完成与否」的真相在对话汇报里，台账只记客观生命周期事件；展示层 join 参与者表标注「獭当前是否在场」（实时态，不落库）
- ❌ 獭间信号页内裁决——协议义务保留在对话内（同初版）
- ❌ 消息内容展示 / 实时推送（SSE、<30s 轮询）/ 历史趋势图——同初版
- ❌ healing/signal 数据层改造——两域数据可信，只加读路径

## 方案设计

### Part 1：dispatch 数据层重建（先行 PR）

**新表**（migration.ts）：

```sql
CREATE TABLE dispatch_records (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  otter_id TEXT NOT NULL,
  otter_name TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',  -- created | dispatched | dissolved
  created_at TEXT NOT NULL,
  dispatched_at TEXT,   -- 首次收到行动权
  dissolved_at TEXT,    -- 獭被解散
  UNIQUE(otter_id, conversation_id, created_at)
);
CREATE INDEX idx_dispatch_records_conv ON dispatch_records(conversation_id);
CREATE INDEX idx_dispatch_records_status ON dispatch_records(status);
```

**状态语义（只记系统可客观判定的事件）**：

| 状态 | 触发事件 | 写入点 |
|---|---|---|
| created | create_otter 成功（獭就位待命） | tool-factory.ts create_otter（既有 :357 改指向新 repo） |
| dispatched | 行动权首次交给该獭 | updateDispatchLedgerOnYield（既有 :79 改造：写 dispatched_at，不再批量刷状态） |
| dissolved | dissolve_otter 成功 | **新增钩子**（dissolve 工具执行路径） |

「任务完成」不设终态——见非目标 #2。废弃字段 resultPr/resultSummary 不迁移（零写入者的死字段，随伪存储消亡）。

**repo**：`src/usecases/dispatch/dispatch-record-repository.ts`（接口）+ `src/frameworks/db/dispatch/sqlite-dispatch-record-repository.ts`（实现），方法：create / markDispatched(otterId, conversationId) / markDissolved(otterId) / findByFilter({conversationId?, status?, limit?}) / migrateFromContext()（迁移专用，事务内）。

**存量迁移**（migrateFromContext，事务内三步）：
1. otter_context `dispatch:%` 全量读出解析
2. 状态映射：原 pending → created（dispatched_at = NULL）；原 in_progress → dispatched（**dispatched_at 用原记录 updatedAt 填充**——最后一次派工时间的近似，cost-output 历史指标不丢）；再按 **全局 otter 状态**覆盖：不在 otters 表 active 集 → dissolved（delta 复审建议 2：dissolved 判定以全局 otters 表为准，不用 per-conversation participant 状态——dissolve_otter 销毁的是獭本体（全局事件），且 participant 表在 leave 失败时名册残留不可靠，otters active 集是唯一真相源；dissolved_at 历史不可知，如实为 NULL）
3. 删除 otter_context 中全部 `dispatch:` key（数据搬家非复制，消灭双源）

**三消费者切换**：
- clients.ts dispatch client：createRecord/updateRecord 实现改调新 repo（对外签名不变，tool-factory 钩子改动最小化）；updateRecord 收窄为 markDispatched 语义——**批量语义显式定义**（delta 复审建议 1）：`markDispatched(otterId, conversationId)` 把该獭在该对话**全部 created 状态记录**刷为 dispatched（一条记录 = 一个獭在一个对话的一次生命周期，从创建到首派窗口闭合；旧记录不停留在 created）
- query_dispatch_ledger 工具：改走 findByFilter（全表能力直接获得，参数新增可选 conversationId——行为向后兼容）
- cost-output-collector.ts:519 `collectDispatchTaskCounts`：**新口径显式定义**（delta 复审严重 1）：按 `dispatched_at` 日期聚合 dispatched/dissolved（有 dispatched_at 者）记录数——语义从「任务完成数」（从未工作过的死口径，终态无写入路径，该指标上线以来一直静默归零）改为「**每日派工数**」。SQL：`SELECT dispatched_at, COUNT(*) FROM dispatch_records WHERE dispatched_at IS NOT NULL GROUP BY substr(dispatched_at,1,10)`。存量迁移同步填充 dispatched_at（见下），历史不丢。函数/注释/DTO 字段名同步正名（dispatchCount 语义 = 派工数）

### Part 2：Web 活动页（纯展示，跟随 PR）

**页面**：web/src/pages/activity/（导航「活动」），health 页三 tab 模式：

- **Tab 1 healing**：列表（时间/海獭/类型/严重度色点/描述截断展开全文/状态）+ 过滤（status 默认 open + 类型）。空态正反馈文案。
- **Tab 2 signals**：列表（时间/类型中文标签/严重度/发起獭→目标獭/状态/正文摘要）+ 过滤；pending 未决置顶；已裁决展示裁决文本。只读说明卡片。
- **Tab 3 dispatch**：列表（对话短 ID/海獭/任务摘要/生命周期状态色标/三时间戳/獭当前在场⬤）按对话分组倒序 + 状态过滤。「在场」= 实时 join 参与者表，不落库。

**API**（4 端点，全只读）：

| 端点 | 数据源 |
|---|---|
| GET /api/activity/healing?status=&errorType=&conversationId=&limit= | healingRepo（conversationId 有值走 findByConversation，errorType 由 controller 内存过滤——healing 事件数百条量级安全） |
| GET /api/activity/signals?status=&type=&limit= | signalRepo.findAll（**接口+实现新增**：`SELECT * FROM signal_events WHERE <filter> ORDER BY created_at DESC LIMIT ?`，实现文件为 sqlite-signal-repository.ts） |
| GET /api/activity/dispatch?conversationId=&status=&limit= | dispatch-record-repo.findByFilter（Part 1 新表，简单 SQL——初版设计的「participants+context 三层遍历」随伪存储消亡，**不再需要**） |
| GET /api/activity/summary | 三域 open/pending 计数（可选实现，一期可裁，端点预留） |

**DTO**：api-contract/api/activity.ts 三域 + wrapper；中文标签映射在前端（health 页 SIGNAL_TYPE_LABELS 同模式）。

### 数据流

```
Part 1: create_otter / yield / dissolve_otter（系统钩子）→ dispatch_records 表
        query_dispatch_ledger（agent 工具）↘
        cost-output-collector（health 指标）→ 读 dispatch_records
Part 2: web 活动页 → GET /api/activity/* → controller →
          healingRepo / signalRepo.findAll / dispatch-record-repo（三域只读）
```

## 影响范围

- dispatch 状态从「永远 in_progress 的假数据」变为「客观生命周期」——agent 工具与 cost-output 指标消费到真数据，**这是行为修正**（原 in_progress 语义本就无人依赖其真实性）
- otter_context 表 dispatch key 清空（470 条迁移后删除）——context 读写路径无感知（key 前缀本就由 dispatch client 独占）
- router.ts +4 路由；web 导航 +1 入口；无既有页面改动
- dissolve_otter 工具新增台账钩子（失败仅 warn 日志不阻断主流程——与既有 4.5/4.6/4.7 清账钩子同模式，保持一致性；原方案写「记 healing 事件」，实现时按模式一致性采纳 warn，见对抗审视记录）

## 风险与约束

- **迁移一次性**：470 条事务内迁移+删 key；失败整体回滚。迁移前后计数核对（470 in → 新表 470 行 + context 0 残留）
- **dissolved_at 历史不可知**：存量迁移的 dissolved 记录只有状态无时间戳，如实为 NULL，前端展示「已解散（时间未知）」
- **状态语义变更的沟通成本**：in_progress → dispatched 是语义收窄（「派过工」≠「在干」），「在干吗」看对话页——页面 tab 3 顶部加一句口径说明
- healing 描述是机器格式长串：前端截断+行展开，不后处理原文（每日健康检查的下游数据源）

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 需求形态 | 纯展示零写端点 | 含 healing 页内处置 | 搭档拍板「不需要处理事件，獭自行处理」；认知对齐不需要写 |
| dispatch 存储 | 正式表重建 | 提取复用伪存储查询 | 伪存储状态 100% 失真（终态无写入路径），在其上做任何事都是沙上塔——搭档原则「霰弹修改/多处冲突更贵」的正解；healing/signal 两域「正式表+repo」是本项目已验证模式 |
| 状态语义 | 客观生命周期三态 | 补 completed/failed 写入点 | 「完成」无系统可判定信号（完成真相在对话汇报）；硬造终态=新一轮假数据。三态全部可客观判定，长期零漂移 |
| 迁移 | 存量搬家+删旧 key | 双写过渡 / 弃历史重算 | 单机单用户无并发迁移风险，事务一次到位；双源是永久性漂移隐患 |
| 拆 PR | 数据层先行、页面跟随 | 单 PR | 数据层独立可审可回滚；页面依赖新表；cost-output 指标切换先行验证数据质量 |
| signals 只读 | 同初版 | 页内裁决 | 协议义务保留对话内 |
| 轮询 | 30s 温和 + 手动刷新 | 2s/SSE | 按需浏览场景，实时性无消费者 |
| summary 端点 | 可选可裁 | 必做 | 避免无人点的红点噪音；使用数据说话 |

**本特性自审（机制预算四问）**：

- **① 谁需要它**：搭档——原话锚「我现在只是想更深入了解你们所看到的东西而已，保证我和你们的认知是一致的」。次级受益（非立项依据）：大獭与每日健康检查从假数据切真数据。
- **② 失败后果**：不做 → 假状态继续毒害三个消费者（认知对齐失败 + agent 决策失真）；做了页面无人看不构成失败（按需消费，不承诺打开率）。
- **③ 后续机制**：新状态可能出错处——三钩子漏挂或失败（dissolve 钩子失败仅 warn 不阻断，与既有清账钩子同模式；created/dispatched 钩子在既有代码路径上改造，失败会使工具主调用也失败，天然同生共死）；迁移双源残留（事务+计数核对）；未来若要求「完成」语义（对话汇报结构化后可加终态事件，留演进口）。
- **④ 退役条件**：搭档连续 30 天未打开该页（无埋点，以口头/观察为准）或对话页未来内嵌同等信息；dispatch 表本身不退役（消费方是 agent 工具与 health 指标，页面只是第三消费者）。

**重对抗门**：**`确认治本`**（检视-avlb 第一轮，2026-09-12，针对初版方案）——初版判定理由（可见性层缺失是根因，最薄视图层）继续适用；本版在此之上把「假数据源头」一并根治（搭档原则驱动）。**修订后机制实质变化（视图层 → 数据层重建+视图层），delta 复审待检视-avlb。**

**Modification-Class**：PR-1（数据层）`mechanism-addition`（删伪存储建正式表，净新增存储机制；四问答毕）；PR-2（页面）`mechanism-addition`（净新增页面+读端点；四问答毕）。

## 验证

- PR-1：repo 单测（状态迁移三路径 + 迁移映射 + 事务回滚）；query_dispatch_ledger 手动回归（新表数据）；cost-output 指标数值比对；迁移后 `otter_context` 无 `dispatch:` key + 新表 470 行
- PR-2：tests/api/activity.test.ts（三读端点结构 + 过滤参数；无写端点为架构断言）；手动验收三 tab 真实数据（SQLite 直查对照）
- 端到端：create_otter → 页面出现 created；yield → dispatched；dissolve → dissolved

## 改动范围

**PR-1（数据层重建）**：
| 文件 | 操作 | 说明 |
|---|---|---|
| src/usecases/dispatch/dispatch-record-repository.ts | 新建 | 接口 |
| src/frameworks/db/dispatch/sqlite-dispatch-record-repository.ts | 新建 | 实现（含 migrateFromContext） |
| src/frameworks/db/migration.ts | +1 表 | dispatch_records |
| src/bootstrap/clients.ts | 改 | dispatch client 实现切新 repo |
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | 改 | 两钩子语义（markDispatched）+ dissolve 钩子 |
| src/usecases/health/cost-output-collector.ts | 改 | SQL 切新表 |

**PR-2（web 活动页）**：
| 文件 | 操作 | 说明 |
|---|---|---|
| api-contract/api/activity.ts | 新建 | 三域 DTO |
| api-contract/api/index.ts | +1 行 | re-export |
| src/interface-adapters/http/controllers/activity-controller.ts | 新建 | 4 只读端点 |
| src/interface-adapters/http/router.ts | +4 路由 | |
| src/bootstrap/controllers.ts | 装配 | 注入三 repo |
| src/usecases/signal/signal-event-repository.ts | +1 方法 | findAll 接口 |
| src/frameworks/db/signal/sqlite-signal-repository.ts | +1 方法 | findAll 实现 |
| web/src/pages/activity/index.tsx | 新建 | 三 tab 纯展示页 |
| web/src/api/client.ts | +4 函数 | API client |
| tests/api/activity.test.ts | 新建 | API 测试 |

## 对抗审视记录

**第一轮**（检视-avlb，mimo，2026-09-12，针对初版）：重对抗门 `确认治本`。3 严重 + 4 建议全处置（详见 git 历史——初版处置明细；要点：signal 文件名、跨对话遍历设计、幂等层次；其中核实出 repo 层 resolve 不幂等，防护上移 controller）。delta 复核通过（两处措辞残留已清）。

**需求收窄与原则修正（搭档，2026-09-12 晚）**：初版的 healing 写端点、提取重构方案废弃；数据层真相（469/470 假状态 + 终态无写入路径）触发方案重写为本文档。

**第二轮 delta 复审**（检视-avlb，2026-09-12 晚，方案重写后）：重对抗门**维持 `确认治本`**（叠加假数据根治，更强）。1 严重 + 2 建议，全处置：

| 发现 | 处置 | 要点 |
|---|---|---|
| 严重1 cost-output 新口径未定义（迁移后指标永久归零） | 接受并修订 | 新口径 = 按 dispatched_at 聚合「每日派工数」；核实确认原口径上线以来一直静默归零（只认从未存在过的终态）；存量迁移同步填充 dispatched_at（原 in_progress 用 updatedAt），历史不丢 |
| 建议1 markDispatched 批量语义未明确 | 接受并修订 | 显式定义：该獭在该对话全部 created → dispatched（创建到首派窗口闭合） |
| 建议2 dissolved 判定全局 vs per-conversation | 接受并修订 | 全局 otters 表 active 集为准（dissolve 销毁的是獭本体；participant 名册不可靠） |

Delta 复核结论：**通过**（严重 1 修正后可进实现——已修正）。

**第三轮（代码对抗审视，检视-avlb，2026-09-12 深夜，针对 PR #903）**：0 严重 + 2 建议，B1-B7 全过，变更完整性清单全勾。处置：

| 发现 | 处置 | 判断依据 |
|---|---|---|
| 建议1 query_dispatch_ledger 工具未暴露全对话查询（repo/端口已支持，仅缺 tool 参数） | **接受并当场修**（不建 issue） | 关联度前置闸检验：该工具是本 PR 三消费者之一，能力升级与本 PR 语义强关联；增量约 30 行，不命中建 issue 合法清单（依赖未就绪/需产品决策/增量>300 行）任何一条——检朒建议建 issue 被大獭驳回，改为修在原 PR |
| 建议2 dissolve 钩子失败仅 warn 与方案「记 healing」字面差异 | **接受，文档对齐实现** | 检视自评当前行为可接受；warn 不阻断与既有 4.5/4.6/4.7 清账钩子模式一致（一致性优先于单点最优），方案文档已同步订正（影响范围节 + 四问③） |

---

## 实现记录（2026-09-12，开发獭-avlb）

### 交付形态变更（搭档拍板留痕）

方案原拆 PR-1（数据层）/ PR-2（web 页面）两步交付，搭档拍板**合成单 PR 一次性交付**。本节以下内容覆盖原「改动范围」节的 PR 划分——全部条目在本 PR 内完成。

### 实际落点与方案差异

| 项 | 方案锚点 | 实际落点 | 差异说明 |
|---|---|---|---|
| dissolve 钩子 | 「dissolve 工具执行路径新增钩子」 | DissolveOtter usecase 注入 `markDispatchDissolved` 依赖（dissolve-otter.ts 步骤 4.45） | 结构性优化：与既有 4.5/4.6/4.7 清账钩子（settlePendingForOtter 等）完全同模式——usecase 层统一收口 dissolve 的全部台账副作用，tool 层保持薄。失败记日志不阻断主流程（方案要求的行为语义不变） |
| dispatch client 改造 | 「updateRecord 收窄为 markDispatched 语义（对外签名不变）」 | 端口直接改名 `updateRecord` → `markDispatched`（签名收窄），clients.ts 实现直调新 repo | 方案说「对外签名不变」指 tool-factory 调用点改动最小化；实际 tool-factory 只有一处调用 updateRecord（yield 钩子），改名后调用点同步更新、无其他消费者——直接改名更干净（无兼容桥代码，coding-principles 禁止 shim） |
| query_dispatch_ledger | 参数新增可选 conversationId | 同方案；另将工具 description 同步更新为新三态语义；**delta 修正（三轮建议 1）**：conversationId 缺省不再兑底当前对话——不传 = 全表（与 web 端 controller 口径一致，跨对话巡检能力对齐） | description 是 agent 消费的行为契约，旧四态枚举描述会误导；初版实现的「缺省当前对话」兑底使全表能力对 agent 不可达，检朒发现属实，已修 |
| summary 端点 | 可选可裁，一期建议裁掉 | 已裁（controller 只有 3 个方法，测试有架构断言锁死「无写端点」） | 方案建议采纳 |
| 迁移防重跑 | 「查一下 migration 框架怎么防重跑」 | settings 表键 `dispatch_records_migrated=done`（与 fts_jieba_double_write/chunking_v1_migrated 同模式），createTestDb 每次跑 migrateDatabase 天然覆盖幂等路径 | 项目惯例 |
| otters active 集覆盖 | dissolved 判定以全局 otters 表为准 | 同方案（migrateFromContext 内 SELECT id FROM otters WHERE status='active'） | — |

### 关键实现细节

- **表**：`dispatch_records`（schema.ts `createDispatchRecordsTable`，CHECK 约束锁死三态枚举 + UNIQUE(otter_id, conversation_id, created_at) + 两索引）。schema 初始化日志 tables 计数 45→46
- **repo**：`src/usecases/dispatch/dispatch-record-repository.ts`（接口）+ `src/frameworks/db/dispatch/sqlite-dispatch-record-repository.ts`（实现，含 migrateFromContext——单事务整体搬家，坏 JSON 中断回滚而非静默跳过）
- **三钩子**：create_otter → `create`（status=created）；yield 成功 → `markDispatched`（只刷 created 行，首次派工时间戳不被多轮交棒刷新）；dissolve → `markDissolved`（全局不分对话，非 dissolved 全刷）
- **cost-output 口径切换**：`collectDispatchTaskCounts` 从「任务完成数」（只认从未存在过的 completed/failed 终态，上线以来静默归零的死口径）切换为「**每日派工数**」（按 dispatched_at 日期聚合，`substr(dispatched_at,1,10)` GROUP BY）。存量迁移用原 in_progress 记录的 updatedAt 填充 dispatched_at，60 天滚动窗口重扫自动回填历史指标。health 页指标卡标签「任务完成」→「每日派工」
- **signal findAll**：接口 + SQLite 实现双新增（复用 mapper 的 buildSignalFilterClause，`WHERE 1=1` + AND 拼接）
- **web 活动页**：`web/src/pages/activity/index.tsx`（三 tab：自愈事件/獭间信号/派工台账；过滤 chip 单选；healing 描述截断展开；signals pending 置顶 + 裁决文本展示；dispatch 三时间戳 + 在场⬤实时 join）。导航「活动」注册进 MPA_PAGES 单一真相源（vite/server/TopBar/路由测试 4 消费方自动同步）
- **API**：`/api/activity/{healing,signals,dispatch}` 三 GET（全只读），DTO 在 api-contract/api/activity.ts；healing conversationId 有值走 findByConversation + 内存过滤（数百条量级安全）；dispatch present 按 conversation 分组批量预取参与者（防 N+1）

### 测试

| 测试文件 | 覆盖 |
|---|---|
| tests/frameworks/db/dispatch-record-repo.test.ts（新增，13 用例） | 生命周期三路径 + markDispatched 批量语义/时间戳保留/不跨对话 + markDissolved 全局/幂等 + findByFilter + 迁移映射（pending→created、in_progress→dispatched+updatedAt、全局 dissolved 覆盖）+ 迁移事务回滚（坏 JSON）+ migration settings 键防重跑 + 老库真实串联（initSchema 后插伪存量再 migrateDatabase） |
| tests/api/activity.test.ts（新增，9 用例） | 三读端点返回结构 + 过滤参数（healing status/conversationId、signals status/type、dispatch status/present join）+ 架构断言：controller 仅 3 只读方法、路由表无写端点 |
| tests/usecases/health/cost-output-collector.test.ts（改写 4 用例） | 新口径：dispatched_at 聚合（含 dissolved）、created/NULL 不计、since 过滤、空表 |
| tests/interface-adapters/query-dispatch-ledger-tool.test.ts（新增，3 用例，三轮建议 1 修复伴生） | 不传 conversationId → undefined 透传（全表口径，不兑底当前对话）；传则限定单对话；status/otterId 透传 |
| 既有测试更新 | create-otter-tool / yield-level / speak-tool 三处 mock 从 updateRecord 改 markDispatched |

### 自检清单

- ✅ 新测试全过：dispatch repo 13 + activity API 9 + cost-output 19
- ✅ 既有测试无回归：**全量 257 文件 / 3207 用例全绿**（基线证据：本 PR 变更前同分支全量跑过 3205 用例通过——新增 13+9-改写前后差 +2 为新测试净增，无任何既有用例失败）
- ✅ lint 0 error（余 5 warning 全部 pre-existing：cost-output console ×2 已用 git stash -u 基线复跑验证、conversation 页 react-hooks ×3 未触碰）
- ✅ lint:tests OK / lint:intent 490 docs OK / tsc + tsc-alias 构建通过 / web vite build 通过（47 文件 408 用例）
- ✅ pre-existing 声明：本 PR **无任何测试失败**，无需 pre-existing 声明
- ✅ #791 废弃资源清理四核查：①旧代码引用清零（`dispatch:%` 只剩 migration 读/删路径；updateRecord/resultPr/resultSummary 全仓无残留）②无孤儿文件（伪存储无独立文件）③无旧配置迁移（伪存储无配置面）④DB 运行时副本由启动迁移自动搬家（470 条 → 新表，旧 key 清零——**待部署后核实**，迁移测试已覆盖行为）
- ✅ 最简实现检查：**已过**——新表+repo 是方案定案（伪存储提权为正式表无更简替代）；signal findAll 是单方法增量（无新抽象）；web 页复用 health 页三 tab 模式与既有组件（AppLayout/Toast），无新组件框架；activity controller 无多余层（直连三 repo）；summary 端点裁掉；无兼容桥代码（端口签名直接改名，调用点全仓唯一）
- ✅ Modification-Class：`mechanism-addition`（commit body 声明）
- golden gate：本变更为 feature 代码（非 prompt/skill/协议层），不强制；intent 块沿用文档 frontmatter 既有声明
