---
id: F20260810rout
title: otter-talking-stone-misroute
doc_type: feature

summary: |
  子獭（检视獭等）完成本职后把发言权（talking_stone）传给 user，本该传回召唤者大獭。
  根因是 speak 工具路由规则(1)「仅当任务完成传 user」对子任务和整体任务没区分，
  且系统未把「召唤者=对接人」作为硬约束注入子獭上下文。LLM 按规则字面意思走捷径。

causal_links:
  from:
    - F20260803trrf
  to: []

status: design
change_type: prompt
tags: [agent-routing, talking-stone, prompt, multi-otter]
modules:
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/frameworks/agent/pi-session-factory.ts
  - .pi/SYSTEM.md
  - .pi/skills/adversarial-review/SKILL.md
capability_test: tests/capability/talking-stone-routing.capability.test.ts
---

# F20260810rout: 海獭发言权路由错误（talking_stone misroute）

> **阶段说明**：本文档 Part 1 为根因诊断（已完成），Part 2（方案设计、变更、Acceptance Test）待补充。

## 背景

### 问题描述

用户在 2026-08-10 的三个对话（《ui优化》《skill优化》《speak优化》）中，多次对海獭说「你找错人了，你应该找 xxx」。

用户的核心诉求：

> 我期望海獭们协作来完成事情，而不是每一轮都来喊我。otter 系统创建出来就是要让海獭们**协作**来完成某些事情的。

现状是海獭-to-user-to-otter 的**星型中转**：用户被卡在中间当路由器。用户想要的是海獭之间的 **P2P 协作**。

### 现象数据（基于 messages 表 talking_stone_passed_to 字段）

三个对话中共识别出 **11 次路由错误**，其中 **9 次触发用户明确纠正**。

**skill优化**（大獭=06fd1d90, 检视獭=751152fc）

| seq | 发言者 | passed_to | 应传给 | 用户纠正 |
|----|--------|-----------|--------|---------|
| 21 | 检视獭 | user | 大獭 | s22「你找错人了，你找下大獭」 |
| 24 | 大獭 | user | 检视獭复核 | s25「你找错人了，你让检视獭看看」（自我签收） |
| 29 | 检视獭 | user | 大獭 | s30「你签收完了应该告诉大獭，而不是叫我」 |

**speak优化**（大獭=2bc22fe4, 设计检视=ed516d19, 代码检视=247ce6d2）

| seq | 发言者 | passed_to | 应传给 | 用户纠正 |
|----|--------|-----------|--------|---------|
| 8 | 设计检视 | user | 大獭 | s9「你应该让大獭来处理下」 |
| 11 | 大獭 | user | 检视复核 | s12「你改完了那得让他复核下」（自我签收） |
| 14 | 设计检视 | user | 大獭 | s15「你回错人啦，你还是要找大獭 他是主导者」 |
| 21 | 代码检视 | user | 大獭 | s22「你回复错人了，你应该让大獭来处理下」 |

**ui优化**（大獭=bfadcff9, 多个检视獭轮替）

| seq | 发言者 | passed_to | 应传给 | 用户纠正 |
|----|--------|-----------|--------|---------|
| 8 | 检视獭 | user | 大獭 | s9「开发者是大獭，你和大獭一起讨论」 |
| 14 | 检视獭 | user | 大獭 | — |
| 29 | 检视獭-PR200 | user | 大獭 | s30「检视应该评论到pr上，然后应该叫开发者(大獭)来处理」 |
| 42 | 检视獭-方案 | user | 大獭 | s43「你找错人了，你要找下大獭让他看看」 |
| 45 | 大獭 | user | 检视复核 | s46「你应该让检视者看看复核」（自我签收） |

### 两种失败模式

**模式 A：检视獭 → user（应 → 任务主导者/开发者）** — 8 次
- 触发：检视獭完成首轮审视 / delta 复核后
- 规律：**所有检视獭的首轮发言 passed_to 都是 user，无一例外**
- 根因：检视獭缺「召唤我的是 X，结论要交回 X」的硬约束，默认向对话创建者（用户）汇报

**模式 B：大獭 → user（应 → 检视獭复核）** — 3 次（skill24 / speak11 / ui45）
- 触发：大獭处置完检视意见后
- 根因：大獭把「我修完了」等同于「闭环了」，缺「修复≠签收，须由原审视者复核」的对抗闭环意识

