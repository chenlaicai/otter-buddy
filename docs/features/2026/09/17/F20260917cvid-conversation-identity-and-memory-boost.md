---
id: F20260917cvid
title: 对话身份注入（对话标题）+ 记忆检索本对话加权
summary: >
  海獭身份注入新增「你所在的对话」段（注入对话标题），让每只獭（含被召唤的小獭）
  一醒来就知道自己身处哪个对话，几十世长对话的主题认知不再依赖搭档每次口头告知；
  记忆检索 rerank 阶段新增本对话来源条目乘法加成（默认 ×1.5，可配置），
  本对话历史在跨对话记忆中排序上浮。
change_type: feature
capability_test: n/a（检索排序与身份注入分支由单测钉住；端到端效果依赖真实 LLM 长期观察，无可重放场景）
created_in_conversation: 55eb8442-0169-48b9-9edb-942b6cc94d1e
modules:
  - src/frameworks/agent/identity-builder.ts
  - src/frameworks/agent/pi-session-factory.ts
  - src/bootstrap/platforms.ts
  - src/usecases/memory/search-engine.ts
  - src/usecases/memory/search-memory.ts
  - src/frameworks/config-service.ts
  - src/usecases/ports/otter-tool-client.ts
  - src/bootstrap/clients.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
intent:
  problem: >
    海獭不知道自己在哪个对话（身份注入只有裸 conversationId UUID，无语义），
    且记忆检索对本对话来源条目无任何优先级——长对话几十世同一主题，
    本对话昨天的结论可能排在三个月前其他项目讨论之后，搭档需每次口头告知项目上下文。
  expected_effect: >
    身份注入含「你所在的对话」段（对话有标题时）；search_memory 结果中本对话来源
    条目 finalScore ×1.5 上浮，跨对话知识保留可见只是排序下沉；debug=true 时
    conversationBoost 系数可见。
  verify_by:
    type: behavior_check
---

# 对话身份注入（对话标题）+ 记忆检索本对话加权

## 背景

搭档原话（意图锚）：

> 「有时候在一个对话中，我会长期、多次的和你对话，可能涉及到你几十世……比如说 echo agent 的对话中，其实就是都在处理 echo agent 项目。但是好像，海獭们不知道自己在哪个对话？以及，我认为，本对话的历史消息在所有的长期记忆中，权重应该要更高一点点。」

现状核实（2026-09-17）：

- 身份注入有「当前对话 ID」（identity-builder.ts），但只是裸 UUID 且语义绑定写文档 frontmatter——獭手里有一串 UUID 但不知道这个对话叫什么、是什么主题。
- `search_memory` 的 `conversationId` 参数是**过滤器**（filter 语义），且工具层从不传——RRF 排序对所有对话来源一视同仁。

## 设计取舍

### 搭档拍板的关键决策

1. **只注入 title，不注入 summary**：「既然对话没有 summary 那就不要乱填吧，我觉得带上 title 就好」——对话无标题（空串/纯空白）时不注入对话段，不编造、不降级为其他语义。
2. **A+B 一次做完**：「A 的工作量非常少，没必要单独做」——对话身份注入与本对话加权同 PR 交付。

### 加权位置与形态（技术拍板，L1）

- **rerank 阶段乘法加成**，与 `userFlagMultiplier` 同型同位置：`finalScore = rrfScore × timeDecay × frequencyBoost × userFlag × conversationBoost`。RRF 融合阶段不动——本对话条目先在相关性上公平竞争，再在排序上获得语境加成。
- **乘法而非加法**：与既有系数族（userFlagMultiplier/frequencyBoost）保持同型，排序语义一致。
- **系数默认 1.5**：「权重高一点点」的量化。时间衰减半衰期 7 天的条目，×1.5 ≈ 补回约 4 天衰减（ln1.5/ln2×7≈4.1）——本对话一周内的讨论大约压过同等相关性的一两周前跨对话条目，但不会窒息跨对话召回（跨对话高分条目仍可见，只是下沉）。配置项 `memory.currentConversationBoost` 可调，设 1.0 即完全关闭。
- **新参数 `currentConversationId` 与既有 `conversationId` 过滤器并存**：语义不同（排序加成 vs 过滤），改名风险大于并存成本。
- **注入点在 agent 工具层**：`ctx.conversationId` 系统注入不可伪造；Web 端搜索页（HTTP 路径）不传，行为不变——Web 端是跨对话浏览场景，不应加权。

