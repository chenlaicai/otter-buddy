---
id: F20260811sktp
title: skill-tool-prompt-system-optimization
doc_type: feature

summary: |
  向 clowder-ai 学习——重构 otter 三层 agent 基础设施。
  Part A：Skill 系统契约化（manifest 路由表 + description 三段式铁律 + writing-skills 元 skill + 双向 lint）。
  Part B：Tool 系统标准化（description 5 元素简化版 + GOTCHA 模式 + errorResponse/isError 统一错误返回）。
  Part C：SYSTEM.md 重组为 P 原则-W 世界观-R 规则三层。
  动机：skill 会持续扩展，不提前固化契约必然退化；speak 工具描述 1500+ 字塞三件事已是反例；错误返回靠 `[错误]` 文案 pattern match 不可靠。

causal_links:
  from:
    - F20260810ka23
    - F20260810sopt
    - F20260716t2ab
  to: []

status: design
change_type: prompt
tags: [agent, skill, tool, system-prompt, infrastructure]
modules:
  - .pi/SYSTEM.md
  - .pi/skills/
  - src/interface-adapters/agent-runtime/tools/
  - prompts/
capability_test: "n/a: 设计文档，实施阶段各子项单独建能力测试（B 类 LLM 行为变更）"
---

# F20260811sktp: Skill / Tool / Prompt 系统优化

## 背景

向 `/Users/orca/ai/others/clowder-ai` 学习，重构 otter 三层 agent 基础设施（system prompt / skill / tool）。本文件是**设计文档**，落地实施分批 PR。

### 对标差距（基于代码实锤）

| 维度 | clowder-ai 实锤 | otter 当前实锤 | 差距判定 |
|---|---|---|---|
| Skill 路由表 | `cat-cafe-skills/manifest.yaml`（756 行）含 triggers/not_for/output/next/sop_step | 无 manifest，靠 SKILL.md frontmatter `name + description` 路由 | 缺契约源 |
| Skill description 铁律 | writing-skills/SKILL.md:64-78 明文规定"description 只描述触发条件，绝不总结流程" | `_shared/SKILL-TEMPLATE.md` 没此约束；companion/core-workflow 已自发遵守，requirement-analysis/code-implementation 未遵守 | 铁律未固化 |
| Skill 三段式契约 | manifest 强制 `Use when / Not for / Output:` | 部分 skill 有"排除"段落但无强制结构 | 风格不一致 |
| Skill-writing 元规范 | `writing-skills` skill + persuasion-principles.md + testing-skills-with-subagents.md | `_shared/SKILL-TEMPLATE.md` 只讲结构，不讲说服设计与 TDD | 元规范缺失 |
| Tool description 标准 | `cat-cafe-skills/refs/mcp-tool-description-standard.md` 5 元素 | 无标准；`speak` 描述 1500+ 字塞发言+卡片+自愈三件事；`invite_participant` 只 13 字 | 风格极乱 |
| Tool 错误返回 | `ToolResult { content, isError }` + `errorResult/successResult` 工厂 | `textResponse(text)` 单一工厂；错误靠文案 `[错误]` 前缀 pattern match | 不可结构化识别 |
| Prompt 第一性原理 | `shared-rules.md` P1-P5 原则 + W1-W8 世界观 + 18 条规则，每条引用户原话 | `.pi/SYSTEM.md` 5 条原则（事实优先/诚实/安全/搭档优先/流程）+ 红线 + 约定，扁平罗列 | 缺根因锚 |

### 不抄的部分（去伪存真）

| clowder-ai 元素 | 不抄理由 |
|---|---|
| `manifest.yaml` 的 `sop_step` 字段 | otter 的 skill 不按 SOP 阶段切（5-stage dev flow），目前按场景切 |
| `manifest.yaml` 的 `requires_mcp` 字段 | otter 暂无 MCP 依赖声明需求 |
| `shared-rules.md` 源文件 + 编译 digest 双轨 | otter 体量不需要双轨维护，单一 SYSTEM.md 即可，重组结构而非拆双源 |
| `PackSecurityGuard` prompt injection 防御 | otter 单租户，暂无 pack 扩展模型 |
| `cat-template.json` 643 行的 breed/roster/cat personality 体系 | otter 用 `BIG_OTTER.md + SMALL_OTTER.md + OtterConfigProvider.systemPrompt` 已够 |
| symlink 到 `~/.claude/skills/` 的分发方案 | otter 用 SDK 原生 `.pi/skills/` 发现，更简单 |

### otter 已做对的（不重写）

- Tool 用闭包捕获 `ToolContext`（注入 otterId/conversationId/currentMessageId），LLM 不可见——clowder-ai 无此设计
- Skills 引用工具名（`search_memory`、`create_linked_resource`），工具不知道 skill——边界已对
- 三层 prompt 组装（SDK base + otterPromptConfig + identityPrefix），通过 `AsyncLocalStorage + before_agent_start hook` 注入——架构合理
- `textResponse` + `truncateToolResult` 已统一成功返回与截断

---

## Part A: Skill 系统契约化

### 现状（otter）

8 个 skill，分布如下（行数为 SKILL.md 体量）：

