---
id: F20260908efmd
title: 有效模型一等化与 restart 切模型
summary: 搭档发现 UI 模型 badge/武器栏显示不一致（根因：创建时未显式指定 modelAlias 的獭不落库，但实际仍跑默认模型——配置缺失≠无模型）。确立「有效模型（effective model）」为一等概念：所有展示面显示真实生效模型（空配置回退默认并标注）；restart_otter 增加 modelAlias 参数支持配额耗尽应急切模型；模型身份从 otter 粒度扩展为 session 粒度（每世快照），转世履历展示每世武器。
change_type: feature
capability_test: "n/a: 后端数据模型+API 变更走单测/API 测试断言（tests/），UI badge/武器栏走组件测试；无可采样对话行为断言点"
created_in_conversation: d335d3e1-bb66-4713-9346-caa70cf6afbd
tags: [agent, model-routing, identity, restart, web-ui, data-model]
intent:
  problem: "创建不选模型≠没有模型，獭实际跑默认模型但配置不落库，导致 badge/武器栏有的对话有有的没有；模型配额耗尽时 restart 无法切模型，healing #543 识别 429 终态后无处置手段"
  expected_effect: "每只獭在所有展示面都有真实模型标识；restart_otter 可携带 modelAlias 应急换模型；转世履历展示每一世的武器"
  verify_by:
    type: behavior_check
    detail: "DB 中 model_alias 为空的獭在右栏/武器栏显示默认模型并标注（默认）；restart_otter(modelAlias=xxx) 后 otter_configs 更新且下一世身份注入新模型；转世履历每世行显示该世模型"
modules:
  - src/usecases/otter/manage-session.ts
  - src/usecases/otter/query-otter-profile.ts
  - src/usecases/conversation/manage-participant.ts
  - src/usecases/ports/otter-config-provider.ts
  - src/interface-adapters/http/controllers/otter-controller.ts
  - src/interface-adapters/http/controllers/conversation-controller.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/frameworks/db/schema.ts
  - src/frameworks/db/otter/sqlite-otter-config-provider.ts
  - src/frameworks/db/otter/otter-mapper.ts
  - src/frameworks/agent/identity-builder.ts
  - src/entities/otter/otter-session.ts
  - contract/api/otter.ts
  - web/src/pages/conversation/RightPanel.tsx
  - web/src/pages/conversation/Modals.tsx
  - web/src/components/OtterProfileCard.tsx
  - web/src/lib/mappers.ts
created_at: 2026-09-08
---

# 有效模型一等化与 restart 切模型

## 背景

搭档原话（意图锚）：

> 「无值不展示是对的，但每只海獭必须有模型，创建时不选不代表没有，而是用了默认的，所以海獭肯定是有模型的（默认的应该只视为一种默认配置，而最终生效肯定是某一个model）」

> 「两个特性我认，确实一个是海獭数据模型的优化，一个是 重启獭生功能的优化（但这个优化的前提条件就是 海獭数据模型要支持模型的属性切换）」

> 「我遇到一个场景，有时候某一家模型可能配额用完了，但工作干到一半，所以我期望说 重启獭生 机制 可以增加一个 切换模型的参数」

现状排查结论（2026-09-08 实测，`data/otter-buddy.db`）：

- `otter_configs` 212 条，其中「大獭」135 个实例，仅 **4 个** `model_alias` 非空（均为 glm-flash），131 个为空
- 空 alias 的运行时行为：`ModelPool.getModel(alias)`（`src/frameworks/llm/model-pool.ts:71`）空值回退默认模型——**獭实际跑在某模型上，但配置层没有任何记录**
- UI 层「有值才渲染、缺失如实省略」是既有设计决策（武器面板 F20260826「缺失数据如实省略，不留空占位」），显示行为本身一致——不一致的是底层数据
- 9/1 multi-model-routing 方案（F20260901cxmw）曾把「不支持运行时切换模型——模型选择在创建时固定」列为**非目标**，本特性显式推翻该条（restart 是新旧世边界，不算同世运行时切换，但效果上覆盖了配额应急场景）

