---
id: F20260821evaf
title: embedding-version-anchor-deadcode-fix
doc_type: feature

summary: |
  修复 embedding 版本锚机制（F20260811mrpy Part 3）在存量库上完全死代码的缺陷。
  根因四层叠加：meta 上报取 dims[0] 恒为 batch=1；embedding_meta 表只在新库 initSchema 建、老库无补建；
  verifyEmbeddingVersion 用 worker ready 时序快照 available 做守卫、bootstrap 时恒 false 直接跳过；
  降级告警写 otter_context('system') 被 FK 挡住且无消费方。经两轮独立 agent 对抗审视定稿。
  修法：取形状末维、migration 幂等补表、守卫只看 getMeta（30s 超时兜底）、删除双重死代码的告警写入、
  vecCoverage 透传打通 agent 感知通道（二轮审视发现该通道原本也是断的）。

causal_links:
  from:
    - F20260811mrpy

status: final
change_type: fix
tags: [embedding, memory, migration, bootstrap]
modules:
  - src/frameworks/embedding/bge-m3-worker.ts
  - src/frameworks/db/migration.ts
  - src/bootstrap/database.ts
  - src/bootstrap/clients.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
---

# F20260821evaf: embedding 版本锚死代码修复

## 背景与需求

### 问题描述

对生产库（data/otter-buddy.db）的实证排查发现，F20260811mrpy Part 3 引入的 embedding 版本锚机制**从未实际运行过**：

1. 日志中 `Embedding model loaded: bge-m3 rev=unknown dim=1`——维度恒报 1；
2. 日志中从未出现 `Embedding meta baseline recorded`（初次启动写基线的必经路径）；
3. 直接查 sqlite_master：`embedding_meta` 表不存在；
4. 若校验真跑到 `getEmbeddingMeta()`，`SELECT ... FROM embedding_meta` 会直接抛 no such table。

### 根因分析（四层叠加，前三层任一层都足以让校验失效）

**层 1 — meta 上报取错维度**（`bge-m3-worker.ts`）：
dummy embed 后 `dim: dummy.dims[0]`。transformers.js 的 `dims` 是形状数组 `[batch, dim]`，`[0]` 恒为 batch=1。即使锚启用，dim=1 与任何存量基线都不一致，会误触发降级。

**层 2 — 老库无表**（`migration.ts`）：
`embedding_meta` 的 CREATE TABLE 只在 `initSchema` 里，而 `initSchema` 仅新库执行（`bootstrap/database.ts` 的 `isNewDb` 分支）。migration.ts 补建了同期的 `embedding_tasks` 却漏了 `embedding_meta`——存量库该表永远不存在。

**层 3 — 守卫时序错误**（`bootstrap/database.ts` verifyEmbeddingVersion）：
```ts
if (!embeddingGateway.available || typeof embeddingGateway.getMeta !== "function") return { vecEnabled: true };
```
`available` 是 worker ready 的时序快照。app.ts:130 调用时 worker 尚在加载模型（本地 bge-m3 约 4s），`available` 恒为 false → 走"兼容老接口"跳过分支。讽刺的是接口文档自己写着 getMeta "worker ready 后才可用，**内部会 waitForReady**"——守卫根本不需要也不应该看 available。

**层 4 — 降级告警写入双重死代码**（T3 补验实锤，对抗审视阶段发现）：
mismatch 时写 `otter_context('system', 'embedding_degraded')` 实测被 `FOREIGN KEY constraint failed` 挡住（otter_id → otters.id，'system' 是幽灵 id）；且 agent 的 get_context 工具按系统注入的 otterId 读，全仓库无任何路径读 'system' 行——即使写成功也无消费方。

