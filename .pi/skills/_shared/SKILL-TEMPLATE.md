# SKILL.md 模板

## 设计原则

一个 skill 只回答 5 个问题：何时触发、需要什么输入、如何做、产出什么、之后交给谁。
其余内容（过程纪律、弹性规则、异体执行）是全局约定，在 SYSTEM.md 中定义，不在 skill 中重复。

## 触发机制说明

Skill 的触发由 pi-coding-agent SDK 驱动：
1. SDK 扫描 `.pi/skills/` 目录，找到所有 SKILL.md
2. 提取 frontmatter 中的 `name` 和 `description`
3. 格式化为 XML 注入 system prompt（LLM 只看到 name + description）
4. LLM 读 description，自行判断任务是否匹配
5. 匹配时用 `read` 工具加载 SKILL.md 全文

description 是触发的唯一控制字段。写好 description = 写好触发条件。
不需要额外的 triggers 字段。

## description 铁律（F20260811sktp）

> **铁律：description 只描述触发条件，绝不总结流程内容。**

**原因**：description 进入 system prompt，LLM 只看到 name + description 决定是否 read SKILL.md。若 description 含流程摘要，LLM 会按摘要行动而跳过读 SKILL.md，工作流细节失效。

**例外 1（安全前置）**：可使用 `Precondition:` 段或 `MUST ... BEFORE` 强制语序约束——这属于触发条件，不属于流程总结。
- 例：worktree-isolation 的 description 可写 `Precondition: MUST trigger BEFORE modifying or committing any git-tracked file.`

**例外 2（能力摘要）**：可包含一句能力摘要（skill 提供什么价值），禁具体步骤。
- 例：writing-skills 的 description 可写"创建或修改 otter skill 的元技能（含铁律、三段式、模板）"——这是能力摘要
- 反例：禁写"通过 8 步流程产出 SKILL.md + manifest + lint 校验"——这是流程总结

## 三段式契约

description 必须按三段式结构：

```
Use when: <具体触发条件>
Not for: <应转到哪个其他 skill>
Output: <交付物契约>
```

**反例（禁止）**：

```
❌ "Transform vague user intent into a clear technical plan."
   # 偏内容描述，LLM 看不到触发条件
```

**正例**：

```
✅ Use when: 搭档要求分析需求/设计方案/做技术方案.
   Not for: 已有方案要求写代码 → code-implementation. 闲聊讨论 → companion.
   Output: 结构化技术方案文档（按产出模板）.
```

**fallback skill 豁免**：companion 作为默认 fallback，其 `Use when: 不匹配任何其他 skill` 与 `Not for: 所有其他 skill` 是同义反复。lint 对 companion 豁免三段式 marker 校验。

## 模板

```markdown
---
name: skill-name
description: >-
  Use when: <触发条件>.
  Not for: <转到其他 skill>.
  Output: <交付物>.
co_loads: []
category: technique   # technique（方法步骤）/ pattern（思维原则）/ reference（查表文档）
---

# Skill 标题

一句话定位（含一句能力摘要——见铁律例外 2）。

## 触发（可选，仅当 description 三段式不够清晰时展开）

**触发条件**：什么场景下使用这个 skill。
**Precondition**：如有安全前置约束（MUST/BEFORE），写在这里。
**排除**：哪些场景不该用这个 skill（应转到其他 skill 或 companion）。

**输入**：
| 输入 | 必选 | 缺失时 |
|------|------|--------|
| xxx  | 是   | 停下来问搭档 |

## 工作流

1. **步骤名**：做什么，关键约束内联。
2. **步骤名**：做什么，关键约束内联。
3. ...

> 约束（如果有的话）直接写在对应步骤里，不单独开"Behavioral Rules"段落。

## 产出

| 产出 | 下一步 | 执行者 |
|------|--------|--------|
| xxx  | yyy    | zzz    |

## 参考

- `path/to/file.md` — 说明
```

## category 字段（F20260811sktp）

frontmatter 必填字段：`name / description / co_loads / category`。

| category 值 | 含义 | 例 |
|---|---|---|
| `technique` | 具体方法步骤，按工作流执行 | troubleshooting / code-implementation |
| `pattern` | 思维模型原则，无固定步骤 | companion |
| `reference` | 查表文档，给 LLM 在工作中查阅 | （暂无，未来如术语库 skill） |

`category` 由 lint 读取，自动同步到 manifest.yaml；SDK 不消费此字段（[key: string]: unknown 容忍）。

## 模板约定（全局，不在各 skill 中重复）

> 这些约定同时写入 `.pi/SYSTEM.md`（companion 模式下 LLM 也看得到）。本段是双源校验源——若 SYSTEM.md 改动，这里同步。

### 输入约定

- 每个 skill 的"输入"表列出该 skill 特有的输入要求
- 缺失时的处理策略：必选输入缺失 → 停下来问搭档；可选输入缺失 → 从上下文推断或跳过

### 产出约定

- 每个 skill 的"产出"表定义该 skill 的交付物和后续动作
- "执行者"列可以是：当前獭、检视獭（异体）、搭档、-
- 异体执行规则：审视类动作的执行者不得是实现者，单 agent 场景下降级为搭档确认
- 搭档不在场 → 记录状态到 memory，不阻塞

### 弹性约定

- 搭档说"行了"/"就这样" → 流程可提前终止，记录决策
- 搭档说"跳过审视" → 显式决策，记录后放行
- 安全红线不可弹性，但搭档可以喊停任何流程（记录决策后放行）

### 特性文档

特性文档（`docs/features/` 下的 markdown 文件）是特性开发的全流程载体，贯穿探索、分析、设计、实现、审视等各阶段。

- **位置**：特性文档在 worktree 中（`<worktree>/docs/features/<yyyy>/<mm>/<dd>/F<date><id>-<title>.md`），随代码一起提交到 PR
- **协调**：首次写入时用 `create_linked_resource(type: "file", groupId: "<特性ID>")` 注册（groupId 可选），所有参与者通过 `list_artifacts` 发现并追加
- **时机**：当有需要记录的内容时就记录——各 skill 中的「写入特性文档」步骤是建议性的（"当有内容需要记录时"），不是强制检查点
- **角色**：任何参与者（大獭/小獭）都可以创建和更新特性文档，无角色约束
- **格式**：参考 worktree 中的 `docs/features/` 下已有文档的 frontmatter 格式（id、title、doc_type、summary、causal_links、status、change_type、tags、modules、created_at、created_in_conversation）
- **入库与关系**（F20260813mrel）：写完/改完文档后调 `sync_docs` 立即入库（否则要等系统重启才可被 search_memory 检索）；并用 `link_memory` 声明关系——典型是"当前讨论 produced 本文档"（from=当前对话中的关键消息 entry，to=文档 summary entry），让"这文档怎么来的"可被 get_related 拼出链。`created_in_conversation` 填当前对话 ID（身份注入中有）。

## 当前 skill 到模板的映射

| 当前段落 | 去向 |
|----------|------|
| Core Principles | 并入工作流步骤的约束 |
| 输入契约 | 简化为"触发"下的"输入"表 |
| Behavioral Rules | 并入工作流步骤的约束 |
| 问题处理决策树 | 并入工作流步骤的分支 |
| 后续动作声明 | 简化为"产出"表 |
| 异体执行原则 | 提到 SYSTEM.md 产出约定 |
| 弹性完成规则 | 提到 SYSTEM.md 弹性约定 |
| Additional Resources | 简化为"参考" |
