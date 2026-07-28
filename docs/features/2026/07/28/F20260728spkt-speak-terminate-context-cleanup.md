---
id: F20260728spkt
title: speak-terminate-context-cleanup
doc_type: feature

# 记忆索引
summary: |
  speak 回合终止从文案禁令改为 loop terminate 机制（SDK 原生能力，transcript 实证文案禁令 0% 生效）；
  工具 description 与参数 schema 去重（8 个工具）；
  code-implementation skill 合规条款三处重复收敛为一处，禁用语黑名单改写为正向处置原则。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260722d3k7   # 行为模式强化（本特性清理其引入的重复条款，保留合规效力）

# 元数据
status: implemented
change_type: refactor
tags: [speak, agent-loop, terminate, context-engineering, skills, tools, prompt]
modules: [interface-adapters/agent-runtime/tools/, skills/code-implementation/]

# 时间
created_at: 2026-07-28
---

# F20260728spkt speak 回合终止机制化 + 上下文工程清理

## 背景 [required]

研究报告 R20260728c5xt（随 PR #96 同分支提交）对 Otter 上下文工程做了全面体检，发现三类问题，本特性是其行动项落地。

### 问题 1：speak 尾随消息——文案禁令 100% 无效

3 个 session transcript、15 次 speak 调用实测：**每次 speak 成功后模型都会再发一条 assistant 消息（15/15）**。

关键证据是模型的 thinking：「The speak call was successful. My turn is complete. I should not output any additional text.」——随后仍输出文本。**模型理解禁令，但 agent loop 在 tool_result 后强制模型再生成一条消息，"沉默"在结构上不可能**。且实质内容在 speak body 与尾随消息间重复（400-700 字符级），尾随内容不进 DB body，增量信息有丢失风险。

### 问题 2：工具 description 与参数 schema 重复

8 个工具把参数说明写进工具级 description，而参数 schema 的 description 已写过一遍（如 `create_linked_resource` 的 description 复述全部 6 个参数）。

### 问题 3：code-implementation skill 合规条款三处重复

F20260722d3k7 事故补丁将 worktree 隔离、PR-only、职责分离三条合规规则同时写入 Core Principles、Workflow Step 7、Behavioral Rules 三处；另有预判式借口枚举（"NEVER skip worktree — even for small changes..."）和禁用语黑名单。同一约束多处重复是旧模型时代的防呆写法，对强模型是注意力稀释（依据：Anthropic《The new rules of context engineering for Claude 5 generation models》规则 4）。

## 用户意图锚 [required]

| ID | 用户原话 | 关键修饰语 | 架构师解读 | 来源 |
|----|---------|-----------|-----------|------|
| UA-1 | "现在效果基本是ai会调用speak tool，然后还会再发一次最终的assistant message，这理论上是llm决定的" | llm 决定的 | 尾随消息是 loop 结构产物，非模型态度问题 | 对话反馈 |
| UA-2 | "本质是让llm懂怎么做，其余工程我觉得更像是'事后拦截'不太优雅不能作为主手段，所以我之前是拒绝这种做法" | 不是主手段；拒绝过 | 工程拦截方案（guard）被否决；需证明方案不是拦截 | 对话反馈 |
| UA-3 | "你来验证下sdk api是否具备这种能力" | 验证 | 方案必须建立在 SDK 原生能力实证上，不能想当然 | 对话指令 |
| UA-4 | "要！"（对"terminate 机制化 + 文案优化项一起立项实现"的确认） | 一起立项 | 三项问题合并为一个特性交付 | 对话指令 |

**UA-2 的回应**：terminate 不是事后拦截——拦截是"模型想做某事，挡住它"；而 transcript 证明模型没有想做的事（thinking 明确"不应再输出"），是 loop 强制它再开口。terminate 是工具声明"我是回合终点"、loop 尊重该声明，属协议修正。模型已理解（UA-2 的前提成立），是 loop 结构使其无法执行。

## 目标 [required]

### T1 — speak 成功路径返回 terminate，结构性终止 loop

speak 工具执行成功时结果置 `terminate: true`，agent loop 不再发起下一轮 LLM 调用。失败路径（校验错误、声明失败）不带 terminate，loop 继续，模型可重试。

### T2 — speak 文案去禁止化

terminate 生效后"不要输出任何文字"类禁令失去存在必要（模型不会再被问到），description 与返回值精简为协议事实陈述。