**层 4b — vecCoverage 的 agent 通道同样是断的**（二轮审视实锤）：
移除告警时声称"agent 感知由 vecCoverage 承担"，但 vecCoverage 实际只到 HTTP 端点（/api/memory/search，前端用）——`bootstrap/clients.ts` 的 search 映射与 tool-factory 的解构序列化两层都把它丢弃，而 search_memory 工具 description 早已承诺该字段。agent 侧的感知通道是本轮（技术方案 7）才打通的，此前纯靠日志。

### 数据实锤

- 生产库 `memory_vec` 4245/4245 全覆盖、向量数据 24MB——embedding 本身工作正常，问题仅限防线机制；
- 7/27–8/3 曾有 20 次 `fetch failed` 降级（worker 远程拉模型被阻断），此后零降级；
- 40 次+ 启动日志中 `dim=1`、零次 baseline recorded。

## 方案设计

### 技术方案

1. **dim 取值**：`dummy.dims[dummy.dims.length - 1]`（最后一维才是向量维度，batch 维被自然跳过）。
2. **migration 补建**：`ensureEmbeddingMetaTable`，CREATE TABLE IF NOT EXISTS 与 schema.ts 同构，注册进 migrateDatabase（幂等，新库老库都安全）。日志只在真正补建时打（sqlite_master 先行探测），使日志可作为升级证据。
3. **守卫修正**：去掉 `!embeddingGateway.available` 条件，只保留 `typeof getMeta !== "function"`（老接口兼容）。getMeta 内部 waitForReady，worker 加载失败时 reject → 走 catch 分支跳过校验（模型不可用时本来也无法 embed，语义不变）。
4. **getMeta 30s 超时**（对抗审视项）：截断"worker 永不 ready 也永不报错"的挂起态（onnxruntime 原生死锁、远程 fetch 挂起）。超时只 skip 校验、不掩盖 mismatch（mismatch 在 meta 拿到后才判定）。
5. **DB 读写容错**（对抗审视项）：getEmbeddingMeta 读失败 / setEmbeddingMeta 写失败 → warn + 跳过校验，不崩 boot。二轮审视修正：no such table（schema 缺失）单独识别为 error 级——那是 migration 没跑到的信号，不能与 IO 错误同等静默。
6. **移除 otter_context 告警写入**（T3 补验发现的层 4）：双重死代码。
7. **vecCoverage 透传到 agent 路径**（二轮审视发现的层 4b）：ports 类型 + clients.ts search 映射 + tool-factory 序列化三处打通，兑现 search_memory 工具 description 的既有承诺。
8. **fetchCurrentMeta timer 清理**（二轮审视项）：成功路径 clearTimeout，避免一次性进程多活 30s。

### 目标

- T1: 存量库启动后 embedding_meta 表存在且记录正确基线（dim=1024）
- T2: meta 上报维度为真实向量维度
- T3: 版本不一致时降级路径真正可达

### 成功标准

boot 日志出现 `Embedding model loaded: ... dim=1024` + `Embedding meta baseline recorded: ... dim=1024`；二次启动无 mismatch 降级。

## 验收标准

### 验收场景
| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | 老库补建 embedding_meta | VACUUM INTO 复制生产库（无该表）→ 启动 | 日志 `Ensured embedding_meta table exists`；表可读写 |
| AT-2 | dim 上报正确 | 启动后看日志 | `Embedding model loaded: bge-m3 rev=unknown dim=1024` |
| AT-3 | 基线写入 + 一致性分支 | 首次启动 → 查表；二次启动 → 看日志 | 首启 `baseline recorded`；二启无 mismatch/降级日志 |
| AT-4 | 降级路径可达 + 恢复闭环（T3 补验） | 副本库 `UPDATE embedding_meta SET value='999' WHERE key='dim'` → 重启；还原后三启 | mismatch 日志 + vec 禁用 + retry worker 停；三启恢复 vec 且 retry worker 回灌暗化条目 |

### 能力测试映射

| 验收场景 | 能力测试文件 |
|---------|-------------|
| 全部 | n/a（A 类纯代码逻辑，单测 + 隔离实例实证） |