## 目标

- T1：确立「有效模型」语义并全链打通——`effectiveModelAlias = config.modelAlias ?? modelPool.getDefaultAlias()`，右栏 badge、身份证武器栏、参与者 DTO、身份注入全部显示有效值；空配置显示为 `<alias>（默认）` 区分显式指定与默认回退
- T2：`restart_otter` 工具 + HTTP `POST /otters/:id/restart` 支持可选 `modelAlias` 参数——校验合法后写回 `otter_configs`，新世以新模型启动
- T3：模型身份 session 粒度化——`otter_sessions` 表快照 `model_alias`（该世生效的模型，含默认解析后的值），转世履历每世行展示武器
- T4：启动期数据修复——存量空 alias 不回填 config（保留「未显式指定」的语义），但 UI 通过 T1 的有效模型解析自动获得展示；存量 session 行的 `model_alias` 为 null 时履历行省略武器展示（如实省略原则的延续）

## 非目标

- 不支持同世运行时换模型（invoke 中途切模型）——换模型只发生在 restart（新旧世边界），保持 F20260901cxmw 的同世不变量
- 不做自动降级/自动 failover——#543 识别 429 后仍由人/獭决策 restart，不自动切换
- 不解决「大獭 135 个实例」的多实体问题（同名多獭 vs 一獭多世的身份模型重构）——那是独立议题，本特性只保证「无论多少实例，每个实例的模型显示都是真实值」
- 不改 `create_otter` 的 modelAlias 语义（仍可选，不传 = 跟随默认）
- 不做模型成本统计（`otter_sessions.model_alias` 可用于未来成本分析，但本特性不实现分析）

## 方案设计

### 核心语义：有效模型（effective model）

```
effectiveModelAlias(otterId) = otterConfigProvider.getConfig(otterId)?.modelAlias ?? modelPool.getDefaultAlias()
isDefaultModel = config?.modelAlias 为空
```

「默认」是一种配置来源标注，不是「无模型」。所有读取模型展示的点位从「读 config 裸值」切换为「读有效模型 + 来源标注」。

### 数据模型变更

**`otter_sessions` 表新增列**：

```sql
ALTER TABLE otter_sessions ADD COLUMN model_alias TEXT;
```

- 语义：该世**生效的模型 alias**（默认解析后的真实值，不是配置裸值）
- 写入时机：`createSession` / `restartSession` 创建行时快照
- 消费方声明（#379 ⑥ 要求）：
  1. **转世履历 UI**（`Modals.tsx`）：每世行展示 `modelAlias`，为 null（存量数据）时省略
  2. **OtterSessionDTO**（`contract/api/otter.ts` → `web/src/lib/mappers.ts`）：透传字段
  3. 未来成本分析（非本特性实现，但字段设计预留）

**`otter_configs` 不变**——`model_alias` 空值继续表示「跟随默认」，不回填存量数据。

### T1 改造点位（展示面）

| 点位 | 文件 | 现状 | 改后 |
|------|------|------|------|
| 右栏 badge | `manage-participant.ts:216` | `configsByOtterId.get(id)?.modelAlias` 空则不返回 | 返回 `effectiveModelAlias` + `modelIsDefault` 标注 |
| 参与者 DTO | `conversation-controller.ts:103` / `mappers.ts:193` | 透传可选 alias | 透传 alias + 默认标注 |
| badge 渲染 | `RightPanel.tsx:363` | 有值才渲染 | 始终渲染；默认来源时显示 `<alias>（默认）` |
| 武器栏 | `query-otter-profile.ts:74` | `config?.modelAlias ?? null`，null 则武器行省略 | 有效 alias 恒非空 + `modelIsDefault`；`resolveModelDescriptor` 改用有效值 |
| 身份注入 | `identity-builder.ts:106` | 已做默认回退（`models.find(alias) ?? find(default)`） | 保持运行时回退，但展示文案标注默认来源 |