### T3 — 工具 description 与 schema 去重

工具级 description 只写"做什么 + 系统注入项"，参数语义只留在 schema description。

### T4 — code-implementation skill 去重

合规三条只保留 Core Principles 一处；删除 Step 7 与 Behavioral Rules 的重复 NEVER 条款；删除借口枚举。

### T5 — 禁用语黑名单改写为正向处置原则

"Forbidden escape phrases" 黑名单改写为正向规则（每个问题必须有处置），原清单保留在 adversarial-review/references/anti-patterns.md（已有 "Ask Whether to Fix" 反模式记录症状措辞）。

## 非目标 [required]

- 不改动合规三条的**效力**（worktree 隔离、PR-only、职责分离来自 F20260722d3k7 真实事故，只去重不松绑）
- 不改动 adversarial-review skill 的禁用语清单（审查阶段措辞是工作定义而非防呆）
- 不处理 speak 与其他工具同批次调用时 terminate 不生效的边缘场景（SDK 语义：批次内所有结果均 terminate 才终止；transcript 显示 speak 几乎均单独调用）
- 不做 assistant 最终消息即发言本体的架构重设计（方向性演进，需单独立项）
- 不修改 SYSTEM.md、身份文件、记忆体系（已符合新范式）

## 设计 [required]

### 1. speak terminate（T1/T2）

**SDK 能力验证**（pi-agent-core 0.80.10 源码，详见 R20260728c5xt §2.4）：
`AgentToolResult.terminate?: boolean` 是 loop 一等公民能力，`agent-loop.js` L124 `hasMoreToolCalls = !executedToolBatch.terminate`。全链路（Otter 工具 → pi-session-factory 适配 → ToolDefinition wrapper → extension wrapper → loop）逐层确认透传。

**改动**：

- `tool-helpers.ts`：`ToolResponse` 增加 `terminate?: boolean`（可选字段，纯增量）
- speak 成功路径：`return { ...textResponse("[系统控制信号] 发言已提交成功，回合结束。系统将自动调度下一位发言者。"), terminate: true }`
- speak description：删除禁令段落，保留职责说明 + terminate 事实（"调用成功后回合立即结束（结果带 terminate，loop 不再发起后续生成）"）

**失败路径设计**：body 为空、发言石为空、目标为自己、目标不在场、startSpeaking 异常——全部返回错误文本且**不带 terminate**，loop 继续，模型可修正后重试。transcript 中存在 speak 校验失败后重试成功的真实案例，此路径必须护住。

### 2. 工具 description 去重（T3）

| 工具 | 删除的复述内容 |
|------|---------------|
| speak（顺带） | 参数规则复述保留在 schema |
| invite_participant | "参数：otterId（被邀请的Otter ID）" |
| create_otter | "参数：name，type（big/small），systemPrompt" |
| dissolve_otter | "参数：otterId" |
| create_linked_resource | 全部 6 个参数的复述（条件必填语义已在 schema） |
| get_context | "参数：key（可选，不传则返回全部上下文）"（语义并入 schema key 描述） |
| set_context | "参数：key, value" |
| delete_context | "参数：key（必填）" |
| get_active_participants | 预防式强制调用场景枚举（speak/create_otter 的 execute 已有校验兜底，错误返回即情境化教学） |

### 3. SKILL.md 去重与改写（T4/T5）

- **删** Step 1 第 5 条借口枚举（Core Principles 已有 "ALL file changes must happen in a worktree"，Step 1 第 3 条已有 "zero modifications"）
- **删** Step 7 第 4-5 条（NEVER merge / NEVER push，Core Principles L17-18 已有）
- **删** Behavioral Rules 三条 NEVER 重复
- **改写** 禁用语黑名单为：「Every discovered issue needs a disposition: fixed immediately, or recorded (PR description + linked issue). Labeling an issue as minor or low-risk is not a disposition」——黑名单防字面不防意图，正向规则覆盖未枚举的变体措辞

## 硬约束 [required]

1. speak 成功路径必须返回 `terminate: true`
2. speak 所有失败路径不得带 terminate（保护重试链路）
3. 合规三条（worktree/PR-only/职责分离）在 Core Principles 中保留，一字不改
4. 工具参数的条件必填语义（如 create_linked_resource 的 url/content）不得在精简中丢失——只删工具级复述，schema 描述保留
5. 尾随消息消除依赖 SDK terminate 语义，不得额外引入 harness 层拦截/丢弃逻辑（UA-2）