## 实现细节

### 代码修改

| 文件 | 操作 | 说明 |
|------|------|------|
| src/frameworks/embedding/bge-m3-worker.ts | 修改 | dim 取 dims 最后一维 |
| src/usecases/memory/embedding-gateway.ts | 修改 | modelRev 注释如实记录"恒 unknown + 固化代价"；dim 注释更正 |
| src/frameworks/db/migration.ts | 修改 | 新增 ensureEmbeddingMetaTable（条件打日志）并注册 |
| src/bootstrap/database.ts | 修改 | 守卫去掉 available 快照；getMeta 30s 超时（含 timer 清理）；DB 读写容错（no-such-table 升 error 级）；移除 otter_context 告警写入 |
| src/usecases/ports/otter-tool-client.ts | 修改 | search 返回类型补 vecCoverage（二轮审视） |
| src/bootstrap/clients.ts | 修改 | search 透传 vecCoverage 到 agent 路径（二轮审视） |
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | 修改 | search_memory 输出含 vecCoverage；description 补 vecCoverage 读法（三轮审视） |
| src/usecases/memory/search-memory.ts | 修改 | terminology 路由 vecCoverage total=0（不参与统计）；全库混排透传对话库口径（三轮审视修正口径错位） |
| src/app.ts | 修改 | 注释同步（降级状态经 vecCoverage 暴露） |
| tests/bootstrap/verify-embedding-version.test.ts | 修改 | 反转 available 用例；新增超时/IO 错误/no-such-table 用例；降级用例改为断言不写 otter_context |
| tests/bootstrap/clients.test.ts | 修改 | 新增 vecCoverage 透传用例（二轮审视） |
| tests/interface-adapters/search-memory-tool.test.ts | 新增 | search_memory 输出 shape 3 例，钉住 vecCoverage 序列化契约（三轮审视） |
| tests/frameworks/db/migration.test.ts | 修改 | 新增老库补建 + 幂等两个用例 |

### 逻辑变更

版本锚从"永远走不到的代码"变为"每次 boot 真实校验"。语义不变项：模型加载失败仍跳过校验（vecEnabled=true）、不一致仍 disableVec。行为变化项：boot 现在会等模型加载完成（本地约 4s，30s 超时上限）才继续 memory index 写入——这本来就是注释声明的顺序要求（"在 memory index 写入前完成"）。

## 验收结果

### 测试结果

- 单测：`npm test` 1360/1360 通过、lint 0 error（verify-embedding-version 10 例含超时/IO 容错/no-such-table、clients vecCoverage 透传 1 例、search_memory 输出 shape 3 例、migration 新增 2 例）
- 隔离实例实证（worktree + 独立端口 3901 + 生产库一致性副本，三轮启动）：
  - 首启：`Ensured embedding_meta table exists` → `Embedding model loaded: bge-m3 rev=unknown dim=1024` → `Embedding meta baseline recorded: bge-m3 rev=unknown dim=1024`；表内容 model_id=bge-m3 / dim=1024
  - mismatch 轮（dim 改 999）：`Embedding version mismatch, degrading to FTS-only` → `Embedding vec path disabled` → `EmbeddingRetryWorker not started`，memory_vec 被 disableVec 清空；无 FK 报错（告警写入已移除）
  - 恢复轮（dim 还原 1024）：无 mismatch、vec 恢复可用、`EmbeddingRetryWorker started, migratedExisting=1000`——暗化条目自愈回灌闭环
  - （副本库同步报 1 个 F20260731 文档 UNIQUE 冲突，为副本与 worktree 文档差异的既有现象，与本修复无关）

### 证据判定

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| T1 老库补表 + 基线 | 证明完成（日志 + 表内容） | ✅ |
| T2 dim=1024 | 证明完成（三轮启动日志） | ✅ |
| T3 降级路径可达 + 恢复闭环 | 证明完成（真库构造 mismatch：日志 + vec 清空 + retry worker 停启 + 回灌） | ✅ |