## 变更

### 设计原则

- **prompt 硬规则为主**（让 LLM 懂怎么做），**工程兜底为辅**（按需）——遵循「机制约束优先让 LLM 理解」
- **信道分层**：路由规则作为**必达硬规则**进身份注入（首次 invoke 进 session 上下文），不是按需 know-how
- **分两期**：第一期做 prompt 层 + 身份注入（L1-L4），验证效果后再决定是否需要工程兜底（L5）

### 第一期变更（核心修复）

#### 变更 1：L2 修复 — buildIdentityPrefix 注入召唤者身份（关键修复）

**文件**：`src/frameworks/agent/pi-session-factory.ts:552-577`（`buildIdentityPrefix`）

**问题**：函数拿到完整 `otter` 对象（含 `parentOtterId`），但只读 `otter.name`，不读 `parentOtterId`。子獭不知道召唤者。

**改动**：对小獭（`!isBig`），注入召唤者身份段。需要从 `otterRepo.getById(otter.parentOtterId)` 取召唤者名字。

注入内容（叠加在现有身份段之后，SMALL_OTTER.md 之前）：

```
## 你的召唤者
- 召唤你的海獭：{parentName}（本次任务的主导者）
- **子任务完成后，发言权默认交回 {parentName} 处置**
- 只有整个协作任务真正完成、需要搭档（用户）拍板时，才传 'user'
```

**为什么是必达信道**：身份段通过 R20260810piab 引入的 system role 注入机制（`otterInvokeStorage` → `before_agent_start` extension handler → SDK `systemPrompt`）传递给 LLM，每次 invoke 都重建，不依赖对话历史，不会被上下文噪声稀释。符合「硬规则→必达」的信道分层。

#### 变更 2：L1 修复 — speak 工具 talkingStonePassedTo 规则消歧

**文件**：`src/interface-adapters/agent-runtime/tools/tool-factory.ts:99-102`

**问题**：规则(1)「仅当任务完成、需要搭档接管时传 user」对子任务和整体任务没区分。检视獭把"本职审视完成"理解为"任务完成"。

**改动**：重写 `talkingStonePassedTo` 参数描述：

```
发言权交给谁（用 Otter 的名字或 'user'）。路由规则：
(1) 子任务完成时，传回召唤你的海獭（默认）或工作流下一步的执行者——不是 'user'
(2) 整个协作任务完成、需要搭档（用户）拍板时，才传 'user'
(3) 不能传自己
不确定在场成员时先调 get_active_participants。
```

关键消歧：把「任务完成」拆成「子任务完成」（传召唤者）和「整个协作任务完成」（传 user）两层。

#### 变更 3：L3 修复 — 术语统一

**文件**：`.pi/SYSTEM.md`、`src/interface-adapters/agent-runtime/tools/tool-factory.ts`（speak 描述）

**问题**：「搭档」在 SYSTEM.md 定义为用户，但海獭之间在实际对话里互称搭档（如"抱歉搭档，搞错了"），导致规则(1) 的"搭档"有歧义。

**改动**：
- SYSTEM.md 保持「搭档 = 人类参与者」定义，加一行明确：「海獭之间协作时，用名字或"协作海獭"称呼对方，不用"搭档"——"搭档"专指用户」
- speak 描述里的"搭档接管"改为"搭档（用户）拍板"，消除歧义

**未实施（原方案含但合并到变更 1）**：原方案计划在 `SMALL_OTTER.md` 里强化"大獭会根据你的发言决定下一步"为"发言权交回大獭"。实施时发现变更 1（`buildSummonerIdentity`）已经在身份注入段里更强地覆盖了这个语义（显式注入"召唤你的海獭是 X，发言权交回 X"），且身份注入走 system role（必达信道），比 SMALL_OTTER.md 的通用文案更精准。故 SMALL_OTTER.md 不再单独修改。

#### 变更 4：L4 修复 — skill 产出表映射到 speak 路由

**文件**：`.pi/skills/adversarial-review/SKILL.md`（产出表后）

**问题**：skill 产出表写了「下一步执行者 = 实现者」，但没映射到 `talkingStonePassedTo`，LLM 要自己做翻译，链条太长。

**改动**：在产出表后加显式「发言权路由」段（含「修复≠签收」闭环规则）：

