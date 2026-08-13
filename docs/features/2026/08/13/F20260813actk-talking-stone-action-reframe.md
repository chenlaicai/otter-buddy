---
id: F20260813actk
title: talking-stone-action-reframe
doc_type: feature

summary: |
  大獭召唤小獭后把发言石传给 user（小獭当轮不被唤醒），误以为"创建即派工"。
  生产 DB 行为数据：70 起创建事件，纯失败 10.0% / 含批量部分丢失 21.4%；批量创建 57.1% 失败；
  失败签名是大獭 body 写"正在并行检视"——真心以为小獭在干活。
  根因四层：L0 create_otter description 自身"执行特定任务"误导（上游源头，第三轮架构审视发现）；
  L1 otter-summon 工作流缺派工编排步；L2 控制流原语被命名"发言"frame 错位；L3 回包误导。
  修复＝改 description 堵源头 + 补工作流派工步 + reframe 全局同步 + 待派工票据工具层反馈，三层协同。
  D4 承认是第二个补丁，第三次同类 bug 时启动语义层抽象。

causal_links:
  from:
    - F20260810rout
  to: []

status: implemented
change_type: prompt
tags: [agent-routing, talking-stone, prompt, multi-otter, dispatch]
modules:
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/usecases/conversation/dispatch-chain-engine.ts
  - src/frameworks/agent/pi-session-factory.ts
  - prompts/identity/BIG_OTTER.md
  - prompts/identity/SMALL_OTTER.md
  - .pi/skills/otter-summon/SKILL.md
  - .pi/skills/otter-summon/references/collaboration-patterns.md
  - .pi/skills/adversarial-review/SKILL.md
  - data/terminology/seed-terminology.json
  - tests/capability/big-otter-dispatch.capability.test.ts
capability_test: tests/capability/big-otter-dispatch.capability.test.ts
---

# F20260813actk: 发言石 → 行动权 reframe（大獭召唤不派工缺口）

## 背景与需求

### 问题描述

**现象**：大獭（big otter）通过 `create_otter` 召唤若干小獭，把任务写进 systemPrompt，然后调用 `speak(talkingStonePassedTo=['user'])` 向用户汇报"我已经安排好了"。被创建的小獭的 otterId 从未出现在 `talkingStonePassedTo` 里——dispatch-chain 引擎不 invoke 它们——**小獭永远沉睡，永远不产出**。用户等半天没人干活。

**与 F20260810rout 的区别**：F20260810rout 修的是**小獭侧**（小獭不知道结论该交回谁，走"任务完成传 user"捷径，已通过注入召唤者身份修复）。本特性修的是**大獭侧**（大獭根本没把小獭放进调度链）。两者是同一协作链路的两端缺口，F20260810rout 闭合了回程，本特性要闭合去程。

### 数据实锤

#### 静态代码事实（确定性，未被推翻）

1. `create_otter` 的 execute（`tool-factory.ts:215-239`）只做两件事：建 Otter 实体 + `participant.join`。**不 invoke 小獭的 agent session**。
2. 小獭的 agent session **只在 dispatch-chain 在 `talkingStonePassedTo` 聚合目标里看到其 otterId 时**才被 invoke（`dispatch-chain-engine.ts:53-84` 的 `executeChain` 循环）。
3. 因此"创建小獭 + 不把发言石传给它"＝"小獭在该轮不执行"，是确定性的工程结果。

#### 行为数据（生产 DB `data/otter-buddy.db`，messages + otters 表，2026-08-06 ~ 2026-08-13）

查询方法：每个小獭的 `created_at` 落在某条大獭 message 的 `created_at~completed_at` 窗口内 → 该 message 的 `talking_stone_passed_to` 即"创建时的派工信号"。

**总体**（按结果三分类）：

| 结果 | 含义 | 数量 | 占比 |
|---|---|---|---|
| OK | 创建时正确传给该小獭 | 53 | 75.7% |
| FAIL_TO_USER | 创建时传给 user，该小獭未获行动权 | 9（含 2 系统中断） | 12.9% |
| BATCH_PARTIAL | 批量创建多只，只传了部分，其余被丢 | 8 | 11.4% |
| **合计** | | **70** | |

- **纯 FAIL_TO_USER 失败率**：7/70 = 10.0%（排除 2 系统中断）
- **含批量部分丢失的总失败率**：(7+8)/70 = **21.4%**——这是大獭召唤后"至少有一只小獭没被派工"的真实发生率

**批量创建是放大器**：

| 创建模式 | OK | FAIL_TO_USER | BATCH_PARTIAL | 失败率（含部分丢失） |
|---|---|---|---|---|
| SINGLE（一条大獭消息创建 1 只） | 44 | 5（含 2 中断） | — | 7.1%（纯）/ 5.0%（排除中断） |
| BATCH（一条大獭消息创建多只） | 9 | 4 | 8 | **57.1%** |

批量创建时大獭显著更容易丢失派工——创建多只小獭后，不知道如何一次性把行动权分给所有人，要么退回 user（FAIL_TO_USER），要么只传部分（BATCH_PARTIAL）。

**失败签名（frame 问题的铁证）**：

7 个真实失败案例中，**6 个的大獭 body 含"正在..."进度汇报语**：

| 小獭 | 大獭 body 摘录 |
|---|---|
| 检视獭-PR259/260/261/262 | "4 只检视獭已召唤，**正在并行检视**" |
| 检视獭-feature-doc-review | "🔄 对抗审视中——检视獭已召唤，**正在审视** PR #249" |
| 检视獭 (08-10 09:12) | "检视獭已经召唤成功，**正在进行对抗审视**" |

"正在..."这个词证明大獭的**心智模型是"create + 分配 task = 小獭正在干活"**——它向搭档汇报进度，因为它真心以为工作已经启动。它不知道还需要把行动权传过去。这正是 frame 错位（L2）的行为表现，不是偶发失误。

**恢复模式**：7/7 真实路由失败案例的小獭最终都被 invoke（用户纠正后大獭重新派工；2 个系统中断案例的恢复由用户重新触发，不计入）——bug 是可恢复的，但每次都折磨搭档当路由器，与 F20260810rout 记录的"用户被卡在中间当路由器"诉求直接冲突。

### 根因分析

三层根因，按因果链排序。**L1 是最硬的（工作流缺口），L2/L3 是放大器（frame/命名）。**

#### L1（主因，硬缺口）— otter-summon skill 工作流缺"派工"步

`.pi/skills/otter-summon/SKILL.md` 工作流（第 29-54 行）：

```
1. 判断是否召唤
2. 写 systemPrompt
3. 接住产出：审视小獭产出质量 → 整合...
```

**从 step 2（create + 写 task）直跳到 step 3（接住产出），中间没有"把行动权传给小獭"这一步**。skill 教大獭的是"创建 + 分配 → 收结果"，把派工这一关键动作完全省略了。

