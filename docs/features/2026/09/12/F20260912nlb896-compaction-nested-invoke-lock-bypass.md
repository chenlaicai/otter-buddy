---
id: F20260912nlb896
title: compaction 合成嵌套 invoke 锁旁路（#896 死锁修复）
summary: session_before_compact 钩子在 prompt 中途触发，合成 invoke 再取同一把 per-otter 锁必死锁；invoke 入口用 ALS store 检测同獭嵌套调用，旁路取锁直接执行
change_type: fix
capability_test: "n/a: 纯运行时并发行为修复，非 prompt/skill/协议层软代码"
created_in_conversation: df7b01cd-eb19-479a-8f98-ace69e3ec37c
doc_type: feature
tags: [agent, compaction, lock, deadlock, pi-session-factory]
modules: [frameworks/agent/pi-session-factory]
from: F20260903cmpk
---

# compaction 合成嵌套 invoke 锁旁路（#896）

## 问题

Issue #896（bug+P1）：自 F20260903cmpk（9/3）上线起，threshold 压缩的七段合成**必现死锁降级**。

实证钉死的死锁链（全部核实过源码）：

1. `session_before_compact` 钩子在 `session.prompt()` 的 agent loop **内部**触发（SDK agent-session.js:805，`_checkCompaction` 在每轮 LLM 响应后跑）
2. 此时外层 invoke 持有 per-otter 锁（SimpleLockManager，invoke 全程持有，steal 阈值 300s）
3. 钩子里的 `synthesize(realOtterId, prompt)` → `buildSynthesisFunction` → `agentInvoke.invoke(readOnly: true)` → `PiSessionFactory.invoke` → **再取同一把锁** → 30s 超时 → 降级 Pi 默认摘要

后果：threshold 压缩自 9/3 起从未真正用上七段合成，全部走了 Pi 默认摘要兜底。

## 方案：ALS 嵌套检测锁旁路

`PiSessionFactory.invoke` 入口增加检测：

```ts
const nestedStore = otterInvokeStorage.getStore();
if (nestedStore && nestedStore.otterId === otterId) {
  // 同 async context 内的嵌套 invoke（压缩合成正是这种）——外层已持锁，直接执行
  return await this._invokeInternal(otterId, message, options);
}
```

### 为什么安全

- **嵌套 invoke 必然在同 async context**：压缩钩子在 `session.prompt()` 内触发，prompt 在 `_executeWithSession` 的 `otterInvokeStorage.run` scope 内执行——钩子里的合成 invoke 沿同一 ALS 链传播，store 必有外层 otterId
- **真并发不旁路**：来自其他 async context 的 invoke（另一消息派发、定时任务）`getStore()` 返回 undefined 或 otterId 不匹配，照常走锁排队
- **嵌套串行由 ALS 链保证**：外层 `await` 嵌套（钩子是 await 的合成调用），不存在并行执行；锁的互斥语义在嵌套场景由调用栈天然保证
- **readOnly 合成**：合成 invoke 是 readOnly（跳过消息持久化和 SSE 广播），工具白名单过滤（SYNTHESIS_READ_ONLY_TOOL_WHITELIST），副作用面窄

### 被否的候选

| 候选 | 否决理由 |
|---|---|
| 合成不走完整 invoke（窄通道直接 LLM 调用） | session restore / 模型解析 / 工具装配全要另处理，改动面大，且与 handoff 合成链路分叉 |
| SimpleLockManager 改可重入 | 通用组件，改它影响所有使用方；可重入语义对「真并发」场景反而削弱保护 |

## 验证

- 新增 `tests/frameworks/agent/nested-invoke-lock-bypass.test.ts`（3 用例）：
  1. 外层持锁期间，同 otterId 嵌套 invoke 旁路锁立即执行（用可控 barrier 挂起外层模拟 prompt 中途，嵌套若误取锁必超时——旁路的可观察证据是立即完成且外层锁仍持有）
  2. 不同 async context 的同 otterId invoke 照常取锁排队（真并发不旁路）
  3. ALS store otterId 不匹配（其他獭上下文）不旁路，照常取锁
- 全量 254 文件 3179 用例通过（基线 3176 + 新增 3）；tsc/eslint clean
- **最简实现检查**：已过。ALS 检测 10 行改动，复用既有 store（F20260826mwrd 起就在）；不新增组件、不改锁语义