### 机制识别检查点（本特性未经 RA 流程，issue/对话驱动）

- [x] 是否新增机制？——rerank 新增一个乘法系数，属**既有权重重排机制内的参数扩展**（与 userFlagMultiplier 同型），非净新增机制；身份注入新增一个身份段，属既有身份段家族（搭档身份/召唤者身份/模型身份）的同型扩展。一行记录：**不涉及净新增机制**。

## 涉及文件与改动

| 文件 | 改动 |
|---|---|
| `identity-builder.ts` | 构造函数加 `conversationRepo`（可选）；新增 `buildConversationIdentity`——查对话标题，注入「你所在的对话」段；无标题/查不到/未装配时降级空段 |
| `pi-session-factory.ts` | cfg/config 加 `conversationRepo` 透传 |
| `platforms.ts` | 装配 `repos.conversation` |
| `search-engine.ts` | `SearchEngineConfig` 加 `currentConversationBoost`；`rerank` 加第三参 `currentConversationId`，命中条目乘系数 |
| `search-memory.ts` | `SearchQuery` 加 `currentConversationId`；透传 rerank；debug 注入 `conversationBoost` 系数 |
| `config-service.ts` | `memory.currentConversationBoost` 配置项，默认 1.5 |
| `otter-tool-client.ts` / `clients.ts` | `memory.search` 第 8 参透传 |
| `tool-factory.ts` | `search_memory` execute 自动注入 `ctx.conversationId` |

## 验证

- `npx tsc --noEmit` 全绿
- 全量单测 265 文件 3572 用例全绿
- 新增测试：
  - `search-engine.test.ts`：本对话条目 ×1.5 / 其他对话与 null 不受影响 / 不传参时与旧行为逐分一致
  - `identity-prefix.test.ts`：有标题注入 / 纯空白标题不注入 / repo 未装配降级 / conversationId 不存在降级
  - `search-memory-tool.test.ts`：工具层自动注入 ctx.conversationId（第 8 参）
- eslint 零 error（新增 3 处 disable 均附理由：DI 6 参、rerankAndReturn 超行、config-service 超行——均为既有豁免模式的同型延续）
- **最简实现检查**：已最简——身份注入复用既有 ConversationRepository.getById；加权复用既有 rerank 系数模式，无新表无新索引无迁移
- **负面向验收**：本次变更未破坏任何旧契约——rerank 不传第三参时与旧行为逐分一致（测试钉住）；identity-builder 不传 conversationRepo 时行为与旧版一致（测试钉住）；Web 端搜索路径不传 currentConversationId 行为不变
- Golden Gate: n/a（golden 五场景无对话身份认知/记忆加权场景，无可重放场景——身份注入段确属 prompt 层产出，但无对应锚点可跑，豁免理由以此为准）
- 锚点重放评审：n/a（不涉及 SYSTEM.md 或核心 skill 文字内容）

## 已知边界与后续

- **1.5 系数是拍脑袋起点**：真实效果需搭配记忆评估基线（F20260826rcmm 检索埋点已落）长期观察；若出现跨对话知识被窒息的反馈，调低或设 1.0 关闭。
- **文档条目无 conversationId 不加权**：feature/research chunk 的 conversationId 为 null（文档是跨对话资产），frontmatter 有 created_in_conversation 但检索条目不携带——本期不做文档维度的本对话加权，message/fact 等对话产物已覆盖主诉求。
- **定时任务场景**：定时任务触发的 invoke 也有 conversationId，本对话加权同样生效——符合预期（定时摘要类任务本就该优先本对话语境）。
