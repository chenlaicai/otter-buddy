---
id: F20260901sgp0
title: '协作机制 v2：信号协议 P0 — 信号元数据铺轨'
summary: '为信号协议（F20260901sgp0）铺轨：messages 表加 signal_level/signal_meta 列，yield 工具接受 level 参数（NORMAL/URGENT/HALT），HALT 权限约束落地（仅用户/大獭可投）。P0 阶段行为零变化——不做路由、不改调度逻辑。'
change_type: feature
status: draft
capability_test: n/a — P0 阶段无新增能力，仅铺轨数据层
created_in_conversation: 52bfdd91-a61e-4323-b1f7-1fe3daaadc32
---

# F20260901sgp0: 信号协议 P0 — 信号元数据铺轨

## 背景

本文档记录信号协议实现的第一阶段（P0）。完整设计方案见 [F20260901sgpx 设计文档](https://github.com/chenlaicai/otter-buddy/pull/669)。

P0 的目标是**铺轨不走路**：在数据库和工具层埋入信号元数据能力，但不改变现有调度行为。

## 变更说明

### 1. 数据库层

- **schema.ts**：messages 表新增 `signal_level TEXT` 和 `signal_meta TEXT` 列（索引由 migrateDatabase 在列之后幂等创建，避免存量库 initSchema 时列不存在崩溃——PR #386 前科模式）
- **migration.ts**：`ensureMessagesSignalColumns()` — 存量库 PRAGMA 检测幂等迁移
- **conversation-mapper.ts**：`MessageRow` 接口 + `rowToMessage()` 映射新增两列

### 2. yield 工具

- **参数**：新增 `level` 参数（`NORMAL` | `URGENT` | `HALT`，默认 `NORMAL`，大小写不敏感）
- **HALT 权限**：小獭投 HALT 被拒绝 + 错误提示（沿用 F20260826mwrd C2 裁决：仅用户/大獭可投）
- **写入**：`signalLevel` 和 `signalMeta` 透传到 `startSpeaking` → messages 表

### 3. 消息查询 API

- `get_message`、`list_messages`、`search_messages` 透出 `signalLevel`（有值时）和 `signalMeta`（有值时）

### 4. 全链路透传

- `conversation-repository.ts`：`startSpeaking` 接口加 `signalLevel?` / `signalMeta?`
- `sqlite-conversation-repository.ts`：UPDATE 写入 signal_level / signal_meta
- `send-message.ts`：`StartSpeakingInput` 加 signalLevel / signalMeta
- `otter-tool-client.ts`：接口加 signalLevel / signalMeta
- `bootstrap/clients.ts`：适配层透传

## 不在范围内

- P0 **不做路由**（P1 实现信号路由器）
- P0 **不改 invoke 循环**（P2 实现）
- P0 **不改打断决策**（P3 实现）
- P0 **不退役 turn 表**（P4 实现）

## 验证

### 单测

- `tests/frameworks/db/signal-metadata-migration.test.ts`：
  - 新库 schema 包含新列 + 索引
  - 存量库迁移幂等（多次运行不报错）
  - 迁移后存量消息 signal_level 为 null
  - 可通过 signal_level 索引查询 URGENT 消息
- `tests/interface-adapters/yield-level.test.ts`：
  - 默认 level=NORMAL（不写 signalMeta）
  - level=URGENT 透传 signalLevel + signalMeta（含 reason）
  - level=HALT 大獭可投（写入 signalLevel + signalMeta）
  - 小獭投 HALT 被拒绝（isError=true）
  - 小獭投 NORMAL/URGENT 正常通过
  - level 参数大小写不敏感

### 全量测试

- 207 test files, 2570 tests 全部通过

### 最简实现检查

- 已过最简检查：ALTER TABLE ADD COLUMN + yield 参数透传 + otter.getById 权限校验，无新增依赖、无新增表、无新增框架

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 新列 NULL 语义 | 存量行 NULL = 无信号语义 | DEFAULT 'NORMAL' 填充 | 填充会混淆存量消息（它们从未被 yield 过），NULL 才是准确的"无信号"语义 |
| signalMeta 格式 | JSON 字符串 | 独立列（reason/suggestion 各一列） | 设计文档 §1 定义 signal_meta 为 JSON——为 P1/P2 预留扩展空间，避免频繁 ALTER TABLE |
| HALT 权限校验位置 | yield 工具 execute 内（调用 getById 查类型） | 工具白名单层拦截（manifest） | 白名单拦的是工具名，拦不住 yield 的 level 参数——权限必须在 yield 语义内校验 |
| signal_level 索引 | migrateDatabase 内幂等建（列 ALTER 之后） | initSchema 内建（列存在时） | 存量库 initSchema 先于 migrateDatabase，列不存在时 CREATE INDEX 抛 no such column（PR #386 前科） |

## 迁移路径

P0 是独立可验证的一小步：
1. 合入后存量库自动迁移（PRAGMA 检测幂等）
2. 新 yield 参数向后兼容（不传 level = NORMAL，现有 LLM prompt 无需修改）
3. 后续 P1-P4 在此基础上增量叠加
