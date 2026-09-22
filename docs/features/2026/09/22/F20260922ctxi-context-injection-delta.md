---
id: F20260922ctxi
title: 上下文注入面 delta 化——会话摘要/工作区首轮注入、名册按变化注入、触发消息去重、batchMaxSeq 游标透传修复
summary: "搭档审视 invoke session 发现用户消息过长，逐项排查上下文注入面得三个问题：①会话摘要每轮重复注入（换世情报应首轮一次）②dispatch 包装恒定内容每条重复+触发消息双份注入③三处 invokeFn 闭包漏传 batchMaxSeq 致游标不推进、未读重复注入。合并修复：首轮情报包 + 每轮 delta 的双层注入模型。"
change_type: fix
capability_test: "n/a: 纯代码变更（消息组装层），未触碰 prompt/skill/tool description；回归证据=新增 8 用例 + 全量单测 3666 过"
created_in_conversation: b96c3215-f614-4417-93f9-c81c74c86e94
created_at: 2026-09-22T09:45:00+08:00
tags: [context-injection, dispatch, cursor, delta-injection, session-summary]
modules: [src/interface-adapters/, src/usecases/conversation/, src/frameworks/agent/, src/usecases/ports/, src/usecases/recruiting/]
---

# 上下文注入面 delta 化（F20260922ctxi）

## 追加：方案 A 合并发言流（2026-09-22 11:13 搭档拍板）

搭档审视消息形态后定性「这个不应该叫任务，这其实就是发言呀，别人的发言、我的发言、系统消息」——
一切皆发言（聊天室模型），「## 当前任务」是错误叙事（对「hi」型触发误导为工单姿态，对系统通知类
触发词不达意），且与「对话历史」构成同质内容两顶帽子的叙事割裂。拍板：**方案 A 合并发言流，本次
（PR #1094）一起修复**。