统一实现：`ManageParticipant` / `QueryOtterProfile` 各自调用一个共享解析 helper（放 usecase 层，如 `resolveEffectiveModel(config, modelPool): { alias, isDefault }`），不重复造逻辑。

### T2 restart 切模型

**链路**：

```
restart_otter 工具 (tool-factory.ts:432)
  → 新增参数 modelAlias（可选）
  → 校验：ctx.modelPool.hasModel(modelAlias)，非法返回可用列表（与 create_otter 同款错误格式）
  → 自重启：pendingRestart 携带 modelAlias → agent-invoker 执行
  → 重启他人：otterToolClient.restart(otterId, summary, modelAlias)
  → ManageSession.restartSession(otterId, summary, modelAlias?)
      ├─ archiveSession（旧世快照已有 model_alias）——先归档，config 未动
      ├─ modelAlias 存在 → otterConfigProvider.setConfig(otterId, { ...existing, modelAlias })
      │     ⚠️ 硬约束：写回必须在 archive 成功之后、createSession 之前，顺序不可调换
      └─ createSession → 新世行快照 effectiveModelAlias
```

**竞态认领路径的 modelAlias 交互**：按上述顺序，config 写回发生在 archive 成功后、createSession 前。若 createSession 撞 conflict 走 adopt 分支（archive 期间新 invoke 兜底已建新行），config 已写好，adopt 只需照常补 summary——**无额外处理**。但注意：adopt 的新行是由兜底 invoke 创建的，其 `model_alias` 快照取的是当时（config 写回前）的旧值——该行为 null/旧值的偏差可接受（竞态窗口极短，且语义上该行确实诞生于旧配置之下），不引入补偿机制。

**运行时面声明（检视发现 2 处置）**：日志/监控点位（`pi-session-factory.ts:412` getModelAliasForLog、`circuit-breaker-helpers.ts:120` metrics label、`bootstrap/platforms.ts:171` contextWindow 解析）已各自做了等效的默认回退，功能正确。本特性**不改这些点位**——它们不需要 isDefault 标注（日志只关心真实模型），仅展示面需要区分来源。

**HTTP 层**：`otter-controller.ts restart` body 增加 `modelAlias`，经 `modelPool.hasModel` 校验（F20260827ucrt 已有同款校验先例，controller 行 52）。

**访问控制不变**：小獭只能重启自己（可给自己换模型），大獭可重启任意獭。

### T3 session 粒度快照

- 实体：`src/entities/otter/otter-session.ts` `OtterSession` 增 `modelAlias: string | null`；`buildNewSession` 增**可选参数** `modelAlias: string | null = null`——纯工厂不解析有效模型，**解析在调用方完成**（entities 层不依赖 usecase port，检视发现 3/5 处置）
- 写入点位（`buildNewSession` 全部调用方逐一覆盖）：
  | 调用点 | 策略 |
  |--------|------|
  | `ManageSession.createSession`（manage-session.ts:68） | 注入 `ModelPoolLike` + `OtterConfigProvider`（`model-pool-like.ts` 端口已存在，usecase 层依赖它不违分层，settings-controller 已有先例），解析有效模型后传入 |
  | `CreateOtter.execute`（create-otter.ts:66，首世建账，**本 PR 必须覆盖**） | 创建时 alias 已解析过（params.modelAlias ?? 默认），直接传入；注意它不调 ManageSession（避免组装环），需自行解析或复用同一 helper |
  | `backfill-session-ledger.ts:34`（存量迁移） | 传 null——存量不回填（T4） |
  | `agent-invoker.ts:539`（session backfill 兜底） | 经 `ManageSession.createSession` 路径，自动获得快照，无需单独改 |
