---
id: F20260724skch
title: skill-tool-channel-consolidation
doc_type: feature

summary: |
  根治"speak 后 loop 不停止"反复修不好的问题，重点发现是信道分层混乱：
  1. Pi SDK 的 skill 是懒加载机制——系统提示只注入 name+description+路径，
     SKILL.md 全文需要模型用 read 工具主动加载；小獭无 read 工具，skill 全文
     对其物理不可达。多次调整 speak skill 无效的本质：编辑的是模型看不到的文档。
  2. speak 工具 description 写着"调用后 agent loop 继续运行"——机制描述被模型
     当作行为指令，与 skill/返回值三方信号互相矛盾。
  治理：删除 5 个 1:1/策略型 skill，硬规则归位 SYSTEM.md（每次必达），工具用法
  归位 tool description（与工具同生共死），skill 只保留 3 个真正的复杂工作流；
  小獭开放 read 工具。附带修复两个 abort 缺陷：SDK 吞 abort 后误入 speak 重试、
  message.aborted 事件缺身份字段导致中断气泡显示 "Otter"。

causal_links:
  from:
    - F20260724regd

status: draft
change_type: fix
tags: [skill, tool, prompt-channel, speak, abort, system-prompt, pi-sdk]
modules:
  - .pi/
  - src/interface-adapters/agent-runtime/
  - src/frameworks/agent/
  - api-contract/sse/
  - web/src/pages/conversation/

created_at: 2026-07-24
---

# F20260724skch Skill/Tool 信道治理 + Abort 缺陷修复

## 术语定义

| 术语 | 定义 |
|------|------|
| **信道（channel）** | 规则/知识到达模型上下文的途径；按可达性分为"每次必达"与"按需可达" |
| **tool description** | 工具 schema 中的描述字段，每次 LLM 请求全量在上下文中（必达信道） |
| **skill（Pi SDK）** | `.pi/skills/*/SKILL.md`，懒加载：系统提示只有一行索引，全文需 read 工具加载（按需可达） |
| **1:1 skill** | 内容与单个工具用法强绑定、三五百字可说清的 skill——属于理解偏差，应折叠进 tool |

## 重点发现

### 发现 1：Pi skill 是懒加载，SKILL.md 全文默认不在上下文

Pi SDK `formatSkillsForPrompt`（node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js:257）只向系统提示注入：

```
<available_skills>
  <skill><name>...</name><description>...</description><location>...</location></skill>
</available_skills>
"Use the read tool to load a skill's file when the task matches its description."
```

两个致命推论：

1. **多次调整 speak SKILL.md 无效的本质：编辑的是模型看不到的文档。** 全文需要模型自己判断"任务匹配"并主动 read——行为规则恰恰是不能依赖模型自觉加载的。
2. **小獭 `codingTools: []`（无 read）→ skill 全文对其物理不可达。** 而小獭正是 speak 规则最主要的约束对象（它两次未调 speak）。同理，文档称"小獭执行 code-implementation/adversarial-review 等实质性工作"，但无 read 既无法加载工作流 skill 也无法读代码——设计自相矛盾。

### 发现 2：tool description 是矛盾信号源

speak 工具 description 原文（tool-factory.ts）：

> "声明本次发言内容和发言石目标。**调用后 agent loop 继续运行直到结束**，消息才真正完成。"

这是对两阶段提交机制的**系统视角**描述，但模型读作**行为指令**。三方信号互相矛盾：skill（不可见）说"结束后别回应"、description（必达）说"loop 继续运行"、返回值说"直接结束本 loop"。模型遵从了必达信道。前几轮修复都在调 skill 和返回值，从未触及这个最上游的信号源。

### 发现 3：abort 路径两个独立缺陷

1. **SDK 吞掉 abort 正常返回 → 误入 speak 重试**：agent-invoker.ts 有注释"invoke 正常返回后检查 abort（SDK 可能不抛错）"但检查代码从未实现。用户点击中断后，消息停在 streaming → 触发 speak 重试 → 发出"你必须使用 speak 工具"系统消息。
2. **中断气泡显示 "Otter"**：前端 `stopStream` 乐观删除 streaming entry，`message.aborted` 事件（只带 messageId）到达时无法解析发送者身份 → fallback 成 "Otter"。

## 信道分层原则（本次治理确立）