## 对抗审视记录

### 第一轮（修复本体成为靶子）

两个独立 agent 并行审视（代码正确性 / 集成面与升级路径），交叉确认了根因诊断、dims 修复（实读 transformers.js 源码验证 `[batch, dim]` 形状）、migration 同构性、无其他 available 消费方。发现的问题与用户逐题拍板：

| 审视项 | 决策 | 处置 |
|--------|------|------|
| getMeta 无超时，worker 挂死 → 全进程起不来且无日志 | 加超时 | 30s，超时走 skip（不掩盖 mismatch） |
| embedding_degraded 只写不清（恢复后永久脏状态） | — | 被 T3 实锤的层 4 取代：连写入本身都是死代码，整体移除 |
| modelRev 恒 unknown，基线固化后未来实现真实 rev 需人工重写 | 仅修注释+文档 | gateway 注释如实记录；不实现 mtime 上报（换模型是低频运维事件，与"不做 re-embed 基础设施"决策一致） |
| T3 降级路径未真实验证（❓） | 补验 | dim=999 实验，✅（且发现层 4） |
| verify 内 DB 读写无容错（IO 错误崩 boot） | 修 | 读/写失败 warn + skip |
| 补建日志无条件打削弱 AT-1 证据 | 修 | sqlite_master 先行探测，只在真补建时打 |
| 基线语义：写的是"当前 worker meta"，未验证存量向量来源 | 记录已知限制 | 存量向量 1024 维由 vec0 表写入约束背书（维度错写入必报错）；跨模型历史混合的可能性无法事后追溯，接受 |
| 启动 time-to-listen 净增约 4s | 接受 | 端口在 verify 前未开，外部表现为 connection refused 而非挂起连接 |

### 第二轮（第一轮的修复成为靶子）

两个独立 agent 换新攻击面（上轮新增代码 / 数据安全与运维），关键发现是层 4b——第一轮移除告警的理由链是断的。均属技术实现对齐，由 AI 架构师决定处置：

| 审视项 | 处置 |
|--------|------|
| **vecCoverage 在 agent 路径被 clients.ts / tool-factory.ts 两层丢弃，移除告警的理由链断裂；工具 description 却承诺了该字段** | 修：三处透传打通（ports/clients/tool-factory），层 4b 记入根因 |
| readStoredMeta 的 catch 无差别吞掉 no-such-table，与"不掩盖 schema 缺失"的决策声明矛盾 | 修：no-such-table 升 error 级告警（仍不崩 boot），IO 错误维持 warn |
| fetchCurrentMeta 成功路径 30s timer 不清理（一次性进程多活 30s） | 修：finally clearTimeout |
| 超时测试只覆盖 race 层，未覆盖 waitForReady 真分支 | 接受：集成路径由 30s 超时外层兜底，两层耦合已注释钉住 |
| 测试 deletedKeys 死脚手架 | 修：删除 |
| 超时 fail-open 空窗语义未文档化 | 修：见下方运维语义 |
| disableVec 破坏性 + 回灌代价未文档化 | 修：见下方运维语义；shadow 备份表方案记录不做（见设计决策） |
| migratedExisting 语义被误读为"回灌完成量" | 修：文档澄清是入队数 |
| boot 迁移复活 dead-letter 条目（attempts 不重置，每次 boot 白做一轮推理） | 记录未修：F20260812mrcq 遗留，独立问题 |

### 第三轮（发布前门禁 + 二轮新增成为靶子）

两个独立 agent（攻 vecCoverage 透传语义 / 最终门禁审查）。核心发现：刚打通的通道在最常用的两种查询下传递失真信号。

