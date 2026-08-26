---
id: F20260826rsme
title: 服务重启自动恢复中断发言
summary: |
  搭档需求：本地应用升级重启后，被中断的 otter 发言应在重启完成后自动续跑，
  无需手动重试。现状 reconcileOrphans 一刀切置 failed。方案：reconcile 阶段
  识别可恢复中断并写入恢复队列（attempts 原子守卫防循环，8/24 自重启循环教训）；
  启动完成后 ResumeInterruptedService 延迟触发，逐条 prepareForRetry(保留半截
  segments) + 链引擎 re-invoke（#332：直接 invoke 丢 yield 目标）。恢复上限 1 次，
  超限/失败降级现状语义（不比现状差）。
change_type: feature
status: active
capability_test: "n/a: 恢复编排为确定性逻辑（DB 查询+状态机+链引擎复用），无新 LLM 行为面"
created_in_conversation: a7f5b5c0-cef0-4851-9e6d-67260622bb6d
---

# 服务重启自动恢复中断发言

## 背景

> 搭档原话：「本系统目前还是本地应用，所以其实我期望说，当我升级版本重启时，这些由于系统重启中断的，可以在系统重启成功后自动触发继续」

### 现状

服务重启（版本升级是主要场景）后，`src/usecases/conversation/reconcile-orphans.ts` 在启动早期（`bootstrap/database.ts:82` → `postInitDatabase`）执行兜底：所有遗留 `streaming/speaking` 消息一刀切置 `failed` 并插入「[服务重启，发言中断]」segment，随后关闭孤儿 turn（F20260724cwgn）。用户需要手动点重试（`message-controller.retry`）才能续跑。

### 根因

重启后不存在活跃 agent，进行中消息不可能自然到达终态——当时的兜底设计是「判死」而非「挂起」。pi session 文件本身持久化在磁盘（`sessions/` 目录），消息 segments 也已落库，恢复的原料齐全，缺的只是编排。

## 目标

- **T1**：服务重启成功后，被中断的 otter 发言自动恢复续跑，无需人工介入
- **T2**：恢复 = 续写：保留已落库的半截 segments + pi session 上下文，otter 从中断处继续
- **T3**：防无限循环（F20260826 循环教训）：单条消息自动恢复上限 1 次，超限降级现状（failed + 中断说明）
- **T4**：恢复失败不影响现状兜底语义——任何路径都不比现状差

## 非目标

- 用户消息/系统消息的「中断恢复」（用户消息原子写入，无 streaming 中间态）
- 定时任务的调度级恢复（scheduler 按下次触发时间自然重跑；执行中被中断的发言已由本方案消息层覆盖）
- 多进程/分布式恢复（当前为本地单进程应用）
- 前端改造（复用现有 streaming 刷新机制 F20260723mk75：failed→streaming 状态变化对前端透明）

## 方案设计

### 时序总览

```
buildApp()
 ├─ initDatabaseAndModels
 ├─ postInitDatabase
 │   └─ reconcileOrphans（改造）
 │       ├─ 识别可恢复中断（见下）→ 写 restart_pending_resumes（原子 attempts 守卫）
 │       ├─ 可恢复消息 fail 不插 notice（干净进入恢复流程）
 │       └─ 其余走现状：fail + 「[服务重启，发言中断]」notice
 ├─ … agentGateway / agentInvoker / dispatchChainEngine 装配 …
 ├─ schedulerService.start()
 └─ 【新增】ResumeInterruptedService.resume()（延迟 3s 触发）
     └─ 逐条串行：校验 → prepareForRetry(preserveSegments=true)
         → 链引擎 executeChain → 状态流转
```

### 1. 数据模型：新表 `restart_pending_resumes`

```sql
CREATE TABLE IF NOT EXISTS restart_pending_resumes (
  message_id      TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  otter_id        TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | done | exhausted
  created_at      TEXT NOT NULL,
  updated_at      TEXT
);
```

**消费方声明（issue #379 ⑥）**：
- 写入方：`reconcileOrphans`（启动识别可恢复中断，`attempts` 原子自增守卫）
- 读取/流转方：`ResumeInterruptedService`（启动完成后查询 `pending` 记录，成功→`done`，失败→`exhausted`）

表按 `message_id` 主键幂等，保留历史记录做审计（每次重启最多产生个位数行，不清理）。