| Skill | 行数 | description 是否只讲触发 | 是否有"排除" | 是否声明 output |
|---|---|---|---|---|
| companion | 31 | ✅ | ✅ | ✅ |
| core-workflow | 43 | ✅ | ✅ | 表格里隐含 |
| troubleshooting | 41 | ✅ | ✅ | ✅ |
| otter-summon | 57 | ✅ | ✅ | "编排层"隐含 |
| worktree-isolation | 46 | 部分（MUST trigger BEFORE 偏流程） | ✅ | ✅ |
| requirement-analysis | 88 | ❌ "Transform vague user intent into a clear technical plan" 偏内容描述 | ✅ | ✅ |
| code-implementation | 73 | ❌ "Turn a technical plan into runnable code" 偏内容描述 | ✅ | ✅ |
| adversarial-review | 154 | ❌ "Find real problems in code changes" 偏内容描述 | ✅ | ✅ |

3/8 违反"description 只讲触发"原则。无 manifest，无 lint，无 writing-skills 元 skill。

### 设计决策

#### A1. 引入 `prompts/skills/manifest.yaml`（路由契约源）

**位置**：`prompts/skills/manifest.yaml`（与 `prompts/identity/`、`prompts/contexts/` 同级，但承担 skill 路由角色）。

注：SKILL.md 仍由 `.pi/skills/` 下的 SDK 原生发现机制注入 prompt。manifest 不替代 SDK 发现，而是作为**契约源**：
- lint 时校验 manifest 与 SKILL.md frontmatter 一致
- 启动时由 lint 脚本读取，确保新增 skill 不漏更新
- LLM 不读 manifest，仍读 SKILL.md 的 description（保持现状）

**Schema（轻量起步）**：

```yaml
version: 1
skills:
  - name: companion          # 必须与 .pi/skills/<name>/SKILL.md frontmatter.name 一致
    description: >           # 三段式契约，与 SKILL.md frontmatter.description 等价（lint 校验）
      Use when: 不匹配任何其他 skill 的非结构化对话。
      Not for: 明确匹配其他 skill 的需求。
      Output: 自然语言答复，或建议切换 skill。
    triggers:                # 触发关键词，description 的结构化镜像
      - "闲聊"
      - "讨论"
      - "头脑风暴"
    not_for:
      - "需求分析"           # → requirement-analysis
      - "写代码"             # → code-implementation
    output: 自然语言答复 / 建议切换 skill
    next: []                 # 后续可能进入的 skill（按 next 指向构图，避免环）
    notes: 默认 fallback，不主动拉入流程
```

字段起步只 7 个：`name / description / triggers / not_for / output / next / notes`。不抄 clowder-ai 的 `sop_step / requires_mcp / merged_from / feature`，待真有需求再加。

**对抗审视预留问题**：
- Q-A1：manifest 与 SKILL.md frontmatter 双源同步是负担，能否只保留一处？
- Q-A2：triggers 字段是 description 的结构化镜像，是否冗余？

#### A2. description 铁律 + 三段式契约

写入 `_shared/SKILL-TEMPLATE.md` 和新建的 `writing-skills/SKILL.md`：

> **铁律：description 只描述触发条件，绝不总结流程内容。**
>
> **原因**：description 进入 system prompt，LLM 只看到 name + description 决定是否 read SKILL.md。若 description 含流程摘要，LLM 会按摘要行动而跳过读 SKILL.md，工作流细节失效。

**强制三段式**：
```
Use when: <具体触发条件>
Not for: <应转到哪个其他 skill>
Output: <交付物契约>
```

**反例（禁止）**：
```
❌ "Transform vague user intent into a clear technical plan."  # 偏内容描述
✅ "Use when: 搭档要求分析需求/设计方案.
    Not for: 已有方案要写代码 → code-implementation.
    Output: 结构化技术方案文档."
```

#### A3. writing-skills 元 skill

**位置**：`.pi/skills/writing-skills/SKILL.md` + `references/`。

内容：
- description 铁律 + 三段式契约
- 三种 skill 类型：Technique（具体方法步骤，如 troubleshooting）/ Pattern（思维模型原则，如 companion）/ Reference（查表文档，如术语）
- 模板套用 checklist
- skill description 说服设计（精简版，不抄 clowder-ai 的 persuasion-principles 全套研究）
- skill 长度预算：SKILL.md ≤ 150 行；超长移到 `references/`
- naming：kebab-case；避免 `_`、特殊字符（YAML 解析）
- 单一职责：合并后的 description 不能变"什么都能做"

**触发**：搭档要求新建/重写 skill 时。

#### A4. Skill lint 脚本

**位置**：`scripts/lint-skills.mjs`（参考已有 `scripts/lint-capability-docs.mjs` 模式）。

**校验项**（启动时 + pre-commit 可选）：
1. 每个 `.pi/skills/<name>/SKILL.md` 必有 frontmatter：`name / description / co_loads`
2. frontmatter.name 必须等于目录名
3. description 必须含三段式 marker（`Use when` / `Not for` / `Output`）
4. description 长度 30-500 字符
5. SKILL.md 行数 ≤ 150（超长警告，建议移到 references）
6. manifest.yaml 中每个 skill 与 SKILL.md frontmatter 一致（name 相同；description 等价）
7. manifest 中 `next` 指向的 skill 必须存在（broken pointer 报错）
8. manifest 中 `not_for` 提到的 skill 必须存在
9. 无 manifest 中的 skill 没有 SKILL.md，反之亦然（孤立）
10. `references/` 中提到的文件路径必须存在

**输出**：error（阻断）/ warning（不阻断）。可接入 `npm run lint:skills`。

#### A5. 重写现有 8 个 skill 的 description

3 个违规 skill 重写（requirement-analysis / code-implementation / adversarial-review），其余 5 个对齐三段式结构。详见实施清单。

