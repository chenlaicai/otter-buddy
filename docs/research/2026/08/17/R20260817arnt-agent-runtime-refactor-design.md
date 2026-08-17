---
id: R20260817arnt
title: agent-runtime-refactor-design
doc_type: research

summary: |
  批次 3（issue #282）设计文档 v2（经两轮对抗审视修订）：AgentInvoker 编排逻辑
  上提为 usecase 层 AgentTurnOrchestrator（含 abort 面、attemptDriver 执行回调、
  领域事件去 SSE 化），tool-factory 规则下沉，port 收拢（含 OtterToolClient 整体
  上移），MemoryRepository 三分。七个 PR 切分（A/B/C/D1/D2/E/F），C 为最高风险
  分两段实施。含待拍板决策 D1-D11。

causal_links:
  from:
    - F20260814qswp
    - F20260817mrp2
    - F20260817bcst

status: locked
change_type: refactor
tags: [agent, architecture, port, refactor]
modules:
  - src/interface-adapters/agent-runtime/
  - src/frameworks/agent/pi-session-factory.ts
  - src/usecases/
capability_test: "n/a: 设计文档（实施 PR 各自声明）"
created_in_conversation: quality-sweep-batch3-design
---

# R20260817arnt: agent runtime 拆解 + port 体系统一（批次 3 设计 v2）

## 0. 文档状态

**locked（2026-08-17 用户拍板）**。v1 经两轮对抗检视（架构视角 + 可实施性视角）被打回，
v2 全部吸收（审视记录见 §6）。拍板结果：D1-D11 全部按推荐通过（D8 metrics 跟
orchestrator、D9 领域事件 TurnEvent、D11 K1 记已知问题批后单独修、其余见 §3）。
实施 PR-A 起按 §2/Q7 切分执行。

## 1. 目标架构

```
entities/                     领域实体 + 不变量（不动）
usecases/
  conversation/
    agent-turn-orchestrator/  ★新：发言轮编排（原 AgentInvoker 的编排职责，~800 行）
      exit-classifier.ts        ExitReason 分类（状态+依赖注入函数，非纯函数）
      retry-policy.ts           重试决策（白名单/梯度介入，纯函数+配置）
      terminal-guard.ts         终态防护（Sets + 成功路径清理时序）
      turn-events.ts            领域事件类型 TurnEvent（去 SSE 化，见 D9）
      orchestrator.ts           状态机路由 + metrics 埋点（绑分类点，见 D8）
    talking-stone.ts          ★新：发言石路由校验（自 tool-factory 下沉，已验证零闭包耦合）
    dispatch-guard.ts         ★新：派工软守卫（状态挂 ToolContext，已验证可挂）
  ports/                      ★收拢服务型 port（gateway/repository 保持原位，全局后缀约定）
    agent-turn-port.ts          发言轮编排 port（含 abort 面）
    sdk-invoke-port.ts          SDK 级 invoke（自 interface-adapters 改名上移）
    agent-tools.ts              AgentTool/ToolContext 领域接口（ToolResponse 随迁）
    otter-tool-client.ts        ★整体上移（usecase 门面，含 TurnHistoryEntry 依赖链）
  memory/
    memory-reader.ts / memory-writer.ts / embedding-retry-queue.ts  ★三分（见 D7 勘误）
interface-adapters/agent-runtime/
  agent-invoker.ts            瘦身：SDK 调用 + TurnEvent↔SSE 映射 + attemptDriver 提供（~400 行）
  tools/tool-factory.ts       瘦身：工具 schema + LLM 文案 + 参数组装（~450 行）
frameworks/agent/
  pi-session-factory.ts       消费 agent-tools port（倒穿消除）；identity-builder/registry 拆出
```

**不变量**：反强编排原则——上提的是**既有行为策略**的搬家，不新增流程步骤；
attemptDriver 回调仅限"重执行当前轮"，接口注释显式声明防扩写成流程引擎。

## 2. 七个设计问题的回答（v2）

### Q1 编排逻辑落点、接口、终态防护归属

