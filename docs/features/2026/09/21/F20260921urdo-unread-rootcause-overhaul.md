---
id: F20260921urdo
title: 未读机制治本：契约收口（sequenceNum 全链贯通）+ 判定换轨（打开+聚焦即已读）
summary: 红点僵死根因是 entry.speak SSE 载荷无 sequenceNum（发射点手拼）+ 已读判定绑滚动几何。本特性两步治本：①服务端统一事件投影（seq 必含）贯通 speak 落库链；②已读判定换轨为「打开+聚焦」状态语义，滚动几何触发点退役。
change_type: fix
capability_test: 'n/a: 后端投影与前端 ack 行为由单测覆盖（tests/ 与 web/ 下对应 *.test.ts），无 prompt 行为变更'
created_in_conversation: d2934a0b-9474-4d30-8d6e-be03d880e1a7
causal_links:
  - F20260916ubrd   # 底部即已读——本特性判定换轨后其 scheduleMarkReadIfAtBottom 退役
  - F20260914rmap   # 游标重映射事故——seq 兼职存储序号的耦合暴露
  - F20260913ctlv   # entries 表模型——seq 唯一刻度的基础
  - F20260813actk   # 首次未读修复——修补史起点（滚动几何绑定自此始）
tags: [conversation, unread, read-cursor, sse, contract, ack, web]
modules:
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/bootstrap/clients.ts
  - src/usecases/ports/otter-tool-client.ts
  - src/usecases/conversation/send-entry.ts
  - web/src/pages/conversation/index.tsx
  - web/src/lib/mappers.ts
created_at: 2026-09-21T08:15:00+08:00
---

# F20260921urdo 未读机制治本：契约收口 + 判定换轨

## 0. 背景与问题

### 现象（搭档 9/21 报告）
停留在对话中，有新消息时红点出现且无法消散；偶尔又能消散。稳定消散方式只有「重新进入对话再切走」。

### 全局审视结论（9/20，本对话前世）
修补史四轮（8/13 滚动到底→已读、9/4 发言即已读、9/14 游标重映射、9/16 底部即已读）都在症状层加触发点，两个结构层从未被设计：

- **层1 判定语义错位**：红点判定输入 = 滚动几何（isAtBottom），业界（Telegram/Slack/Discord/微信）全部用会话状态（打开+聚焦）。触发点 5 个各自为政、互相打架。
- **层2 契约裸奔**：同一事实（entry）有 5 份投影（历史接口/轮询/常驻 SSE/POST 流/重试流），发射点手拼载荷。实锤：entry.system 4 个后端发射点全带 seq，唯独 entry.speak 不带（agent-invoker.ts:618）——前端 speak 气泡永远无 seq。
- **层3 演化耦合**：seq 兼职存储序号/排序/已读游标三角色。9/14 迁移重排 seq 炸出全量假未读。

### 直接根因（本次 bug）
`scheduleMarkReadIfAtBottom` 计算 maxSeq 时 `filter(m => m.seq != null)` 排除无 seq 的 speak 气泡 → 游标推不过最新 speak → `unreadCount = speak AND seq > 游标` 恒真 → 红点僵死。
「有时能消散」：用户自己发言（POST 流 entry.user 带 seq）时 markRead 到 user 的 seq，顺带盖过之前的 speak。

### 搭档拍板
「直接完整修改，不要分步」——治本两步走一个 PR 完成。

## 1. 设计取舍（机制识别检查点判定）

本次属修法排序②「收窄管辖」+③「删除机制」组合（既有已读游标机制语义内修正判定输入，删除滚动几何触发机制），非新增机制。

机制识别清单判定：
- [x] 新增持久化数据结构 —— 无（read_state 表不动）
- [x] 新增跨模块调用路径 —— 无（前端内部 ack 调既有 api.markRead；后端投影在既有发射链内）
- 结论：无新机制。Modification-Class: `scope-reduction`（判定输入收窄到会话状态 + 滚动触发机制删除）。

关键取舍：
1. **判定输入换「打开+聚焦」**（Slack/Discord 同型）而非保留滚动：滚动几何是本次修补闭环的结构性病根，5 个触发点依赖同一几何状态互相打架（9/16 #790 视口上跳即前车之鉴）。换轨后触发点语义归一：会话打开、窗口聚焦、聚焦期间新消息到达。
2. **失去「快速扫过保留未读」能力**：对 IM 有价值（快速处理多会话），对本产品（单用户、长对话为主）价值弱——已与全局审视卡「风险与反对意见」节披露，搭档拍板接受。
3. **游标仍 MAX 只进不退**：多标签页同开互踩由服务端 MAX 钳制吸收（同 Slack）。
4. **「打开即已读」多标签页场景**：A 标签页打开会话、B 标签页未打开——B 收到红点，用户点开 B 的同会话也即已读。可接受（ack 幂等，语义「看过这个会话」而非「看过这条消息」）。
5. seq 三角色（存储/排序/游标）耦合本次不动——那是存储层重构，超出本特性管辖；契约收口后游标依赖的 seq 数据面完整，耦合风险降级为「内部实现细节」。

