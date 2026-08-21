---
id: F20260821scrt
title: secrets-write-redaction
doc_type: feature

summary: |
  在 LLM 可写持久层（memory_entries / otter_context / linked_resources / otter_sessions.summary / memory_edges）写入前做 secrets 脱敏，明文密钥不再入库（issue #366 #2，PR-3）。
  根因：用户粘贴的 token/密钥会随消息投影与 set_context 零防御进入持久层，唯一单用户形态下也伤人。
  机制：纯函数 redactSecrets（已知前缀 + PEM 块 + 带标签赋值的保守模式集），在 StoreMemory 三个写入口与各 usecase 持久化点统一拦截，DB 双写表与 embedding 均拿脱敏后内容。三路对抗审视后扩模式集、修三处替换缺陷、补三个漏网通道。

causal_links:
  from:
    - F20260812mrcq

status: development
change_type: feature
tags: [security, memory, redaction]
modules:
  - src/usecases/security/redact-secrets.ts
  - src/usecases/memory/store-memory.ts
  - src/usecases/otter/manage-context.ts
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为——redaction 对 LLM 透明，不改变任何工具契约"
---

# F20260821scrt: secrets 写入前脱敏

## 背景与需求

### 问题描述

issue #366 #2（尽调清单）：LLM 可写持久层存在 secrets 通道——

1. **系统主动 store_memory**：用户在对话中粘贴的 token/密钥随消息正文投影进入 `memory_entries`（含 `memory_fts` / `memory_fts_jieba` 双写表与 embedding 向量），零防御、零脱敏。
2. **`otter_context` 是 LLM 可写的自由 TEXT KV**（`set_context` 工具）：模型可往持久化存储塞任意内容。
3. 涉及面还包括 `connections.metadata`、`messages.metadata`、`settings` 等无 schema 自由 TEXT。

Owner 排期（issue #366 评论）将此项从"产品化触发条件"提前纳入 W0 快赢：**唯一单用户形态下也伤人的安全项**。本 PR 覆盖定义中的两个通道：`store_memory` 与 `otter_context`。

### 根因分析

- 记忆索引把完整对话正文（`send-message.ts` 三处 `indexMessage`：发送 :146 / 完成 :279 / 中止 :343）作为检索语料投影入库，从未考虑内容敏感性。
- `set_context` 工具的 value 从工具入参到 DB UPSERT 全链路原样透传（`tool-factory.ts` → `clients.ts` → `ManageContext.set` → repo）。
- 全仓在本次之前不存在任何 redaction/sanitize 代码。

### 数据实锤

- `src/frameworks/db/schema.ts`：`memory_entries.content`(:160)、`otter_context.value`(:459-463)、`memory_fts.content`(:184) 均为自由 TEXT。
- 代码路径实锤见"方案设计"调用链。

## 方案设计

### 技术方案

**拦截点选择**（权衡记录）：

| 候选 | 结论 |
|------|------|
| `StoreMemory.execute/replaceBySource/replaceChunksBySource`（usecase 入口） | ✅ 采用。所有记忆持久化（消息投影 / fact / linked_resource / 文档 summary+chunks）必经这三个方法，一处拦截覆盖全部来源，且已有测试基架 |
| `ManageContext.set`（usecase） | ✅ 采用。otter_context 唯一写入口（工具侧）。系统内部状态（`embedding_degraded`，bootstrap/database.ts:182）直写 repository，不经 usecase，天然不受影响、无需豁免 |
| `MemoryWriter`（port 层） | ❌ 未采用。内容改写放在 adapter 前的 port 上职责错位，且收益为零（上游 StoreMemory 已全覆盖） |
| `tool-builder.ts` 统一工具闭包 | ❌ 本 PR 不采用。覆盖面更广（scheduled_tasks.body 等）但需按工具名配置字段路径，复杂度高；留待后续按观测数据决定 |

**redactor 设计**（`src/usecases/security/redact-secrets.ts`，纯函数）：

- 已知前缀模式（整串替换为 `[REDACTED]`）：Anthropic `sk-ant-`、OpenAI `sk-` / `sk-proj-` / `sk-svcacct-`、GitHub `gh[pousr]_`、AWS `AKIA|ASIA`、Slack `xox[baprs]-`、Google `AIza`、JWT 三段式、`Bearer ` 凭据。
- 带标签赋值模式（保留标签、只替换值）：`api_key|apiKey|secret|token|password|...` 及中文 `密钥|密码|令牌|凭据|口令` + `[:=]` + ≥16 字符凭据字符集。
- **刻意保守**：模式集只覆盖"明文密钥不再入库"目标，不做全量 PII 清洗；短占位符（`sk-xxx`）、URL、普通代码片段不误伤（有专门测试用例）。
- metadata 递归脱敏（字符串值 / 嵌套对象 / 数组），无命中返回原引用（`===` 可用于变更检测，避免多余 warn）。

