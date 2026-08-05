---
id: F20260805olc4
title: otter-lifecycle-capability-tests
doc_type: feature

summary: |
  能力测试批次 2：獭生命周期三件套——restart 全链路、身份注入、speak 协议合规（真系统 + 真 LLM）。
  restart 是真实事故点（F20260805rsto 双层 session 断裂），三层（agent/domain/记忆）联动只有真系统能验证。
  断言分层：账本/记忆转换等确定性断言保持严格；LLM 行为用统计采样（F20260805mspk）。
  调试发现 waitForOtterMessage 必须等"回合终局"而非"第一个终态消息"——speak 未收尾的失败会触发
  系统自动重试（F20260730sbrt）且重试常成功，修正后 speak 采样合规率 3/3。

causal_links:
  from:
    - F20260805capt   # 能力测试层骨架
    - F20260805rsto   # restart 事故（本批测试的事故回归点）
    - F20260805mspk   # mimo speak 协议不稳定（统计断言依据）
    - F20260730sbrt   # speak-retry 机制（waitForOtterMessage 语义来源）
  to: []

status: implemented
change_type: feature
tags: [test, capability-test, otter, restart, identity, speak, session]
modules:
  - tests/capability/otter-lifecycle.capability.test.ts
  - tests/capability/helpers/session-file.ts
  - tests/capability/helpers/assert-behavior.ts
---

# F20260805olc4: 獭生命周期能力测试

## 三个用例

### 1. restart 全链路（真 PiSessionFactory + 真 LLM）

建对话（自动建大獭）→ 真实对话一轮 → POST /api/otters/:id/restart → 断言：

- **账本（严格，确定性）**：旧行 restarted + archiveReason=restart + summary；
  新行 active + previousSessionId 建链 + summary 双写；DTO 返回新行 id（F20260805rsto 全部事故形态）
- **记忆层转换（严格）**：该对话 memory_entries 全部 working → historical
- **新獭生可用（行为）**：restart 后再发消息，真 LLM invoke 走到 completed

### 2. 身份注入

读取 pi session jsonl（agent_sessions.session_file 定位，解析集中于
`helpers/session-file.ts`——SDK 格式变化只改一处）：

- 首条用户消息携带 BIG_OTTER.md 身份前缀（标记「海獭团队的头儿」，有意的文案存在性守护）
- 第二轮对话后身份标记仍只出现一次（不重复注入）

### 3. speak 协议合规（统计采样）

3 次采样 ≥1 次合规：speak 工具调用 + body 非空 + 发言石目标 ∈ 合法集合。

## 关键调试发现：回合终局 ≠ 第一个终态消息

初版 `waitForOtterMessage` 取第一个终态獭消息，speak 采样 1/3 合规（2/3 failed）。
诊断发现：那 2 个 failed（"未调用 speak 工具结束发言"）之后**系统自动重试并成功了**——
同一对话里 failed（首试）与 completed（重试）两条獭消息并存。修正为：优先返回 completed；
仅当最新终态连续 3 次轮询不变（无重试迹象）才接受 failed/aborted。

修正后 speak 采样 3/3 合规。**产品含义**：mimo 首次 speak 遵从率虽不稳（F20260805mspk），
但 speak-retry 机制（F20260730sbrt）有效兜底，用户视角的回合成功率显著更高。

## 验证

- 能力套件累计 6/6 绿（本批 3 + memory-recall 3）
- restart 用例 6s、身份注入 4s、speak 采样 16s（3 轮）
- A 类套件无回归：85 文件 / 1045 用例
