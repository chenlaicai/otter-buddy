---
id: F20261124mretr
title: 检索降级状态与 MemoryResult 完整出口
summary: 区分 vec 嵌入失败、查询失败、禁用与成功，队列健康独立于 topK 覆盖率；SearchMemory、buildMemoryClient 与 search_memory 共享并直出 RetrievalResult，完整透出检索属性、belief 与 debug。
change_type: fix
doc_type: feature
created_at: 2026-11-24
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
capability_test: "n/a: 纯 A 类检索降级与响应契约，由真实 SQLite、异步故障注入和真实 client/tool 链验证；不新增 LLM 自由行为"
tags: [memory, retrieval, vector, tools, compatibility]
modules:
  - src/usecases/memory/search-memory.ts
  - src/usecases/memory/memory-types.ts
  - src/usecases/memory/memory-reader.ts
  - src/frameworks/db/memory/sqlite-memory-repository.ts
  - src/bootstrap/clients.ts
  - src/usecases/ports/otter-tool-client.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
intent:
  problem: "vec 失败被压成空数组，调用方无法区分嵌入失败、查询失败与禁用；buildMemoryClient 和工具层手工窄映射丢失 source、beliefStatus、supersededBy、drillDown、debug、belief，队列健康也无法与 topK 覆盖率分开观察。"
  expected_effect: "searchVec/searchSimilar 异步拒绝时 FTS 主流程继续或相似检索安全返回空结果，vecState 准确标识四态；真实 client/tool 链完整输出六属性、total、vecCoverage 与独立 pending/dead/oldestAgeSeconds，total 语义不变。"
  verify_by:
    type: behavior_check
    rollback: "整体 revert 本 PR；纯代码与响应字段变更，无数据库 schema、配置或数据迁移，新增字段可随代码回退消失。"
    risk_note: "search_memory JSON 增加 vecState、queueHealth、total 及完整 entry 字段，属于向后兼容扩字段；不重排结果、不改变 total。"
---

# 检索降级状态与 MemoryResult 完整出口

## 背景与基线

实施基线：`origin/main@d6625453a8d18ba6e94a03188dcabc060942e4c8`。开工时开放 PR 只有 #1994、#1966，无本批在途实现。

现状有三个断点：

1. `searchVec` 把文本嵌入与底层查询放在同一个 catch 中，失败只返回 `[]`；`searchSimilar` 的异步拒绝直接逃逸。
2. `buildMemoryClient` 用窄类型手工挑选 entry 字段，`search_memory` 又只序列化 entries/contextEntries/vecCoverage，导致 usecase 已计算的检索信息无法到达 agent。
3. `vecCoverage` 只描述 topK 命中是否有向量，无法表达本次调用到底在哪一步失败；pending/dead/age 属于持久队列，也不应混入覆盖率。

## 设计取舍

| 取舍 | 决策 | 被否替代 | 理由 |
|---|---|---|---|
| 状态判据 | 在真实失败点记录 `embed_failed`、`query_failed`；表缺失或运行时禁用为 `disabled`，两阶段成功为 `ok` | 用一个布尔值或 ratio=0 推断全部状态 | 调用方可以区分模型/嵌入故障、SQLite vec 查询故障与有意禁用 |
| 降级边界 | 普通检索 vec 失败后继续 FTS；相似检索在源向量读取或 vec 查询失败时返回空结果，重排/计数异常不吞 | 所有异常统一吞掉或让异步拒绝打挂工具 | 保留既有可用性，同时避免把非 vec 故障误报为 query_failed |
| 结果类型 | client port 直接返回共享 `RetrievalResult`，client 与工具不再二次映射 | 每层维护一份窄 DTO | source、beliefStatus、supersededBy、drillDown、debug、belief 与后续字段不会因手工漏列而消失 |
| 队列健康 | 新增独立 `queueHealth={pending,dead,oldestAgeSeconds}`，复用既有 pending stats 并单查 dead | 把队列数量塞进 vecCoverage.total 或 ratio | topK 与持久队列是不同时间尺度、不同消费者的真值 |
| 兼容策略 | 只新增响应字段和可选 debug 参数；旧 Reader 未实现健康读口时省略 queueHealth | 改 total、改排序、伪造 queueHealth 零值 | 旧调用方可继续工作，新调用方获得真实可观测性 |

机制识别：未新增后台任务、锁、持久化格式或跨模块业务流程；这是既有 SearchMemory 管道的状态补齐和出口修复，按既有语义内修处理，不新增独立机制。

## 实现

1. `memory-types.ts` 定义共享 `VecState` 与 `EmbeddingQueueHealth`；`RetrievalResult` 增加 `vecState` 和可选 `queueHealth`。
2. `searchVec` 分开捕获文本嵌入与底层查询失败；disabled 时不调用文本嵌入。`searchSimilar` 只包围源向量读取和 vec 查询，后续重排/计数错误仍按原路径抛出。
3. 所有检索路由统一经 `finalizeResult` 附加执行状态和队列健康。健康读取失败仅省略字段并告警，不影响检索。
4. `SqliteMemoryRepository` 通过可选 Reader 读口返回真实 pending/dead/oldestAgeSeconds；旧 mock 或其他 Reader 不实现时不伪造零值。
5. `RetrievalResultEntry` 增加合法 `belief` 领域对象；原有 beliefStatus 仍保留。`buildMemoryClient` 直接返回 usecase 结果，删除手工 entry 映射。
6. `search_memory` 增加可选 debug 参数并直接序列化共享结果；total 同时进入工具 JSON，logSearch 继续读取同一个 total，不改其语义。

## 四态与覆盖率

