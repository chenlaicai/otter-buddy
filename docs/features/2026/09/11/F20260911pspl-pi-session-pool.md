---
id: F20260911pspl
title: PiSessionPool：pi AgentSession 通用 LRU 会话池（宿主无关的冷启动优化设施）
summary: 把「獭 session 按需拉起 + 空闲驱逐」从具体对话机制中抽出为宿主无关的通用设施。池只知道 key→AgentSession 的拉起/保活/驱逐，不认识"对话/房间/协作机制"；拉起逻辑由宿主以工厂注入，running 豁免优先用宿主谓词、回退 SDK 自有 isStreaming。v1/v2 均可接入：v1 替换 pi-session-factory 每次 invoke 冷启动 dispose 的老路，v2 替换当前与 Executor 焊死的拉起逻辑。本 PR 只交付池本体 + 单测，宿主接入另起 PR。
change_type: feature
capability_test: "n/a: 纯 A 类基础设施代码（无 prompt/skill/协议层改动），行为由 13 个单元测试锁定（acquire/驱逐/并发/容错全路径）"
created_in_conversation: df7b01cd-eb19-479a-8f98-ace69e3ec37c
tags: [pi-agent, session-pool, lru, cold-start, infrastructure, host-agnostic]
modules:
  - src/frameworks/pi/pi-session-pool.ts
  - tests/frameworks/pi/pi-session-pool.test.ts
created_at: 2026-09-11
---

# PiSessionPool：pi AgentSession 通用 LRU 会话池

## 背景

9/8 另一对话讨论 pi agent 冷启动优化时，搭档指出常驻内存爆炸的顾虑，当时提出「LRU 热池：活的常驻、冷的驱逐」方案。9/11 v2 协作机制重写时该方案以 `SessionPool` 落地，但拉起逻辑与 v2 协作协议（speak/yield 工具闭包、房间 system prompt）焊死在 `Executor.ensureSession()` 里——搭档随即提出架构质疑：**LRU 池理应是宿主无关的 pi session 管理机制，松耦合是必然还是设计问题？**

经本对话架构分析（代码 + pi SDK 类型定义 + 9/8 方案三方互证）结论：**松耦合理应成立，当前紧耦合是切片切错了层**——pi SDK 自己的 `CreateAgentSessionRuntimeFactory` 抽象（agent-session-runtime.d.ts）就是「工厂闭包持有固定输入、每次重建 session 绑定的运行时」的模式，`AgentSessionRuntime.setRebindSession()` 为 session 重建后的宿主上下文重绑定提供了明示钩子。必然耦合仅一处：驱逐前需要「运行中豁免」判定，而 SDK 的 `AgentSession.isStreaming` 自有此状态（一行谓词的事）。

## 目标

T1: 交付宿主无关的 `PiSessionPool`：acquire（命中/拉起）/ touch（LRU 刷新）/ 驱逐（TTL + 可选容量）/ 手动驱逐 / disposeAll，全部与「对话机制」零耦合。

T2: running 豁免两路支持：注入 `isBusy` 谓词（宿主语义）优先；缺省回退 `AgentSession.isStreaming`（SDK 自有）。

T3: 并发安全：同 key 并发 acquire 共享 inflight Promise（防双对象挂同一 jsonl）；factory 失败不入池可重试。

T4: 可观测：onEvict 回调（ttl/lru/manual 三种原因）；has/size/keys 查询（名册状态呈现用）。

## 非目标

- **宿主接入**：v1 pi-session-factory 改造、v2 Executor 解耦均不在本 PR（各自另起 PR，池先行确立接口）
- 跨进程共享（池是单进程内存设施；jsonl 是跨进程持久层）
- 预拉热/大 jsonl 恢复延迟优化（v2 文档 R-1 已列，待实测后单独立项）

## 设计

### 接口