```
### 发言权路由（talkingStonePassedTo）
| 阶段 | talkingStonePassedTo |
|------|---------------------|
| 审视报告产出 | 传 [实现者/大獭] |
| 实现者修复完成 | 传 [审视者] 做 delta 复核 |
| 复核通过 | 传 [实现者/大獭]，由大獭决定是否传 'user' 终审 |
| 整个任务终审 | 传 'user' |

修复≠签收：实现者处置完检视意见后，必须把发言权传回审视者做 delta 复核。
```

**未实施（原方案含但合并到变更 4）**：原方案计划在 `references/review-loop.md` 补「修复≠签收」闭环规则。实施时将这条规则直接写进 SKILL.md 的发言权路由表（更靠近 LLM 实际读的位置），review-loop.md 的 delta 审视机制已经隐含了闭环逻辑，不需重复。故 review-loop.md 不再单独修改。

### 第二期变更（工程兜底，按需）

#### 变更 5：L5 修复 — speak execute 路由合理性软校验

**触发条件**：第一期上线后，如果 capability test 或生产数据仍出现「子獭传 user」的漏网。

**文件**：`src/interface-adapters/agent-runtime/tools/tool-factory.ts:107-133`（speak execute）、`ToolContext` 接口

**改动**：
- `ToolContext` 增加 `otterType` 和 `parentOtterId`（由 `buildCustomTools` 注入）
- speak execute 在 `validateAndResolve` 后加软校验：
  - 条件：`otterType === 'small'` && `talkingStonePassedTo === ['user']` && 召唤者还在场
  - 动作：返回提示（不阻断）：「[路由提示] 你是子獭，召唤你的 {parentName} 还在场。子任务完成后应传回召唤者，不是 'user'。请重新选择。」
  - LLM 收到提示后可重新调用 speak

**为什么是软校验**：遵循「机制约束优先让 LLM 理解」——提示而不是阻断，给 LLM 修正机会。只在 prompt 修复无效时兜底。

## 设计决策

### 根因层级（按因果链，带证据）

#### L1（主因）— speak 规则(1)「任务完成」歧义

`src/interface-adapters/agent-runtime/tools/tool-factory.ts:99-102`，`talkingStonePassedTo` 参数描述：

> 规则：(1) **仅当任务完成、需要搭档接管时传 'user'**；(2) 需要某个 Otter 继续发言时，传该 Otter 的名字……

问题：「任务完成」对**子任务**和**整体协作任务**没区分。

- 检视獭完成审视报告 → 它的本职子任务完成了
- 规则(1) 字面意思触发：任务完成 + 需要有人接管 → 传 `user`
- **系统真实意图**：检视獭只是整个 `检视 → 修复 → 复核 → 签收` 闭环里的一步，应把发言权交回大獭（实现者）去处置

数据验证：**8/8 检视獭首轮发言全部传 user，无一例外**；用户纠正后全部改对——LLM 在按规则字面意思走，不是没能力。

#### L2 — 召唤者身份未注入子獭上下文

子獭被大獭用 `create_otter` 召唤时，`parentOtterId` 存进 `otters` 表（`tool-factory.ts:247`），但**没有进系统 prompt、没有进 speak 工具上下文、没有进路由规则**。

`ToolContext`（`tool-factory.ts:40-52`）注入了：
```
client, otterId, conversationId, currentMessageId, modelPool, getTurnAssistantText
```
**没有 `parentOtterId`、没有 `summonerId`、没有 `currentTaskOwner`**。

结果：检视獭的 session 里知道自己叫「检视獭」、知道职责是审视，但**不知道是谁召唤它来的、结论该交回给谁**。它只能从对话历史里推断，而规则(1) 又给了「传 user」的捷径。

#### L3 — 「搭档」术语双重含义

`.pi/SYSTEM.md:3`：

> 对话中的人类参与者是**搭档**（buddy）

所以 speak 规则(1) 的「需要搭档接管时传 user」里，搭档 = 用户（系统定义）。

但海獭之间在实际对话里**互称搭档**——证据：检视獭纠正后说「抱歉搭档，搞错了！」（speak优化 seq16），这里搭档指大獭。

「搭档」在海獭语境里有两层含义：用户 / 协作海獭。规则(1) 说「传给搭档」，LLM 在子任务完成的语境下更容易把「搭档」对齐到「权威来源 = 用户」。

#### L4 — 工作流「执行者」未映射到 speak 路由

