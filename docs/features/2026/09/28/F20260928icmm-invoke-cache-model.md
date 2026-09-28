---
id: F20260928icmm
title: 右栏状态缓存模型换轨（弱合并退役：对账可覆盖本地，读点挂齐）
doc_type: feature

summary: |
  右栏卡「行动中」（实际已休息）经 #1095/#1144/#1161 三轮修复仍复发。双獭联合排查
  推翻前三轮根因排序：真病灶不在事件/拉取的「触发时机」，而在拉取结果的「写入语义」
  ——内联恢复「本地已有即 continue」弱合并 + mergeInvokesFromServer「本地终态即跳过」
  反向洞，让对账拉取（listInvokes 200 数据正确）写不进状态：SPA 切对话组件不卸载、
  invokeStates 不清空，切回后服务端正确数据被原样丢弃，右栏永久卡「行动中」直到
  硬刷新。本 PR 正确性模型换轨：invokeStates = 服务端 invokes 表的缓存（同獭
  startedAt 最新者胜、服务端可覆盖本地、防回退保留）+ 对账读点挂齐（focus/可见性
  + POST 流结束，无门控）+ 通道分工（POST 流不管右栏）。失败测试先行，570/570 绿。

type: BugFix
domain: web
status: implemented
created: 2026-09-28
created_in_conversation: 5603032d-569c-42c1-b318-1e3b4629ab1f
related_issues: [1160]
related_pr: []
causal_links:
  - F20260924ircc
  - F20260923sswd
  - F20260922rprf
---

# 右栏状态缓存模型换轨：弱合并退役，对账可覆盖本地

## 背景：为什么修了三轮还在复发

#1095（断连补偿拉取）→ #1144（SSE 看门狗 + 初始化竞态）→ #1161（门控回归分离）
三轮全在「事件/拉取的**触发时机**」上加码：重连补偿、活性检测、重试链、门控语义分离。
但 9/25 复发现场（升级系统重启后，切对话场景右栏卡「行动中」）的日志+DB 双向核实显示：

- `GET /invokes` **200 成功**且返回正确终态数据（14:52:41），**UI 没有被修复**；
- 数据层闭合正常（invokes 表 aborted 行有 ended_at，invoke_end entry 已落库）；
- 服务端广播正常（broadcastEvent 有记录），丢失只是触发场景。

**根因（架构獭提出，大獭独立核验采纳）**：拉取结果的**写入语义**是弱合并——

1. `loadConversationDetail` 内联恢复（index.tsx:~355）：`if (next[inv.otterId]) continue`
   ——本地已有该獭任何记录就跳过服务端数据。SPA 切对话组件不卸载、`invokeStates`
   是 `useState({})` 无清空点，旧对话的 running 残留让**每次切回对话的对账拉取全部被丢弃**。
2. `mergeInvokesFromServer`（invoke-tracker.ts:~83）：`existing.status !== 'running' continue`
   ——本地终态同样阻断服务端更新（反向洞：本地终态旧 invoke + 服务端新 invoke 被跳过）。

**为什么手动刷新能修**：整页 reload → 组件重挂载 → 状态清零 → `continue` 不命中。
这解释了四轮未解之谜「只有硬刷新能修」。

## 方案：正确性模型换轨（搭档拍板「不要打补丁」后的架构级修复）

**新不变量**：`invokeStates` = 服务端 `invokes` 表的**缓存**。任何拉取点都能用权威
数据覆盖本地旧状态（按 startedAt 单调，防回退）；SSE 事件降级为延迟优化（新鲜度），
不再承担正确性。错误从「永久（直到硬刷新）」变为「最多一个对账周期」。

### 修改点（阶段 1，本 PR）