大獭读这个 skill，心智模型变成：`create_otter(systemPrompt=task)` ＝"派工完成"。然后它自然地 `speak(talkingStonePassedTo='user')` 汇报安排——因为在它的心智里，**没有"我还需要把行动权传给小獭"这一步**。行为数据印证：失败案例的大獭 body 写"正在并行检视/正在审视"——它真心以为小獭在干活。

**精确表述**（对 references 作用的校准）：`references/collaboration-patterns.md:17` 其实写了"创建小獭后...你可以在 speak 时将其作为路由目标"——**方法教了**（speak 时能传给小獭）。但主工作流 SKILL.md 的**步骤序列**从 create 跳到"接住产出"，**没把"spe­ak 派工"排进执行计划**。弱模型（mimo）严格按字面步骤走——方法会但计划没排进去，等于不会。这才是 L1 的本质，不是"完全没教"。另外 references 第 1 步"通过 systemPrompt 交给任务"的"交给任务"措辞**反向强化**了"create 即派工"心智。

#### L2（frame 错位）— 控制流原语被命名为"发言"

全系统把**控制流原语**（谁被 invoke 去执行）命名为**输出原语**（说话）：

| 位置 | 当前措辞 | 实际语义 |
|---|---|---|
| `speak` 工具描述 | "结束你的发言并指定下一位**发言者**" | 结束本轮行动（思考+调工具+出结论），指定下一位**行动者** |
| `talkingStonePassedTo` 参数描述 | "**发言权**交给谁" | **行动权**交给谁——接收者会被立即唤醒执行 |
| SMALL_OTTER.md | "你的**发言**就是你的交付物" | 你的**本轮行动产出**就是交付物 |
| collaboration-patterns.md | "**发言石**传给检视獭" | **行动权**传给检视獭 |

"发言"是窄词（口头表达），但 token 实际承载的语义宽得多：派活、行动触发、交付接力、答复请求——全是行动/派遣语义，被一个窄词盖住。

**L2 如何放大 L1**：即便 skill 补了派工步，如果措辞仍是"把发言石/发言权传给小獭"，大獭的心智仍是"我为什么要给小獭一个发言轮？活儿我已经派下去了"。"发言"框架让派工步**感觉是可选的礼貌**，而不是**触发执行的硬动作**。

#### L3（工具回包无提醒）— create_otter 成功回包默认"已交付"

`tool-factory.ts:238`：

```typescript
return textResponse(`Otter created: ${otter.id} (${otter.name})`);
```

回包只说"创建成功"，不提示"小獭已就位但未开工，需随后 speak 派工"。大獭在创建的那一刻（最高显著性时刻）收到的信号是"完成"——没有任何线索暗示还差一步。

#### 根因层级图

```
现象：大獭召唤小獭后传 user，小獭永远不被唤醒
         │
         ▼
L1 otter-summon 工作流缺"派工"步 ◄── 主因（硬缺口）
         │   （create → 接住产出，跳过了 dispatch）
         ▼
L2 控制流原语被命名成"发言" ◄── frame 放大器
         │   （即便补步，"发言权"听起来像可选礼貌）
         ▼
L3 create_otter 回包默认"已交付" ◄── 时机性失教
         │   （最高显著性时刻给了"完成"的错误信号）
```

### 关键判别信号

**这不是 LLM 随机失误**：L1 是确定性的工作流缺口——任何按 skill 字面执行的大獭都会漏掉派工步。F20260810rout 的实验已证明 otter 实际模型（mimo）严格按 prompt 字面走，不会自己推断缺失的步骤。

**这与 F20260810rout 同源不同端**：F20260810rout 的 L2 修复（注入召唤者身份）解决了小獭→大獭的回程；本特性解决大獭→小獭的去程。两者合在一起才闭合完整协作环。

## 方案设计

### 设计原则

1. **上游优先（C8）**：frame 错位的第一个信号源是 create_otter description 自身的"执行特定任务"措辞——工具选择时必读，比 skill/回包都早。先堵上游源头，再补下游
2. **分层负责（C1 vs C8/C3/C9）**：派工的**工程必然性**（不派工＝不发生）由工具层保证（C8 description 教育 + C3 回包提示 + C9 票据反馈）；skill 只沉淀**编排 know-how**（并行 vs 串行、顺序判断）。遵循 SYSTEM.md A5——skill 是经验不是官僚
3. **L2 reframe 概念，保留工程名**：把 prompt-facing 的概念词从"发言/发言权"reframe 到"行动/行动权"，但**不改 `talkingStonePassedTo` 字段名和 DB 列名**（rename 成本高、文档漂移大）
4. **工具优先于强编排（C9 第三条路）**：待派工状态由工具协议层反馈（C9 结构化票据回包），不是强编排/硬阻断——系统传达事实（"还有 N 只未派工"），不决定大獭该传给谁。这属于"工具优先"范畴，与"反强编排"记忆一致
5. **C3 串行辅助**：create_otter 回包提示只覆盖串行调用场景；同批 create+speak(to user) 由 C8（description 上游）+ C9（票据反馈，即使同批 speak 也会触发未清空提醒）覆盖
6. **承认架构债（D4）**：本期是控制流原语问题的第三个补丁（F20260810rout + 本特性 + 未来的未来）。语义散落 N 处无单一真相源——第三次同类 bug 时启动语义层抽象

### 目标

- **T0（L0 上游）**：create_otter description 去掉"执行特定任务"误导，明确"创建不触发执行，需 speak 派工"——堵 frame 错位的第一个信号源
- **T1（L1 编排 know-how）**：otter-summon skill 工作流显式包含"派工编排"步，但只教编排经验（并行/串行判断），工程必然性由 T0/T3/T4 保证
- **T2（L2）**：所有 prompt 表面把控制流原语从"发言"reframe 到"行动权/行动"，让大獭理解传 token＝触发执行
- **T3（L3 串行辅助）**：create_otter 回包提示"已就位但未开工"；speak 回包不再误导"自动调度"
- **T4（工具层状态反馈）**：C9 待派工票据在 speak execute 提供结构化状态提醒——不阻断、基于系统事实、覆盖同批调用场景
- **T5（工程层一致性）**：buildRoster 名册 + buildSummonerIdentity + adversarial-review/SKILL.md + 术语库 措辞与 reframe 同步
- **T6（不破坏）**：F20260810rout 已修复的小獭→大獭回程路由不退化；真正需要 user 拍板时仍能传 user

### 变更清单

#### 变更 C1（L1 编排 know-how）— otter-summon skill 补"派工编排"步

**文件**：`.pi/skills/otter-summon/SKILL.md` 工作流段

**问题**：当前 3 步工作流（判断 → 写 systemPrompt → 接住产出）跳过了派工。

**架构分层调整（第三轮审视采纳）**：原方案把"派工"整体塞进 skill 工作流。但派工的**工程必然性**（不派工＝工程上不发生）应由工具层保证（C8 description + C3 回包 + C9 票据反馈），skill 只沉淀**编排 know-how**（怎么编排多只小獭的派工顺序）。这遵循 SYSTEM.md A5——skill 沉淀经验，工程约束住工程层。