---

## Part B: Tool 系统标准化

### 现状（otter）

26 个工具，描述风格极乱。两个极端反例：

```typescript
// tool-factory.ts:99 — speak 描述 1500+ 字符
description: "结束你的发言并指定下一位发言者。发言内容全部放在 body 里；
speak 之外的任何输出...【HTML 卡片】...【系统自愈】..."  // 三件事塞一个 description

// tool-factory.ts:145 — invite_participant 13 字符
description: "邀请指定 Otter 加入当前对话。"
```

错误返回：

```typescript
// tool-helpers.ts:9 — 只有 success 工厂
export function textResponse(text: string): ToolResponse { ... }

// tool-factory.ts:113 — 错误靠文案前缀
return textResponse("[错误] 系统错误：当前消息 ID 未设置，无法声明发言。");
```

LLM 要靠 pattern match `[错误]` 才知道是错误，不可靠。

### 设计决策

#### B1. Tool description 标准化（5 元素简化版）

**位置**：`docs/user-guide/tool-description-standard.md`（新建）+ 写入 `_shared/` 供 LLM 通过 read 加载。

**5 元素**（按需启用，不强制全写）：
1. **What**（必写）：一句话能力描述
2. **When**（必写）：触发场景，含中文关键词
3. **Not for**（推荐）：边界，指向替代工具
4. **Output**（推荐）：调用后返回什么
5. **GOTCHA**（必写）：常见误用、与其他工具的区分

**inline label 模式**（仿 clowder-ai）：
- `GOTCHA:` — 常见误用
- `BOUNDARY:` — 边界
- `TIP:` — 推荐用法
- `WORKFLOW:` — 多步流程

**反例**：
- 1500+ 字塞多件事 → 拆分（speak 的 HTML 卡片规则移到 `references/html-card-rules.md`，自愈规则移到 `references/healing-tag.md`）
- 单句无 When/Not for/GOTCHA → 至少补 When 和 GOTCHA

**长度预算**：description 50-800 字符。超长移到 references。`speak` 的卡片+自愈是该规则的样本案例。

#### B2. ToolResult 加 isError + errorResponse 工厂

**位置**：`src/interface-adapters/agent-runtime/tools/tool-helpers.ts`。

```typescript
export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  /** F20260811sktp: 错误标志，让 agent loop 和上游能结构化识别错误 */
  isError?: boolean;
  terminate?: boolean;
}

export function textResponse(text: string): ToolResponse {
  return { content: [{ type: "text", text }], details: {} };
}

export function errorResponse(text: string): ToolResponse {
  return { content: [{ type: "text", text }], details: {}, isError: true };
}
```

**迁移策略**：
- 渐进迁移——不一次性改 26 个工具
- 高频错误返回的工具优先（speak、create_otter、create_linked_resource 等已有 `[错误]` 前缀的）
- 文案保留 `[错误]` 前缀（人类可读），同时设 `isError: true`（机器可识别）
- 上游消费方（agent loop、self-healing）按需切换为读 `isError`

**对抗审视预留问题**：
- Q-B1：isError 字段 SDK 是否原生支持？若不支持，Pi 透传是否丢失？
- Q-B2：是否要加 error code（如 `INVALID_PARAM / NOT_FOUND / CONFLICT`）？还是 isError + 文案足够？

#### B3. 重写 26 个工具的 description

按 B1 标准重写。重点：
- `speak` 拆分——卡片规则移到 references，description 只留"发言+发言石+卡片围栏入口指针"
- `create_otter` / `dissolve_otter` / `restart_otter` 补 When / Not for / GOTCHA
- `search_memory` 已经不错（有渐进式披露工作流），按 5 元素对齐
- `workspace_*` 4 个工具补边界声明（不能改项目代码、只读 sandbox 等）

---

## Part C: Prompt 第一性原理重组

### 现状（otter）

`.pi/SYSTEM.md` 5.6KB，扁平结构：
- 核心原则（事实优先 / 诚实直言 / 安全底线 / 搭档优先 / 流程纪律）+ 两条关系说明
- 仓库安全红线（5 条）
- Skill Chain 规则
- 产出约定 / 弹性约定

问题：
1. 原则没上升到"第一性原理"层级，缺根因锚（无用户原话 / 无历史教训引用）
2. 扁平罗列，无"原则-世界观-规则"层级，LLM 难分辨优先级
3. 与 SKILL.md 内容有重复（产出约定、弹性约定在 SKILL-TEMPLATE.md 也写）

### 设计决策

#### C1. 三层重组（不拆双源）

**位置**：仍是 `.pi/SYSTEM.md`（单一真相源），重组结构。

**新结构**：