- 查询：`OtterSessionDTO` 增加 `modelAlias`；mapper 透传；`Modals.tsx` 转世履历每世行显示武器（`<alias>` 或 `<alias>（默认）`——快照存的是解析后值，来源标注需要额外存吗？**不存**：快照只管「这一世实际用什么」，来源标注是当前配置视角的概念，历史世不需要）

### 关键接口变更

```typescript
// usecases/ports/otter-config-provider.ts（窄端口新增，不动 OtterConfig）
export interface EffectiveModel {
  alias: string;        // 恒非空（默认解析后）
  isDefault: boolean;   // true = 配置未显式指定，跟随默认
}

// ManageSession
restartSession(otterId: string, summary?: string, modelAlias?: string): Promise<OtterSession>

// OtterSession 实体 / DTO
modelAlias: string | null  // null = 存量历史数据未快照
```

### 存量数据处理

- `otter_configs.model_alias` 空值：**不动**，T1 的解析层自动覆盖显示
- `otter_sessions.model_alias`（迁移后为 null）：**不回填**——历史世的真实模型已不可考（当时的默认模型可能与现在不同），null 如实省略
- 迁移：幂等 `ALTER TABLE`（schema.ts 既有 `columns.some(...)` 检查模式）

## 影响范围

- **UI 显示变化**：所有对话的右栏獭卡片将出现模型 badge（此前 131/135 大獭无 badge）——这是预期变化，正是搭档要的「每只獭必须有模型」
- **工具签名变化**：`restart_otter` 参数新增（向后兼容，可选）；`otterToolClient.restart` 签名扩展
- **DTO 变化**：`ParticipantDTO` / `OtterProfileDTO` / `OtterSessionDTO` 增字段（向后兼容，web 端 mapper 已习惯可选透传模式）
- **不动**：默认模型选择逻辑、create_otter、invoke 路径的模型解析（`pi-session-factory.ts:412` 已有同款回退）

## 风险与约束

1. **「（默认）」标注的 UI 噪音**：131 只大獭突然全部显示 `kimi（默认）`，右栏空间紧张。缓解：badge 已有 `whitespace-nowrap shrink-0` 防变形（#512 修复），默认标注可以用更轻的视觉（如括号灰色小字）——具体样式实现时定，原则是不再出现「无 badge」
2. **config 写回顺序是硬约束**：invoke 的模型选择是每次 invoke 时从 `otter_configs` 实时读的（`pi-session-factory.ts:412`）。若 config 写回放在 archive 之前，archive 失败会导致当前世下一次 invoke 偷换模型——违反同世不变量。因此顺序固定为 **archive → 写 config → createSession**；archive 失败则 config 不动，restart 原子性靠此保证。竞态 adopt 路径见 T2 链路说明。
3. **session-restore 重建路径**：session 文件丢失时 `recreateFromConfig` 从 config 读 alias——这是 otter 粒度，与本特性的 session 快照不冲突（重建场景本身就是「新 session」，用当前 config 正确）
4. **identity-builder 的展示一致性**：prompt 注入的「你的运行时模型」段与实际 invoke 模型必须一致——目前两处都走 config+默认回退，本特性不改运行时逻辑，只统一展示语义

## 不兼容更新