**变更**：删「## 当前任务」段，触发发言（userMessageContent，自带 [sender]/[系统] 前缀）直接追加
发言流末尾（\`## 对话历史（你上次发言后的消息）\` 时间序流）——最新=天然焦点，链内 hop 2+ 语义统一为
「流末尾=本次要响应的发言」。触发消息去重（排除未读批）不变。

**Modification-Class: deletion**——删除「任务叙事」段机制；其原始问题（焦点引导）由「流末尾=最新」
天然承担，无回归。

**形态对比**：
- 旧：\`## 对话历史\n[历史未读]\n## 当前任务\n[user] hi\`（两段两顶帽子）
- 新：\`## 对话历史（你上次发言后的消息）\n[历史未读]\n\n[chen] hi\`（单一发言流）

**测试**：dispatch-chain-engine.test.ts 断言面 5 处同步（结构断言改流形态，去重断言不变）。

## 背景与问题现象

搭档点击 Session 弹窗发现每次 invoke 的「用户消息」都是一大段，逐层追问「这到底是 agent.prompt 入参还是全量 LLM request」。排查后搭档逐项定性并拍板（2026-09-22 原话「1/2/3合并一个pr修复好」）：

1. **会话摘要每轮重复注入**：「这些内容明明应该只是换世首轮注入的，现在每一轮invoke都要触发，这非常错误」
2. **dispatch 包装恒定内容重复**：「有变化的才注入，为什么每次都注入完全一样的东西？」
3. **未读游标疑点**：「你说的另外一个小疑点你排查清晰」

实证数据（本对话 session `01a0c695`，三条 user 消息逐段 dump）：

| user# | 总长 | 会话摘要段 | 对话历史段 | 当前任务段 |
|---|---|---|---|---|
| #1 | 1048 | 636（前世档案） | 112 | 62 |
| #2 | 1157 | 636 **逐字节相同** | 194（含 #1 已注入的两条重复） | 89 |
| #3 | 1400 | 636 **逐字节相同** | 269 | 257（**与对话历史同文双份**） |

## 根因分析

### ① 会话摘要每轮注入
- `src/interface-adapters/agent-runtime/agent-invoker.ts`（原 :739-741）：`buildDynamicContext` 每次 invoke 读 `session.summary` 无门控拼入 user 消息（`session-helpers.ts` buildMessageWithContext 的「## 会话摘要」段）
- 换世情报（前世档案，实测 636 字符）在 session 历史里 N 轮线性堆积，每轮 LLM request 全量重发

### ② dispatch 包装恒定内容重复 + 触发消息双份
- `src/usecases/conversation/dispatch-chain-engine.ts`（原 :804/:826）：名册（roster）每条消息无条件拼接——同一对话同一獭的名册逐字节相同却重复注入
- `pendingPreview` 死代码（恒 null，F20260908rlcp 已退役）残留在模板
- 触发消息既在「对话历史（未读批含它）」又在「当前任务」全文注入——实测 user#3 同文本 269+257 字符双份
- 对话工作区路径恒定不变（147 字符）每条重复

### ③ 三处 invokeFn 闭包漏传 batchMaxSeq（游标不推进）
- `src/interface-adapters/http/controllers/invoke-controller.ts`（原 :159-170）：retry 路径闭包重组字段漏传
- `src/interface-adapters/http/controllers/message-controller.ts`（原 :355-365）：dispatchTurnLoop 闭包同款漏传（降级/直连路径）
- `src/usecases/recruiting/process-inbound-recruit.ts`（原 :246-249）：解构丢弃 batchMaxSeq
- `src/usecases/ports/agent-turn-port.ts`：port 签名缺 batchMaxSeq 声明（实现早已支持，声明缺失使 recruiting 路径无法透传）
- 后果链：`pushCursorOnStartup`（pi-session-factory.ts:684-686）条件 `batchMaxSeq !== undefined` 永假 → `updateLastReadSeq` 不执行 → 下轮 `getUnreadEntries`（sqlite-entry-repository.ts:302）重复返回已注入条目
- 实证：00:48 手动重试（user#1 未读=[⏳✅]）游标停在 1 → 00:51 user#2 未读又带 [⏳✅+新消息] 三条；游标轨迹 1→1(retry 丢)→11(普通路径正常)→16 与 `conversation_participants.last_read_seq=16` 精确吻合

## 修复（一个 PR 两 commit）

**c1 narrow-fix**：三处闭包补 batchMaxSeq 透传 + agent-turn-port 签名补齐。
**c2 scope-reduction**：
- 换世首轮判定 `shouldInjectSessionPreamble`（session-helpers.ts，纯函数：session 无 user 消息=首轮）——`buildDynamicContext` 据此门控 sessionSummary + workspacePath（后者移入同函数，首轮注入组）
- 名册 delta 注入：dispatch-chain-engine 进程内快照（`consumeRosterSegment`），内容未变不拼接、变化重新注入
- 触发消息去重：executeOneHop 将 triggerMessageId 并入未读排除集（幂等：非 entry id 不命中）
- pendingPreview 死代码删除

## 影响范围

- 全部 invoke 路径的 user 消息结构（首轮含前情情报包，后续轮次为增量 delta）
- F20260818cbkr 红线核验：熔断 restart / 水位交接后均为新 session（无 user 消息）→ 首轮判定真 → 摘要照常注入 ✓
- F20260829cach 语义保留：分钟级时间每轮注入（每分钟变化=「有变化才注入」合规，新鲜度补偿不受影响）

## 预期 vs 实际对照

- 预期「游标机制有系统性 bug」→ **偏离**：普通路径（signal-router 直传 app.ts:354）完全正常，实证数据（user#2 推 11、user#3 推 16）推翻全称判断；逐步收敛为「三处闭包重组路径漏传」局部缺陷
- 预期「未读计算口径错误」→ **反转**：dump 实证 user#3 未读=[触发消息单条]，口径正确，重复的真凶是 retry 不推游标 + 触发消息双份
- 排查中两次推断被数据推翻（一度怀疑双 prompt 重燃、一度怀疑 SQL 写值 bug），最终以 session jsonl + DB + 代码三方吻合收口

## 设计取舍

**机制识别检查点判定**（issue/指令驱动未经 RA，动手前完成）：清单命中「新增状态生命周期」边缘项（名册进程内快照 Map）。为何命中但不涉净新增机制：快照是纯运行时缓存（进程内存、无持久化、无创建→销毁管理、重启丢失即自然重建全量注入），等价于跨消息保留的局部变量，不构成清单意义上的状态生命周期与被记住的决策分支；其余变更均为既有语义内修（batchMaxSeq 透传）与管辖收窄（首轮/delta 注入），整体走修法排序①②，非④。

**负面向条目（本次变更破坏了什么旧契约/绕过了什么既有保护）**：
1. 「每条消息自带完整前情」契约收窄为「首轮自带 + 历史可溯」——若 compaction 把首轮前情压缩掉，非首轮消息不再自带摘要，前情依赖 compaction 合成摘要保留要点（pi shouldCompact 合成语义）；极端场景（合成质量差）前情可能变薄——接受，因每轮重复是确定性浪费，compaction 风险是概率性的
2. 「每条消息自带完整名册」同理收窄为 delta——进程重启后首条消息重新全量注入（多注入一次，无损）；compaction 后名册丢失风险同上
3. workspace 路径只首轮注入——后续轮次靠历史/工具返回值可溯

**最简实现检查**：已过。纯函数判定 + stdlib Map 快照，无新依赖、无新框架、无新配置项；未引入「注入状态持久化」等更重方案（otter_context 消费即删备选被弃：需额外写删状态，首轮判定复用现成 readCurrentSessionEntries 零新状态）。

## 验证

- **失败/通过双证据**（bugfix 硬规则）：`git stash push -- src` 回退实现保留新测试 → **7 failed | 38 passed**（shouldInjectSessionPreamble×4、名册 delta、触发去重、batchMaxSeq 透传断言）；恢复后 **45/45 passed**（dispatch-chain-engine + session-helpers + dispatch-turn-loop 三文件）
- **全量回归**：3666/3667 passed；tsc --noEmit 清零
- **pre-existing 声明证据**：唯一失败 `tests/scripts/validate-commit-date.test.ts > dual-base 定稿改名场景`——`git stash -u` 干净基线复跑**同一用例同样失败**（1 failed | 31 passed），与本次变更无关（疑为日期敏感测试，另议）
- **Golden Gate**: n/a（verify 向纯代码变更，未触碰 prompt/skill/tool description，无 golden 场景可跑）
- **锚点重放评审**: n/a（未改动行为触发语义的 prompt/tool description；消息组装结构调整的行为面由上述单测覆盖）
- 首轮判定的 agent-invoker 门控接线无独立集成用例（构造 AgentInvoker 全装配 mock 成本超收益）——由 tsc + 纯函数单测 + code review 覆盖，记入最简检查结论