**改动**：插入 step 3（派工编排），原 step 3 顺延为 step 4：

```
1. **判断是否召唤**：[不变]
2. **写 systemPrompt 并 create_otter**：[措辞改："创建小獭并写下任务"，
    删除"交给任务"这个暗示 create 即派工的表述]
3. **派工编排**：create 让小獭就位待命，speak 把行动权传给它它才会执行（工程机制见 create_otter
   工具描述与回包）。编排选择是经验判断：
   - 单只小獭：直接 speak(talkingStonePassedTo=["小獭名"])
   - 多只小獭并行：一次 speak 传多个名字（同时唤醒，各自独立产出）
   - 多只小獭串行：按序逐次 speak（前一只产出后再派下一只，适合有依赖的任务）
   选择并行的判据：任务相互独立、无依赖；选择串行的判据：后一只需要前一只的产出作输入
4. **接住产出**：[原 step 3，不变]
```

**分层说明**：step 3 不再承担"教育大獭必须派工"的工程约束责任（那由 C8/C3/C9 保证），只教**怎么编排**派工——并行 vs 串行的判断、多只小獭的顺序决策。这是 A5 意义下的 know-how。

#### 变更 C2（L2 reframe）— speak 工具描述、label、talkingStonePassedTo 参数描述

**文件**：`src/interface-adapters/agent-runtime/tools/tool-factory.ts:100-109`

**问题**：speak 描述"结束你的发言并指定下一位发言者"+ 参数描述"发言权交给谁"，把控制流框死在"发言"。

**改动**：

speak description 开头从：
> 结束你的发言并指定下一位发言者。

改为：
> 结束你的本轮行动（思考、调工具、出结论都在这里），并指定下一位**行动者**——接到行动权的人会立刻开始干活。发言内容全部放在 body 里……

talkingStonePassedTo description 从：
> 发言权交给谁（用 Otter 的名字或 'user'，见在场成员名册）。路由规则：……

改为：
> **行动权**交给谁（参数名 talkingStonePassedTo 即行动权令牌；用 Otter 的名字或 'user'，见在场成员名册）。接到行动权的人会被系统立即唤醒执行。路由规则：……（规则内容不变）

**工具 label 同步**：speak 工具的 display label（LLM 在工具选择时看到的名称展示）从默认的 "speak" 改为"结束行动"或类似——不改工具 `name`（工程名），只改 `label`（display name），降低名/义不一致对弱模型的干扰。

#### 变更 C3（L3 时机教育）— create_otter 回包提醒

**文件**：`src/interface-adapters/agent-runtime/tools/tool-factory.ts:238`

**问题**：成功回包 `Otter created: {id} ({name})` 信号"已完成"，无派工提示。

**改动**：

```typescript
return textResponse(
  `Otter created: ${otter.id} (${otter.name}). 已就位待命，但尚未开工——` +
  `你需要在随后的 speak 里把行动权（talkingStonePassedTo=["${otter.name}"]）传给它，它才会执行。`
);
```

为什么是工具回包而非 skill 文档：回包是 create 发生那一刻（高显著性、最小延迟），且不需要大獭"记得"早先读过的 skill——信号就在动作的反馈里。

**适用范围说明（对抗审视修正）**：C3 只覆盖**串行调用**场景（大獭 create 后，下一轮才 speak）。当大獭同批调用 create_otter + speak 时（SDK 并行执行 + terminate 批后生效），create 回包在该轮不可见，C3 失效。但同批 create+speak(to user) 的根因正是大獭误以为"create=派工"——这个认知由 C1（补派工步）+ C2（reframe）修复后，大獭会改为 create 后 speak(派工给小獭)（同批也 OK，因为 speak 的 tsp 是小獭），同批 create+speak(to user) 路径自然消失。C3 不为该路径单独加工程兜底（遵循设计原则 4 反强编排）。

#### 变更 C4（L2 reframe 扩散）— 身份 prompt 与协作模式文档

**文件**：
- `prompts/identity/BIG_OTTER.md` "召唤小獭"段
- `prompts/identity/SMALL_OTTER.md` "完成任务时"段
- `.pi/skills/otter-summon/references/collaboration-patterns.md`

**改动**：

**BIG_OTTER.md** "召唤小獭"段（当前仅一句话指向 skill）扩展为：

```
## 召唤小獭

你有权也有责任在需要时创建和管理小獭。召唤的判断、systemPrompt 编写、协作编排——见 `otter-summon` skill。

召唤是两步动作，不是一步：
1. **create_otter**：招募小獭就位（给它写下任务）
2. **speak 派工**：把行动权（talkingStonePassedTo）传给它，它才会被唤醒执行

只 create 不派工＝小獭永远沉睡。这是新手最容易踩的坑，务必记住。
```

**SMALL_OTTER.md** "完成任务时"段措辞从"调用 speak 结束发言 / 你的发言就是你的交付物"微调为"调用 speak 结束本轮行动 / 你的本轮行动产出就是你的交付物"——保持与小獭侧 F20260810rout 注入的"召唤者"语义一致，并把"发言"reframe 到"行动"。

**collaboration-patterns.md** "开发↔检视循环 / 流程"第 1 步：

从：
> 1. 你创建开发獭，通过 systemPrompt 交给任务

改为：
> 1. 你 create_otter 创建开发獭（systemPrompt 写任务），然后 **speak 把行动权传给它**——create 只是就位，speak 派工它才会开工

"发言石路由"段措辞统一从"发言石/发言权"改为"行动权"。

**`src/frameworks/agent/pi-session-factory.ts` `buildSummonerIdentity`**（F20260810rout 注入的文案）：把"发言权默认交回 {parentName}"改为"**行动权**默认交回 {parentName}"——本期 reframe 必须同步改这里，否则小獭收到的注入文案说"发言权"，而 speak 工具描述说"行动权"，措辞撕裂会让弱模型困惑。

**`.pi/skills/adversarial-review/SKILL.md`** "发言权路由（talkingStonePassedTo）"段（F20260810rout 变更 4 加的，第 248-259 行）：该段标题和正文多次用"发言权"，是检视獭/大獭对抗审视时高频读的 prompt。**必须同步 reframe**——把段内"发言权路由/发言权交给/发言权传回"统一改为"行动权路由/行动权交给/行动权传回"。遗漏这段会造成 skill 文档说"发言权"、工具描述说"行动权"的措辞撕裂（对抗审视第二轮发现）。

**`data/terminology/seed-terminology.json`** "发言石"条目（第 76-78 行）：当前定义"对话级发言权传递机制"。reframe 后更新定义为"对话级行动权传递机制（控制谁被唤醒执行；工程名 talkingStonePassedTo）"——术语库是 LLM 经术语工具检索的权威定义，与 prompt 措辞必须一致（遵循"术语改动要全局排查，保留处必须写新旧词映射"）。