**防循环机制**：恢复进行中再次重启 → 新一轮 reconcile 看到的仍是 streaming 消息 → 原子 UPDATE `attempts = attempts + 1 WHERE message_id = ? AND attempts < 1` 返回 0 行受影响 → 判定已恢复过，走现状 fail + notice 路径。绝不二次恢复，杜绝「重启循环恢复」。

### 2. reconcile-orphans 改造（`src/usecases/conversation/reconcile-orphans.ts`）

新增可恢复识别逻辑，**显式分流确保所有 streaming/speaking 消息都被处理**（审视发现 2 修复——避免守卫拒绝的消息被遗漏在 streaming 状态）：

```
for each msg in (streaming/speaking 消息):
  if sender_type='otter' AND conversation 存在 AND otter 仍是 active participant
     AND 原子守卫成功（UPDATE attempts=attempts+1 WHERE message_id=? AND attempts<1 → 1 行受影响）:
    → 入恢复集合（INSERT pending 记录）
  else:  # 覆盖：不可恢复 + 守卫拒绝（attempts≥1，恢复中二次重启）
    → 走现状路径
failInFlightMessages(failedAt, notice, skipNoticeIds=恢复集合):
  恢复集合内消息 → 只置 failed 不插 notice（恢复流程会重置回 streaming 续写，notice 污染续写内容）
  其余消息 → 现状语义：failed + 「[服务重启，发言中断]」notice
```

**消费方声明（issue #379 ⑥）**：skipNoticeIds 为可选参数，既有调用方传 undefined 行为不变。

### 3. ResumeInterruptedService（新 usecase，`src/usecases/conversation/resume-interrupted-service.ts`）

```
resume():
  1. 延迟 3s（等启动完全就绪 + 避开用户首条消息并发窗口）
  2. 查 pending 记录，按 conversation 分组
  3. 每组发一条 sendSystem：「[系统] 服务重启导致 N 条发言中断，正在自动恢复」
  4. 逐条串行处理：
     a. 校验：conversation/otter/participant 仍有效（启动间隙可能被清理）
     b. 并发防护前置检查（审视发现 4 修复）：查该 conversation 最新 user 消息的
        created_at，若在「now - 3s」之后（说明恢复延迟窗口内有新用户消息正在处理）
        → 跳过恢复：status=exhausted + 补插 notice「[系统] 检测到新消息进入，跳过自动恢复，请手动重试」
     c. senderId = 该消息**原所属 turn（msg.turnId）**的最后一条 user 消息的 senderId，
        fallback "user"（对齐 retry 端点取法；注意 prepareForRetry 会创建全新 turn，
        新 turn 为空不能用作查询锚——审视发现 3 修复）
     d. prepareForRetry(messageId, preserveSegments=true)
        → 消息 failed→streaming，新 turn，半截 segments 保留（F20260821fix 同款语义）
     e. dispatchChainEngine.executeChain({
          initialTargets: [otterId],
          userMessageContent: buildRestartResumeMsg(),  // 见 4
          senderId,
          invokeFn: (params) => agentInvoker.invokeConversation(params),  // 审视发现 1 修复
        })
        → otter 在持久化的 pi session 上下文里续写，完成后自然 yield 交棒，
          链引擎消费 aggregatedTargets 续跑发言链（#332 教训：不能直接 invoke）
     f. 成功 → status=done；链引擎抛错 → status=exhausted + 补插失败 notice
        「[系统] 服务重启自动恢复失败，请手动重试该消息」
```

**串行而非并发**：单次重启的待恢复消息通常 0~2 条，串行避免启动风暴；多条时也避免同 conversation 并发 invoke 的 sequence_num 竞态。

### 4. 恢复提醒文案（`retry-policy.ts` 新纯函数）

```ts
export function buildRestartResumeMsg(): string {
  return '[系统提醒] 服务重启导致你的发言中断，系统已自动恢复。你之前 speak 的内容已保留在本条消息中，请基于已有进度继续完成发言，然后 yield 交棒。如果对任务上下文记忆不完整，先查阅消息历史再继续。';
}
```

末句是兜底：pi session 延迟落盘时上下文尾部可能缺失（见风险 1），提示 otter 主动查历史。

### 5. 装配（`src/app.ts`）