- 落点：`usecases/conversation/agent-turn-orchestrator/`（D1）。
- 接口（v2 关键修订——补 abort 面、执行回调、全字段、去 SSE）：

  ```ts
  interface AgentTurnPort {
    /** 执行一轮发言：分类退出、按策略重试、守护终态 */
    executeTurn(input: TurnInput, driver: AttemptDriver, callbacks: TurnCallbacks): Promise<TurnResult>;
    /** 用户中断：标记 user-abort（分类状态）+ 委托 driver.abort SDK 层。
     *  现状 controller.abort 直连 invoker 的两步动作，port 化后两步都归编排 */
    requestAbort(otterId: string, messageId?: string): void;
  }
  interface TurnInput {          // 字段对照现 invokeConversation 全量
    otterId: string; conversationId: string;
    userMessage: { id: string; body: string };
    talkingStonePassedTo?: string[];
    retryCount: number;          // 重试链开关（现 routeGuardAbort/handleSpeakRetry 判定它）
    manualRetry: boolean;
    timeoutMs?: number;          // scheduler 入口传入；行为保持现状（race 不取消，见已知问题 K1）
  }
  interface AttemptDriver {      // orchestrator 驱动 adapter 的执行面（仅限重执行当前轮）
    invoke(input: TurnInput, events: (e: TurnEvent) => void): Promise<AttemptResult>;
    abort(otterId: string, messageId?: string): Promise<void>;
    getInternalAbortReason(messageId: string): string | undefined;
  }
  interface TurnCallbacks {
    onEvent(conversationId: string, event: TurnEvent): void;   // 领域事件，SSE 映射留 adapter（D9）
    onTerminal(messageId: string, outcome: TerminalOutcome): Promise<void>;
  }
  ```
- 终态防护归 orchestrator（terminal-guard 含**成功路径的清理时序**——completeAgentInvocation
  的 delete、降级分支的 add，不是单纯 Set 管理器）。
- exit-classifier 定性修正：**状态+依赖注入函数**（依赖 userAbortedMessages 与
  getInternalAbortReason），测试面按此设计，不再声称纯函数。
- routeByReason 的递归重入（handleAutoRetry 回 invokeConversation）由 orchestrator
  内部循环 + driver.invoke 表达。

### Q2 tool-factory 领域规则下沉

检视确认下沉逻辑零闭包耦合，方案维持 v1：talking-stone.ts（纯函数）、dispatch-guard.ts
（状态挂 ToolContext，已验证接口可变字段支持）、访问控制与 fact 不变量归各自 usecase。
触发时机（check/confirm 的调用序列）留 tool-factory，规则内容下沉。

### Q3 pi-session-factory 倒穿消除（v2 补全四件套）

倒穿依赖共四件，v1 漏了 OtterToolClient 和 ToolResponse：
1. `AgentTool`/`ToolContext` → `usecases/ports/agent-tools.ts`
2. `truncateToolResult` + **其返回类型 `ToolResponse`**（连带定义）→ 随 agent-tools.ts
3. **`OtterToolClient` 整个文件（128 行）→ `usecases/ports/otter-tool-client.ts`**（它本身
   就是 usecase 门面，含 TurnHistoryEntry 依赖；消费方 bootstrap/clients、
   pi-session-factory、6 个测试文件随改）
4. ToolContext 的 `pendingRestart`/`getTurnAssistantText` 字段**保留原字段但接口注释
   声明其 SDK 会话协议语义**（frameworks 消费合法；换 SDK 时需修订 port，注释警示）
- 顺手拆分不变：identity-builder.ts、model-runtime-registry.ts，主文件目标 <600 行（D4）。

### Q4 port 统一（v2 改述）

- **改述**（检视指出"全收拢"名不符实）：ports/ 收拢**服务型 port**（agent-turn/sdk-invoke/
  agent-tools/agent-metrics/trace-context/logger/model-pool）+ **全局后缀约定**
  （gateway=外部系统、repository=持久化、port=本系统服务；gateway/repository 保持原位）。
- 双定义消除：interface-adapters 的 agent-invoke-port.ts 改名 sdk-invoke-port.ts 上移（PR-A）；
  usecases 侧旧 agent-invoke-port.ts 的**删除移到 PR-D1**（scheduler/recruiting 切换时一并，
  否则 PR-A 迫使 ~40 个测试 mock 站点立即改签名，不可独立回滚）。
- **防复发手段如实声明**：eslint 只能拦路径拦不住"再手写同形接口"（语义复制），双定义
  防复发靠 review checklist 显式条目（"新增接口前 grep 现有 port"），不暗示工具能防。
- 组合根钉死具体类（bootstrap/types.ts:34-46）→ PR-A 一并改为声明 port 接口。

### Q5 controller/scheduler 切 port；跨层重试声明（v2 修正论证）

- MessageController 的具体依赖 → AgentTurnPort；dispatchTurnLoop 内业务文案（链深度触顶
  策略）移入 orchestrator。controller 回归翻译层。
