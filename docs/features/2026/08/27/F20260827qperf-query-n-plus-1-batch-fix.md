---
id: F20260827qperf
title: query-n-plus-1-batch-fix
summary: |
  双 issue 修复：#370 memory_fts trigram 表只写不查的裁决（已被 PR #408 按"删除"路线修复，本次零代码关闭）+
  #446 getActiveParticipants 循环内 N+1 查询消除（批量接口 + 全链路 modelAlias 透传）。
  #446 实现：OtterConfigProvider.getConfigs / OtterRepository.getByIds 批量方法（单条 IN 查询），
  ManageParticipant.getActiveParticipants 循环外预取两 Map；agent tool 的 get_active_participants
  原循环内逐个 getConfig 补 modelAlias 属 PR #445 填充 HTTP DTO 前的旧路径，改为直接读 DTO 透传字段。

causal_links:
  from:
    - F20260824ftsd
    - F20260824aibd
    - F20260825vrqh

status: development
change_type: fix
tags: [performance, database, n-plus-1, participants, model-alias]
modules:
  - src/usecases/ports/otter-config-provider.ts
  - src/frameworks/db/otter/sqlite-otter-config-provider.ts
  - src/usecases/otter/otter-repository.ts
  - src/frameworks/db/otter/sqlite-otter-repository.ts
  - src/usecases/conversation/manage-participant.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/usecases/ports/otter-tool-client.ts
  - src/bootstrap/clients.ts
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
created_in_conversation: 02e892ea-b291-4108-bacf-0d6148790511
---

# F20260827qperf: 参与者查询 N+1 消除 + memory_fts 只写不查裁决

## 背景与需求

### #370：memory_fts（trigram 表）只写不查

issue 描述：`schema.ts` 定义的 `memory_fts`（trigram 分词）与 `memory_fts_jieba` 同时写入，但检索路径只查 jieba 表，trigram 表零读取——每条记忆白写一份 FTS 索引（写入放大 + 磁盘占用）。处置方向二选一：删除写入，或接入查询降级链。

### #446：getActiveParticipants 循环内 N+1 次 getConfig

issue 来源：mimo-reviewer 对 PR #445 的对抗审视建议发现 3（2026-08-25）。

`ManageParticipant.getActiveParticipants` 遍历 participants 时，每个 participant 触发一次 `configProvider.getConfig(otterId)`（底层单条 SELECT）；同函数内 `otterRepo.getById` 也是同模式 N+1（存量行为，issue 建议顺手治）。

影响评估：当前典型场景 2-5 只海獭、同步 SQLite 微秒级，可忽略；但参与者增多或 getConfig 改异步（远程配置服务）时成瓶颈。

## 方案

### #370 裁决：零代码，关 issue

代码核实结论：**该 issue 已被 PR #408（F20260824ftsd，2026-08-24 合入）按"删除"路线完整修复**：

- `insertEntryRow` 现在只写 `memory_fts_jieba`，不再写 trigram 表
- `schema.ts` 已无 `memory_fts` CREATE 语句（仅留一行注释说明历史）
- `migration.ts` 级联删除路径也已移除 trigram DELETE
- 全仓（src/tests/web）零残留消费方

issue 挂着未关的原因：PR #408 description 使用中文「关闭 #370」，GitHub 只认 `Fixes/Closes/Resolves` 等英文关键词，未触发自动关闭。本 PR 以 `Fixes #370` 关闭之。

裁决理由：删除路线已在生产运行 3 天（8/24-8/27），验证了"旧库残留表无害"的判断（CREATE IF NOT EXISTS 不再创建，旧表零读零写自然废弃）；jieba 表为唯一检索信道运转正常，无 fallback 需求。

### #446：批量预取 + 全链路 modelAlias 透传

三处改动，一条数据流：

**① 接口层加批量方法**（`IN` 单条查询）：

- `OtterConfigProvider.getConfigs(otterIds: string[]): Map<string, OtterConfig>`——未配置的 id 缺席
- `OtterRepository.getByIds(ids: string[]): Promise<Map<string, Otter>>`——不存在的 id 缺席
- 两者均处理边界：空数组返回空 Map（避免 `IN ()` 语法错）、重复 id 去重
- `SqliteOtterConfigProvider` 内部提取 `rowToConfig` 私有映射，getConfig/getConfigs 共用

**② usecase 层批量预取**（`ManageParticipant.getActiveParticipants`）：

循环外两次预取（getByIds + getConfigs），循环内从 Map 取值。消除 N+1：每参与者 2 次查询 → 全程 3 次（1 次参与者列表 + 2 次批量）。

**③ tool 层删冗余二次查询**（`tool-factory.ts` 的 get_active_participants）：

时间线核实：8/24 PR #414（F20260824aibd）给 tool 加的循环内 getConfig 补 modelAlias，当时 DTO 尚无 modelAlias 字段；8/25 PR #445（F20260825vrqh）起 HTTP controller 已从 usecase 填充 modelAlias 进 DTO。此后 tool 层的 getConfig 循环成为纯冗余重复查询（每参与者 1 次多余 DB 往返）。

修复：client 契约类型（`otter-tool-client.ts`）的 `getActive` 返回类型补 `modelAlias?` 字段，`bootstrap/clients.ts` 从 `ParticipantWithOtter` 透传，tool 直接读 DTO 字段。

## 验证

### 测试

- 新增 `tests/frameworks/db/otter/batch-get-by-ids.test.ts`（7 用例）：getConfigs/getByIds 行为契约——Map 返回、缺席语义、空数组、重复 id 去重、与单条方法一致性
- 重写 `tests/interface-adapters/agent-runtime/tools/get-active-participants-tool.test.ts`：适配 DTO 透传语义（带/不带 modelAlias/混合场景），移除不再走的 configProvider 查询路径
- 存量行为测试全部保持：`manage-participant.test.ts` 的 modelAlias 断言（注入 configProvider 返回 modelAlias、未配置 undefined、不注入 undefined）原样通过——批量路径行为等价

### 自检

- [x] `npm test`：149 文件 1752 用例全绿（含 7 新增）
- [x] `npm run lint` 通过
- [x] `npm run build` + `tsc --noEmit` 零错误
- [x] #370 零代码改动，裁决结论如上
- [x] 接口扩展向后兼容：OtterRepository mock 全为 `as unknown as`（无需补方法）；OtterConfigProvider 字面量 mock 6 处已补 getConfigs

## 影响范围

- 参与者列表查询：Web 端（HTTP controller）+ agent tool（get_active_participants）+ bootstrap 客户端
- 无 API 契约破坏：ParticipantDTO.modelAlias 本就是可选字段，tool 输出 JSON 结构不变
- OtterConfigProvider/OtterRepository 接口新增方法，实现者仅 Sqlite* 两个类

## 取舍

- **不删 getConfig/getById 单条方法**：tool-factory 其他 10+ 处单点查询仍依赖，批量方法仅服务循环场景
- **不为假设的未来需求加 JOIN 查询**：issue 建议方向之一是 JOIN 一次取齐，但当前两表查询语义独立（otters 表 + otter_configs 表），双 IN 查询已把 N+1 压成 O(1)，JOIN 会把两实体耦合进一条 SQL，违背仓储分界
- **旧库残留的 memory_fts 表不主动 DROP**：PR #408 已裁决"零读零写自然废弃"，主动 DROP 属额外风险（迁移脚本）无收益