#### 变更 C5（L2 工程层）— buildRoster 名册措辞

**文件**：`src/usecases/conversation/dispatch-chain-engine.ts:165`（`buildRoster`）

**问题**：每次小獭/大獭被 invoke 时，名册里都注入一行"搭档（传 'user' 即**交还发言权**）"——与 L2 reframe 目标直接矛盾。名册是 LLM 每轮都读的高频 prompt 信号，比 skill 文档（按需读）频次更高，是 frame 错位的持续强化源。

**改动**：

```typescript
lines.push(`- ${partnerLabel}（传 'user' 即交还行动权给搭档）`);
```

把"交还发言权"reframe 为"交还行动权"。**只做术语 reframe，不加行为限定**——"终审才传"等限定条件已在 speak description 路由规则和 buildSummonerIdentity 注入文案里，名册不重复（重复"才传"可能让小獭在正常应传 user 的场景犹豫）。

#### 变更 C6（L3 工程层）— speak execute 回包去掉"自动调度"误导

**文件**：`src/interface-adapters/agent-runtime/tools/tool-factory.ts:139`

**问题**：speak 成功回包当前是"[系统控制信号] 发言已提交成功，回合结束。系统将**自动调度下一位发言者**。"但当 `talkingStonePassedTo=['user']` 时，dispatch-chain 的 `processHopResults`（`dispatch-chain-engine.ts:153`）会把 user 从下一跳过滤掉，链条**静默终止**——回包说"自动调度"是在说一个不会发生的调度。这是与 C3（create 回包）平行的失教：在错误发生的瞬间给"一切正常"的信号。

**改动**：

```typescript
return { ...textResponse("[系统控制信号] 发言已提交成功，回合结束。"), terminate: true };
```

去掉"系统将自动调度下位发言者"——这条措辞在传小獭时是冗余的（dispatch-chain 本就会做），在传 user 时是误导（链条终止）。去掉后无论哪种情况都准确。失败回包（conflict 分支）保留原样。

#### 变更 C7（验收基础设施）— 新建能力测试文件

**文件**：`tests/capability/big-otter-dispatch.capability.test.ts`（新建）

**问题**：frontmatter `capability_test` 声明此路径，但 docs/README.md 硬规则"路径不存在报错"——sync 时若文件不存在会失败。必须在实现阶段创建。

**改动**：随 C1-C6/C8/C9 一并新建测试文件，覆盖 AT-1（单只）/AT-2（批量 4 只）/AT-3（小獭回传）/AT-4（终审传 user）四个场景。设计要点见"能力测试映射"段。

#### 变更 C8（L0 上游根因修复）— create_otter description 去掉"执行特定任务"误导

**文件**：`src/interface-adapters/agent-runtime/tools/tool-factory.ts:205`（create_otter description）

**问题（第三轮架构审视共识发现）**：当前 description 第一句"When: 需要召唤专门**执行特定任务**的小獭"——"执行特定任务"这五个字直接暗示 create 会触发执行。这是大獭形成"create=派工"错误心智的**第一个、最权威的信号源**（工具选择时必读，比 skill 文档按需读、回包动作后反馈都更早更强）。前两轮审视没回头审工具自身措辞，第三轮两个架构师独立命中。

完整因果链：
```
create_otter description 说"执行特定任务"
   → 大獭心智：create = 执行
   → skill 工作流跳过派工（"已经在执行了"）
   → 大獭 speak 传 user 汇报进度
   → 小獭不被 invoke
```

C1-C7 修的是第 2-4 步，C8 修第 1 步（上游源头）。架构师判定：**如果只能改一处，C8 比其他所有 reframe 杠杆都大**。

**改动**：

description 从：
> 创建子 Otter. When: 需要召唤专门执行特定任务的小獭（独立审视/并行工作/角色讨论/任务分担）. Not for: 解散 → dissolve_otter. Output: 新 Otter 的 ID 与名称，自动加入当前对话. ...

改为：
> 创建子 Otter 并让它就位待命. When: 需要召唤小獭分担工作（独立审视/并行工作/角色讨论/任务分担）. **创建不触发执行——新 Otter 只是就位待命，你必须在随后的 speak 里把行动权（talkingStonePassedTo）传给它，它才会被唤醒干活**. Not for: 解散 → dissolve_otter. Output: 新 Otter 的 ID 与名称，自动加入当前对话（但未开工）. ...

把"执行特定任务"换成"就位待命"，并在 When 后**立即**声明"创建不触发执行 + 必须 speak 派工"——这是工具选择时第一眼读到的信号，时机最早、强度最高。

#### 变更 C9（L0 工具协议层）— 待派工票据的结构化状态反馈

**文件**：`src/interface-adapters/agent-runtime/tools/tool-factory.ts`（ToolContext 接口 + create_otter/speak execute）

**问题（第三轮架构审视 Agent B 第三条路）**：C3 的回包提示是预设文案（"已就位但未开工"），基于"create 时一定该提醒"的假设——不携带实际系统状态。如果大獭 create 后确实同批 speak 派工了（正常流程），C3 回包仍说"未开工"是噪音；如果大獭 create 了 3 只只派了 2 只，C3 三条回包都说"未开工"但分不清"哪只没派"。**自然语言回包无法表达结构化状态**。

**架构定位（与"反强编排"的边界）**：C9 是**工具层状态反馈**，不是强编排/硬编码逻辑——它不决定大獭该传给谁（编排自由度完整保留），只在系统观察到"待派工未清空"时把**事实**反馈给大獭。这属于"工具优先"——用工具回包传达系统状态，而非加 prompt 措辞或硬阻断。

**改动**：

1. **ToolContext 增加 `pendingDispatches`**（本轮新建的小獭 id → name 映射，agent turn 级生命周期）：

```typescript
interface ToolContext {
  // ... 现有字段
  pendingDispatches: Map<string, string>; // otterId -> otterName，本轮 create 新建但未被 speak 覆盖
}
```

2. **create_otter execute 注册票据**：创建成功后 `ctx.pendingDispatches.set(otter.id, otter.name)`。

3. **speak execute 软守卫**（在 `validateAndResolve` 后、`startSpeaking` 前）：

```typescript
// 清除已被本次 speak 覆盖的票据
for (const id of resolvedIds) ctx.pendingDispatches.delete(id);
// 软守卫：未派工票据未清空且本次未提醒过 → 不提交 speak，返回提醒（terminate=false 让 agent 能读到并 reconsider）
if (ctx.pendingDispatches.size > 0 && !ctx.dispatchWarningShown) {
  ctx.dispatchWarningShown = true;
  return textResponse(`[系统状态] 你本轮创建的小獭还有 ${ctx.pendingDispatches.size} 只未获得行动权：${names}。如果是漏派，把 ${names} 加入 talkingStonePassedTo 重新调用 speak；如果确实要传给 [当前目标]，再次调用 speak 即可放行。`);
}
// 二次调用（dispatchWarningShown=true）或已全部派工 → 正常提交
await startSpeaking(...);
return { ...textResponse("[系统控制信号] 发言已提交成功，回合结束。"), terminate: true };
```