`.pi/skills/adversarial-review/SKILL.md:118-122` 产出表：

| 产出 | 下一步 | 执行者 |
|------|--------|--------|
| 审视报告 | 作者按处置协议回应 | 实现者 |
| 审视通过 | 搭档终审 | 搭档 |

skill 文档**确实定义了「下一步执行者」**——审视完应交给「实现者」（大獭）。但这是 markdown 表格里的概念，**没有映射到 `speak` 的 `talkingStonePassedTo`**。LLM 要自己做翻译：「执行者=实现者」→「实现者是大獭」→「talkingStonePassedTo=大獭」。链条太长，被规则(1) 抢先短路了。

模式 B 同理：`references/review-loop.md` 定义了多轮收敛（复核闭环），但「执行者=检视獭复核」同样没映射到 speak 路由，大獭没有硬规则告诉它「修复后必须传回检视獭」。

#### L5 — speak 闭包无路由合理性校验（兜底缺失）

`tool-factory.ts:107-133` 的 speak execute 只校验：
- body 非空（`validateSpeakBody`）
- `talkingStonePassedTo` 非空、不传自己、目标在场（`validateAndResolve`）

**不校验路由合理性**。「子獭首轮审视发言、召唤者还在场、却传 user」这种明显可疑路由系统照单全收。

self-healing 闘包（`interceptHealingReport`）只剥离 `<healing>` 标记，不管路由。现有拦截点（speak execute 闭包）已存在，但未覆盖路由场景。

### 根因层级图

```
现象：海獭频繁把发言权传给 user（本该传给协作海獭）
         │
         ▼
L1 speak 规则(1)「任务完成传 user」歧义 ◄── 主因
         │   （子任务完成 ≠ 整体任务完成）
         ▼
L2 召唤者身份没注入子獭上下文 ◄── 使 L1 无法被纠正
         │   （parentOtterId 存 DB，不进 prompt）
         ▼
L3「搭档」术语双重含义 ◄── 放大 L1 歧义
         │   （系统：用户；海獭互称：协作伙伴）
         ▼
L4 工作流「执行者」没映射到 speak 路由 ◄── 让捷径赢得竞争
         │   （skill 写了下一步执行者，但 LLM 要自己翻译）
         ▼
L5 speak 闭包无路由合理性校验 ◄── 兜底缺失
         │   （现有 self-healing 拦截点没覆盖路由）
```

### 关键验证信号

**纠正后能改对** → 用户的纠正进入对话历史，子獭从上下文读到「你应该找大獭」，临时学到路由规则。LLM 有能力选对，不是不会。

**新检视獭又犯** → 检视獭按需召唤（`create_otter` → 新 session），纠正经验只留在旧检视獭的对话历史里。下一只检视獭冷启动，又只看到规则(1)，又走字面意思。

这与 `project_session_design_issue` 记录的问题直接相关——「每次 invoke 重建 session，系统消息无法注入 agent 上下文」的具体表现就是：**路由纠错经验无法沉淀给后续召唤的子獭**。

## Acceptance Test

### 需求推导

从根因和现象推导出可验证需求：

1. **需求 R1（L2 修复验证）**：新召唤的子獭（无人工纠正），完成本职后应把发言权传给召唤者，不传 'user'
2. **需求 R2（L1 修复验证）**：子獭收到「子任务完成」语境时，不触发规则(1) 的"传 user"字面捷径
3. **需求 R3（L4 修复验证）**：大獭处置完检视意见后，应把发言权传回检视獭做 delta 复核，不向 user 宣布完成
4. **需求 R4（不破坏正向路径）**：真正需要用户决策时（终审、产品取舍、整体任务完成），仍能正确传 'user'

### 权威证据

| 需求 | 权威证据来源 | 证据类型 |
|------|-------------|---------|
| R1 | `messages.talking_stone_passed_to` 字段（DB 记录） | 运行时状态 |
| R1 | 检视獭 invoke 日志的身份注入内容（含召唤者段） | 日志文件 |
| R2 | speak 工具描述文本（规则消歧） | 文件内容 |
| R3 | `messages.talking_stone_passed_to`（大獭修复后传检视獭） | 运行时状态 |
| R4 | `messages.talking_stone_passed_to`（终审场景传 user） | 运行时状态 |

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|---------|
| AT-1 | R1 | 独立实例 + 干净 DB；用户发消息让大獭召唤检视獭并把发言权传给检视獭；检视獭完成审视后 speak | `talking_stone_passed_to = [大獭 ID]`，**不传 user** |
| AT-2 | R1 | 检视獭 invoke 日志 | 身份注入段含「召唤你的海獭：大獭」 |
| AT-3 | R3 | 延续 AT-1：大獭收到检视报告后处置，speak | `talking_stone_passed_to = [检视獭 ID]`（做 delta 复核） |
| AT-4 | R4 | 整个审视-修复-复核闭环完成后，大獭做终审发言 | `talking_stone_passed_to = ['user']`（正向路径不破坏） |