| 内容性质 | 位置 | 可达性 |
|------|------|------|
| 无条件遵守的硬规则 | SYSTEM.md / tool description | 每次必达 |
| 工具用法契约（是什么、参数、调用后行为） | tool description + 参数描述 + 返回值（三位一体） | 每次必达 |
| 复杂任务的程序化 know-how（多步骤、需判断、references 渐进披露） | skill | 按需可达（需 read 工具） |

**防再犯口诀**：改行为规则前先问"这条规则在哪个信道上？模型每次都能看到它吗？"

## 决策记录

| 决策点 | 结论 | 理由 |
|------|------|------|
| 5 个 1:1/策略型 skill（speak、participant-management、history-query、key-resources、memory-recall） | **删除**，内容归位 | 1:1 skill 是理解偏差；其内容简单且需无条件遵守，懒加载信道错误 |
| 硬规则去向 | SYSTEM.md 新增"信息查询""关键产出记录"两节 | 每次必达；保持精简（SYSTEM.md 全量注入，不能膨胀） |
| 工具用法去向 | 各 tool description 增强（speak/get_active_participants/search_memory/update_artifact_status/list_messages/search_messages） | 工具自文档化，与工具同生共死，单一信号源 |
| 保留 skill | adversarial-review、code-implementation、requirement-analysis | 真正的复杂工作流，含 references/ 渐进披露，是 skill 机制的设计目的 |
| 小獭工具策略 | codingTools `[]` → `["read"]` | 可加载保留的 skill 全文、读代码做实质性工作；write/edit/bash 不开放（权限最小化） |
| speak 后 loop 结构化强停（speak 执行成功→运行时强制终止 loop） | **本次不做，留作后续** | description 修复是概率性的（依赖模型配合）；结构化方案由系统保证"speak 即终止"，参考 circuit breaker 的 session.abort() 先例，另立 feature 评估 |
| message.aborted 身份 | 事件携带 otterId + otterName（服务端解析），前端以事件为准 | 投影原则：前端是后端状态的投影，不靠本地残留状态补偿 |

## 改动清单

| 文件 | 改动 |
|------|------|
| `.pi/skills/{speak,participant-management,history-query,key-resources,memory-recall}/` | 删除（git rm） |
| `.pi/SYSTEM.md` | 新增"信息查询""关键产出记录"两节 |
| `tools/tool-factory.ts` | speak description 重写（"回合最后动作"，删除"loop 继续运行"矛盾表述）；get_active_participants/search_memory 描述增强 |
| `tools/message-tools.ts` | list_messages/search_messages 描述吸收查询策略 |
| `tools/artifact-tools.ts` | update_artifact_status 描述吸收生命周期规则 |
| `src/frameworks/agent/session-helpers.ts` | small otter codingTools → `["read"]` |
| `agent-invoker.ts` | 消息状态检查后、speak 重试前插入 abort 标记检查（放在状态检查之后，保留"speak 已成功 vs abort 竞态→正常完成"语义）；message.aborted 事件携带 otterId/otterName |
| `api-contract/sse/events.ts` | message.aborted + otterId/otterName |
| `web/src/pages/conversation/index.tsx` | message.aborted 身份以 SSE 事件为准 |
| `tests/interface-adapters/agent-invoker.test.ts` | 新增"SDK 吞 abort 不触发 speak 重试"用例 |

## 测试计划

- 单元：agent-invoker 中断路径（SDK 正常返回 + streaming + abort 标记 → message.aborted、无 sendSystem、无 message.failed）；既有"abort 后 invoke 成功→正常完成"竞态用例不回归
- 手工验收：
  1. 发言过程中点击中断 → 出现"[用户中断]"气泡（名称正确），**不再**出现"你必须使用 speak 工具"系统消息
  2. 大獭/小獭 speak 后 loop 停止（观察 tokenUsage 是否还有 speak 后的多余生成）
  3. 小獭能 read 文件/skill，不能 write
  4. 启动日志 `ResourceLoader discovered 3 skill(s)`

## 验收标准

- [x] 中断不触发 speak 重试系统消息
- [x] 中断气泡发送者名称正确
- [ ] speak 后 loop 停止（概率性修复，若复发则启动结构化强停 feature）
- [x] skill 从 8 减至 3，硬规则全部位于必达信道
- [x] 全部既有测试通过（535），新增中断路径用例