**时序保证**：redaction 在 `StoreMemory` 构造 entry 之前完成，因此同步事务（entries + fts + weights 双写）与 fire-and-forget embedding 拿到的都是脱敏后内容——FTS 表与向量不会泄露，也无需双写同步逻辑。

**观测**：命中时 `logger.warn` 只记录来源定位（`sourceTable/sourceId/contentType`），不记录原文与命中串。

### 目标

- T1: 用户粘贴的明文密钥不再以明文进入 `memory_entries`（含 FTS 双写表与 embedding 向量）
- T2: `set_context` 写入的明文密钥不再以明文进入 `otter_context`
- T3: 正常对话/文档内容零误伤（保守模式集）
- T4: 系统内部 otter_context 写入（embedding_degraded 等）不受影响
- T5（对抗审视后新增）: fact 本体表 / restart 前情摘要 / link_memory 备注三个 LLM 自由文本通道同享脱敏

### 成功标准

单测证明 T1-T4；全量 `npm test` 无回归。

## 验收标准

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | T1 | 单测：`store-memory.test.ts` "execute：content 含密钥时入库与 embed 均为脱敏后内容" 等 5 例 | 入库 content/metadata 与 embed 收到的均为 `[REDACTED]` 版本；普通内容不变 |
| AT-2 | T2 | 单测：`manage-context.test.ts` 2 例 | value 脱敏入库，key/otterId 原样；普通值原样 |
| AT-3 | T3 | 单测：`redact-secrets.test.ts` 误伤防护 6 例 + metadata 引用等值 1 例 | 普通文本/URL/短占位符/含 "token" 一词的句子均不变；无命中 metadata 返回原引用 |
| AT-4 | T1（覆盖面） | 调用链审查：三写入口汇聚消息投影/fact/linked_resource/文档 summary+chunks | `bootstrap/memory.ts` 所有索引方法均走 StoreMemory 三方法，无旁路 |
| AT-5 | T5 | 单测：manage-key-info 3 例 / manage-session 1 例 / create-edge 2 例 | 三通道落库内容脱敏，普通内容原样 |

### 能力测试映射

| 验收场景 | 能力测试文件 |
|---------|-------------|
| 全部 | n/a（A 类纯代码逻辑，LLM 行为不变） |

## 实现细节

### 代码修改

- 新增 `src/usecases/security/redact-secrets.ts`：`redactSecrets(text)` / `redactMetadataSecrets(metadata)` / `REDACTED_PLACEHOLDER`
- `src/usecases/memory/store-memory.ts`：新增私有 `redactInput()`，三个写入口（execute/replaceBySource/replaceChunksBySource）入口处统一调用；命中时 warn（仅定位信息）
- `src/usecases/otter/manage-context.ts`：`set()` 对 value 调 `redactSecrets`
- `src/usecases/conversation/manage-key-info.ts`（对抗审视后补）：`buildResource` 对 content + metadata 脱敏
- `src/usecases/otter/manage-session.ts`（对抗审视后补）：createSession / setSessionSummary / restart 竞态认领三个 summary 持久化点脱敏
- `src/usecases/memory/create-edge.ts`（对抗审视后补）：落库前对 metadata（含 note）脱敏

### 逻辑变更

- `StoreMemory` 各入口参数重命名为 `rawInput(s)`，脱敏后 `input(s)` 再构造 entry 与触发 embedding——对调用方（MemoryIndexAdapter / ManageKeyInfo）零感知。
- 工具契约不变：`set_context` 仍返回原文确认（LLM 自己生成的内容回显给 LLM 无新增泄露面）；读取路径（get_context / search_memory）返回的是已脱敏存储值。
- 带标签替换为三捕获组结构（标签+分隔符 / 引号 / 值）：保留标签与引号、只脱值；值尾部 `.` 视为句读保留（base64 以 `=` 结尾不以 `.` 结尾）。