| vecState | 触发条件 | 主流程行为 |
|---|---|---|
| `ok` | vec 可用且本次需要的读取/嵌入/查询成功 | 正常融合；searchSimilar 源条目无向量时返回空结果 |
| `embed_failed` | `embeddingGateway.embed` 异步拒绝 | 记录告警，普通检索继续 FTS |
| `query_failed` | 源向量读取或 `reader.searchVec` 异步拒绝 | 普通检索继续 FTS；searchSimilar 安全返回空结果 |
| `disabled` | vec 表不存在或运行时禁用 | 不调用文本嵌入，继续 FTS 或返回相似检索空结果 |

`vecCoverage.total/withVec/ratio` 仍只统计本次 topK 命中；`queueHealth.pending/dead/oldestAgeSeconds` 来自 embedding_tasks 持久队列，两者不得互相推导。`total` 继续是既有检索结果计数，不改为候选总数、队列长度或 entries.length 的新口径。

## 负向核查与旧机制接管

| 旧行为 | 原消费者 | 新接管 | 未破坏的契约 |
|---|---|---|---|
| client 手工窄映射 | agent 工具 | 共享 RetrievalResult 直出 | getById/getDetails 的轻量读取不变；搜索条目字段更完整 |
| 工具再次筛选输出字段 | search_memory JSON | 直接序列化同一结果 | contextEntries 仍独立，logSearch 仍 fire-and-forget，total 不变 |
| vec 异常统一空数组 | SearchMemory/searchSimilar | 分阶段状态 + 有限降级 | FTS 排序、RRF、rerank、配额和权重算法零改动 |
| coverage 兼任健康信号 | 检索调用方 | coverage 与 queueHealth 分列 | vecDisabled 旧字段保留，新增状态不改旧字段含义 |

负向结论：没有禁用 vec 成功路径、没有把 embed_failed 与 query_failed 合并、没有在 disabled 时调用嵌入、没有吞掉 searchSimilar 的非 vec 重排异常、没有把健康读口缺省当成零队列、没有改数据库或记忆投影政策。

## 非目标

- 不做向量代际 sidecar、generation 或 CAS。
- 不实现 outbox、投影 worker 或持续对账。
- 不改记忆 schema、embedding 队列结构、检索排序、RRF/rerank、total 或 HTTP 路由语义。
- 不改外部流量、查询日志政策和 P2 检索质量评估 backlog。

## Acceptance Test

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 文本嵌入失败 | 真实 SQLite FTS 可命中，embed 异步 reject | entry 仍返回，vecState=embed_failed |
| vec 查询失败 | embed 成功，reader.searchVec 异步 reject | FTS entry 仍返回，vecState=query_failed |
| 成功与禁用 | 两阶段成功；随后 disableVec | 分别得到 ok/disabled，FTS 均可用 |
| 相似检索失败 | 源向量存在，searchVec 异步 reject | 不抛出，entries=[]、total=0、vecState=query_failed |
| 完整工具出口 | 真实 SearchMemory → buildMemoryClient → search_memory，带 supersedes 边、合法 belief、debug=true、pending/dead fixture | source/beliefStatus/supersededBy/drillDown/debug/belief 全透传，metadata 保留，total/coverage/vecState/queueHealth 正确 |
| 既有回归 | 跑 SearchMemory、memory API、queue、投影、client/tool 测试 | 旧断言不因扩字段或降级语义而失败 |

## 测试改动声明

方向：收紧。新增两组测试，不改既有断言。状态测试用真实 SQLite 和可控异步故障边界；出口测试使用真实 `SearchMemory → buildMemoryClient → search_memory` 链，不用窄映射自证，也不只检查 TypeScript 类型。

## Verification

### 失败用例证据（bugfix）

实现前运行两个新增文件，**6 个场景全红**：完整工具链 `source=undefined`，四态均 undefined，两个异步 vec 查询直接抛错。原始摘录见对话工作区 `evidence/pr05-red-before.log`。

修复后同两组加既有 client/tool/SearchMemory 回归：**5 文件 / 58 用例全绿**，见 `evidence/pr05-focused-green.log`。扩大 memory/API/queue/projection 回归为 **40 文件 / 405 用例全绿**，见 `evidence/pr05-memory-suite.log`。

### 回归与最简检查

- 已过最简检查：复用现有 RetrievalResult、MemoryReader、pendingTaskStats、parseBeliefMetadata 和工具序列化；仅新增一个可选健康读口与两个共享类型，无新依赖、无 schema。
- `npm run check`：build、eslint、schema、fresh/existing DB boot、脚本/端口/otterbar 探针全通过，见 `evidence/pr05-check-final.log`。
- `npx vitest run`：**536 文件 / 6854 用例全部通过**，见 `evidence/pr05-full-test-final.log`。
- `npm run test:capability`：**17 文件通过，17 passed + 48 skipped**；跳过均为未配置真实 LLM，确定性 wire 与本地 embedding 用例实跑通过，见 `evidence/pr05-capability-final.log`。
- `npx tsc --noEmit`、eslint、`git diff --check` 与注释编号扫描：通过。
- Golden Gate 已随 capability 执行；锚点重放 `n/a`：tool description 只补充实际响应字段说明，没有改变工具何时调用的触发语义，也未修改 prompt/Skill 文本。

## 回滚

整体 revert 本 PR 即可恢复旧代码；无数据库、配置或数据迁移。新增的 vecState、queueHealth、total 及完整 entry 字段会随代码回退消失，旧调用方不依赖这些字段才能工作。若新版本已消费更完整状态，回滚前应确认消费者重新接受旧的窄响应，但这不需要任何数据修复。