## 2. 方案设计

### Step 1 契约收口（sequenceNum 全链贯通）

**后端——speak 落库链贯通 seq**：

```
send-entry.ts createSpeakEntry   → 返回 created（含 sequenceNum，createEntryAtomic 原子分配后回读，已天然存在）
  ↓
clients.ts entry.createSpeakEntry → 返回补 sequenceNum（当前只回 id/entryType/body）
  ↓
otter-tool-client.ts 接口类型      → 返回类型补 sequenceNum
  ↓
tool-factory.ts speak 工具         → details 补 sequenceNum
  ↓
agent-invoker.ts:618 entry.speak  → 载荷补 sequenceNum + createdAt
```

**后端——字段名统一**：entry.system 发射点（scheduler-service.ts ×2、circuit-break-support.ts:233、agent-invoker.ts:831、tool-factory.ts:348）`seq` → `sequenceNum`（与 entry.user 一致）。

**前端——归一化读取**：所有 entry.* handler 的 data 类型声明统一含 `sequenceNum?: number`，LocalMessage 构造时 `seq: d.sequenceNum`。涉及 entry.system ×2（index.tsx:657、949）、entry.speak ×3（485、854、1091）。旧 `seq` 字段读取同步改 `sequenceNum`（前后端同 PR 合入，无兼容窗口）。

**不动项**：entry.yield（invoke_end 居中条目）载荷本就不进未读统计（`entry_type IN ('speak','system')` 才计数），不扩载荷；entry.user 已带 sequenceNum 不动。

### Step 2 判定换轨（打开+聚焦即已读）

**新增 `ackActiveRead` 统一函数**（index.tsx）：

```ts
/** F20260921urdo 判定换轨：已读判定输入 = 会话状态（打开+聚焦），不再依赖滚动几何。
 *  打开 / 聚焦 / 聚焦期间新消息到达 → ack 到当前已知最新 seq。 */
const ackActiveRead = useCallback((convId: string) => {
  const msgs = allMessagesRef.current[convId] || []
  const realMsgs = msgs.filter(m => !m.id.startsWith('tmp-') && !m.id.startsWith('err-') && m.seq != null)
  if (realMsgs.length === 0) return
  const maxSeq = Math.max(...realMsgs.map(m => m.seq!))
  api.markRead(convId, maxSeq).catch(() => {})
}, [])
```

**触发点接法**：
1. **会话打开**：loadConversationDetail 成功后（现有「首次访问初始化已读」逻辑扩展为无条件 ack——打开即已读）。**实珇细节**：ack 带 msgsOverride 直通刚拉到的 msgs（setState 异步，ref 尚未同步）。
2. **窗口聚焦**：`window.addEventListener('focus', ...)` + `visibilitychange`（document.visibilityState === 'visible'），activeId 存在时 ack，防抖 300ms。**切回场景兑底**（e2e 挖出）：ack 前先 refreshMessages 拉失焦期增量——否则 ack 只到本地已知 seq，失焦期新消息红点僵到下轮数据到达。
3. **聚焦期间新消息到达**：现有 `useEffect([activeMessages.length])` 触发条件从 `scheduleMarkReadIfAtBottom` 换成 `ackActiveRead`（去掉 isAtBottomRef 门控，加 visible+hasFocus 门控）。
4. **发言即已读保留**（聊天通用语义，F20260904smsj 确立）：handleSend 内联 markRead 块改用 ackActiveRead(activeId)。

**退役删除**：
- `scheduleMarkReadIfAtBottom`（index.tsx:108-120）+ 两处调用（380、762）+ markReadTimerMapRef（84）+ 对应清理 effect（102-105）
- `handleMarkRead`（滚到底触发，index.tsx:1060-1072）+ markReadDebounceRef（1055）+ 清理 effect + MessageList `onReachBottom` prop 传递
- MessageList.tsx 中 `onReachBottom` prop 与其调用点（若专为已读服务则一并退役；scroll handler 中其他职责保留）

**保留不动**：
- 分隔线定位（unreadSeparatorSeq）——滚动信息只服务视觉
- 自动滚底门控（isAtBottomRef 的视觉职责）
- 服务端 markRead 端点与 MAX 语义

## 3. 影响范围

| 路径 | 变更 | 风险 |
|---|---|---|
| speak 落库链 5 文件 | 返回值/载荷补 sequenceNum | 低——纯增量字段，消费方未读才受影响 |
| entry.system 发射点 5 处 | `seq` → `sequenceNum` | 低——前后端同 PR，无兼容窗口 |
| 前端 handler 6 处 | 读 `sequenceNum` 建气泡 seq | 低——与后端同合入 |
| 已读触发点 | 5 → 1 函数 3 接法 | 中——行为语义变化（见取舍 2/3） |
| MessageList props | onReachBottom 退役 | 低——需确认无其他消费 |
| IM 通道（weixin/feishu message-channel） | 只读载荷既有字段，不读 seq | 零——载荷增量字段不破坏 |