### 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/usecases/security/redact-secrets.ts | 新增 | 脱敏纯函数（对抗审视后扩模式集 + 修三处替换缺陷） |
| src/usecases/memory/store-memory.ts | 修改 | 三写入口接入 |
| src/usecases/otter/manage-context.ts | 修改 | set 接入 |
| src/usecases/conversation/manage-key-info.ts | 修改 | fact 本体表接入 |
| src/usecases/otter/manage-session.ts | 修改 | summary 三持久化点接入 |
| src/usecases/memory/create-edge.ts | 修改 | edge metadata（note）接入 |
| tests/usecases/security/redact-secrets.test.ts | 新增 | 命中/误伤/metadata/审视补充用例 |
| tests/usecases/otter/manage-context.test.ts | 新增 | set 脱敏用例 |
| tests/usecases/otter/manage-session-restart.test.ts | 修改 | setSessionSummary 脱敏用例 |
| tests/usecases/conversation/manage-key-info.test.ts | 修改 | fact 脱敏用例 |
| tests/usecases/memory/create-edge.test.ts | 新增 | note 脱敏用例 |
| tests/usecases/memory/store-memory.test.ts | 修改 | 三路径脱敏用例 |

## 验收结果

### 测试结果

- 定向：6 文件 45+ 用例全过（含对抗审视补充的混合密钥/长文本时序/幂等/短 ant 顺序用例）
- 全量：`npm test` 115 文件 1403 用例全过（对抗审视修复前基线：114 文件 1380 用例）
- `npx tsc --noEmit` 无错误；lint 0 error（8 个存量 warning 为 web/ 前端既有项）

### 证据判定

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| T1 | 证明完成（store-memory 5 用例 + 调用链审查） | ✅ |
| T2 | 证明完成（manage-context 2 用例） | ✅ |
| T3 | 证明完成（误伤防护用例 + Slack 结构约束防误报用例） | ✅ |
| T4 | 证明完成（系统写入直写 repo，路径不相交） | ✅ |
| T5 | 证明完成（manage-key-info 3 例 + manage-session 1 例 + create-edge 2 例） | ✅ |

## 对抗审视记录

2026-08-21 提 PR #374 后三路独立 agent 对抗审视（安全攻击视角 / 实现正确性视角 / 架构完整性视角）。通过项：拦截点完整性（`new StoreMemory` 全仓唯一、无旁路写 memory_entries/FTS、embedding 队列只存 entryId）、无 ReDoS、无 lastIndex 污染、strip 不会切碎 key、幂等性成立、验收声明与实况一致。发现与裁决：