- `buildApp` options 新增 `startResume?: boolean`（默认 true，测试/CI 可关——对齐 `startRhiWorker`/`startScheduler` 开关模式）
- **开关只在 resume 层生效，reconcile 侧不联动**（审视发现 5 处置）：reconcile 在 `postInitDatabase`（database.ts:82）调用，无 buildApp options 上下文，改造签名成本高；且 reconcile 统一入队在测试库中无副作用（记录不触发任何行为），行为开关收敛在 resume 层一处。
- `schedulerService.start()` 之后调用 `resumeService.resume()`（fire-and-forget，不 await——不阻塞服务就绪）
- ResumeInterruptedService 依赖注入：`{ repos, dispatchChainEngine, sendMessage, queryMessage, invokeFn: (params) => agentInvoker.invokeConversation(params), logger }`——invokeFn 在装配处闭包捕获 agentInvoker（审视发现 1 处置：agentInvoker 诞生于 `initAgentAndScheduler`（app.ts:227），装配顺序在 resumeService 之前，无循环依赖）
- 不加 yaml 配置项：进程级默认启用已满足需求，避免配置面膨胀

## 影响范围

| 模块 | 影响 |
|---|---|
| `reconcile-orphans.ts` | 语义增强：可恢复中断不再「判死」而是入队待恢复 |
| `failInFlightMessages` | 签名扩展（新增可选参数 skipNoticeIds），既有调用方传 undefined 行为不变 |
| 启动时序 | buildApp 尾部新增异步恢复任务，不阻塞 listen |
| 前端 | 无改动：failed→streaming 经现有事件流/刷新机制自然呈现 |
| 定时任务执行中的中断 | 意外受益：scheduler invoke 的消息中断后同样被恢复，任务语义在消息层闭环 |

## 风险与约束

1. **pi session 延迟落盘**（`SessionManager.create` 延迟写入，首条 assistant 消息后才落盘）：中断时上下文尾部几步可能缺失。缓解：otter 可见已落库的半截 segments + unread 消息历史注入 + 提醒文案引导查历史。恢复质量从「完整续写」降级为「基于可见证据续写」，可接受。
2. **恢复 invoke 与用户新消息并发**：同 conversation 两个 invoke 存在 sequence_num 竞态可能。缓解：3s 延迟 + 恢复前时间戳检查（发现窗口内有新 user 消息则跳过恢复降级手动，见方案设计 §3 step 4b）；彻底解法是 conversation 级互斥锁，超本特性范围，标注为已知限制。
3. **前端中间态**：消息短暂显示为无 notice 的 failed（秒级窗口）后转 streaming。用户几乎无感。
4. **表遗留**：exhausted/done 记录永久保留。量级为每次重启 ≤ 个位数行，不构成膨胀压力。

## 不兼容更新

无。`failInFlightMessages` 为可选参数扩展；新表为纯增量；行为变化仅限「原来判死的中断现在会自动复活续写」——这正是需求本身。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 恢复清单载体 | 独立新表 | messages.metadata JSON 字段 | 查询干净（status 索引）、attempts 原子守卫天然落地、审计可查；metadata LIKE 查询脏且 JSON 无并发保护 |
| 中断态处理 | 先 fail 再 prepareForRetry | 新增 suspended 状态 | 完整复用现有 retry 链路（状态机/FTS/前端适配零改动）；恢复禁用/失败时兜底语义与现状完全一致（T4） |
| re-invoke 通道 | DispatchChainEngine | 直接 agentInvoker.invokeConversation | #332 教训：直接 invoke 丢弃 aggregatedTargets，恢复后 yield 交棒的链会断 |
| 恢复执行 | 串行逐条 | 并发批量 | 量小（0~2 条）；规避 sequence_num 竞态与启动风暴 |
| segments 处理 | preserveSegments=true | 清空重写 | 半截内容是有效产出（F20260821fix 已确立该语义）；清空会导致 otter 看不到自己说过什么 |
| 恢复次数上限 | 1 次 | 不限次 / 可配置 | 恢复后再中断大概率是系统性问题（版本 bug），继续重试只会循环烧 token；1 次上限与熔断机制的克制哲学一致 |
| 并发窗口防护 | 时间戳检查跳过 | conversation 级互斥锁 / 无防护 | 互斥锁超范围（影响所有 invoke 路径）；无防护有 sequence_num 竞态实害；时间戳检查一条查询解决 90% 场景（重启后立刻发消息），跳过时降级手动重试不比现状差 |