## 4. 负面向验收条目

- 本次绕过了什么旧契约：entry.system 前端读 `seq` 字段的旧契约（前后端同 PR 换名，无过渡期）。
- 本次破坏了什么旧行为：①「不滚动到底则保持未读」——换轨后打开+聚焦即已读，快速扫过保留未读的能力失去（搭档已拍板接受）；②MessageList 的 onReachBottom prop（若无其他消费则删除）。

## 5. 验证

### 单测（新增）
- `tests/interface-adapters/agent-runtime/entry-seq-contract.test.ts`：驱动真实 `AgentInvoker.handleStreamEvent`（speak 工具 execution_end → entry.speak SSE），断言载荷必含 sequenceNum/createdAt；createSpeakEntry/createSystemEntry 返回 entry 的 seq 单调。
- `tests/interface-adapters/agent-runtime/entry-speak-seq-baseline.test.ts`：源码级契约锁（发射行必含 sequenceNum）。
- `web/src/pages/conversation/read-ack-migration.test.ts`：判定换轨回归锁——旧机制（scheduleMarkReadIfAtBottom/handleMarkRead/markReadTimerMapRef/markReadDebounceRef/onReachBottom prop）不得复活（去注释检查）；新接法（ackActiveRead + focus/visibility 监听）必须存在。
- `first-dumb-detection.test.ts` 适配：sendSystem 投影补 createdAt 后 mock 同步。

### 失败用例证据（bugfix Verification 硬规则）
- 修复前（主仓 origin/main 代码）：
  - `agent-invoker.ts` entry.speak 发射行 = `emitEvent({ event: "entry.speak", data: { entryId, invokeId: opts.currentInvokeId, otterId, body, otterName: resolvedName } })` —— **无 sequenceNum**（node -e 源码断言：`含 sequenceNum: false`）
  - 前端 speak 气泡 LocalMessage 无 seq → `filter(m => m.seq != null)` 排除 → maxSeq 推不过 speak → 红点僵死
- 修复后（worktree）：发射行含 `...(sequenceNum != null && { sequenceNum }), ...(createdAt && { createdAt })`（`含 sequenceNum: true`），契约测试 3/3 绿

### 真机 UI 自查（alpha 3178 隔离实例 + Playwright，scripts/alpha.sh）
脚本：`data/workspaces/d2934a0b-9474-4d30-8d6e-be03d880e1a7/urdo-e2e-v3.cjs`，截图：同目录 `urdo-e2e-v3-final.png`。
- [A] 前台打开对话（预置 speak seq=1）→ 打开即 ack：unread 0 ✅
- [C] 失焦（hasFocus=false）注入新 speak（seq=2）→ 不 ack：unread 1 ✅（失焦保留红点）
- [D] 切回（focus 事件）→ ack：unread 0 ✅（切回消散）
- 过程中挖出并修复真 bug：切回场景「focus ack 只能到本地已知 seq」——失焦期落库的新条目不在
  state（SSE 未投递/断连），ack 到旧 seq 红点僵死。修法：focus ack 防抖回调内先 refreshMessages
  拉增量再 ack（refreshMessages 拉到后聚焦态自 ack；直接 ack 作为竞态兑底，MAX 钐制无害）。
- 验证面说明：alpha 无可用 LLM 配额（kimi 403），真实 speak 链（speak 工具 → SSE 广播）无法
  端到端触发，SSE 载荷契约由单测驱动真实 handleStreamEvent 覆盖；e2e 以直接写库模拟新条目
  落库，验证 ack 语义矩阵。

### 回归
- 后端：`npx vitest run` 263 文件 / 3615 测试全绿；`npx tsc --noEmit` 零错误
- 前端：`web npx vitest run` 56 文件 / 501 测试全绿；`web npx tsc --noEmit` 零错误

### 最简实现检查（必答）
已过最简检查：无新库/新文件级抽象——后端仅既有返回链补字段（零新增函数），前端 ack 复用
既有 api.markRead 端点与 refreshMessages，删除的代码（~60 行旧触发点）大于新增（~40 行 ack 接法）。

### Golden Gate
n/a（verify_by=n/a：无 prompt/skill/协议层软代码变更，纯后端载荷字段+前端状态语义；
行为由单测+e2e 覆盖）

### Intent 块
n/a（非软代码变更，无 intent 块需求）

## 6. 遗留与边界（诚实披露）
- SSE 断连期间（如笔记本休眠）常驻通道无投递，依赖重连 + 下一轮数据到达拉齐——重连成功后
  服务端不补发 missed 事件，需靠 refreshMessages/重新打开拉平。此为既有边界（非本次引入），
  切回场景已由 focus-ack 的 refreshMessages 兑底缓解。
- 多标签页同开同一对话：互相 ack（幂等，MAX 钐制），语义「看过这个会话」——设计取舍 3 已披露。
- 未读分隔线（unreadSeparatorSeq）保留定位职责，但「打开即 ack」后首次打开时 unread
  状态已归零，分隔线只在后台期新消息场景出现。
