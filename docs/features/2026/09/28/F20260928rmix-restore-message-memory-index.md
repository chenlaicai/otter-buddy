---
id: F20260928rmix
title: 消息→记忆索引链路接回（#1191）：增量写入点 + 存量回填 + capability 回归锚
change_type: fix
tags: [memory, entries, search-memory, migration, regression-anchor]
modules:
  - src/usecases/conversation/send-entry.ts
  - src/bootstrap/usecases.ts
  - src/frameworks/db/migration.ts
  - tests/usecases/conversation/send-entry-memory-index.test.ts
  - tests/frameworks/db/backfill-entry-memory-index.test.ts
  - tests/capability/memory-recall.capability.test.ts
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
summary: "#1191：#886 删除旧 SendMessage 时三处 indexMessage 调用随消息体消失，9/13 后对话正文（user+speak 3837 条）不再入记忆，search_memory 失明 15 天。接回：SendEntry 两写入点非阻断索引 + migration 幂等回填存量 + capability 行为锚防再断"
intent:
  trigger: "搭档指令：「已合入，你收尾，然后重启下自己，然后继续处理bug类issue」（2026-09-28 20:40）——重启后捞 bug 池选中 P1 #1191"
  purpose: 恢复「对话消息可被 search_memory 跨对话检索」能力（R4 记忆先行的数据面），消灭静默断裂
from:
  - F20260913ctlv
  - F20260915midu
  - F20260928cl1a
---

# 消息→记忆索引链路接回（#1191）

## 预注册（troubleshooting 步骤 1）

- 预期根因方向：管道断在调用点（#886 重构吞了 indexMessage 调用），而非投影层/检索层缺陷
- 验证标准：git log -S indexMessage 显示删除 commit = #886（b1d11c5f），且现 src 树 MemoryIndexAdapter 实现存在但零调用者
- 最强反例方向：若 indexMessage 接口本身也删了（非仅调用点），则需重建接口而非接回——核实结果：接口与实现均幸存（src/bootstrap/memory.ts:18），预期成立

**预期 vs 实际**：命中。git log -S 确认最后触点 b1d11c5f（#886），三处调用（旧 send-message.ts:233/383/447——user 侧 buildIndexBody、otter 侧 complete、abort 侧）随消息体删除；新 SendEntry（#886 后唯一落点）无索引消费。F20260913ctlv 特性文档四处承诺「记忆索引适配」（183/378/385/423 行）未兑现——「承诺适配未兑现」有直接文档证据（issue #1191 评论，来自 PR #1192 对抗审视）。

## 问题现象

- 生产库实证：message 类记忆最后一条 = 2026-09-13T09:10（恰为 #886 合入时段）；9/14 后 fact 12409 / feature 656 / message **0**
- 行为面：search_memory（content_type=message, created_after 9/13）检索不到任何对话原话
- R4 记忆先行场景（跨会话问题脉络、搭档原话引用）对 9/13 后对话失明；每日健康检查的未闭环扫描同源失明

## 根因

#886（F20260913ctlv）删除旧 SendMessage 时，三处 `memoryIndex.indexMessage(...)` 调用随消息体整删。管道（MemoryIndexAdapter.indexMessage → StoreMemory.execute → memory_entries + fts_jieba + weights）完好幸存但零调用者——接口、适配器、装配（usecases.ts:103 assistantSession 还在用 indexAssistantDigest）都在，只有消息入口断了。

## 修复方案（修法决策树①既有语义内修）

### A. 增量写入点（src/usecases/conversation/send-entry.ts）

- `SendEntry` aux 注入可选 `memoryIndex?: MemoryIndexGateway`（usecases.ts:110 装配点传入）
- `sendUserEntry`：落库后索引——正文 = stripHtmlCardFences(body) + 附件占位投影行（旧 buildIndexBody 同构，私有方法 buildUserIndexBody）
- `createSpeakEntry`：落库后索引 stripHtmlCardFences(body)（旧 complete/abort 侧同构）
- 非阻断语义：索引失败仅 warn 不抛（对齐附件 attach 的 F20260913ctlv 终审语义——文字优先送达，索引挂了不能造幽灵消息）
- 边界条目不入：system/yield/invoke_* 不索引（旧口径：只有正文承载语义的条目入）
- sourceId = entry.id（#942 ID 统一后投影主键即源 id）

### B. 存量回填（src/frameworks/db/migration.ts backfillEntryMemoryIndex）