- SchedulerService 保持独立（D5 结论不变），但**"正交"论证修正**：调度与轮内编排分层
  正交，**重试语义三层叠加**是现状已知问题——scheduler once 重试(3) × invoker 重试(2) ×
  SDK maxRetries(5) 最坏 ≈30 次 LLM 调用，且 5min race 超时不取消底层 invoke（状态分裂
  风险）。记为已知问题 K1，**本批不改行为**，单独小 PR 修（timeout 语义需拍板，见 #282 后续）。

### Q6 MemoryRepository 三分（v2 按调用方实况修订）

- 三分维持，但如实记录：调用方多面引用是常态（store-memory 需 Writer+Queue+vec 可用性、
  search-memory 需 Reader+更新），分面收益是**接口可读性与实现可替换性**，不是按调用方切。
- D7 勘误：`disableVec` 本就不在接口（bootstrap 用结构化断言调用）；在接口里的是
  `hasVecTable/isVecEnabled`，消费方含 usecase（embedding-retry-worker 的 tick 守卫、
  search-memory 的 vecCoverage）——移出接口 = 给这两处注入 `vecEnabled: () => boolean`
  （构造签名变更），仍在 PR-E 内做。
- 裸 db 导出收敛：`@internal` 注释 + eslint 规则限制 import 方仅 sqlite-memory-repository。

### Q7 实施切分（v2 修订：D 拆两件、风险重估、工作量实评）

| PR | 内容 | 风险 | 实评工作量 | 依赖 |
|----|------|------|-----------|------|
| A | port 收拢（sdk-invoke-port 改名上移、agent-tools port、OtterToolClient 整体上移、gateway 收拢、bootstrap/types 改 port 声明） | 低 | **M** | — |
| B | tool-factory 规则下沉 + 新增单测 | 低-中 | **S-M** | A |
| C | AgentInvoker 编排上提（两段式，见 §4） | **高**（全案最高） | **L** | A |
| D1 | controller/scheduler/recruiting 切 agent-turn-port + 删旧 agent-invoke-port | 中 | **M**（~45 mock 站点机械替换） | C |
| D2 | pi-session-factory 瘦身（identity-builder + registry 拆分、倒穿消除落地） | 中 | **M** | A（与 C/D1 并行） |
| E | MemoryRepository 三分 + vec 注入 + 裸导出收敛 | 低-中 | **M-L** | 独立可穿插 |
| F | broadcaster 事件通道改造：onEvent 声明 `void \| Promise<void>` **不 await** + 逐通道 catch 隔离 | 低 | **S** | 独立 |

关键路径 A → C → D1；B/D2/E/F 并行池。

**文档约定**（用户拍板口径）：F 文档跟 PR 走——批次 3 的主 F 档随 **PR-A 诞生**，
后续 PR 各自追加 Part；实施进度追踪在 issue #282（不预建 F 骨架，避免与 issue 双记账）。

## 3. 决策清单（已拍板，2026-08-17）

**拍板结果：全部按推荐通过。** D8=metrics 跟 orchestrator（invoker ~400 / orchestrator
~800 行带豁免）；D9=领域事件 TurnEvent（SSE 映射留 adapter）；D11=K1 记已知问题、
批次 3 后单独 PR 修（已记入 #282 后续项）；D1-D7/D10 见表中推荐列。

| # | 决策 | 推荐 | 检视意见 |
|---|------|------|---------|
| D1 | 编排层位置 | usecases/conversation/agent-turn-orchestrator/ | 两审一致同意 |
| D2 | AgentTool/ToolContext 归属 | usecases/ports/agent-tools.ts（含 ToolResponse 随迁、OtterToolClient 整体上移、pendingRestart 注释警示） | 同意但附条件（v2 已补） |
| D3 | port 目录策略 | ports/ 收拢服务型 port + 全局后缀约定；gateway/repository 原位；防复发靠 review checklist | 部分采纳（改述） |
| D4 | pi-session-factory 拆分粒度 | 拆 identity-builder + registry 两件，主文件 <600 行 | 同意 |
| D5 | SchedulerService | 保持独立；补三层重试叠加声明（K1 已知问题，本批不改行为） | 结论同、论证已修 |
| D6 | MemoryRepository 旧接口 | 一次切换不保留 | 同意 |
| D7 | vec 细节移出接口 | PR-E 内做（含 worker/search 注入，构造签名变更） | 同意（勘误已吸收） |
| D8 | **PR-C 的 ~250 行 metrics 埋点归属** | **跟 orchestrator 走**（绑分类点的去重计数不可拆）；invoker ~400 行、orchestrator ~800 行（带 max-lines 豁免+理由） | 审视提出，需拍板 |
| D9 | **TurnEvent 事件类型** | **领域事件（usecases 定义），SSE 映射留 adapter**——port 签名不引 @contract；与既有 message-broadcaster 的 SSEEvent 先例（已豁免存量）不同，新 port 不再扩大渗漏 | 审视提出，需拍板 |
| D10 | PR 拆分 | 7 个（A/B/C/D1/D2/E/F），D 拆两件缩短关键路径 | 审视建议，已吸收 |
| D11 | K1（scheduler 超时不取消 + 三层重试） | 记已知问题，批 3 后单独 PR 修 | 需确认接受"暂不修" |

