---
id: F20260906srst
title: 自重启防循环误拦修复：引入用户消息介入判据
summary: |
  修复 issue #811：自重启防循环三道防线（F20260824srst）的判定只看「session 是否由自重启创建」，不看重启意图来源，导致搭档显式指令的正常重启也被拦。修复：tool 层与 invoker 层两道防线统一加「session 创建后是否有用户消息介入」判据——有介入放行（正常运维），纯 LLM 自发才拦（循环）。
change_type: fix
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
created_in_conversation: 4f1a20f1-1171-46ae-bdd7-7a577ac2b700
from: [F20260824srst]
tags: [self-restart, circuit-break, healing-events, agent-runtime]
modules: [src/interface-adapters/agent-runtime/, src/usecases/ports/, src/bootstrap/]
---

# 自重启防循环误拦修复：引入用户消息介入判据

## 背景

### 问题现象（issue #811 现场）

2026-09-04 21:30，搭档显式指令「老规矩，你重启下自己，然后批6」，大獭调用 `restart_otter(self)` 被拒：

```
[系统保护] 当前 session 已由自重启创建，不允许连续自重启。请通过新消息与獭交互。
```

该 session 虽由自重启创建，但此后搭档已发过 2 条新指令（「已合入」、重启指令本身）——有用户消息介入的自重启是正常运维，不构成循环。

### 根因

F20260824srst 建立的三层防线中，两道判定防线（tool 层 `isSelfRestartLoop`、invoker 层 `isSessionSelfRestartCreated`）的判定逻辑相同：**当前 active session 的 id 出现在 healing_events 的 self_restart 事件 context.newSessionId 里**——即「只要本 session 是由自重启创建的，下一次自重启一律拒绝」。

这个判定缺了**意图来源维度**：

| 场景 | 意图来源 | 原行为 | 应有行为 |
|---|---|---|---|
| LLM 退化循环自动重启（无新用户消息） | LLM 自身 | 拦截 ✅ | 拦截 |
| 搭档显式指令重启 | 用户消息 | 拦截 ❌ | 放行 |

### 判据设计

**循环的准确定义**：重启后没有任何用户消息介入，LLM 又自发重启。新 session 醒来后第一条消息若来自用户，说明有新指令介入，不构成循环。

判据实现：`最新一条 senderType='user' 消息的 createdAt >= session.startedAt` ⟺ 用户已介入。

判据可靠性论证：
- **continuation message 不落库**：`invokeConversationInner` 只创建 otter 的 streaming 消息，用户消息由上游入口（HTTP/飞书/微信 processor）落库——自重启的递归调用不会制造假 user 消息
- **scheduler 消息是 senderType='system'**（scheduler-service.ts:994），不污染判据——定时任务触发的纯 LLM 循环依旧被拦，语义正确
- **降级保守**：查询失败/mock 缺方法时降级为「无介入」→ 维持拦截（原行为），不放大误拦也不漏拦循环

## 方案设计

issue #811 给了三个方向，采用方向 1（用户消息介入检测）：
1. ✅ **用户消息介入检测**（采纳）：判据是 messages 表现成数据，无需 LLM 如实申报
2. ❌ intent 参数申报：可靠性依赖 LLM 自报，退化场景下恰是最不可信的
3. ❌ 频率兜底：不区分意图，误伤率高

### 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/interface-adapters/agent-runtime/circuit-break-support.ts` | 修改 | `isSessionSelfRestartCreated` 加可选 conversationId 参数 + 介入检测；新增导出辅助 `hasUserMessageSince` |
| `src/interface-adapters/agent-runtime/agent-invoker.ts` | 修改 | `handleSelfRestartSignal` 传 conversationId 给第二道防线 |
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | 修改 | `isSelfRestartLoop`（第一道防线）加同样的介入检测 |
| `src/usecases/ports/otter-tool-client.ts` | 修改 | message 端口新增 `getLastBySenderType`（只读） |
| `src/bootstrap/clients.ts` | 修改 | 装配 `getLastBySenderType` → `uc.queryMessage.getLastMessageBySenderType` |
| `tests/interface-adapters/agent-runtime/tools/pending-restart.test.ts` | 修改 | +2 用例：用户介入放行 / 旧用户消息仍拦 |
| `tests/interface-adapters/agent-invoker-self-restart.test.ts` | 修改 | +2 用例：AT-10 用户介入放行 / AT-11 纯 LLM 自发仍拦 |