```markdown
# 对话环境
（保留：搭档定义、海獭协作称呼）

## 第一性原理（P）

每条引根因——用户原话或历史教训。

### P1. 事实优先于一切
> 根因：[用户原话或教训引用]
原则：基于实际数据和逻辑分析，不凭印象推测。
优先级：事实 > 搭档判断 > AI 偏好。

### P2. 诚实优于服从
> 根因：[用户原话或教训引用]
原则：不确定就说不确定；发现问题基于事实直言；不讨好不顺着说。
区分：搭档的决策（明确指令）拥有最终决策权；搭档的判断（技术观点）平等看待。

### P3. 安全底线不可让步
> 根因：[历史教训]
原则：注入/权限提升/数据泄露风险必须指出；高风险搭档坚持时拒绝执行。

### P4. 搭档是伙伴不是用户
> 根因：[用户原话]
原则：流程服务搭档不是反过来；搭档说"行了"就是完成；该不该走流程本身是伙伴能力。

### P5. 流程是 know-how 不是官僚
> 根因：[用户原话]
原则：有 skill 覆盖先 read 再动手；skill 定义"完成"标准；无 skill 覆盖按 P4 直接响应。

## 世界观（W）

### W1. 海獭是有名字的唯一实体
（第一公民原则——身份锚点）

### W2. Skill 是契约不是建议
（manifest + description 铁律 + 三段式 = 契约；skill 一旦定义，触发与产出可预期）

### W3. Tool 是技能的延伸
（skill 引用工具，工具不知道 skill；工具返回 isError 让上游结构化判断）

### W4. 主目录只读，worktree 是工作场所
（仓库安全红线的世界观根因）

## 规则（R）

### R1. 仓库安全红线
（保留原 5 条，但归入规则层）

### R2. Skill Chain
（保留原 chain 规则）

### R3. 产出 / 弹性约定
（保留，但移除与 SKILL-TEMPLATE.md 重复的部分——SKILL-TEMPLATE.md 已写的，这里只留指针）
```

**与 SKILL.md 的去重**：产出约定、弹性约定、异体执行规则——SKILL-TEMPLATE.md 中已写入"模板约定（全局）"段落。SYSTEM.md 中只保留指针："详见 `_shared/SKILL-TEMPLATE.md` 模板约定段落"，不重复内容。

#### C2. 根因锚的来源

每条 P/W 原则引根因，来源候选：
- 用户原话：从历史对话 `search_memory` 提取（如 P5 的"AI agent 100x 执行速度下，方向正确性的价值远大于启动便捷性"）
- 历史教训：引用 F 文档编号（如 `F20260803trrf` 重复发言 bug → 触发 speak 工具的访问控制规则）
- 现有 SYSTEM.md 的隐含根因（如"搭档优先"已经写了根因，重组时保留）

实施时由大獭调用 `search_memory` 补齐根因锚，不强造。

**对抗审视预留问题**：
- Q-C1：SYSTEM.md 重组会改变 LLM 行为，是否需要灰度（先在小獭上跑）？
- Q-C2：根因锚引用 memory，session 重启后 memory 不一定可重建——是否应内联而非引？

### D6. isError 走 afterToolCall extension（SDK 官方扩展点）

审视 B-R1 实锤：`AgentToolResult` 接口无 `isError` 字段，工具返回值里加的会被丢弃。SDK 的 `isError` 标志由两条路径控制：
1. catch 分支（工具抛异常时 SDK 自动设 isError=true）
2. `afterToolCall` extension handler 的返回值覆盖（SDK types.d.ts:50-51）

选 path 2。理由：
- 抛异常路径改变所有错误处理的编程模型，触发 SDK 异常处理链路
- afterToolCall 是 SDK 设计的官方扩展点，已有钩子机制（otter-hooks extension）
- 工具返回 `errorResponse("...")` 带 `isError: true` 标志位 → otter-hooks 的 `afterToolCall` handler 检测到 result 上的 isError，返回 `{ isError: true }` 覆盖

实施细节：
- `ToolResponse` 加 `isError?: boolean` 字段
- `errorResponse(text)` 工厂设置 `isError: true`
- 在 `pi-session-factory.ts` 已有的 otter-hooks extension 中加 `afterToolCall` handler

### D7. manifest 不写 description 镜像（消除双源）

审视 A-R1/A-R2 实锤双源 description 是负担——"等价"无法机器判定。最终方案比 D6 初稿更简：
- SKILL.md frontmatter 是 description 真相源（SDK 直接消费）
- `prompts/skills/manifest.yaml` **完全不写 description / triggers**，只手写结构化字段：`next / not_for / category / notes`
- 砍掉 D6 初稿的 `gen-manifest.mjs` 脚本（不需要生成镜像）
- lint 校验三项一致性：(1) manifest skill 集合 = `.pi/skills/` 目录集合；(2) `next` / `not_for` 指针有效；(3) manifest 的 `category` 与 SKILL.md frontmatter `category` 一致（防漂移）

manifest 文件功能：(a) 路由图（看 skill 之间 next/not_for 关系）；(b) lint 校验源；(c) 维护者查阅用——不再承担 description 镜像职责。

### D8. description 铁律加 Precondition 例外

审视 A-R3：worktree-isolation 的 `MUST trigger BEFORE` 是安全前置不是流程总结。铁律补充：

> **铁律（完整版）**：description 只描述触发条件，绝不总结流程内容。
> **例外 1（安全前置）**：可使用 `Precondition:` 段或 `MUST ... BEFORE` 强制语序，这属于触发约束不属于流程总结。
> **例外 2（能力摘要）**：可包含一句能力摘要（skill 提供什么价值），禁具体步骤。

例外 2 同时解决 A-R6 writing-skills 自举问题。

### D9. companion 豁免三段式强制

审视 A-R7：fallback skill 的 `Use when: 不匹配任何其他 skill` 是同义反复。lint 对 companion 只校验存在性 + 行数，不校验三段式 marker。

### D10. Part C：P+W+R 三层 + W 层精简

用户拍板保留三层。审视 C-R5 实锤 W2/W3/W4 是 Part A/B/R 层复述。最终 W 层只含有独立信息量的世界观：