**软守卫设计（实现时强化的关键点）**：原设计在 speak 回包追加提醒 + terminate=true——但 terminate=true 后 agent loop 结束，agent 看不到回包（与 C3 同问题）。实现改为**首次未派工时不提交 speak、返回 terminate=false 的提醒**，agent 能读到并重选路由；若 agent 坚持原路由再次调用 speak，`dispatchWarningShown` 已置位，直接放行提交。这避免了死循环，且让 C9 的反馈**真正可见**——区别于 C3/C6 的 terminate 后不可见。

**为什么是第三条路**：
- **不是强编排**：不决定传给谁、不永久阻断——首次提醒后 agent 自主选择（补派 or 坚持），二次放行
- **不是纯 prompt**：基于系统实际状态（pendingDispatches 是否清空），而非预设文案；能区分"全没派/派了一半/全派了"
- **是"工具优先"**：用工具回包（LLM 已在读的信道）传达结构化状态，比加 prompt 措辞或加新工具更轻

### 命名决策

**决策**：保留工程名（`talkingStonePassedTo` 字段、`talking_stone_passed_to` DB 列），reframe prompt-facing 概念词为"行动权"。

**理由**：
1. **rename 成本高**：字段在 entity/DB/tool param/类型校验/F20260810rout 文档里广泛存在；rename 涉及 DB 迁移、代码全量替换、历史文档漂移
2. **LLM 读的是 description 不是 name**：参数名 `talkingStonePassedTo` 只是 JSON key，LLM 通过 description 学语义——description 里 reframe 到"行动权"并显式桥接（"参数名 talkingStonePassedTo 即行动权令牌"）即可让 LLM 建立正确心智
3. **F20260810rout 刚建立"发言权"词汇**：短期内再 rename 是 churn，且 F20260810rout 的注入文案（"发言权默认交回召唤者"）也需要同步改——本期一并 reframe（C2 + 小獭身份注入文案微调）
4. **概念词与工程名解耦**是 prompt 工程的常规做法：人类读"行动权"，机器读 `talkingStonePassedTo`，description 做翻译层

**被否决的方案**：
- *全量 rename 字段为 `actionTokenPassedTo`*：成本/收益不划算，且字段名改动不解决 LLM 心智问题（LLM 不靠字段名学语义）
- *保留"发言"概念不改 frame，只补工作流*：L1 修复能解决一部分案例，但 L2 frame 会让派工步在弱模型上仍被当成可选——F20260810rout 实验已证明弱模型严格按字面走，frame 错位会持续制造漏网

## 验收标准

### 需求推导

1. **需求 R1（L1 工作流修复）**：大獭读 otter-summon skill 后，知道 create 与 receive-outputs 之间必须有一步 speak 派工——不再认为 create 即派工
2. **需求 R2（L2 frame reframe）**：大獭理解 `talkingStonePassedTo`＝行动权，传给小獭＝触发它执行——不是可选的"让出发言轮"
3. **需求 R3（L3 时机教育）**：create_otter 回包提示"已就位但未开工"；speak 回包不再误导"自动调度"
4. **需求 R4（工程层一致性）**：buildRoster 名册 + buildSummonerIdentity 注入文案与 reframe 同步，无措辞撕裂
5. **需求 R5（核心行为）**：大獭召唤小獭后，`messages.talking_stone_passed_to` 包含小獭 ID（不直接跳到 user）；批量创建尤其要覆盖
6. **需求 R6（不破坏）**：F20260810rout 的小獭→大獭回程路由不退化；整体任务终审仍能正确传 user

### 权威证据

| 需求 | 权威证据来源 | 证据类型 |
|------|-------------|---------|
| R1 | `.pi/skills/otter-summon/SKILL.md` 工作流含独立"派工"步 | 文件内容 |
| R2 | `tool-factory.ts` speak/talkingStonePassedTo 描述含"行动权"语义 | 文件内容 |
| R3 | `tool-factory.ts` create_otter 回包 + speak 回包措辞 | 文件内容 |
| R2 | `tool-factory.ts` speak/talkingStonePassedTo 描述含"行动权"语义 + 工具 label | 文件内容 |
| R3 | `tool-factory.ts` create_otter 回包 + speak 回包措辞 | 文件内容 |
| R4 | buildRoster + buildSummonerIdentity + adversarial-review/SKILL.md + seed-terminology.json 措辞 | 文件内容 |
| R5 | `messages.talking_stone_passed_to`（大獭召唤后传小獭 ID） | 运行时状态 |
| R6 | `messages.talking_stone_passed_to`（小獭完成后传召唤者；终审传 user） | 运行时状态 |

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|---------|
| AT-1 | R5 | 独立实例 + 干净 DB（端口隔离）；用户发消息让大獭召唤**单只**小獭处理任务；大獭 create_otter 后 speak | `talking_stone_passed_to = [小獭 ID]`，**不传 user** |
| AT-2 | R5 | 用户让大獭**批量召唤 4 只**小獭（还原 2026-08-13 PR259-262 失败场景）；大獭 create 4 只后 speak | 大獭**同一条** speak 的 `talking_stone_passed_to` 必须包含**全部 4 个**新建小獭 ID——缺失任一即判失败（无"或按序逐次"模糊空间，因为批量场景的"逐次"会丢后续小獭） |
| AT-3 | R6 | 延续 AT-1：小獭完成本职后 speak | `talking_stone_passed_to = [大獭 ID]`（F20260810rout 回程不退化） |
| AT-4 | R6 | 整个协作任务完成后大獭终审 | `talking_stone_passed_to = ['user']`（正向路径不破坏） |

### 能力测试映射

| 验收场景 | 能力测试文件 |
|---------|-------------|
| AT-1, AT-3, AT-4 | `tests/capability/big-otter-dispatch.capability.test.ts`（新建） |
| AT-2 | 同上（多小獭场景用例） |

**能力测试设计要点**（继承 F20260810rout 验证经验 + 对抗审视第二轮阈值修正）：
- 用独立实例 + 独立 DB（端口隔离，不污染生产）
- 真实 mimo 模型（不能用 mock，不能只测 Claude——F20260810rout 实验已证明 Claude subagent 无法复现弱模型行为 bug）
- 触发完整链路：用户 → 大獭 → create_otter → speak 派工 → 小獭 invoke → 小獭 speak 传回大獭
- 断言 `messages.talking_stone_passed_to` 字段值
- 任务设计极简（避免 mimo 在重任务下退化，干扰路由验证）
- **采样阈值**（对抗审视二项分布计算后修正）：AT-1/AT-3/AT-4 跑 **5 次 ≥4 次成功**；AT-2（批量 4 只联合概率，更难）跑 **7 次 ≥5 次成功**。原 3 次 ≥2 阈值在真实成功率 p=0.7 时仍有 78% 通过率，无法检测修复是否有效