## 审视决策史

第 1 轮对抗审视（检视獭-重启恢复，mimo）：5 条发现全部接受，逐条处置如下——

| 发现 | 级别 | 处置 | 更好/更差判断 |
|---|---|---|---|
| 1. executeChain 缺 invokeFn 参数 | 严重 | 接受并修订：装配节补充 invokeFn 闭包注入，含装配顺序论证 | 更好——原方案照写会直接编译失败 |
| 2. 防循环分流缺口（守卫拒绝的消息可能停留 streaming） | 严重 | 接受并修订：改写为显式 if/else 分流，else 覆盖不可恢复+守卫拒绝 | 更好——这是真实闭环缺口，遗漏场景下消息永久悬挂 |
| 3. senderId「同 turn」歧义 | 建议 | 接受并修订：明确为原所属 turnId 反查 | 更好——消除实现歧义 |
| 4. 3s 窗口并发无防护 | 建议 | 接受并修订：增加恢复前时间戳检查，命中则跳过降级手动；同时新增 AT-8 验收场景 | 更好——一条查询消除大部分竞态实害 |
| 5. startResume 开关传递路径未展开 | 建议 | 接受并修订：开关收敛在 resume 层，reconcile 不联动，AT-6 相应修正 | 更好——避免 reconcileOrphans 签名改造，行为控制点单一 |

## 验证

### 验收场景

| AT | 场景 | 操作 | 预期 |
|---|---|---|---|
| AT-1 | 基础恢复 | otter speaking 中 kill 进程 → 重启 | 系统消息提示恢复；消息 failed→streaming，半截 segments 保留，otter 续写并 yield；pending 记录 done |
| AT-2 | 无中断 | 重启时无 streaming/speaking 消息 | 无系统消息，无 pending 记录，行为与现状一致 |
| AT-3 | 防循环 | 恢复 invoke 进行中再次重启 | 第二轮 attempts 守卫拒绝入队（else 分支），走现状 fail+notice，不二次恢复；分流保证该消息仍被 fail，不停留 streaming |
| AT-4 | 恢复失败 | 链引擎 invoke 抛错 | status=exhausted，补插失败 notice，用户可手动重试 |
| AT-5 | 不可恢复者 | 中断消息的 otter 已被 dissolve | 不入队（participant 校验失败），走现状 fail+notice |
| AT-6 | 开关关闭 | buildApp({ startResume: false }) | reconcile 照常入队（无开关联动），resume 不执行；测试库 pending 记录无害堆积 |
| AT-8 | 并发跳过 | 恢复触发前 3s 内该 conversation 有新 user 消息 | 跳过恢复：status=exhausted + 补插 notice，用户手动重试 |
| AT-7 | streaming 零内容 | 消息 streaming 且无 segments（模型还没 speak） | 同样恢复；pi session 未落盘时 otter 依提醒文案从消息历史重建任务 |

### 测试设计

- `resume-interrupted-service.test.ts`：mock repo + 链引擎——成功路径 / attempts 上限 / participant 失效跳过 / 链引擎抛错降级 / preserveSegments 透传
- `reconcile-orphans.test.ts`（扩展）：可恢复识别四条件 / notice 跳过 / 原子守卫幂等
- 手动集成：开发环境制造 speaking 中断 → 重启 → 观察恢复全链路（消息状态 + 系统消息 + 续写内容）

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/frameworks/db/schema.ts` | 修改 | initSchema + migrate 增表 `restart_pending_resumes` |
| `src/frameworks/db/conversation/sqlite-conversation-repository.ts` | 修改 | failInFlightMessages 扩展 skipNoticeIds；新增 pending_resumes CRUD（含原子 attempts 守卫） |
| `src/usecases/conversation/conversation-repository.ts` | 修改 | 接口同步 |
| `src/usecases/conversation/reconcile-orphans.ts` | 修改 | 可恢复识别 + 入队 + 分流 fail |
| `src/usecases/conversation/resume-interrupted-service.ts` | 新增 | 恢复编排 usecase |
| `src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts` | 修改 | 新纯函数 buildRestartResumeMsg |
| `src/app.ts` | 修改 | 装配 ResumeInterruptedService + startResume 开关 |
| `tests/**` | 新增 | 上述测试 |