| 审视项 | 处置 |
|--------|------|
| **全库混排 vecCoverage 口径错位**：分母用混排后 entries.length（含术语条目）、分子用对话库混排前统计——ratio 被系统性稀释，极端时算成 0.0 | 修：全库直接透传对话库自身口径（分子分母同源，术语库不参与统计） |
| **terminology 路由恒 ratio=0.0**：术语条目恒无 vec，报实际数量=告诉 agent"全部暗化" | 修：total 报 0（约定=本路由不参与 vec 统计），与空结果/锚点短路路径一致 |
| **vecDisabled 在 description 零解释**：透传只完成一半，降级时 agent 拿到字段却没有解码钥匙 | 修：description 补 vecCoverage 完整读法（total=0 / 0<ratio<1 / vecDisabled=true 三态语义） |
| search_memory 输出 shape 无直接单测 | 修：新增 3 例钉住序列化契约 |
| created_in_conversation 填了 worktree 名（假指针，provenance 追溯失效） | 修：删除该字段（存 null 比存假指针诚实） |
| 文档测试计数 off-by-one（11 例实为 10 例） | 修：更正为 1360/1360 全量复算 |
| 输出 shape 变化的消费方 / no-such-table 字符串匹配 / timer 时序 | 验证无问题：healing 不碰工具 JSON；HTTP 端点 shape 未变；SQLite 错误消息不走 locale 跨版本稳定；executor 同步执行保证赋值先于 finally |
| memory_fts 只写不查无跟踪去处 | 修：建 issue 登记（见设计决策） |

### 运维语义（二轮审视要求补文档）

- **mismatch 的代价**：disableVec 会 DELETE memory_vec（防新旧向量混跑，F20260812mrcq Part 0 设计）。按 retry worker 实际吞吐（每 30s 批 10 条 ≈ 1200 条/小时），4245 条全量回灌约 3.5 小时；期间检索静默 FTS-only，agent 可经 vecCoverage 感知，人类用户无感知。回灌与对话查询共用同一 worker 线程，回灌期查询 embed 延迟会叠加。
- **runbook**：改 embedding 相关配置（modelId/dim/localModelPath）前先停服确认，避免热重启触发非本意 mismatch；mismatch 恢复后不要频繁重启（每次 boot 全量重扫暗化条目入队）。
- **getMeta 超时 = 本次锚不生效（fail-open）**：不写基线也不降级，模型随后照常工作；基线延迟到首个加载 <30s 的 boot 补写。慢盘/冷页缓存可能触发（capability 测试给 embedding ready 留 240s 预算可佐证）。空窗期日志有 warn 可查。
- **`migratedExisting` 是入队数非完成数**：回灌完成量看 `embedding_tasks` 表消费情况。

## 设计决策

- **schema 缺失不静默**：migration 补建已修根因，但若表仍缺失（migration 未跑到/旧库覆盖），error 级告警让"锚失效"可被运维发现——原 bug 正是被静默跳过藏了 10 天。IO 错误另论——warn + skip。
- **移除而非修复 otter_context 告警**：修复需要造 system 海獭实体 + 新增读取通道，而降级状态已有暴露通道（vecCoverage，本轮起 agent 路径也通），再建一条是重复机制。
- **不做 disableVec 前的向量影子备份**：mismatch 属低频事件且假 mismatch 路径已收窄（基线只从真实 worker meta 写入）；备份表引入恢复语义复杂度，与"不做 re-embed 基础设施"决策方向一致。以 runbook 文档化替代。
- **modelRev 固化为 unknown 的代价**：本地 models/ 目录整目录替换（同 modelId 同 dim）时锚检测不到；将来实现真实 rev 时需一次性重写基线。接受理由：换模型属低频运维事件，届时全库线下 re-embed 顺带重写锚即可。
- **顺带发现未修**：memory_fts（trigram 表）只写不查，每条 entry 白写一份索引——已建 issue 跟踪（三轮门禁要求消除无主状态）；boot 迁移复活 dead-letter 条目——F20260812mrcq 遗留，独立问题。