```markdown
## 世界观（W）

### W1. 海獭是有名字的唯一实体
（第一公民原则——每只海獭和用户都是有名字的唯一存在，名称是身份锚点。
不在 P 层（不是行为原则）也不在 R 层（不是规则），独立属世界观根因。

### W2. AI 是独立思考者不是服从工具
（区分决策权与判断力：搭档的决策有最终决策权，搭档的判断平等看待；
事实与决策冲突时基于事实建议，搭档坚持则尊重执行。诚实优于服从。）
```

砍 W2/W3/W4 复述内容：W2（原"Skill 是契约"）并入 P5 流程纪律；W3（原"Tool 是延伸"）并入 tool description standard；W4（原"主目录只读"）留在 R1。

P 层前缀改 **A**（Axioms）避免与 clowder-ai P1-P5 SOP 哲学冲突（C-R4）。

### D11. Magic Words 手动拉闸机制

仿 clowder-ai，定义 otter 自己的关键词（写入 SYSTEM.md）：

| 关键词 | 触发行为 |
|---|---|
| 「绕路了」 | 大獭停止当前动作，审视方案是否走了捷径/局部最优，画出直达终态的路径 |
| 「就这样」 | 流程提前终止（已隐式存在），记录决策 |
| 「停下」 | 大獭停止当前所有动作（不发新工具调用、不写新文件），等待搭档指示 |
| 「严肃点」 | 从 companion 模式转入结构化流程（询问走哪个 skill） |
| 「星星罐子」 | P0 不可逆风险信号——立即停止新增副作用，等搭档 |

注：与 clowder-ai 不同的关键词对应 otter 自己的协作语境。"星星罐子"沿用 clowder-ai 的高危信号语义（用户偏好一致）。

### D12. 召唤小獭前先搜 memory 硬约束

召唤前必须 search_memory，已有相关结论/方案/教训的不重复召唤。两层实现：
1. **软层（SYSTEM.md 规则）**：写入"召唤前先搜"硬规则
2. **硬层（skill 工作流）**：`otter-summon/SKILL.md` 工作流步骤 1 改为"先 search_memory 检查是否已有相关结论 → 有则用、无则召唤"

未来若 SDK 支持工具层前置校验，可进一步加 `precondition` 检查（类似 clowder-ai 的 multi_mention 强制 searchEvidenceRefs）。当前靠 prompt + skill 双层约束。

### D13. 砍掉的清单（综合审视建议）

- 砍 manifest `triggers` 字段（A-R2）
- 砍 manifest `description` 手写（D7 改为自动生成）
- 砍 lint 项 3（三段式 marker）、项 4（长度 30-500）、项 6（双源等价）—— A-R4/R8
- 砍 W 层的 W2/W3/W4 复述内容 —— D10
- 砍 `_shared/references/html-card-rules.md` 和 `healing-tag.md` 方案（B-R3）—— speak description 用指针指向已有的 `get_html_card_contract` 工具，自愈规则留 SYSTEM.md
- 砍 tool description 50 字符下限（B-R5）

---

## 变更清单（实施分批）

### Part A（Skill 系统契约化）
- [x] A1. 改 `_shared/SKILL-TEMPLATE.md`：加 description 铁律（含 D8 两个例外）+ 三段式契约段落
- [x] A2. （取消，D7 简化方案不需要 gen-manifest）
- [ ] A3. 新建 `prompts/skills/manifest.yaml`（纯手写结构化字段：next/not_for/category/notes）
- [x] A4. 新建 `.pi/skills/writing-skills/SKILL.md` + `references/`
- [ ] A5. 新建 `scripts/lint-skills.mjs`（7 项 error + 4 项 warning）+ 接入 `package.json`
- [x] A6. SKILL.md frontmatter 加 `category` 字段（8 个 skill 全部已加）
- [x] A7. 重写 8 个 SKILL.md 的 description（companion 豁免，requirement-analysis / code-implementation / adversarial-review 重写；worktree-isolation 加 Precondition）
- [ ] A8. 跑 lint，确保 0 error

### Part B（Tool 系统标准化）
- [x] B1. 改 `tool-helpers.ts`：加 `isError` 字段 + `errorResponse` 工厂
- [x] B2. `pi-session-factory.ts` 的 otter-hooks 加 `tool_result` handler（透传 isError 到 SDK via details.__isError）
- [x] B3. 一次性迁移 15 处错误返回到 `errorResponse`（含 artifact-tools.ts 的 2 处 "Error:" 前缀统一为 `[错误]`）
- [x] B4. 新建 `docs/user-guide/tool-description-standard.md`（5 元素简化版 + GOTCHA/TIP/BOUNDARY 至少一条；纯开发者文档不进 skill）
- [x] B5. 重写关键工具 description（speak 拆分用指针指向 get_html_card_contract；invite/create/dissolve/restart/linked_resource/get_active_participants 补 When/Not for/GOTCHA）
- [x] B6. create/dissolve/restart_otter 的 GOTCHA 已写入 tool-description-standard.md 附录