## 4. PR-C 两段式实施（v2 重写）

- **第一段：函数抽取（不改调用方语义）**。exit-classifier（状态+依赖注入）、retry-policy
  （纯函数）、事件映射五件（SDK_EVENT_SSE_MAP/mapToSSEEvent/extract* 等 ~200 行模块级
  纯函数）→ 独立文件，invoker 改调。全量测试锁行为等价。
- **第二段：状态机与终态上提**。terminal Sets + recordedAttempts 去重 + metrics 埋点
  + routeByReason 递归重入（orchestrator 循环 + driver.invoke）+ 成功路径清理时序。
  invoker 测试改走 orchestrator（最大单文件测试改动，警惕 mock 空转——用真 sqlite 仓库
  先例，tests/usecases/conversation/send-message.test.ts 的教训）。
- 每段独立 commit、独立对抗检视一轮、隔离实例真实验证。

## 5. 风险与对策（v2）

- PR-C 最高风险：两段式 + 每段全量测试 + 能力层冒烟 + 对抗检视。
- 反强编排红线：attemptDriver 注释"仅限重执行当前轮"；策略参数变更视同行为变更需评审。
- 回滚边界：每 PR 独立可 revert（PR-A 不删旧 port 保证 D 可独立回退）。
- 测试迁移量化（检视提供）：PR-A 冲击 8 个测试文件 import；PR-C 2 个大测试文件重写；
  PR-D1 3 文件 ~45 mock 站点；PR-E 125+ 用例分面重接。

## 6. 对抗审视记录

### 第一轮（架构视角 + 可实施性视角，并行）

v1 被打回的要点与本版处置：

| 攻击点 | 处置 |
|--------|------|
| 【P0】port 缺 abort 面 / scheduler 超时取消 / TurnInput 字段 / 递归重入无执行回调 | Q1 接口重写（requestAbort + AttemptDriver + 全字段 + timeoutMs） |
| 【P0】SSEEvent 渗入 port（#282 要治的病被写进新接口） | D9：领域事件 TurnEvent |
| 【P0】PR-C "纯函数先抽"不成立（classifyExit 依赖实例状态；terminal Sets 耦合成功路径清理） | §4 重写两段式；exit-classifier 定性修正 |
| 【P0】PR-A 范围自相矛盾（删旧 port 迫使 scheduler 立即改签名） | 删除移至 D1 |
| 【P1】ToolContext 污染四件套（漏 OtterToolClient/ToolResponse） | Q3 补全 |
| 【P1】metrics ~250 行无去向（1196 行现状，v1 用了旧数字 873） | D8 拍板 |
| 【P1】D5 "正交"论证与代码不符（三层重试叠加、race 不取消状态分裂） | Q5 修正 + K1 |
| 【P1】PR-E 调用方多面引用 / D7 勘误（disableVec 不在接口、isVecEnabled 消费方含 usecase） | Q6 修订 |
| 【P2】bootstrap/types.ts 静默遗漏 | Q4 补 |
| 【P2】D3 名不符实 / eslint 防不了语义复制 | Q4 改述 + 如实声明 |
| 【P2】PR-F await 通道会阻塞 Web 订阅者；现存 onEvent async 异常逃逸缺陷 | Q7-F：不 await + catch 隔离（顺带修存量缺陷） |

## 7. 明确不做（本批范围外）

- K1 scheduler 超时取消语义 + 三层重试预算（单独 PR，需独立拍板）
- healing/recruiting 孪生流程合并（另立）
- node:fs 绕过 FileSystemGateway（PR-A 顺手修 or 另立）
- @contract 渗入 usecase 的存量清理（message-broadcaster 先例维持豁免；新代码不得新增，D9）
- migration 版本化（另排）