无破坏性变更。DB 迁移为幂等加列；DTO 加字段向后兼容；工具参数新增可选。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|----------|------|
| 空 alias 语义 | 保留「跟随默认」，展示层做默认解析 | 创建时强制落库默认 alias / 启动时批量回填 | 搭档原话：「默认的应该只视为一种默认配置，而最终生效肯定是某一个model」——回填会冻结历史默认，默认模型日后变更时老獭不会跟随，与语义相悖 |
| 每世模型快照 vs 履历实时解析 | 快照进 `otter_sessions.model_alias` | 履历展示时用当时的 config 反推 | 反推不可能——config 是当前值，历史世的模型不可考（尤其 restart 换模型后）；快照是唯一能回答「那一世用什么模型」的方式 |
| 换模型生效时机 | restart 边界生效（新世新模型） | 运行时热切换 | 保持 F20260901cxmw 同世不变量；热切换会让同一会话上下文跨模型（token 计费/上下文窗口/风格突变），复杂度爆炸 |
| config 写回顺序 | archive 成功后、createSession 前 | restart 一开始就写 | 见风险 2：避免「世没换成但 config 已改」导致当前世下次 invoke 偷换模型 |
| 历史 session 的 model_alias | 不回填（null 省略） | 回填为当前默认 | 历史不可考，假数据违反「无假数据」原则（F20260826 面板 T2） |
| 机制预算四问 | 见下 | — | — |

**机制预算四问**（净新增机制：`EffectiveModel` 解析概念 + session 快照字段 + restart 参数）：

- ① **谁需要它**：有效模型解析——右栏/武器面板的展示消费者（搭档肉眼）；restart modelAlias——配额耗尽时的操作者（搭档/大獭）；session 快照——转世履历展示 + 未来成本分析
- ② **失败后果**：无有效模型解析 → UI 继续「有的有 badge 有的没有」，搭档持续困惑；无 restart 换模型 → 429 终态后工作卡死只能等新一天配额；无快照 → 履历永远回答不了「那世用什么模型」
- ③ **后续机制**：快照字段可能出错的状态——新写入路径忘传 alias（lint/测试覆盖：createSession 必传）；「（默认）」标注在默认模型变更后显示漂移（可接受，本来就是跟随语义）
- ④ **退役条件**：若未来实现「獭身份统一」（一獭多世取代同名多实体）+ 模型池收敛为单模型，有效模型解析和快照都可以简化——信号是多模型路由配置被移除

## 验证

**后端单测**：
- `resolveEffectiveModel`：config 有值→用值；空→默认+isDefault；config 不存在→默认
- `restartSession(modelAlias)`：合法 alias → config 写回 + 新世快照；非法 alias → 校验错误（hasModel 前置，不进 usecase）；archive 失败 → config 未被改写（顺序守护）
- `createSession`：新行快照 effectiveModelAlias
- 迁移幂等：重复执行不报错

**API 测试**（tests/api/otter.test.ts 扩展）：
- POST restart 带 modelAlias → 201 + session.modelAlias 为新值 + GET otter 显示新 alias
- POST restart 带非法 modelAlias → 400 附可用列表
- GET participants → 空 config 獭也带 modelAlias + isDefault 标注

**Web 组件测试**：
- RightPanel：isDefault=true 时 badge 显示「（默认）」；无 modelAlias 字段的旧 DTO 不炸（向后兼容）
- Modals 转世履历：有 modelAlias 的世显示武器，null 省略
- OtterProfileCard：武器栏恒显示

**手工验收**：启动后打开若干旧对话，确认右栏大獭全部有 badge；`restart_otter` 带 modelAlias 重启一只獭，确认武器栏和下一世身份注入变更。

## 决策史（审视轮次）

**第 1 轮（方案检视獭 mimo，2026-09-08）**：结论「需要修改」——1 严重 + 4 建议，处置：