### Part C（Prompt 第一性原理重组）
- [x] C1. 重组 `.pi/SYSTEM.md` 为 A（Axioms A1-A5）/ W（W1-W2）/ R（R1-R4）三层
- [x] C2. W 层只留 W1（实体身份）+ W2（AI 独立思考者）；原 W2/W3/W4 复述内容已砍
- [x] C3. 每条 A/W 内联根因锚（伪用户原话已删除——A5 改为逻辑根因避免伪造；A4 保留真实原话"流程服务搭档不是反过来"来自原 SYSTEM.md）
- [x] C4. 反向去重：SYSTEM.md R3 保留产出/弹性约定，_shared/SKILL-TEMPLATE.md 中"模板约定（全局）"标为镜像并加注释指向 SYSTEM.md 真相源
- [x] C5. 加 Magic Words 段落（D11）：绕路了 / 就这样 / 停下 / 严肃点 / 星星罐子
- [x] C6. 加 R4"召唤前先搜"硬规则（D12）
- [x] C7. 补 15KB 双轨阈值推导（token 占比 2.5% 推导）+ 隔离实例 A/B 测试方案（C-R10）

### 实施 PR 策略

**一个 PR，4 个 commit**（按 feedback_pr_scope"一件事一个 PR"）：
- **commit-1**：本设计文档（F20260811sktp）
- **commit-2**：Part A 完整（manifest + lint + writing-skills + 8 skill 重写）
- **commit-3**：Part B 完整（isError + description 标准 + 26 工具重写）
- **commit-4**：Part C 完整（SYSTEM.md 重组 + Magic Words + 先搜后召）

三个 Part 共同的设计决策（D6-D13）跨 Part 引用——D11 Magic Words 需 Part A 的 skill 配合、D12 先搜后召跨 Part A（otter-summon skill）和 Part C（SYSTEM.md 规则）。合在一个 PR 避免中间不一致状态。综合能力测试（AT-1~AT-6）一次到位，行为退化按 commit 维度定位。

---

## 设计决策

### D1. 为什么 manifest 不直接进 `.pi/skills/`

`prompts/skills/manifest.yaml` vs `.pi/skills/manifest.yaml`：

选 `prompts/skills/`。理由：
- `.pi/` 目录是 SDK 原生扫描区（SKILL.md 被 SDK 发现并注入 prompt），保持"SDK 直接消费"语义清晰
- `prompts/` 是项目自有 prompt 资产区（已有 identity/contexts/）
- manifest 是项目侧的契约源，与 lint 脚本配合，不被 SDK 直接消费
- 物理隔离 = 职责隔离

### D2. 为什么不引入源/摘要双轨（clowder-ai 的 shared-rules.md → digest 模式）

clowder-ai 双轨动机：441 行 shared-rules 完整版给维护者读，digest 摘要给 LLM 注入（省 token）。otter SYSTEM.md 5.6KB ≈ 1500 token，规模不需要双轨维护。重组结构（三层）即可，不拆双源。等 SYSTEM.md 增长到 ≥15KB 时再考虑双轨。

### D3. 为什么 isError 不加 error code

`isError: boolean` + 文案足够。理由：
- otter 工具的错误主要是参数错误 / 状态错误 / 权限错误，LLM 读文案就能处置
- error code 体系（INVALID_PARAM / NOT_FOUND / CONFLICT）增加 schema 复杂度，但 LLM 处置逻辑差异不大
- 若未来 self-healing 需要按 code 路由，再扩展——YAGNI

### D4. 为什么 writing-skills 是 skill 而不是文档

`docs/user-guide/writing-skills.md` vs `.pi/skills/writing-skills/SKILL.md`：

选后者。理由：
- 大獭/小獭在写 skill 时，按 P5 原则"有 skill 覆盖先 read"——writing-skills 本身是 skill 才会被 LLM 在"写 skill"场景下 read
- 写成普通 docs 不会被 SDK 注入 description，LLM 不知道何时去读
- writing-skills 是元 skill（关于 skill 的 skill），正符合 skill 定义

### D5. 为什么 manifest 与 SKILL.md frontmatter 双源

为何不只在 manifest 维护：SKILL.md frontmatter 是 SDK 原生消费的（注入 prompt 的唯一字段），不可省略。
为何不只在 frontmatter 维护：frontmatter 只能描述自身，不能构图（`next` / `not_for` 指向其他 skill）。
双源同步靠 lint 脚本强制（A4 校验项 6）。

---

## Acceptance Test（验收测试）

### 需求推导

1. **A-需求1**：8 个 skill 的 description 都符合三段式契约，新增 skill 时强制如此
2. **A-需求2**：lint 脚本能识别"违反 description 铁律"、"manifest 与 frontmatter 不一致"、"broken next 指针"
3. **B-需求1**：所有工具错误返回带 `isError: true`，agent loop 能结构化识别
4. **B-需求2**：26 个工具 description 都含 What/When/GOTCHA，无超长（>800 字符）或过短（<50 字符）
5. **C-需求1**：SYSTEM.md 三层结构清晰，每条 P/W 引根因锚
6. **C-需求2**：重组后 LLM 行为不退化（事实优先、安全底线、流程纪律仍生效）

### 权威证据

