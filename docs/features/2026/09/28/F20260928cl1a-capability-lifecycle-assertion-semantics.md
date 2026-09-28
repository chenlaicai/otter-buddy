---
id: F20260928cl1a
title: capability otter-lifecycle 两断言语义更新（#1186：restart 档案化 + 身份 system 注入）
change_type: fix
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
intent:
  who: 本机跑 capability 测试（Golden Gate）的开发者与 PR 自检流程
  problem: "otter-lifecycle 两个用例在真跑（真系统+真 LLM）持续失败（PR #1164/#1167 验证期间均复现），capability 套件的两个红灯悬着持续污染验证面（issue #1186）"
  trigger: "搭档勾选 #1186 开工：「这三个都很严重啊，逐个来」"
  expected_effect: "两个用例断言对齐当前架构语义（restart 统一交接管线的档案化 summary + 身份 system role 注入），本机真跑 3/3 全绿且连续复跑稳定"
  verify_by:
    type: capability_test
    reason: "测试断言语义更新，验证=受影响文件真跑全绿（真系统+真 LLM）"
summary: "#1186 两根因判定均为「断言滞后于有意语义变更」，非产品回归：① restart summary 双写——#1146/F20260920uhuc 统一交接管线下，手工 selfSummary 以 ① 交接意图书 原话层嵌在叠加式档案内（F20260917rsta 搭档语义「填了就按我的」的实现形态），断言从 toBe(裸文本) 改为档案结构断言（含 ① 层 + 原话 + 双写同源不变量保留）；② 身份注入——F20260810piab S1 早已把身份从 user message 迁到 system role（before_agent_start handler，不持久化），断言改为行为证据（模型自称身份标记）+ 架构不变量（用户消息不含身份前缀）。附带发现：#886 删除 indexMessage 后消息→记忆链路无替代（生产库 9/13 后 message 类记忆零新增），测试改显式构造种子，产品侧另立 issue 跟踪。"
tags: [capability, test-infra, restart, identity, unified-handoff]
capability_test: "tests/capability/otter-lifecycle.capability.test.ts 真跑全绿（连续两次 3/3：/tmp/cap-run7.log、cap-run8.log，speak 采样 3/3 合规）"
causal_links:
  from:
    - F20260920uhuc
    - F20260810piab
    - F20260917rsta
    - F20260913ctlv
    - F20260928be9j
---

# capability otter-lifecycle 两断言语义更新（#1186）

## 背景

issue #1186：`tests/capability/otter-lifecycle.capability.test.ts` 两个用例在本机真跑持续失败，PR #1164/#1167 验证期间均复现。issue 按两根因拆分登记，要求先判定「有意语义变更还是产品回归」再动。

## 根因判定（两处均为断言滞后，非回归）

### 根因 1：restart summary 双写断言（:72/:76-77）→ 有意语义变更

**判定依据链**：

1. **搭档语义锚**（F20260917rsta，2026-09-17 搭档原话）：「我输入了那就按我的，我没输入就用默认的压缩 handoff 算法」——手工 summary 是显式需求，不可能被有意吞掉。
2. **架构现状**（#1146/F20260923hspx + F20260920uhuc 统一交接管线）：生产装配（`OtterController` 恒带 `agentInvoker`，`bootstrap/controllers.ts:175`）下 restart 走 `restartWithUnifiedHandoff`（`agent-invoker.ts:1418`）→ `unifiedHandoff` 组装**叠加式档案**（`narrative-synthesis-engine.ts` `assembleHandoffArchive`/`buildMechanicalArchive`）→ 整个 archive 作为 summary 传给 `restartSession`（`agent-invoker.ts:1109`）。
3. **手工 summary 的去向**：`selfSummary` 以 **① 交接意图书（触发方原话，不转述）** 层嵌在档案内——正是搭档语义的实现形态（「填了就按我的」= 原话独立保留，不被叙事合成转述）。
4. **真跑实证**：基线失败输出显示 oldRow.summary 是完整机械转储档案（含 `### ① 交接意图书` + 原话「前世摘要：寒暄过一轮」）——结构符合设计。

**结论**：`toBe("前世摘要：寒暄过一轮")` 断言的是统一交接管线之前的旧语义（裸文本透传）。这是 #1146 重构的有意变更，非产品回归 → 更新测试断言。

### 根因 2：身份注入前缀断言（:109）→ 断言滞后（issue 判断正确：与 #1146 无关）

**判定依据链**：

1. **架构现状**（F20260810piab S1，早在 8/24 前已落地）：身份前缀由 `before_agent_start` extension handler（`model-runtime-registry.ts:120`）从 ALS store 读取并注入 **system prompt**（`buildBeforeAgentStartResult`），不持久化到 session jsonl，也不拼在 user message（`buildMessageWithContext("", ...)` 的 staticPrompt 参数恒为空串，`session-helpers.ts:338`）。
2. **`isFirstInvoke` 已死**：`pi-session-factory.ts:639` 仍构造该标志，但 src 全树无消费者（grep 确认）——身份注入改为「每次 invoke 重建 system」。
3. **生产 session 实证**：9/28 生产 session jsonl（`data/sessions/2026-09-28T06-54-50-*.jsonl`）首条 user message 只含动态上下文（工作区/在场成员/对话历史），无身份前缀；文件中「海獭团队的头儿」的 12 次命中全部来自 toolResult 内容（如 issue 正文），非身份注入。
4. **SDK 行为**：pi-coding-agent 的 session jsonl 不持久化 system prompt（session-manager.js 的 append 系列无 system 条目类型）——**session 文件里抓不到身份**，这是设计事实。