| 发现 | 级别 | 处置 | 更好/更差判断 |
|------|------|------|---------------|
| 1. T2 链路 config 写回顺序与风险约束自相矛盾 | 严重 | **接受并修订**：链路顺序改为 archive→写 config→createSession，补充 adopt 路径说明（config 已写好、adopt 快照为旧值可接受不补偿） | 改了更好——按原文档实现必然踩自己识别的坑 |
| 2. 运行时日志/监控面未纳入 T1 | 建议 | **接受并修订**：T2 段末显式声明「这些点位已有等效语义，本次不改」 | 改了更好——消除实现者误判 |
| 3. buildNewSession 调用点覆盖（分层注入可行性） | 建议 | **接受并修订**：T3 段列出全部调用点策略表；确认 usecase 依赖 ModelPoolLike 端口不违分层（settings-controller 先例）；entities 层不解析、调用方传值 | 改了更好——backfill/兜底路径确实会漏 |
| 4. pendingRestart 自重启路径 modelAlias 透传遗漏 | 建议 | **接受并修订**：改动范围补 agent-tools.ts（ToolContext 类型）、pi-session-factory.ts（_selfRestart 构造）、agent-invoker.ts（handleSelfRestartSignal）三处 | 改了更好——不改则自重启换模型静默失效 |
| 5. buildNewSession 签名变更影响面 | 建议 | **接受并修订**：新参数设可选默认 null（现有调用方零改动），create-otter.ts 首世显式传值列入改动范围 | 改了更好——可选参数避免编译期大爆炸，首世快照不丢 |

全部接受，无反驳——5 条发现均附 file:line 证据且经作者复核成立（create-otter.ts:66 直调 buildNewSession、agent-tools.ts:132 pendingRestart 类型、buildNewSession 三调用点均已核实）。

**Delta 复核（同轮）**：通过，附 1 处清理项——T2 段残留第一轮旧描述「config 写回放在 archive 之前」，与修正后链路矛盾，已删除。

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/frameworks/db/schema.ts | M | otter_sessions 加 model_alias 列 + 幂等迁移 |
| src/entities/otter/otter-session.ts | M | OtterSession.modelAlias + buildNewSession 参数 |
| src/frameworks/db/otter/otter-mapper.ts | M | session 行 ↔ 实体映射新字段 |
| src/usecases/otter/manage-session.ts | M | createSession 快照 + restartSession 增 modelAlias 参数（含 config 写回顺序） |
| src/usecases/ports/otter-config-provider.ts | M | 新增 EffectiveModel 类型 / resolveEffectiveModel helper |
| src/usecases/conversation/manage-participant.ts | M | 参与者查询返回有效模型 + isDefault |
| src/usecases/otter/query-otter-profile.ts | M | 武器栏用有效模型 + isDefault |
| src/interface-adapters/http/controllers/otter-controller.ts | M | restart body 增 modelAlias + hasModel 校验 |
| src/interface-adapters/http/controllers/conversation-controller.ts | M | ParticipantDTO 增 isDefault |
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | M | restart_otter 增 modelAlias 参数 + 校验 + pendingRestart 透传 |
| src/interface-adapters/agent-runtime/agent-invoker.ts | M | handleSelfRestartSignal 透传 modelAlias 至 restartSession（signal 类型同步扩展） |
| src/usecases/ports/agent-tools.ts | M | ToolContext.pendingRestart 类型扩展 `{ summary?: string; modelAlias?: string }` |
| src/frameworks/agent/pi-session-factory.ts | M | `_selfRestart` 信号构造透传 pendingRestart.modelAlias（pi-session-factory.ts:510） |
| src/frameworks/agent/identity-builder.ts | M | 模型身份段标注默认来源 |
| src/usecases/otter/create-otter.ts | M | 首世 buildNewSession 传入解析后的 modelAlias（本 PR 必须覆盖，检视发现 5） |
| contract/api/otter.ts（或对应 DTO 文件） | M | OtterSessionDTO/OtterProfileDTO/ParticipantDTO 增字段 |
| web/src/lib/mappers.ts | M | DTO 透传新字段 |
| web/src/pages/conversation/RightPanel.tsx | M | badge 恒渲染 + 默认标注 |
| web/src/components/OtterProfileCard.tsx | M | 武器行恒渲染 + 默认标注 |
| web/src/pages/conversation/Modals.tsx | M | 转世履历每世行显示武器 |
| tests/api/otter.test.ts | M | restart modelAlias 用例 |
| web 测试若干 | M | badge/武器/履历组件测试 |

## 实现要点