| # | 发现 | 来源 | 评级 | 裁决与处置 |
|---|------|------|------|-----------|
| 1 | `linked_resources.content`（fact 本体表）旁路：索引侧已脱敏但本体存明文，且未列入排除清单 | 架构 | 中 | **本 PR 补接**（用户拍板）：`ManageKeyInfo.buildResource` 写入前脱敏 content + metadata |
| 2 | `otter_sessions.summary`（restart 前情摘要，LLM 自由文本）旁路 | 架构 | 中 | **本 PR 补接**（用户拍板）：`createSession` / `setSessionSummary` / restart 竞态认领三个持久化点全部脱敏 |
| 3 | `memory_edges.note`（link_memory 备注）未脱敏 | 架构 | 低 | **本 PR 补接**（用户拍板）：`CreateEdge.execute` 落库前脱敏 metadata |
| 4 | 值字符集含 `.`，句尾句号被吞进占位符；`_m.replace(value)` 字面量查找写法脆弱 | 正确性 | 缺陷 | **已修**：重构为三捕获组（标签+分隔符 / 引号 / 值），尾部句号视为标点保留 |
| 5 | Bearer 模式整串替换吞掉 "Bearer" 一词，说明性文字受损 | 正确性+安全 | 缺陷 | **已修**：保留 `Bearer ` 前缀，只脱凭据部分；字符集补 `.` |
| 6 | 全角引号 `“` 阻断值捕获，`密码：“xxx”` 漏检 | 正确性 | 缺陷 | **已修**：可选引号扩为 `["'\u201c\u2018]` |
| 7 | PEM 私钥块完全不覆盖（deploy key / k8s Secret 常见） | 安全 | Critical | **已修**：加 PEM 块多行模式（非贪婪整体替换） |
| 8 | 无前缀 hex/base64 secret（飞书 app_secret、Azure AccountKey）靠标签命中，词表缺 `client_secret/account_key/private_key/access_token/refresh_token/credential`；`\b` 对 `_` 复合词不生效 | 安全 | Critical | **已修**：词表逐项补齐 |
| 9 | 常见前缀缺失：Stripe `sk_live_`、GitHub fine-grained `github_pat_`、GitLab `glpat-`、`hf_`、`npm_` | 安全 | Critical | **已修**：前缀集补齐 |
| 10 | 中文标签只认全角冒号 `：`，`密码: xxx` 漏检；词表缺 `秘钥/私钥` | 安全 | Medium | **已修**：分隔符改 `[：:=]`，词表补齐 |
| 11 | 密码类标签阈值 16 漏掉大量真实密码（8-15 位） | 安全 | Medium | **已修**：password/密码/口令 类单独降阈值到 8 |
| 12 | Slack 模式无结构约束，`xoxb-my-company-token` 型普通文字误报 | 安全 | 误报 | **已修**：要求前缀后首字符为数字 |
| 13 | 换行切断的 key、二次编码（base64/URL/HTML 实体）不覆盖 | 安全 | Low | **接受为声明边界**：regex 追不完，代码头注释与本文档记录 |
| 14 | `token:` 后跟 sha256/git hash 会误报，损害记忆真实性 | 安全 | 误报 | **接受为已知 trade-off**：严格阈值 16+ 下误报面已收窄，观测到实际损害再调 |
| 15 | metadata key 与 otter_context 的 key 不脱敏 | 安全 | Low | **接受**：key 参与检索匹配，脱敏破坏检索；key 出现密钥概率低 |
| 16 | 存量数据不回溯，PR 前入库的明文仍可读出 | 安全 | Medium | **用户拍板挂后续**：与密钥管理（#3）或产品化触发统一做，避免 PR 膨胀 |
| 17 | "不放 port 层"决策对未来不稳健：PR-12 若新增写入 usecase，编译器不强制调 redactSecrets | 架构 | 评估 | **补记触发条件**：PR-12 动工时重评是否下沉为 MemoryWriter 装饰器（发现 1-3 即现成反例，已通过全数补接缓解） |
| 18 | 测试缺口：混合密钥 / 6000+ 长文本时序 / sk-ant 短 key 顺序 / 幂等性 | 正确性 | 建议 | **已补**：4 类用例全部落地 |

## 设计决策（对抗审视后补充）

- **三通道补接的定位**：linked_resources / otter_sessions.summary / memory_edges 与 memory_entries / otter_context 同属"LLM 可写持久层"同一件事，本 PR 一并覆盖后，已知 LLM 自由文本入库通道全部有脱敏；剩余排除项（message_events.payload、messages.metadata、scheduled_tasks.body、terminology、存量数据）仍挂密钥管理 #3。
- **port 层下沉的触发条件**：当前 usecase 层拦截对既有代码完备；当出现新的记忆写入 usecase（PR-12 consolidation 是最近的候选）时，评估把 redactSecrets 下沉为 `MemoryWriter` 写入方法的装饰器，用装配层防呆替代逐 usecase 自觉。

## 设计决策

- **为何不用 prompt 约束 LLM 不存密钥**：用户粘贴密钥是用户行为，LLM 无法阻止；此场景主手段是机制兜底而非让 LLM 懂。反之，本改动也未给 `set_context` 工具描述加"勿存密钥"提示——机制已兜底，加 prompt 属 B 类变更会引入能力测试负担，留待观测到 LLM 频繁尝试存密钥再议。
- **替换占位符统一 `[REDACTED]`**：不保留前缀/长度/类型信息，杜绝侧信道。
- **embedding 用脱敏后内容**：向量本身是不可读投影，但向量可被检索侧间接探测，统一用脱敏版内容无额外成本。
- **明确排除范围（本 PR 不做，挂后续）**：`messages.metadata`、`message_events.payload`（工具调用入参持久化，含 set_context 原文回显）、`message_segments`（对话正文本体）、`connections.metadata`、`settings`、`scheduled_tasks.body`、`terminology_entries`、存量历史数据的追溯清洗（对抗审视 #16，用户拍板挂后续）。这些通道的密钥治理随"产品化触发条件"下的密钥管理（KMS/env 强制路径，#3）统一处理。

## 关联

- 上游：issue #366（#2 secrets 通道）、Owner 拆分定稿 PR-3
- 下游：PR-12（记忆语义层）合入摘要时复用同一 redactor；密钥管理（#3）落地时重估排除范围