### 关键代码

**invoker 层（第二道防线）**：

```typescript
// circuit-break-support.ts
async isSessionSelfRestartCreated(otterId: string, conversationId?: string): Promise<boolean> {
  const session = await this.deps.manageSession.getActiveSession(otterId).catch(() => null);
  if (!session) return false;
  const events = await this.deps.healingRepo.findRecentByOtter(otterId, 'self_restart', 20);
  const selfRestartCreated = events.some(e => (e.context as { newSessionId?: string })?.newSessionId === session.id);
  if (!selfRestartCreated) return false;
  // #811：session 由自重启创建，但此后有用户消息介入 → 正常运维，放行
  if (conversationId) {
    const intervened = await hasUserMessageSince(
      () => this.deps.queryMessage.getLastMessageBySenderType(conversationId, 'user'),
      session.startedAt,
    );
    if (intervened) return false;
  }
  return true;
}
```

**tool 层（第一道防线）**：同判据，经 `ctx.client.conversation.message.getLastBySenderType`（OtterToolClient 端口）查询。

### 设计决策

| 问题 | 决策 | 理由 |
|------|------|------|
| conversationId 可选参数 vs 必填 | 可选 | 向后兼容现有调用点（不传 = 原行为）；tool 层天然有 ctx.conversationId 不受影响 |
| 时间比较用 >= 还是 > | >= | 同毫秒边界：session 创建与用户消息落库存在并发窗口，>= 保守偏向放行？否——Date.parse 毫秒精度下 user 消息 createdAt 晚于 startedAt 即介入；等于的极端场景（同一毫秒）倾向放行，因拦截的代价（误拦运维）高于放行的代价（用户在场时下一轮防线仍可拦） |
| 查询失败时降级方向 | 维持拦截（视为无介入） | 保守：宁可误拦也不漏拦循环（循环 = 无限烧 token，不可逆损失）；误拦有 workaround（搭档再发一条消息即解锁） |
| tool 层为何不直接复用 circuit-break-support 的辅助函数 | 走 OtterToolClient 端口 | tool 层无 queryMessage 依赖，经客户端端口保持分层（interface-adapters 内 tools 不直接依赖 usecases 实例的结构先例） |

## 验证

### 测试

| 测试 | 场景 | 验证点 |
|------|------|--------|
| 原「session 由自重启创建时返回系统保护错误」 | 无用户介入（mock 无 getLastBySenderType → 降级） | 仍拦截（向后兼容） |
| 新：#811 用户介入放行（tool 层） | user 消息 createdAt > startedAt | 放行，pendingRestart 设置 |
| 新：#811 旧用户消息仍拦（tool 层） | user 消息 createdAt < startedAt | 拦截 |
| AT-10（invoker 层） | 用户介入 | restart 执行 |
| AT-11（invoker 层） | 纯 LLM 自发 | restart 不执行 |

### 结果

- 全量测试：244 files / 3047 tests passed（零回归）
- `npx tsc --noEmit` exit 0
- **最简实现检查**：已过——判据用现成 `getLastMessageBySenderType`（O(1) 单条查询），无新依赖、无新表、无新配置；两道防线各 ~10 行改动。方向 2（intent 参数）更少代码但可靠性依赖 LLM 自报，不采

## 影响范围

- 影响模块：agent-runtime（自重启防线）、ports/bootstrap（端口装配）
- 使用者：所有海獭的 `restart_otter(self)` 调用
- 破坏性变更：无（行为从「一刀切拦截」变为「有用户介入放行」，纯放宽，且降级路径保持原行为）

## 关联

- issue #811（Closes）
- from: F20260824srst（防循环机制原始设计，本次在其威胁模型上补意图来源维度）