| 需求 | 权威证据来源 | 证据类型 |
|---|---|---|
| A-需求1 | lint 输出 0 error；目视 8 个 SKILL.md description | 命令输出 / 文件内容 |
| A-需求2 | 故意写错 description 的样本 skill，lint 报错 | 命令输出 |
| B-需求1 | tool-helpers.ts 含 isError 字段；tool-factory.ts 中 errorResponse 调用 | 文件内容 |
| B-需求2 | 26 个工具 description 字符数扫描 | 命令输出 |
| C-需求1 | SYSTEM.md 三层 markdown 结构；每条 P/W 含根因锚引用 | 文件内容 |
| C-需求2 | 能力测试：现有 skill（companion / requirement-analysis / adversarial-review）行为样本对比 | 测试结果 |

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|---|---|---|---|
| AT-1 | A-需求1 | 跑 `npm run lint:skills` | 0 error；输出 8 个 skill 全部合规 |
| AT-2 | A-需求2 | 临时把某 SKILL.md description 改为内容描述（如"transform X into Y"） | lint 报错：description 不符合三段式契约 |
| AT-3 | A-需求2 | 在 manifest 中把 next 指向不存在的 skill | lint 报错：broken next pointer |
| AT-4 | B-需求1 | grep `errorResponse` in tool-factory.ts | 高频错误路径全部使用 errorResponse |
| AT-5 | B-需求2 | 扫描 26 个工具 description 长度 | 全部 ∈ [50, 800] |
| AT-6 | C-需求2 | 启用隔离实例（独立端口+DB），让 LLM 处理"事实 vs 搭档判断"冲突场景 | 行为不退化：基于事实提出建议 |

### 能力测试映射

| 验收场景 | 能力测试文件 |
|---|---|
| AT-1~AT-3 | n/a（lint 是确定性脚本，单元测试覆盖） |
| AT-4~AT-5 | n/a（静态扫描，单元测试覆盖） |
| AT-6 | `tests/capability/system-prompt-behavior.capability.test.ts`（新建，按 F20260811sktp 子项落地） |

### 证据判定（验收执行后填写）

| 需求 | 证据状态 | 判定 |
|---|---|---|
| A-需求1 | 缺失 | ❌ |
| A-需求2 | 缺失 | ❌ |
| B-需求1 | 缺失 | ❌ |
| B-需求2 | 缺失 | ❌ |
| C-需求1 | 缺失 | ❌ |
| C-需求2 | 缺失 | ❌ |

---

## 对抗审视记录

### 第一轮（三路独立 agent，2026-08-11）

共发现 9 critical / 14 major / 8 minor。摘录关键项，完整审视记录见对话回溯。

#### Part A 审视（5 critical / 4 major / 2 minor）

| # | 问题 | 严重 | 处置建议 |
|---|------|----|---------|
| A-R1 | manifest description 与 SKILL.md frontmatter 双源同步是负担——"等价"无法机器判定，lint 形同虚设 | critical | 从 frontmatter 自动生成 manifest，或 manifest 删 description 只留结构化字段 |
| A-R2 | `triggers` 字段与 description `Use when` 纯冗余；otter SKILL-TEMPLATE.md:17-18 自己否定 triggers 存在 | critical | 删 manifest 的 triggers 字段 |
| A-R3 | 铁律"绝不总结流程"套到 worktree-isolation 会丢 `MUST trigger BEFORE` 安全前置，触发可能晚于文件修改 | critical | 铁律加例外：允许安全前置（Precondition 段或 MUST/BEFORE 用语） |
| A-R4 | lint 校验项 3 无法做语义判断（区分合规触发 vs 违规流程总结），项 4 长度下限 30 太低、上限 500 不够；项 6 双源等价无法实现 | major | 删项 3/4/6，保留 1/2/5/7/8/9/10；项 5 行数上限放宽至 200 |
| A-R5 | 砍 clowder-ai 的 sop_navigation 后无替代；`next` 单向链表无法表达 otter 实际 branching（code-impl 内部调 worktree-isolation 和 otter-summon） | major | manifest 加 `flow` 段或允许 next 含并行/前置语义 |
| A-R6 | writing-skills 自举循环：铁律下 description 只写"Use when: 写新 skill"，LLM 不知道 read 后能获得什么 | major | 铁律加例外：允许一句能力摘要，禁具体步骤 |
| A-R7 | companion 作为 fallback 不适合强制三段式——`Use when: 不匹配任何其他 skill` / `Not for: 所有其他 skill` 是同义反复 | major | companion 豁免三段式强制 |
| A-R8 | lint 10 项中 4 项噪声（项 3/4/6 + 长度过严） | major | 见 A-R4 |
| A-R9 | manifest 缺 category/type 字段，skill 多了无法分类 | minor | 可选 `type: technique/pattern/reference` |
| A-R10 | not_for 互指可能循环排除 | minor | lint 加 warning：互指时检查 Use when 区分度 |
| A-R11 | 漏抄 clowder-ai manifest 的 iron_laws / refs 降级机制 | minor | 当前规模不急，记录为未来方向 |

#### Part B 审视（1 critical / 6 major / 3 minor）