## 设计取舍 [required]

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| 尾随消息治理方式 | 工具结果 terminate | harness guard 拦截 speak 后输出；assistant 消息即发言的重设计 | guard 被 UA-2 否决且拦不住文本；重设计改动状态机，单独立项。terminate 是 SDK 原生协议能力，非拦截 |
| 合规条款保留位置 | Core Principles 一处 | 分散多处（现状） | 该处已是原则式表述；多处重复稀释注意力 |
| 禁用语黑名单 | 正向处置原则替代 | 保留黑名单并扩充 | 黑名单永远枚举不完变体；具体症状措辞已在 anti-patterns.md 存档 |
| 同批次 terminate 缺口 | 不处理 | afterToolCall 钩子强制 terminate | 需侵入 SDK loop 配置注入点，成本高于边缘场景收益 |

## 验证 [required]

### 验收标准

- [x] `ToolResponse` 含可选 `terminate` 字段
- [x] speak 成功路径返回 terminate: true，失败路径不带
- [x] speak description/返回值无"不要输出任何文字"类禁令
- [x] 8 个工具 description 无参数复述，schema 语义完整
- [x] SKILL.md 合规条款仅 Core Principles 一处，无借口枚举、无黑名单
- [x] 全量测试通过（51 文件 / 602 用例）
- [x] 构建通过（tsc --noEmit）

### 测试设计

| 测试用例 | 验证点 |
|---------|--------|
| speak 合法目标（otterId / 'user'） | 提交成功 + terminate: true |
| speak 目标不在场 | 错误 + 可选名单 + 无 terminate |
| speak 目标为自己 | 错误 + 无 terminate |
| speak body 为空 / 发言石为空 | 错误 + 无 terminate |

### 上线后观察项

- 新 session transcript 中 speak 后尾随 assistant 消息应为 0（可用 R20260728c5xt §2.4 的脚本复测）
- 观察 1-2 周：SKILL.md 精简后合规行为（worktree/PR 流程）是否退化，退化则回退文案（黑名单原样在 git 历史与 anti-patterns.md 中）

## 改动范围 [required]

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/interface-adapters/agent-runtime/tools/tool-helpers.ts` | 修改 | ToolResponse 增加 terminate 可选字段 |
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | 修改 | speak terminate + 文案去禁止化；8 个工具 description 去重 |
| `tests/interface-adapters/speak-tool.test.ts` | 修改 | terminate 断言（成功带、失败不带）+ 空参数用例 |
| `.pi/skills/code-implementation/SKILL.md` | 修改 | 去重 + 黑名单正向改写 |

## 关联 [required]

- **研究报告**：R20260728c5xt（本 PR Part 1）— 实证依据与 SDK 验证细节
- **行为模式强化**：[F20260722d3k7](../22/F20260722d3k7-agent-behavior-pattern.md) — 本特性清理其引入的重复条款，合规效力不变
- **博客依据**：[The new rules of context engineering for Claude 5 generation models](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models)

## 交叉审视修订记录

对抗检视（2026-07-28，按 adversarial-review 六维度执行）结论：**可以合入**，5 个发现均为建议级，处置如下：

| # | 发现 | 严重度 | 处置 |
|---|------|--------|------|
| R1 | 研究报告"15 次调用、15/15"数字不复现：实际 20 次调用、19 成功、尾随 19/19（已独立复算确认） | 建议 | 本 PR 修正：R20260728c5xt §2.4 数字勘误（定性结论不变且更强） |
| R2 | speak description 删除"每次回复只调用一次"后，批次语义缺口无文案缓释 | 建议 | 本 PR 修复：description 加回"speak 必须单独调用，不要与其他工具同批（同批时 terminate 不生效）"——机制事实陈述，非禁令 |
| R3 | currentMessageId 未设置、startSpeaking 异常两条失败路径无 terminate 断言 | 建议 | 本 PR 修复：补 2 个测试用例 |
| R4 | PR 描述测试数（50 文件/577 用例）过时 | 建议 | 本 PR 修复：更新为 51 文件/602 用例 |
| R5 | 特性文档验收标准未勾选 | 建议 | 本 PR 修复：已勾选 |