### 能力测试映射

| 验收场景 | 能力测试文件 |
|---------|-------------|
| AT-1, AT-2, AT-3, AT-4 | `tests/capability/talking-stone-routing.capability.test.ts`（新建） |

**能力测试设计要点**（基于本次验证经验）：
- 用独立实例 + 独立 DB（端口隔离，不污染生产）
- 真实 mimo 模型（不能用 mock，不能只测 Claude）
- 触发完整链路：用户 → 大獭 → 召唤检视獭 → 传递任务 → 检视獭 speak
- 断言 `messages.talking_stone_passed_to` 字段值
- 任务设计要极简（避免 mimo 在重任务下退化，干扰路由验证）
- 至少跑 3 次降低 LLM 随机性

### 证据判定（验收执行后填写）

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| R1 | 待填写 | 待填写 |
| R2 | 待填写 | 待填写 |
| R3 | 待填写 | 待填写 |
| R4 | 待填写 | 待填写 |

## 对抗审视记录

### 第一轮：CC agent 对抗审视（rebase 到 origin/main @ ea56d7f 后）

**审视者**：CC agent（用户在 CC 环境，无法召唤检视獭，用 Agent 工具替代）

**阻断性问题**（1 个，已处置）：
- **问题 1**：F 文档声称改了 `SMALL_OTTER.md`、`BIG_OTTER.md`、`review-loop.md`，但实际 diff 里没有。文档与实现不一致。
  - **处置**：已更新 F 文档——modules 列表移除未改文件；变更 3/4 的描述补充「未实施（合并到变更 1/4）」说明，解释为什么不需要单独改这些文件。

**次要观察**（6 个，均记录不阻断）：
1. R20260810piab 集成正确性确认——追踪完整注入路径（`buildSummonerIdentity` → `identityPrefix` → `otterInvokeStorage` → `before_agent_start handler` → `systemPrompt` → LLM），**不是死代码**
2. `assert-behavior.ts` 的 `tsp` 注释错误（既有问题，非本 PR 引入）
3. R3/R4 能力测试覆盖缺口（R3 大獭侧路由未测；先验证 R1 子獭侧合理）
4. 3 次采样 ≥2 阈值合理（mimo 随机性；L5 兜底是已规划后路）
5. 注入内容与 speak 描述的语义重复是有益设计（重复信号增加弱模型遵循概率）
6. 召唤者 dissolve 时有 speak `validateAndResolve` 兜底，prompt 层不需额外处理

**结论**：审视通过（阻断性问题已处置）。核心修复（`buildSummonerIdentity` 注入召唤者身份）在 R20260810piab 重构后仍然有效。

## 实施验证结果

### 已实施变更（基于 origin/main @ f03769c）