### T1 有效模型解析
- `EffectiveModel` 接口 + `resolveEffectiveModel(config, modelPool)` helper 放 `otter-config-provider.ts`（usecase 层端口，所有消费方可依赖）
- `ManageParticipant.getActiveParticipants` 注入 `ModelPoolLike`，participants 返回 `modelAlias`（恒非空）+ `modelIsDefault` 标注
- `QueryOtterProfile.execute` 使用 `resolveEffectiveModel`，武器栏恒非空 + `modelIsDefault`
- `IdentityBuilder.buildModelIdentity` 空配置时显示 `alias（默认）`
- 右栏 badge、武器面板、转世履历全部加 `（默认）` 后缀渲染

### T2 restart 切模型
- `restart_otter` 工具增加 `modelAlias` 可选参数 + `hasModel` 校验
- `ManageSession.restartSession` 增第三参 `modelAlias?: string`
- **硬约束**：archive 成功后 → 写 config → createSession（顺序不可调换）
- `pendingRestart` 类型扩展 `{ summary?: string; modelAlias?: string }`（agent-tools.ts）
- `_selfRestart` 信号扩展 `modelAlias`（pi-session-factory.ts + circuit-breaker-helpers.ts）
- `handleSelfRestartSignal` 透传 `modelAlias` 至 `restartSession`
- HTTP `POST /otters/:id/restart` body 增 `modelAlias` + `hasModel` 校验（400 附可用列表）
- `OtterToolClient.restart` 签名扩展，`bootstrap/clients.ts` 装配更新

### T3 session 粒度快照
- `otter_sessions` 加 `model_alias` 列（幂等 ALTER TABLE，schema.ts）
- `OtterSession` 实体增 `modelAlias: string | null`
- `buildNewSession` 增第四参 `modelAlias: string | null = null`
- `SessionRow` + `rowToSession` mapper 映射新字段
- `sqlite-otter-repository.createSession` INSERT 含 `model_alias`
- `CreateOtter.execute` 首世建账时显式传入解析后的 modelAlias（自行解析避免组装环）
- `backfill-session-ledger.ts` 存量迁移传 null（不回填，如文）
- `OtterSessionDTO` 增 `modelAlias?: string | null`
- `toOtterSessionDTO` 透传 `modelAlias`
- 前端 `mapSessionDTO` 透传 `modelAlias`
- 转世履历每世行显示 ⚔️ + modelAlias（null 省略）

### 未改点位（运行时日志/监控）
- `pi-session-factory.ts:412` `getModelAliasForLog`、`circuit-breaker-helpers.ts:120` metrics label、`bootstrap/platforms.ts:171` contextWindow 解析——已有等效默认回退，不改

## 验证

### 编译
- `npx tsc --noEmit` — **0 错误**

### 测试结果
- `npx vitest run` — **247 文件 / 3102 测试全绿**（含 pre-existing 3102 条通过）
- 关键测试：
  - `tests/api/otter.test.ts` — restart 带 modelAlias 用例通过（3 个 restart 断言已更新为3 参）
  - `tests/interface-adapters/agent-invoker-self-restart.test.ts` — 11 个自重启测试全绿
  - `tests/usecases/otter/manage-session-restart.test.ts` — 重启流程测试全绿
  - `tests/frameworks/db/otter/backfill-session-ledger.test.ts` — 存量迁移测试全绿

### 自检报告

**pre-existing 声明**：无。所有测试失败均在本次变更后修复。

**最简实现检查**：已过。
- `resolveEffectiveModel` 单函数放端口文件（非独立文件），最小侵入
- session 快照复用既有 `buildNewSession` 工厂加可选参数，未引入新概念
- 配置写回直接用 `otterConfigProvider.setConfig`，未引入新机制
- 运行时日志点位不改（已有等效语义），避免过度建设

**废弃资源清理**：不适用（无旧路径/旧文件替换）。
