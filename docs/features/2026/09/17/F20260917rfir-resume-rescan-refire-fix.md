---
id: F20260917rfir
title: 重启补扫重燃修复：invoke 存在性判据 + 崩溃窗口收窄
doc_type: feature

summary: |
  修复 9/17 重启风暴（生产实证：单次重启 696 invoke / 656 failed，大量 session
  锁超时）。根因：F20260916b1ea 的 rescanPending 结构性重燃——① invoked 路径
  从不销账（routeTriggerMessage 只对 followed_up/steered 打 consumed），「无
  consumed」≠「未处理」；② 补扫范围全量无界。修复：应答 invoke 存在性主判据
  （getInvokeByTriggerEntryId——已点火语义不依赖销账纪律）+ 窗口收窄到崩溃
  窗口（启动前 2 分钟 / 单会话 50 条）+ invoked 补销账（双保险）。

causal_links:
  from:
    - F20260916b1ea   # 重启自动恢复机制重建（引入 rescanPending，本档修复其重燃缺陷）
    - F20260908rlcp   # 信号销账机制（steer/followUp 销账修复 9/9 三回复；本档补 invoked 路径）

tags: [conversation, signal-router, resume, bugfix, incident]
modules: [src/usecases/conversation/signal-router.ts, src/app.ts]
created_in_conversation: 2964fa59-1b25-45c4-9b0c-23afdb952969
---

# F20260917rfir 重启补扫重燃修复

## 问题现象（生产实证，2026-09-17 08:37 CST 重启）

- 重启后**大量未被中断的会话被重新触发**，一大批 `[错误] Lock acquire timeout for key: session`
- 数据库实证（`data/otter-buddy.db`，只读查询）：
  - 当日（UTC 2026-09-17T00:00 起）invokes：**696 条**，其中 **failed 656 / completed 35 / aborted 2**
  - `restart_pending_resumes` 表 0 行——恢复队列闭环已走完，风暴源不在队列表
- 结论：风暴源 = `rescanPending` 全量补扫（不走队列表）

## 根因分析（附 file:line，修复前基线 b2938163）

### 根因 1：invoked 路径从不销账 → 「无 consumed」≠「未处理」

`signal-router.ts` `routeTriggerMessage` 销账逻辑（修复前 172-176 行）：

```typescript
for (const r of results) {
  if (r.action !== "followed_up" && r.action !== "steered") continue;  // invoked 被跳过
  await r.signal.markConsumed(r.action).catch(() => {});
}
```

RouteAction 三态中 `invoked`（目标空闲时的新 invoke 点火）从不打 consumed。
而进程重启后热池为空，所有目标都走 invoked 路径——**consumed 标记在重启场景下
永远不会被写入**，`rescanPending` 的「无 consumed 则点火」判据对所有历史消息成立。

### 根因 2：补扫范围全量无界

- `listRecentConversationIds`（`sqlite-resume-pending-repository.ts:43-50`）：
  返回**所有有过 invoke 的会话**（无时间窗）
- `rescanPending` 对每会话 `getEntries(entryType:"user")`：全量历史（默认 limit 50
  但无窗口过滤，且 getEntries 默认 DESC 取最新 50 条——未销账的都在其中）

### 次生症状：Lock timeout

`invokeTarget` fire-and-forget（修复前 355 行 `void (async () => ...)`）——补扫瞬间
并发点燃数十条 executeChain，Pi session 锁互踩超窗口 → Lock acquire timeout。
非独立 bug，随点火风暴平息。

### 历史同型

9/9「说一句话大獭被点 3 次」（F20260908rlcp）的同型缺陷——当时修了
steer/followUp 注入后不销账；本次 rescanPending 移植旧 routeAllPending 语义时
只移植了「consumed 标记」一半去重语义，invoked 路径的「已点火」判据缺失。

## 修法排序判断

① 既有机制语义内修（narrow-fix）——在 rescanPending 内补「应答 invoke 存在性」
判据与窗口收窄，无净新增机制。机制识别检查点：无新配置字段/状态生命周期/表/
信号类型/决策分支（invokeRepo 依赖注入为可选窄接口，消费既有 invokes 表）。

## 方案设计

### 修复 1：应答 invoke 存在性判据（主防线）

`rescanPending` 点火前查 `invokeRepo.getInvokeByTriggerEntryId(entry.id)`——
invokes 表已有以该 entry 为 trigger 的 invoke → 该信号已被点火过（无论成败），跳过。

语义优势：「已点火」的真相源是 invokes 表本身，不依赖销账纪律的完备性。
覆盖：正常事件驱动路径（用户发消息 → routeSignal → invoked → invoke 落库）
与上次补扫已点火的信号。

### 修复 2：崩溃窗口收窄（范围控制）

- `RESCAN_LOOKBACK_MS = 120_000`：只扫启动前 2 分钟内的 user 信号
  （崩溃窗口 = 入口写 entry 后进程死的秒级间隙；2 分钟覆盖慢启动装配）
- `RESCAN_MAX_ENTRIES = 50`：单会话加载上限
- getEntries DESC 序遇窗口外 entry 提前 break

### 修复 3：invoked 补销账（双保险）

补扫点火成功后无论 action 都销账（含 invoked）——invoke 存在性判据是主防线，
consumed 标记作为跨语义双保险（兼容未来不含 invokeRepo 的降级装配）。

## 影响范围

- `src/usecases/conversation/signal-router.ts`：rescanPending 重写 + isRescanSkippable
  提取（complexity ≤12）+ SignalView.markConsumed/markEntrySignalConsumed action
  联合类型加 "invoked" + invokeRepo 可选依赖
- `src/app.ts`：SignalRouter 装配注入 invokeRepo
- 行为变化：补扫只处理崩溃窗口内真正未应答的信号；历史消息不再被重燃

## 取舍

- **窗口 2 分钟可能漏掉「慢启动 + 用户消息写于启动前 2 分钟外」的边缘**：
  该场景消息未被 consume 是因为系统尚未就绪而非进程死亡——重启后事件驱动
  路由不会处理历史消息（设计如此），丢失风险可接受；rescanPending 职责是
  崩溃窗口兜底，不是历史消息重放。
- **invokeRepo 可选注入**：不破坏既有测试装配面；生产装配必注入（app.ts）。
  未注入时降级为旧行为（窗口 + consumed 判据），窗口收窄仍生效。

## 验证

- `npx tsc --noEmit`：0 错
- `npx vitest run`：全绿（261 文件 / 3179 用例），含新增 4 用例：
  ① 已有应答 invoke 的信号跳过 ② 窗口外信号不扫 ③ 窗口内未应答信号
  补点火 + invoked 销账 ④ invokeRepo 未注入降级行为
- `npm run build`（含 eslint）：0 error
- `npm run lint:intent`：通过
- 生产库只读验证：风暴实况数据（696/656）已记录于本文档「问题现象」节

## 后续

- issue #996（补扫无界性能）：本修复的窗口收窄已覆盖其正确性面，#996 可关闭
  或降级为纯性能观察项
- 下次重启后观察：补扫应只处理 0~个位数信号（崩溃窗口），不再出现批量点火