## 影响范围

- `src/frameworks/agent/pi-session-factory.ts`：invoke 入口 +10 行（ALS 检测旁路 + 日志）
- 行为变化：threshold 压缩的七段合成从「必现死锁降级」恢复为「真正执行」——这是 F20260903cmpk 的设计意图，非新行为
- 对 handoff 合成无影响（handoff 合成在 invoke 外的编排层触发，本来就无锁冲突）

## 已知边界

- 池化后（F20260911pspl）嵌套 readOnly invoke 走 `_acquirePooled` 会命中池并 reset 寄存器——与外层共享 session/寄存器。9/3 起 handoff 合成同形态嵌套（池化前共享 sessionMap 条目）已在生产运行，此形态非本 PR 新增风险；极端边界（合成 LLM 调 speak 落错消息）属低概率已知形态，不在本修复范围
- stale 双活下 pendingRestart 误逐新 session（#894 检视边缘观察）：与本修复同族（锁/会话语义治理），概率极低，后续一并加固

---

## 附录：PR #897 第 1 轮检视处置（2026-09-12，方案修正）

### 检视发现与裁决

**严重 1（正确性，接受并修复——方案推翻重写）**：ALS 锁旁路判定正确，但旁路后嵌套合成 invoke 在 `_acquirePooled` **必命中 stale-steal 分支**——压缩钩子在外层 `session.prompt()` agent loop 内触发，SDK `_isAgentRunActive` 恒为 true（agent-session.js:773/348）。后果：每次 threshold 压缩都把外层活 session 判 stale 出池、冷启动 `SessionManager.open` 同一 jsonl 顶替池条目——**压缩摘要 entry 与外层后续消息全部丢失，压缩永不生效且上下文逐轮膨胀**，比死锁降级更隐蔽。裁决：发现成立（我核实了 SDK `_runAgentPrompt` 在 prompt 全程置 `_isAgentRunActive=true`，`_checkCompaction` 在其内部跑——每环都核实过）。原「嵌套共享池 session」方案不可行，推翻。

**建议 2（测试 mock 缺口，接受）**：3 用例全 mock `_invokeInternal`，旁路后与池的真实交互零覆盖——严重 1 正从此缺口漏入。修复：补不 mock `_acquirePooled` 的池层用例。

**建议 3（注释/文档口径，接受）**：ALS 旁路的隐式安全契约补全；handoff 论证更新。

### 修正后方案（双管）

**① 压缩合成改走影子通道**（检视推荐方向的落地）：
- `SdkInvokePort` 新增 `runCompactionSynthesis(otterId, prompt)`：`SessionManager.inMemory()` 临时 session 直调 LLM——自包含合成 prompt 无需会话历史，**不入池、不触锁、不写共享 jsonl**，与外层 streaming session 零交互
- 不挂 customTools：合成纯文本直出（speak 等副作用工具在压缩中途触发必错消息归属）；readOnly 白名单（F20260901mbfx）本就是零信任防御，不提供工具不影响合成质量
- `buildCompactionSynthesisFn` 改调影子通道（保留空结果/截断 fail-closed 防线）
- 已知妥协：无熔断/outputGuard 守卫（60s 超时防线在 compaction-hook 层）

**② `_acquirePooled` streaming 分支增加嵌套保护**：
- 嵌套 invoke（ALS store 同 otterId）遇 streaming session → **抛错降级**（调用方 catch → Pi 默认），**不得 stale 出池顶替外层活 session**
- 真并发（无 store / 异 otterId）遇 streaming → stale 出池语义不变（#599 防御保留）

**保留**：invoke 入口 ALS 锁旁路（判定本身正确，且为 handoff 合成等嵌套 readOnly 场景提供死锁免疫——handoff 嵌套若撞上 streaming 现在走②的抛错降级，行为正确）。

### 验证（修正后）

- nested-invoke-lock-bypass.test.ts 扩至 5 用例：锁层 3（旁路/真并发排队/异獭不旁路）+ 池层 2（嵌套撞 streaming 抛错不出池不顶替 / 真并发 stale 出池不变）
- 全量 254 文件 3181 用例通过；tsc/eslint clean