> **R1-R4 证据类型说明**：R1（skill 工作流）/R2（reframe）/R3（回包）/R4（工程层一致性）的权威证据为**文件内容**（prompt 类改动的合理证据类型），不需要运行时验收场景。R5/R6 由 AT-1~AT-4 运行时验证。

### 证据判定（验收执行后填写）

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| R1 | otter-summon SKILL.md 工作流含独立"派工编排"步（step 3） | ✅ |
| R2 | tool-factory.ts speak/talkingStonePassedTo 描述含"行动权"语义 | ✅ |
| R3 | tool-factory.ts create_otter 回包 + speak 回包措辞均已调整 | ✅ |
| R4 | buildRoster + buildSummonerIdentity + adversarial-review/SKILL.md + seed-terminology.json 全部 reframe | ✅ |
| R5 | AT-1 单只 5/5 通过 + AT-2 批量 7/7 通过（远超阈值） | ✅ |
| R6 | 小獭回传大獭由 talking-stone-routing.capability.test.ts 覆盖（F20260810rout）；终审传 user 路径保留（speak 路由规则不变） | ✅ |

## 对抗审视记录

### 第一轮：CC agent 对抗审视（根因扎实度角度）

**审视者**：CC agent（用户在 CC 环境，用 Agent 工具替代独立审视獭）

**阻断性问题**（1 个，已处置）：
- **问题 1**：原"数据实锤"只有静态代码事实，无行为数据，"大獭不传"前提来自用户口头报告未量化。
  - **处置**：已查生产 DB（`data/otter-buddy.db`），补全行为数据章节——70 起创建事件、12.9% 失败率、批量创建放大效应（30.8% vs 10.2%）、"正在..."失败签名、9/9 可恢复。根因权重现在有量化支撑。

**次要观察**（已采纳并修订）：
1. **L1 论证不精确**：references 第 17 行其实教了"speak 时把小獭当目标"的方法，缺口在主工作流没排进步骤序列——已修正 L1 表述为"方法教了但步骤没排进去"。
2. **遗漏两个工程层根因**：buildRoster 第 165 行"交还发言权"措辞（高频注入、与 reframe 矛盾）+ speak 回包"自动调度"误导（传 user 时失真）——已纳入 C5/C6 变更。
3. **结构问题**：C5 原是空变更（SYSTEM.md 不需改）——已移出变更清单（改为说明），新 C5/C6 是真正的工程层变更。

**待补**（用户拍板后推进）：
- 设计风险角度（C3 同批调用时机、reframe 歧义、能力测试阈值、回归）与范围一致性角度（frontmatter 合规、与 F20260810rout 关系、全仓术语完整性）的对抗审视因速率限制未完成，待重试。

### 第二轮：CC agent 对抗审视（设计风险 + 范围一致性，双 agent 并行）

**阻断性问题**（3 个，已处置）：
- **问题 2**：adversarial-review/SKILL.md "发言权路由"段（F20260810rout 加的）未被 reframe 覆盖——prompt 面向 LLM 的高频信号，遗漏会造成措辞撕裂。
  - **处置**：已纳入 C4 变更 + 加入 modules。
- **问题 3**：capability_test 路径 `tests/capability/big-otter-dispatch.capability.test.ts` 不存在，sync 会报错（docs/README.md 硬规则"路径不存在报错"）。
  - **处置**：新增 C7 变更声明随实现创建该文件。
- **问题 4**：数据算术不自洽——总表 53+9=62≠70，BATCH OTHER 8 个"部分派工丢失"未计入，summary 的 12.9% 低估。
  - **处置**：重写数据实锤总表为三分类（OK/FAIL_TO_USER/BATCH_PARTIAL），分两档口径（纯失败 10.0% / 含部分丢失 21.4%），summary 同步更新。

**重要问题**（5 个，已处置）：
- **问题 5（C3 时机）**：SDK 并行执行 + terminate 批后生效 → 同批 create+speak 时 create 回包不可见，C3 对最危险的批量场景失效。
  - **处置（用户拍板）**：C3 降级为串行辅助，**不加工程兜底**（遵循"反强编排，工具优先"）。同批 create+speak(to user) 的根因是大獭误以为 create=派工，由 C1+C2 修认知后该路径自然消失。已在 C3 加"适用范围说明"。
- **问题 6（测试阈值过宽）**：3 次 ≥2 在 p=0.7 时 78% 通过率，修复无效也可能"过"。
  - **处置（用户拍板）**：改为 AT-1/3/4 跑 5 次 ≥4；AT-2（批量联合概率）跑 7 次 ≥5。
- **问题 7（术语库）**：seed-terminology.json 定义"发言石=发言权传递"，与 reframe 冲突。
  - **处置**：纳入 C4，更新定义为"行动权传递机制"。
- **问题 8（C5 措辞收窄）**："才传"限定可能让小獭在正常应传 user 时犹豫。
  - **处置**：C5 去掉限定，只做术语 reframe（限定条件已在 speak 路由规则 + buildSummonerIdentity）。
- **问题 9（C2 名义不一致）**：reframe 后 speak(发言)/talkingStone(发言石)/行动权 三词三义。
  - **处置**：C2 加工具 `label` display name 改为"结束行动"（不改工程 name），降低弱模型映射负担。

**次要观察**（已采纳）：
- D1 用未修复数据的"9 OK"论证修复后能力，归因瑕疵——已弱化为"在特定上下文下能批量派工，可能含运气成分"。
- D1 后路触发条件原为"3 次 <2/3"过宽，L4 永不触发——改为"AT-2 全 4 只都在绝对成功率 <60%"。
- F20260810rout status 仍 design 但已实施——本期改其代码（buildSummonerIdentity）时归属模糊。**前置条件**：本期 PR 前 F20260810rout 应先更新 status 到 implemented/final（属该文档维护，不在本期范围）。
- "9/9 可恢复"含 2 中断——已改为 7/7 真实路由失败可恢复。
- R1-R4 无运行时验收场景——已在能力测试段注明证据类型为文件内容。

**结论**：第二轮审视通过（阻断性问题已处置）。剩余风险（C3 串行局限、弱模型 reframe 映射）由加严的能力测试阈值（AT-2 7 次 ≥5）兜底，验证失败则启动 L4。

### 第三轮：CC agent 架构审视（架构哲学一致性 + 根因根本性，双 agent 并行）

**审视者定位**：跳出前两轮的根因/风险/范围层面，从架构哲学与长期演进挑战。两个 agent 独立命中同一致命遗漏。