```ts
class PiSessionPool {
  constructor(factory: (key: string) => Promise<AgentSession>, options?: {
    ttlMs?: number;          // 默认 10min
    sweepIntervalMs?: number; // 默认 60s
    maxSize?: number;         // 默认 0 = 仅时间驱逐
    isBusy?: (session) => boolean; // 缺省回退 session.isStreaming
    now?: () => number;       // 测试注入
  });
  acquire(key): Promise<AgentSession>;  // 命中刷新 LRU；未命中 factory 拉起
  evict(key): boolean;                  // 手动驱逐（session 损坏等场景）
  start(): void; stop(): void;          // 驱逐扫描生命周期（幂等）
  disposeAll(): void;                   // 进程关闭路径
  onEvict?: (key, reason: "ttl"|"lru"|"manual") => void;
}
```

### 关键语义

- **池不感知 jsonl**：SessionManager.open/create 的恢复逻辑在宿主 factory 内——池只对 `AgentSession` 对象负责。这是与 v2 当前设计的本质区别（v2 把 SessionManager.open 内联在 Executor 里）。
- **容量驱逐的 running 豁免**：超容时只驱逐 idle 项中最久未触者；全员 running 则放弃驱逐（宁超容不杀活会话）。
- **dispose 容错**：所有 dispose 调用 try/catch——驱逐是内存管理手段，dispose 失败不应阻塞出池（泄漏由进程生命周期兜底）。

### 与 v2 现状的差异（重构方向预告）

| 维度 | v2 现状（Executor.ensureSession 内联） | 本设施 |
|---|---|---|
| 池职责 | SessionPool 只记时间戳，拉起在 Executor | 拉起/持有/驱逐全在池内 |
| 宿主装配 | 与拉起焊死 | factory 注入，池不认识 |
| running 判定 | Executor.state 字段（自维护） | isBusy 注入 或 isStreaming 回退 |
| 泄漏点 | executors Map 只增不减（已发现，待修） | 池自持有，驱逐即清 |

## 验证

- 单测 13 用例全绿（acquire 命中/并发去重/失败重试、TTL 驱逐 + touch 刷新、running 豁免双路径、容量驱逐 + running 豁免、手动驱逐、disposeAll、dispose 容错、start/stop 幂等）
- `tsc --noEmit` 0 错；eslint 0 问题；全量 vitest 252 文件 3165 用例通过（无回归）
- **已过最简实现检查**：池为纯内存 Map + setInterval，无新依赖；SDK 未提供等价设施（AgentSessionRuntime 是单 session 替换器，非多 session 池），仓库无既有实现可复用

## 影响范围

纯新增（src/frameworks/pi/ + tests/frameworks/pi/），零改动既有文件。宿主接入前的风险为零。

## 决策记录

- **目录位置**：`src/frameworks/pi/`（新子目录）而非 `src/frameworks/agent/`——agent/ 目录承载的是 otter 信号机制语义（锁、熔断、护栏），pi/ 目录承载 pi SDK 的通用适配设施，分层意图显式化
- **容量上限默认不启用**：与 v2 文档拍板一致（獭数量级小，仅时间驱逐）；maxSize 留作资源压力时的兜底手段
- **不随本 PR 做 v1 接入**：v1 改造涉及工具闭包刷新（conversationId/messageId 跨 invoke 重绑）这一独立难点，混入本 PR 会让「池接口是否正确」的审视失焦

## 机制预算四问

① **谁需要**：协作密集期的獭（连发信号不重复冷启动）+ 任何需要「session 常驻但有界」的宿主（v1 信号机制、v2 聊天室运行时）——池是它们的共享地基。
② **失败后果**：驱逐误判 = 冷启动恢复（秒级，与现状等价，无数据损失——jsonl 早已持久）；池缺席 = 回到每次 invoke 全量冷启动，延迟与工具重建成本每轮都付。
③ **后续机制**：驱逐扫描定时器（已内含）；宿主接入时需要 factory 与 rebind 语义（invoke 上下文重绑）——已在接口预留注入点，不是新机制。
④ **退役条件**：pi SDK 若原生提供多 session 池设施，或所有宿主迁离（v1 退役且 v2 自演化出更优实现）→ 本设施可退。判据：`grep -rn "PiSessionPool" src/ v2/` 仅剩定义文件。