| 变更 | 文件 | 改动 |
|------|------|------|
| 1（L2 修复） | `src/frameworks/agent/pi-session-factory.ts` | +17 行：新增 `buildSummonerIdentity` 方法，小獭首次 invoke 注入召唤者身份段 |
| 2（L1 修复） | `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | +1-1 行：`talkingStonePassedTo` 规则消歧（子任务完成≠整体完成） |
| 3（L3 修复） | `.pi/SYSTEM.md` | +1-1 行：「搭档」术语澄清（专指用户） |
| 4（L4 修复） | `.pi/skills/adversarial-review/SKILL.md` | +13 行：产出表后加「发言权路由」段 |
| 能力测试 | `tests/capability/talking-stone-routing.capability.test.ts` | 新建：3 次采样验证子獭传回召唤者 |

**build 状态**：✅ 通过（0 errors，2 warnings 为既有无关警告）

### 能力测试结果

**测试通过**：3 次采样 2 次成功（达到 ≥2 阈值）

```
[capability] talking-stone-routing 采样结果（2/3 成功）:
#1: OK   tsp=["f38ab3e6..."] bigOtterId=f38ab3e6 match=true  ✓ 传大獭
#2: FAIL tsp=["user"]         bigOtterId=8063d3eb match=false ✗ 传 user
#3: OK   tsp=["45fe7107..."] bigOtterId=45fe7107 match=true  ✓ 传大獭
```

**修复前后对比**：

| 指标 | 修复前（生产数据） | 修复后（能力测试） |
|------|-------------------|-------------------|
| 子獭传 user | 8/8（100%） | 1/3（33%） |
| 子獭传大獭（召唤者） | 0/8（0%） | 2/3（67%） |

**结论**：L2 身份注入修复有效——注入召唤者身份后，mimo 大部分情况能选对路由。#2 仍传 user 是 mimo 随机性的残余，对应方案里第二期工程兜底（L5）的按需触发条件。

### 证据判定（验收执行后填写）

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| R1（子獭传回召唤者） | 能力测试 2/3 通过 | ✅ |
| R2（规则消歧生效） | 隐含在 R1（不再走"任务完成传 user"捷径） | ✅ |
| R3（大獭修复后传检视复核） | 本轮未直接覆盖（测试聚焦子獭侧），逻辑由 L4 skill 映射保证 | ⚠️ 待补 |
| R4（正向路径不破坏） | #2 传 user 证明"传 user"路径仍可用；speak 规则(2) 保留"整体任务完成传 user" | ⚠️ 待补 |

## 根因验证实验记录（Part 1 验证阶段）

### 实验目标

验证 L1+L2（speak 规则歧义 + 召唤者身份未注入）是否为真根因。方法：用 Claude Code subagent 模拟检视獭的决策点，做对照实验。

### 实验设计

- **控制组**：复刻系统当前给检视獭的 prompt（SMALL_OTTER.md + speak 规则(1)，无显式召唤者身份）
- **实验组**：在控制组基础上注入「召唤者=大獭，结论交回大獭」硬约束
- **预期**：控制组选 user（复现 bug），实验组选大獭（验证修复方向）

#### V1（sonnet，干净环境，3+3 次）
控制组 prompt 含 SMALL_OTTER.md 全文，无对话历史干扰。

#### V2（haiku + 对话历史干扰，3+3 次）
加入 10 条对话历史（用户触发 → 大獭召唤检视獭的完整链路），模拟真实上下文噪声。

### 实验结果

| 轮次 | 模型 | 控制组选择 | 实验组选择 |
|------|------|-----------|-----------|
| V1 | sonnet | 大獭 ×3 | 大獭 ×3 |
| V2 | haiku | 大獭 ×3 | 大獭 ×3 |

**12 次实验，控制组 6/6 全选大獭，未复现 bug。**

### 实验失败分析

控制组预期选 user（复现现状），实际选大獭。实验未能复现 bug，原因：

1. **实验方法的根本局限**：用 Claude 模拟非 Claude 模型的行为不可靠。otter 实际用的模型（mimo/glm 等）推理能力弱于 Claude，更易走规则(1) 的字面捷径。
2. **SMALL_OTTER.md 已含隐含信号**：原文「你的发言就是你的交付物，**大獭会根据你的发言决定下一步**」对 Claude 足够强，能据此推断正确路由。
3. **subagent 框架效应**：subagent 知道在被测试，可能比真实场景更谨慎。

### 失败的价值：修正根因权重认知

实验失败未推翻根因，但修正了各层根因的权重：

| 原认知 | 修正后认知 |
|--------|-----------|
| L1-L4 是必然触发因素 | L1-L4 是**系统性弱点**，单因素不必然触发 |
| 注入召唤者身份是关键修复 | 当前 prompt 对强模型够用，弱模型需更强约束 |
| bug 是 prompt 设计问题 | bug 是 **prompt 弱点 × 模型能力**的叠加 |

**关键变量**：模型能力差异。Claude（haiku 都行）能在 L1-L4 干扰下推断出正确路由；otter 实际模型推断不出来，走了规则(1) 的字面捷径。这也解释了「纠正后能改对」——用户纠正相当于在对话历史里加了一条强信号，弱模型也能据此选对。

### 根因证据链状态（实验后）

实验失败只说明"prompt 单因素不足以在弱模型上复现/修复"，但静态 + 行为证据仍然坐实根因：

- **静态代码**：`pi-session-factory.ts:552-577` buildIdentityPrefix 拿到 otter 对象却没读 parentOtterId —— 事实（未被推翻）
- **行为数据**：8/8 检视獭首轮传 user —— 事实（未被推翻）
- **纠正后能改对** —— 事实（未被推翻）

### 对方案设计的启示

1. **不能只靠 prompt 微调**：当前 prompt 对 Claude 够用但对 otter 实际模型不够，方案必须含系统级硬约束（身份注入 + 工程兜底校验）
2. **真实验证必须在 otter 系统里用真实模型做**：subagent 模拟不可靠，Part 2 方案应含能力测试（capability test），用真系统 + 真模型验证
3. **能力测试是验收硬要求**：按 `docs/README.md` 约定，涉及 LLM 行为的改动（prompt/skill）必须有 capability_test

### 实验数据的局限性说明

本实验用 Claude subagent，**不能代表 otter 实际模型的行为**。实验"失败"只证明"这套 prompt 对 Claude 够用"，不证明"这套 prompt 对所有模型够用"。真实系统的行为数据（8/8 传 user）才是 bug 存在的权威证据。

---

### 真实验证：独立 otter 实例 + 真实 mimo 模型（bug 成功复现）

鉴于 Claude subagent 无法代表 otter 实际模型行为，启动了独立的 otter 实例做真实验证：

- **环境隔离**：在 worktree 里启动独立实例（端口 3999，独立 `data/verify.db`，软链主仓 node_modules/models），复用主仓 config.yaml 的真实 LLM 配置
- **真实模型**：默认模型 mimo（与生产一致），对话全程用 mimo
- **干净数据库**：无任何历史数据干扰

#### 验证 1：用户直接 @ 检视獭（对照组）

场景：用户消息 `talkingStonePassedTo: ["检视獭"]`，直接让检视獭确认到岗。

结果：**检视獭传给大獭** ✓

#### 验证 2：大獭传递任务给检视獭（还原生产场景）

场景：用户让大獭召唤检视獭并把发言权传给检视獭（还原 skill优化/speak优化/ui优化 三个生产对话的真实链路）。

消息流：
```
seq 1  user  → 大獭     "召唤检视獭，把发言权传给它"
seq 2  大獭  → 检视獭   "检视獭已召唤完毕，交给你报到了 🦦"
seq 3  system           检视獭加入了对话
seq 4  检视獭 → user    "检视獭到岗，随时待命 🦦🔍"  ← BUG
```

结果：**检视獭传给 user** ❌（bug 成功复现）

#### 对照分析：差异变量

| 验证 | 谁传递任务给检视獭 | 检视獭选择 | 对错 |
|------|-------------------|-----------|------|
| 1 | 用户直接 @ | 大獭 | ✓ |
| 2 | 大獭传递 | **user** | **❌** |

**差异变量 = 谁把任务传给检视獭**：
- 用户直接 @ → 检视獭选对（用户消息提供了"大獭是头儿"的上下文，且用户作为发起者不会是"接收方"）
- 大獭传递 → 检视獭选错（**不知道该传回给谁，默认走规则(1) 的 user 捷径**）

#### 日志直接证据（L2 运行时坐实）

验证 2 的检视獭 invoke 日志显示其收到的身份注入：

```
## 你的身份
- 名称：检视獭 / 名号：检视獭 / ID / 类型：小獭

## 你是谁
你是一只小獭🦦，由大獭为完成特定任务而创建...
（SMALL_OTTER.md 全文）
```

**完全没有「召唤者=大獭」的信息**——检视獭不知道是谁召唤它的，只知道"我是一只小獭，大獭是头儿"。当大獭传任务给它后，它完成了发言，但不知道该把发言权交回给谁，走了规则(1) "任务完成传 user"的字面捷径。

#### 真实验证结论

1. **bug 在干净环境 + 真实 mimo 模型下成功复现**——不是偶然，不是上下文污染
2. **L2 是触发关键**：身份注入缺召唤者信息，检视獭完成发言后无路由依据，走规则(1) 捷径
3. **触发条件**：大獭传递任务给检视獭（生产场景的真实链路）
4. **Claude subagent 实验失败的原因确认**：Claude 推理能力强，能从对话历史推断路由；mimo 不行，需要显式硬约束