| # | 位置 | 修改 |
|---|---|---|
| 1 | `invoke-tracker.ts` `mergeInvokesFromServer` | 重写：服务端数组内同獭取 startedAt 最新（不依赖顺序）；与本地比，服务端记录更新（startedAt 更新，或同刻同 invokeId 终态胜 running）则覆盖；否则本地保持（防回退）。幂等保留：无变更返回原引用 |
| 2 | `index.tsx` 内联恢复 | 手写映射 + `continue` 弱合并退役，改调 `mergeInvokesFromServer`（一处语义，三处消费） |
| 3 | `index.tsx` focus/visibility 钩子 | 挂对账读点：窗口聚焦/切回可见时（复用既有 ack 300ms 防抖窗口）调无门控对账 |
| 4 | `index.tsx` POST 流 onDone | 挂对账读点：POST 发言流结束（通道分工：POST 流不驱动 invokeStates，结束后对账拉齐） |

对账统一走 `syncInvokeStatesOnReconnect`（无门控）——初始恢复门控
（`invokeStatesLoadedRef`）只属于初始重试链，对账不受限（#1144 曾因门控错误覆盖
补偿路径引入回归，教训记入）。

### 通道分工（缺陷 A 的消解方式）

POST 发言流的 `invoke.start/end` handler 只管中间栏消息（气泡终态），**明确不管
右栏 invokeStates**；右栏单一时钟 = GET 订阅事件 + 拉取对账。这比「给 POST 流补上
右栏更新」（修对称）少一条双通道竞态面——是删职责不是加职责。

## 测试

- **失败测试先行**：
  - 单元级（invoke-tracker.test.ts，新增 8 用例）：T1/T2（本地旧 running + 服务端更新
    → 服务端胜）、T2b/T2c（本地旧终态 + 服务端更新 → 服务端胜，**修复前必失败**——
    弱合并的反向洞）、T3（防回退：本地新 + 服务端旧 → 本地保持，**修复前必失败**——
    旧实现无 startedAt 单调性）、T4（同刻终态收敛）、T5（幂等原引用）、T6（数组序无关）
  - 组件级（index.spa-nav.test.tsx，新增 2 用例）：「切走丢 end → 切回对话，右栏被
    服务端权威数据纠正」（**旧 continue 实现必失败**）、「窗口重新聚焦对账恢复」
- 旧弱合并断言测试改写为缓存模型语义（「本地已终态 → 跳过」→「同 invoke 幂等 + 更新
  invoke 覆盖」，语义有意反转）
- 全量 570/570 绿（59 文件）+ `tsc --noEmit` exit 0

## 设计取舍（Modification-Class: narrow-fix 四问）

- **为什么改合并语义而不是再补触发**：9/25 现场证明拉取已成功、数据已正确、UI 没修
  ——继续补触发是第五轮打补丁；搭档明确要求根治。
- **服务端覆盖会不会回退状态**：`recordNewer` 按 startedAt 单调比较，服务端记录只有
  比本地新才覆盖；拉取竞态（SSE 实时先行）下本地保持。
- **同刻冲突怎么办**：同 startedAt 同 invokeId 时终态胜 running（对账收敛幽灵 running）；
  不同 invokeId 无信息可判时保守跳过（先到者保持）。
- **退役条件**：阶段 3（后续 PR）收敛 `syncInvokeStatesFromServer`/`OnReconnect` 双函数、
  降级 600ms/2500ms 重试链——本 PR 保持双函数不动（OnReconnect 语义升格为「通用对账」
  仅是调用点增加，无行为耦合）。

## 阶段规划（搭档已批 1+2）

- **阶段 1（本 PR）**：合并语义修正 + 读点挂齐 + 通道分工
- **阶段 2（下个 PR，mechanism-addition 过机制四问）**：running 存在期间 60s 周期静默
  对账（覆盖 tab 休眠无人切页场景）+ `broadcastEvent` 零订阅 debug→info（可观测性债）+
  POST 流 settle 首查竞态修复
- **阶段 3（随行退役）**：双函数收敛、重试链降级、invoke.end 反查链退役

## 影响范围

- `web/src/lib/invoke-tracker.ts`（mergeInvokesFromServer 重写 + recordNewer/localAsRecord 辅助）
- `web/src/pages/conversation/index.tsx`（内联恢复换轨、focus/POST 读点）
- 测试：invoke-tracker.test.ts +8 用例、index.spa-nav.test.tsx +2 用例（含 2 处旧语义反转改写）
- 服务端零改动