- 范围：entry_type IN ('user','speak') AND body 非空（9/13 后 3837 条：user 1246 + speak 2591，迁移跑全量 entries 不限日期——9/13 前的旧消息在 messages→entries 迁移时已有记忆投影，幂等条件自动跳过）
- 幂等：NOT EXISTS (memory_entries WHERE source_table='entries' AND source_id=e.id)——重跑零重复
- 正文：双侧 stripHtmlCardFences（**占位符替换语义，非删除**——`[html-card: title]` 是三出口公开契约，纯卡片消息以占位符文本入库，与增量路径 StoreMemory 同构）；user 侧拼附件投影行（inline 重写 projectAttachments 语义，migration 独立 humanSizeForIndex 避免跨层 import）
- 卫星写入：memory_fts_jieba（jieba doubleWrite）+ memory_weights——与 SqliteMemoryRepository.insertEntryRow 同构
- vec：不在迁移同步——启动时 createAndStartRetryWorker 扫暗条目入队渐进补齐（3837 条按 bge-m3 历史速率分钟级）
- 事务：单事务逐条（3837 条内存库测试 <1s，生产规模同量级无锁风险）

### C. capability 回归锚（tests/capability/memory-recall.capability.test.ts）

新 it「#1191 用户消息发送后进入记忆系统，search_memory 可召回（防静默断裂锚）」：HTTP 发消息（带独特 token）→ HTTP /api/memory/search 检索命中。纯管道断言（无 LLM 采样、3.4s），把「消息→记忆」链路固化成行为不变量——该链路静默断裂 15 天无人发现，靠的就是缺这条锚。

## 语义变化明示

- 9/13 前旧 message 记忆的 source_table='messages'（5688 historical + 2380 working）；回填与新写入的 source_table='entries'——search_memory 按 content_type=message 检索两者都命中（检索层不按 source_table 过滤），无兼容问题
- 失败消息（invoke failed）的 speak 正文：旧路径 abort 侧索引带中断标记正文；新路径 createSpeakEntry 只管 completed——#886 后 speak 一律 completed 落库（失败的 invoke_end 才是失败标记），语义等价

## 影响范围

- 对话消息发送路径（sendUserEntry/createSpeakEntry）性能：每条消息多一次同步 memory_entries 写入（单事务 INSERT 三联，毫秒级）+ fire-and-forget embedding（已有管道）
- memory_entries 库体：回填 +3837 条（working 层 message 类）；后续每条对话正文 1 条——9/13 前 15 天 message 8000+ 条的口径恢复，库体增长恢复到 #886 前速率
- 检索面：search_memory 重新能召回对话原话；message 类结果占比上升（信噪比靠既有权重与排序机制维持，无新增干预）

## 验证

- 新单测 send-entry-memory-index.test.ts：5 用例（user/speak 索引、html-card 剥离、失败非阻断、未注入兼容）全绿——**修复前 2 红**（索引调用不存在）**修复后 5 绿**，失败证据已固化
- 新迁移测试 backfill-entry-memory-index.test.ts：口径（user/speak 入、边界不入、附件投影、占位符契约）+ 幂等（重跑零新增）+ FTS 可检索（jieba 词典词命中）
- capability 新锚实跑通过（真 bge-m3 + 真 HTTP，3416ms）
- 全量 4195 用例绿；tsc 0 错；build（含 eslint）通过

## 检视处置记录

### 初轮（检视獭-1200，mimo-pro：2 严重 2 建议，全采纳）

| 发现 | 处置 |
|---|---|
| **严重 1**（实验实锤）：回填幂等只查 `source_table='entries'`，但增量路径 indexMessage 写 `'messages'`（本 PR 未改）——#942 后两路径投影主键同源（entry.id），`UNIQUE constraint failed: memory_entries.id` 撞车 → 生产首发即崩 / 二次启动崩（migrateDatabase 无 catch） | **双层修**：①增量口径统一 `messages`→`entries`（memory.ts:21——#886 后源表就是 entries，旧口径是遗留脏值；grep 确认无读取方依赖）②幂等条件改按主键 `m.id = e.id` 判断（两种历史口径全部可见，一劳永逸）+ 撞车场景回归测试（backfill 测试新 it：旧口径行存在时不撞不重） |
| **严重 2**（B4）：7 处注释写 `F20260929rmix`，真相源 `F20260928rmix`——grep 双向断链 | sed 全修，复扫 0 命中 |
| 建议 3：attach 失败路径索引丢附件投影（与旧口径 attachmentRefs 失败模式漂移） | 修：投影改基于发送意图（input.attachmentIds → 新 repo 方法 getAttachmentRefsByIds），attach 失败也投影——旧口径同语义；单测补「attach 失败仍投影」用例 |
| 建议 4：迁移每次启动全量扫 | 修：one-shot 标记（settings `entry_memory_index_backfilled`，惯例同 messages_to_entries_migrated）；测试断言标记写入 + 重跑零扫描 |

**结构整理**（超 max-lines 450 引发）：#1191 辅助方法抽 `send-entry-index-helpers.ts`（buildUserIndexBody/loadAttachmentRefs）；目标解析抽 `resolveTargetsForSend`（resolve-send-targets.ts）；公共委托方法保留原地（多入口消费，非死码）。

验证：全量 4197 绿；tsc 0 错；build（含 eslint）0 错；capability 锚复跑绿。