**结论**：断言「首条用户消息含身份前缀」检测的是 8/24 之前的旧架构。issue 里「归因 #1146 证据不足，独立根因待查」的判断正确——真实根因是 F20260810piab 的架构迁移，测试从未跟上 → 更新测试断言。

## 方案

纯测试侧语义更新（narrow-fix，零生产代码改动）：

### 用例 1（restart 全链路）

- summary 断言改为**档案结构断言**：`toContain("前世档案")`（叠加式结构头）+ `toContain("### ① 交接意图书")`（手工 summary 的层）+ `toContain("前世摘要：寒暄过一轮")`（原话保留）。不锁档案全文（合成内容非确定）。
- **双写不变量保留**（F20260805rsto 语义）：`newRow.summary === oldRow.summary`（同一次 `restartSession(archive)` 写入，同源）。
- **记忆转历史步骤修复**：原断言隐式依赖「对话消息自动写入 working 记忆」——该链路已被 #886 删除 `indexMessage` 后中断（见「附带发现」），改为**显式构造种子**：经真实装配的 `repos.memoryWriter.storeEntry` 写入该对话的 working 记忆，验证 restart 管线自身的转换职责（`archiveSessionCore` 第 5 步 `updateLayer`，`manage-session.ts:180`）。

### 用例 2（身份注入）

断言面从「session 文件里的 user message 前缀」改为两面：

- **断言面 A（行为证据，真 LLM 独立可验）**：引导模型自称身份标记（「逐字包含『海獭团队的头儿』」），断言回答 `content` 含标记——身份经 system 注入生效的行为闭环。第一、二轮各验证一次（system 每次 invoke 重建注入，不依赖 session 历史恢复）。
- **断言面 B（架构不变量）**：用户消息不携带身份前缀——从 jsonl 提取 `content[0].text` 纯文本（新增 `extractUserText` helper，整行 JSON 序列化的嵌套转义会干扰包含性判定），剔除测试提问原文的合法回声（动态上下文的对话历史段会回显提问文本，其中含标记词——新增 `stripPromptEcho`），断言余文不含标记。

### 稳定性设计（针对 LLM 非确定性）

- 行为断言只断不变量（标记 token 出现），不断言措辞——遵守 helper 纪律（`assert-behavior.ts` 头注）。
- 提问显式要求「逐字包含、不要改写」：开发中实证「包含团队角色称呼」的模糊引导会被模型改写为「团队里的大獭」（第 5 次真跑），逐字引导后连续两次全绿。

## 附带发现（开 issue 跟踪）

**#886 删除消息→记忆索引链路后无替代**：`indexMessage`（B11：消息内容索引到记忆系统）随 messages 表族退役被整删（`git log -S indexMessage` 确认最后触点 b1d11c5f），生产路径再无调用者（grep 确认仅 MemoryIndexAdapter 实现存留）。生产库实证：`memory_entries` 中 message 类记忆最后一条停在 **2026-09-13T09:10**（#886 合入时段），此后零新增（9/14 后 fact 类 12409 条 vs message 类 0 条）。影响：search_memory 跨对话检索对话内容的能力实质退化（9/13 后的对话消息不可检索）。与 #992（#886 重构吞掉重启自动恢复）同款「重构吞功能」模式——能力退役没有独立拍板记录。另立 issue 跟踪产品侧恢复，本 PR 不承载。

## 验证

- 真跑（真系统 + 真 LLM，mimo-v2.6-flash）：`npx vitest run --config vitest.capability.config.ts tests/capability/otter-lifecycle.capability.test.ts`
- **连续两次 3/3 全绿**（/tmp/cap-run7.log、/tmp/cap-run8.log）：restart 全链路 18-26s / 身份注入 14-18s / speak 采样 3/3 合规
- 开发过程共 8 次真跑：基线复现 2 失败（run1/2）→ 修复迭代（run3-6，含记忆种子时机修正、回声剔除）→ 稳定全绿（run7/8）
- 最简检查：已过——纯测试断言更新，零生产代码、零新依赖；档案断言用 toContain 结构断言而非全文快照，是「锁语义不锁实现」的最简形态

## 设计取舍

- **不改生产代码**：两处判定均为有意语义变更（证据链见「根因判定」），改产品代码保旧断言反而会回退 #1146/F20260810piab 的架构成果。
- **`isFirstInvoke` 死代码不清理**：pi-session-factory.ts:639 的标志构造仍在（有 pendingIdentity 语义但无消费者）。清理属顺手扩面，超出本 issue 边界，留给后续（若检视要求可当场处理）。
- **提问原文含标记词的回声问题**：选择「剔除回声」而非「提问不含标记词」——后者会让行为断言退化为依赖模型自发引用身份（实证不稳定），前者保留显式引导。
