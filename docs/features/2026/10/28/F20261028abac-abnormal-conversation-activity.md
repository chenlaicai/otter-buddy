---
id: F20261028abac
title: 异常中断纳入对话列表最后活动
summary: 超时中断和调用失败已作为 invoke_end 异常终态落库并在时间线显示，但对话列表只取 user/speak/system，导致预览、时间与排序不刷新。将 aborted/failed 终态纳入同一最后活动查询，正常结束及其他边界条目保持原口径。
change_type: fix
created_in_conversation: 3995c48d-499a-4c2d-b04f-e3581a3d3e28
causal_links:
  - F20260807srts
  - F20260913ctlv
tags: [conversation, sorting, abnormal-terminal, ux]
modules:
  - src/frameworks/db/conversation/sqlite-conversation-repository.ts
  - tests/frameworks/db/conversation/sqlite-conversation-repository.test.ts
created_at: 2026-10-28
---

# F20261028abac：异常中断纳入对话列表最后活动

## 预注册

- 预期根因方向：异常中断消息已落库，但未走会刷新会话时间的同一写入路径。
- 验证标准：能对上具体消息类型的写入逻辑与左侧栏排序字段。
- 最强反例方向：数据库时间已更新，仅前端缓存或筛选不刷新；或异常中断根本没有生成任何可展示条目。

## 问题现象

搭档依据左侧栏最近时间排序识别需要介入的对话。海獭发言和部分系统消息会刷新最后活动；超时中断虽在中间栏可见，却不刷新左侧栏时间、预览和排序，使异常对话仍埋在历史位置。

## 根因与证据

1. 超时、输出保护和调用失败通过 `createInvokeEndEntry` 落为 `invoke_end`，真实终态写入 `metadata.invokeStatus=aborted/failed`，并非另写一条 `system` 条目（`src/usecases/conversation/send-entry.ts:442-490`）。
2. `listConversationsWithMeta` 的最后活动子查询原本只认 `user/speak/system`，预览、时间和 ORDER BY 全部复用该子查询（`src/frameworks/db/conversation/sqlite-conversation-repository.ts`）。因此异常终态被时间线展示、却被列表活动口径漏掉。
3. 生产库只读核验：`ui优化` 对话的 `4a7e082c-284d-4068-9ab8-7a1b66def014` 于 2026-10-27T11:02:38.975Z 记录「单次工具调用超时，已自动中断」，`metadata.invokeStatus=aborted`；同一对话最后可见活动仍是更早的发言。`写个小说` 的 `8c5ec13e-73af-4719-9101-ac2886852f51` 记录「生成过程超时，已自动中断」，也呈同样形态。
4. 前端每 5 秒以服务端列表为准合并，未另行丢弃异常时间；本次无需新增前端刷新路径。

**预期 vs 实际**：方向部分命中——异常已落库且被列表查询漏算；偏离之处是它并非独立 system 条目，而是 invoke_end 异常终态，因此修复点是现有列表活动查询，不是补写系统消息。

## 方案与设计取舍

- 沿用 `listConversationsWithMeta` 单一最后活动子查询，额外接纳 `invoke_end` 且 `json_extract(metadata, '$.invokeStatus') IN ('aborted','failed')` 的条目。
- `invoke_start`、`yield`、正常 `invoke_end` 仍不参与最后活动，避免日常生命周期事件顶起对话。
- 不新增 `conversations.updated_at` 写入链、不补重复 system 条目、不改 schema、不改前端 API；预览、时间和排序天然同源。
- 既有历史异常条目随列表刷新直接获得正确排序，无需回填生产数据。

### 机制识别检查点（动手前）

新增配置字段/枚举/开关：无；新增状态生命周期：无；新增定时任务/后台进程：无；新增信号类型/消息格式：无；新增持久化存储：无；新增持久化决策分支：无；新增跨模块调用路径：无。**全部未命中**，走修法决策树①既有活动语义内补，Modification-Class=`narrow-fix`，不涉净新增机制。

## 影响范围

- 超时/保护中断、invoke 失败会在下一次左侧栏轮询时成为最新预览并刷新排序。
- 用户手动中断也属于 aborted 终态，同样纳入；这是已经发生、需要知晓的对话活动。
- 未读计数不在本修复范围，继续沿用 speak/system 口径；本次只修最后活动、时间与排序。

## 验证

### 失败证据链

修复前在原始实现上运行新增回归：`npx vitest run tests/frameworks/db/conversation/sqlite-conversation-repository.test.ts` 得 **2 failed / 33 passed**：
- 异常对话 `conv-a` 被正常发言对话 `conv-b` 排在前面，复现排序不刷新。
- 失败终态未成为最后活动，返回旧发言时间。

第二用例初稿曾把旧发言放在失败之后落库，修复后仍正确地显示后落库发言；这是测试事件顺序错误，已按真实时间线改为「旧发言→失败」，未改变生产行为来迁就测试。

修复后同一测试文件 **35/35 passed**，新增断言覆盖：
- aborted 刷新时间、预览并推动跨对话排序；
- failed 同样刷新时间与预览；
- invoke_start、yield、正常 invoke_end 不抢占最后活动。

### 验收断言

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 自动超时中断 | 旧发言后落 aborted invoke_end，再查询列表 | 预览为中断正文，时间与排序按中断刷新 |
| 模型/锁等失败 | 旧发言后落 failed invoke_end | 预览为失败正文，时间刷新 |
| 正常生命周期 | 发言后落 start/yield/正常 end | 最后活动仍为发言，不被过程事件顶起 |
| 回归 | 运行 repository 测试与全量检查 | 全部通过 |

已过最简检查：沿用现有 metadata 与单条 SQL，无新表、新字段、新依赖或并行更新时间戳机制。未破坏旧契约：仅将以前被漏算的异常终态纳入最后活动，正常条目的口径与 API 结构不变。