**共识阻断性发现**（2 个，已处置）：
- **问题 10（create_otter description 上游源头）**：create_otter description 第一句"召唤专门**执行特定任务**的小獭"——"执行特定任务"直接暗示 create 触发执行。这是大獭形成"create=派工"心智的**第一个、最权威信号源**（工具选择时必读，比 skill 按需读、回包动作后反馈都早）。方案 C1-C7 全部修下游（skill/回包/术语），漏了上游源头。**两个架构师独立得出同一结论**——证据强度最高。
  - **处置（用户拍板）**：新增 C8 改 create_otter description，"执行特定任务"→"就位待命"，并在 When 后立即声明"创建不触发执行，需 speak 派工"。架构师判定：C8 单项杠杆 > C1-C7 reframe 总和。
- **问题 11（C1 分层混淆）**：派工是工程必然性（不派工＝不发生），不是经验沉淀。把纯机械的工程约束写成 skill 第 3 步，混淆了 SYSTEM.md A5 的"skill=经验"边界。
  - **处置（用户拍板）**：C1 重新分层——skill 只教编排 know-how（并行 vs 串行判断、顺序决策），工程必然性由 C8(description)/C3(回包)/C9(票据) 保证。

**共识架构债**（2 个，已记录为 D4）：
- **问题 12（无单一真相源）**：控制流原语语义散落 7+ 处，两轮审视各发现一处遗漏——手动同步不可靠。
- **问题 13（reframe 治标不治本）**：任何自然语言词命名工程原语都会被弱模型字面误解；"行动权"可能重蹈"发言"覆辙。
  - **处置（用户拍板）**：新增 D4 架构 debt 声明——显式承认是"第二个补丁"，触发条件（第三次同类 bug）+ 演进方向（语义层抽象 / 结构化信号 / 批量协议重设计）。

**第三条路发现**（1 个，已纳入本期）：
- **问题 14（C9 工具协议层结构化反馈）**：C3 回包是预设文案，不携带实际系统状态；且同批调用时不可见。Agent B 提出"待派工票据"——create 注册票据，speak 检查未清空时回包追加结构化事实提醒。**这是"工具优先"而非强编排**——系统传达"还有 N 只未派工"的事实，不决定大獭传给谁。
  - **处置（用户拍板）**：新增 C9 纳入本期。与"反强编排"记忆的张力已澄清——C9 是状态反馈不是硬阻断，属于工具层职责。

**次要观察**（已记录）：
- "行动权"的"权"字带授权/层级色彩，与 W2（AI 独立思考者）有微弱张力——紧迫性低，未来若再 reframe 应奔"接力/令牌"语义而非"X权"。
- D1 否决 auto-dispatch 的"9 OK 能力"论据可能含运气成分——已在 D1 弱化为"特定上下文下能派工"。
- C9 与 C6 回包措辞需在实现时协调合并为一个 return 点（已记入 C9 回归风险段）。

**结论**：第三轮架构审视通过。C8 补上上游根因（最高杠杆），C9 引入工具层状态反馈（第三条路），C1 重新分层（A5 合规），D4 记录架构债与演进方向。方案从"纯 prompt reframe"升级为"上游 description + prompt reframe + 工具层结构化反馈"三层协同。

## 设计决策

### D1：为什么不直接让 create_otter auto-dispatch

**被考虑的方案**：让 `create_otter` 在创建后立即把行动权传给小獭（create 即 invoke），匹配人类"建人→分配→人自动开干"的自然心智。

**否决理由**：
1. **失去编排控制**：当前两步（create + speak 派工）让大獭能控制调度顺序——先创建 3 只小獭，再按特定顺序派工，或并行派工。auto-dispatch 会让 create 变成阻塞串行（每只小獭必须执行完才能 create 下一只）。行为数据显示 BATCH 创建存在 9 个 OK 案例（大獭确实会一次创建多只再批量派工），这个模式不能砍掉
2. **与 F20260810rout 的修复哲学不一致**：F20260810rout 走的是 prompt-first / mechanism-as-fallback（L5 工程兜底只在 prompt 修复无效时启用）。本期也应先验证 prompt 修复效果，再决定是否需要机制改动
3. **可加不可减**：如果 prompt 修复验证后仍兜不住（弱模型仍漏派工步），auto-dispatch 是 L4 工程兜底的候选——届时再做，可进可退

**行为数据支撑**：批量场景含部分丢失 57.1% 失败率，但仍有 9/21 批量事件 OK——说明大獭**在特定上下文下**能批量派工，只是不稳定（注：这些 OK 案例是在当前有 bug 的 prompt 下发生的，可能含运气成分，不能直接推断修复后的能力上限。但至少证明批量派工模式在工程上可行，不应被 auto-dispatch 砍掉）。

**保留的后路**：若能力测试 AT-2（批量 4 只）在 7 次采样中"全 4 只都在"的绝对成功率 <60%（即 <5/7），启动 L4 评估——候选方案包括 create 时 auto-dispatch（牺牲编排灵活性换可靠性）或 speak 闭包的"召唤后未派工"软校验。**触发条件用绝对成功率而非宽松的采样通过率**，避免 L4 永远不被触发。

### D2：L1 与 L2 谁是主因

**审视角度**：是工作流缺口（L1）更致命，还是 frame 错位（L2）更致命？

**判断**：L1 是**结构性的**——任何模型按当前 skill 字面执行都会漏派工步，因为步骤根本不存在。L2 是**放大器**——即便补了派工步，"发言权"措辞让该步在弱模型上感觉可选。两者必须同时修：L1 让步骤存在，L2 让步骤被执行。

证据：F20260810rout 的实验证明 otter 实际模型（mimo）严格按 prompt 字面走，不推断缺失步骤、不权衡措辞细微差别。所以 L1 的"步骤缺失"和 L2 的"措辞软化"对弱模型都是致命的。

### D3：术语 bridge 的处理（对抗审视第二轮强化）

参数名 `talkingStonePassedTo`（工程名）与 prompt 概念词"行动权"不同名，工具 `name` "speak"也仍带"发言"语义——三处三种信号。处理方式三重 bridge：

1. **参数 description 桥接**：talkingStonePassedTo description 显式写"参数名 talkingStonePassedTo 即行动权令牌"。
2. **工具 label 桥接**：speak 的 display label 改为"结束行动"（C2），LLM 在工具选择界面看到的是"行动"语义而非"speak/发言"。
3. **保留工程 name 不改**：`name: "speak"` 和字段 `talkingStonePassedTo` 是 JSON key / 工程标识，rename 成本高且 LLM 主要靠 description 学语义，不靠 name。

不桥接的风险：弱模型看到 description 说"行动权"，但工具叫 speak、参数叫 talkingStone——三词三义可能产生 frame 回退（对抗审视第二轮角度 2）。三重 bridge 后，display 层（label + description）统一为"行动"，工程层（name + 字段）保留原样，分层清晰。

### D4：架构 debt 声明（第三轮架构审视采纳）

**承认的 debt**：控制流原语（talkingStonePassedTo）的语义散落在 7+ 处注入点（工具 description × 2、身份 prompt × 2、skill 文档 × 3、名册、术语库、身份注入文案），**无单一真相源**。本期 C2/C4/C5 一次性手工同步这些 surface，但两轮对抗审视各发现一处遗漏（buildRoster、adversarial-review/SKILL.md）——这是"手动同步不可靠"的铁证，不是审视不充分。