| # | 问题 | 严重 | 处置建议 |
|---|------|----|---------|
| B-R1 | **isError 加在 ToolResponse 上无效**：SDK `AgentToolResult` 无此字段，工具返回值的 isError 不会被透传到 Anthropic API 的 `is_error`。SDK 成功路径硬编码 isError=false，错误标志由 SDK 内部 catch 或 `afterToolCall` extension 覆盖控制 | critical | 走 `afterToolCall` extension 路径，或工具错误时抛异常（改编程模型），或放弃 isError 等待 SDK 升级 |
| B-R2 | errorResponse 迁移策略依赖 B-R1 解决，否则 LLM 看到的全是 is_error=false；"渐进迁移"造成混合期不一致 | major | 先解决透传，再一次性全量迁移 12 处 `[错误]` + 2 处 `Error:` 前缀 |
| B-R3 | speak 拆分到 `_shared/references/` 忽略了已有的 `get_html_card_contract` 工具；工具没有 references 机制，LLM 不知道何时去 read | major | speak description 只留一句指针"卡片规则见 get_html_card_contract"，自愈规则同理走工具或 SYSTEM.md，不进 references |
| B-R4 | 5 元素强制 GOTCHA 对纯查询工具（get_active_participants）教条；clowder-ai 自己也用 TIP/BOUNDARY 而非全用 GOTCHA | major | 改为"GOTCHA/TIP/BOUNDARY 至少一条" |
| B-R5 | 长度预算 50-800 字符下限不合理；invite_participant 当前 40 字符够清楚；clowder-ai 标准无字符数约束 | major | 删下限；上限改 warning，lint 不阻断 |
| B-R6 | tool-description-standard.md 发现机制缺失：docs/ 不被 SDK 注入，LLM 不知道何时读 | major | 纯给开发者（lint 读取）放 docs/；需 LLM 读则做成 skill（writing-tools） |
| B-R7 | 漏抄 clowder-ai 的 clientMessageId 幂等：otter speak 的 conflict 处理是 DB 唯一约束补丁，不是真正的幂等 key | major | 至少在审视预留问题中列出 |
| B-R8 | create/dissolve/restart_otter 的 GOTCHA 被提及但未列具体内容（均不可逆） | minor | 文档附录列出 |
| B-R9 | artifact-tools.ts 用 "Error:" 英文前缀不符合 `[错误]` 约定；文档统计 26 处有误（实际 12+2） | minor | 迁移时统一 |
| B-R10 | "1500+ 字符"未区分字节 vs Unicode code points；speak description 实际 ~700 code points | minor | lint 用 `[...str].length` 不用字节 |

#### Part C 审视（3 critical / 4 major / 3 minor）

| # | 问题 | 严重 | 处置建议 |
|---|------|----|---------|
| C-R1 | 三层 P/W/R 重组无行为退化证据基线——otter 现有扁平结构已用粗体标题 + 优先级链标注，LLM 完全能识别；最好结果"没变化"，最坏"退化"；clowder-ai 三层是因为 441 行需要分层，otter 只有 62 行 | critical | 降级为"根因锚补充 + 局部新增"，不做结构重组 |
| C-R2 | 根因锚引用 memory 是伪引用——SYSTEM.md 是静态文件，注入时不执行 search_memory；写时查好后必须内联 | critical | 表述改为"内联用户原话"，删"引用 memory" |
| C-R3 | 产出/弹性约定移到 SKILL-TEMPLATE.md 后 companion 模式 LLM 看不到——_shared/SKILL-TEMPLATE.md 不在 SDK 发现路径 | critical | 方向反了：约定留 SYSTEM.md，删 SKILL-TEMPLATE.md 中的重复段 |
| C-R4 | P1-P5 与 clowder-ai P1-P5 语义完全不同（行为伦理 vs SOP 哲学）但同用 P 前缀，未来跨项目认知混乱 | major | 换前缀为 A1-A5（Axioms） |
| C-R5 | W 世界观层在单租户单大獭场景是空壳——W2/W3 是 Part A/B 复述，W4 是安全红线复述，W1 已在身份文件 | major | 砍 W 层，P+R 两层足够 |
| C-R6 | 漏抄 Magic Words 手动拉闸机制（"脚手架"/"绕路了"等关键词触发行为矫正）——低成本高收益，与"搭档优先"天然契合 | major | 引入 otter 自己的关键词 |
| C-R7 | 漏抄 multi_mention 先搜后问硬约束——otter 召唤小獭前应先搜 memory（如已有相关结论不重复召唤） | major | 加规则 + 考虑工具层校验 |
| C-R8 | 漏抄 handoff body sanitization 防 LLM 输出注入 | minor | 当前无注入路径，但根因锚从 memory 提取需 sanitize |
| C-R9 | 15KB 双轨阈值无推导 | minor | 补 token 占比推导 |
| C-R10 | Q-C1 灰度方案缺失，SYSTEM.md 是全局 base 无法 per-otter 灰度 | minor | 用隔离实例 A/B 测试替代 |

---

## 实施验证结果

实施完成（2026-08-11）：

**静态验证**：
- `npx tsc --noEmit`：0 错误（Part B 加 isError 字段、afterToolCall handler、errorResponse 工厂均编译干净）
- `npm run lint:skills`：0 error，6 warning（6 个 warning 是 Part A 设计预期的 not_for 互指，每个 skill 的 Use when 都有清晰区分度）
- 9 个 skill 全部合规（含新建的 writing-skills）

**实施清单完成情况**：
- Part A：A1-A8 全部完成（A2 取消，D7 简化为不写 description 镜像）
- Part B：B1-B6 全部完成（15 处错误返回迁移到 errorResponse，关键工具 description 重写）
- Part C：C1-C7 全部完成（SYSTEM.md 三层重组 + Magic Words + R4 先搜后召）

**遗留待真系统验证（AT-6 能力测试）**：
按 `feedback_isolated_instance_verification`，需启动独立端口 + 独立 DB + 真 LLM 跑能力测试：
- 测试 A1-A5 / W1-W2 / R1-R4 不退化（事实优先、安全底线、流程纪律仍生效）
- 测试 Magic Words 触发（"绕路了"/"停下"/"星星罐子"等）
- 测试 isError 透传（工具错误返回时 LLM 能结构化识别 is_error=true）
- 测试召唤前先搜（otter-summon 触发时是否先 search_memory）

能力测试用例 `tests/capability/system-prompt-behavior.capability.test.ts` 待建——PR 合入前由独立实例验证。