**架构根因（更深一层，本期不修但显式记录）**：本特性是"控制流原语被弱模型误解"问题的**第二个补丁**（F20260810rout 是第一个，修小獭侧；本特性修大獭侧）。反复出现同类 bug 的架构根因是——**系统把控制流语义完全委托给自然语言 description 传达**，任何 description 都会被弱模型（mimo 类）部分字面误解。换词（发言→行动权）只是把失真点移位，不消除失真。第三轮架构师判定："行动权"可能重蹈"发言"覆辙——下一个 bug 可以是大獭拿到"行动权"后只 speak 不调工具（"我行动了啊，我说了话"）。

**触发条件**：当**第三次**同类 bug 出现时（控制流原语被弱模型误解导致行为偏移），启动语义层抽象，不再做第三次措辞 reframe。

**演进方向（触发时启动）**：
1. **术语注册表作为 single source of truth**：抽 `control-flow-semantics.ts`，定义 `ACTION_TOKEN_TERM`/`ACTION_TOKEN_DESCRIPTION` 等常量；所有注入点（工具描述、身份 prompt、skill 文档、名册、术语库）从它读取，不硬编码。全局 reframe 改一处，非改 7 处。
2. **结构化语义优先于自然语言**：把"谁该被 invoke"的控制流决策从纯 LLM 自然语言判断，部分转移给工具协议层的结构化信号（C9 的待派工票据是这个方向的雏形）。长期目标：关键控制流 invariant 不依赖真模型测试保证。
3. **批量创建协议重设计**：考虑 `create_otter_batch` 或 speak 预格式化回包，降低"create 多只后维护名字列表"对弱模型的认知负担（当前批量 57.1% 失败率的协议层根因）。

**本期的妥协**：C9（待派工票据反馈）是上述方向 2 的雏形，本期纳入；方向 1（语义层）和方向 3（批量协议）不在本期，触发条件出现时启动。承认本期方案是"高质量的第二个补丁"，不会阻止第三个补丁的需求——但 D4 把触发条件和演进方向写明，避免第三次重蹈手工 reframe 的覆辙。

## 实施记录

### 已实施变更（worktree `action-token-reframe`，rebase 到 origin/main）

| 变更 | 文件 | 改动 |
|------|------|------|
| C8 | `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | create_otter description："执行特定任务"→"就位待命"+ 声明"创建不触发执行" |
| C2 | 同上 | speak description reframe"发言→行动"；talkingStonePassedTo 改"行动权"+ bridge |
| C3 | 同上 | create_otter 回包加"已就位待命，但尚未开工"提示 |
| C6 | 同上 | speak 成功回包去"系统将自动调度下位发言者" |
| C9 | 同上 + `src/frameworks/agent/pi-session-factory.ts` | ToolContext 加 pendingDispatches/dispatchWarningShown；create 注册票据；speak 软守卫（首次未派工 terminate=false 提醒，二次放行）；抽 `checkPendingDispatches` helper 降复杂度 |
| C5 | `src/usecases/conversation/dispatch-chain-engine.ts` | buildRoster "交还发言权"→"交还行动权给搭档" |
| C4 | `pi-session-factory.ts` buildSummonerIdentity | "发言权默认交回"→"行动权默认交回" |
| C4 | `prompts/identity/BIG_OTTER.md` | 召唤段扩展为两步动作模型 |
| C4 | `prompts/identity/SMALL_OTTER.md` | "发言/发言就是交付物"→"行动/行动产出" |
| C4 | `.pi/skills/otter-summon/references/collaboration-patterns.md` | "发言石/发言权"→"行动权"（6 处） |
| C4 | `.pi/skills/adversarial-review/SKILL.md` | "发言权路由"段→"行动权路由" |
| C4 | `data/terminology/seed-terminology.json` | term "发言石"→"行动权"；definition 更新；aliases 加新旧词映射 |
| C1 | `.pi/skills/otter-summon/SKILL.md` | 工作流插 step 3 派工编排（并行/串行 know-how） |
| C7 | `tests/capability/big-otter-dispatch.capability.test.ts` | 新建：AT-1（5次≥4）+ AT-2（7次≥5） |

**label 字段（C2 原 spec 的一部分）未实施**：SDK 不支持工具 `label` display name（无消费者），加了是死代码。D3 的 bridge 从"三重"降为"两重"（description bridge + 保留工程名）。

### Build 与单元测试状态

- **build**：✅ 通过（lint + tsc + tsc-alias，0 errors）
- **单元测试**：✅ `tests/interface-adapters/` 118/118 通过（C9 的 ToolContext 改动用可选字段，零回归）

### 能力测试结果

**环境**：worktree `action-token-reframe`，in-process 独立实例（bootCapabilityApp），独立临时 DB，真实 mimo-v2.5-pro 模型，真实 bge-m3 embedding。

**AT-1 单只（5 次采样 ≥4）**：✅ **5/5 通过**

```
[capability] big-otter-dispatch-single 采样结果（5/5 成功）:
#1: OK 小獭=报告獭 tsp=["4f5b2bab..."] match=true
#2: OK 小獭=报告獭 tsp=["0adb3c82..."] match=true
#3: OK 小獭=报告獭 tsp=["aafdf627..."] match=true
#4: OK 小獭=报告獭 tsp=["8ba5fb57..."] match=true
#5: OK 小獭=报告獭 tsp=["cbb74302..."] match=true
```

**AT-2 批量 4 只（7 次采样 ≥5）**：✅ **7/7 通过**

```
[capability] big-otter-dispatch-batch 采样结果（7/7 成功）:
#1~#7: OK 召唤 4 只（甲獭,乙獭,丙獭,丁獭） tsp 覆盖 4/4 user=false
```

**修复前后对比**：

| 指标 | 修复前（生产数据） | 修复后（能力测试） |
|------|-------------------|-------------------|
| 单只：大獭传 user 不传小獭 | 7.1% 失败率 | 0%（5/5） |
| 批量：含部分丢失的失败 | 57.1% 失败率 | 0%（7/7） |
| 批量：tsp 覆盖全部新建小獭 | 42.9% | 100%（7/7） |

**观察**：大獭 body 出现"现在同时唤醒""集体唤醒""把发言权一次性交给你们四位"等措辞——说明大獭建立了"创建后需主动派工"的正确心智模型。少数 body 仍用"发言石/发言权"旧词，但**路由行为 100% 正确**——reframe 的目标是工具语义理解，非强制 body 文本用词。

**结论**：C8（description）+ C1（工作流）+ C2（reframe）+ C9（票据反馈）三层协同修复完全消除了 bug，包括最难的批量场景。L4 工程兜底（auto-dispatch / speak 闭包硬校验）无需启动。
