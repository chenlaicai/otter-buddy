---
id: F20260810ka23
title: F20260810ka23-skill-refactor
summary: "Skill 系统结构优化：消除双向 co_loads、提取共享内容到 _shared/、拆分 core-workflow 为查询+排查、收紧触发短语消除跨 skill 重叠"
status: development
created: 2026-08-10
---

# Skill 系统结构优化

## 背景

当前 `.pi/skills/` 下 7 个 skill 存在以下结构性问题：

1. **双向 co_loads 死循环**：worktree-isolation ↔ code-implementation 互相 co_loads，触发短语重叠（"改一下"同时匹配两者），LLM 无法可靠仲裁入口
2. **内容大量重复**：署名约定、对抗审视协议在 3-4 个 skill 中复制粘贴，~2000 tokens 浪费 + 同步风险
3. **core-workflow 边界过宽**：覆盖信息查询、问题排查、产出记录三件不相关的事，触发短语太泛
4. **触发短语重叠**：otter-summon 与 requirement-analysis、worktree-isolation 与 code-implementation 存在冲突

## 目标

- T1: 消除双向 co_loads，每个 skill 有明确的单向依赖链
- T2: 提取真正一致的重复内容到 `_shared/`，各 skill 引用而非复制
- T3: 收紧触发短语，消除 skill 间重叠
- T4: 拆分 core-workflow 的三个职责
- T5: 将 code-implementation step 8 的内联审视协议提取为引用

## 非目标

- 不改变 skill 的业务逻辑和审查标准
- 不改变 SYSTEM.md 的核心原则（只追加全局约束）
- 不新增与现有 skill 职能重叠的 skill（troubleshooting 是从 core-workflow 拆分，非全新职能）
- 不改变 Pi SDK runtime 的 skill 加载机制
- 不提取各 skill 特有的弹性完成规则和异体执行原则（这些是针对各 skill 定制的，提取会丢失上下文）

## 方案设计

### 1. 提取共享内容到 `_shared/`

创建 `.pi/skills/_shared/` 目录，存放跨 skill 复用的协议：

| 文件 | 来源 | 引用方 |
|------|------|--------|
| `signature-convention.md` | worktree-isolation + code-implementation 中的"海獭署名约定" | worktree-isolation, code-implementation |
| `review-protocol.md` | code-implementation step 8 + requirement-analysis step 6 中的对抗审视协议 | code-implementation, requirement-analysis |

**不提取的内容**（保留各 skill 内）：
- 弹性完成规则：各 skill 的弹性边界不同（worktree-isolation 红线不可弹性 vs companion 无流程），提取会丢失上下文
- 异体执行原则：与各 skill 的审视环节强耦合，保留在原位更清晰

**加载机制**：各 skill 在"Additional Resources"中显式列出 `_shared/` 文件路径，LLM 在执行对应步骤前 read 该文件。

各 skill 中删除对应重复段落，替换为引用：
```
> 署名约定见 `_shared/signature-convention.md`
```

### 2. 消除双向 co_loads

**根因**：worktree-isolation 同时承担"安全红线层"和"小改动流程"两个职责。

**方案**：将 worktree-isolation 的 5 条红线提取到 SYSTEM.md 的"流程纪律"段落后，作为全局约束：

```markdown
### 仓库安全红线

以下红线适用于一切改动 git 追踪文件的操作，无论大小：

1. **主目录零改动**：所有文件修改必须发生在 worktree 里。主目录只允许只读操作
2. **禁止直接提交到 main**（及 develop / 生产分支）：一律先建 feature 分支
3. **PR-only 交付**：改动以 PR 交付，写代码的人不合自己的 PR
4. **禁止破坏性 git 操作**：`git branch -D`、`git reset --hard`、`git push --force` 等需搭档同意
5. **commit message 一次写对**：提交前先读仓库的提交模板
```

**调整 co_loads**：
- `worktree-isolation`：`co_loads: []`（不再 co_loads code-implementation，只负责 worktree 创建流程）
- `code-implementation`：`co_loads: []`（不再 co_loads worktree-isolation，红线已在 SYSTEM.md 中全局生效）

**调整触发短语**：
- `worktree-isolation`：保留 worktree 相关短语，移除"改一下"等过泛短语
- `code-implementation`：保留实现相关短语

### 3. 拆分 core-workflow

当前 core-workflow 覆盖三件事，拆为两个 skill：

**保留 `core-workflow`**：只负责信息查询 + 产出记录
- 触发短语：收紧为"查一下"、"帮我查"、"看看之前的"、"搜索"、"记录一下"
- 移除排查流程（转入新 skill）

**新增 `troubleshooting`**：负责问题排查
- 触发短语："排查"、"分析问题"、"看看日志"、"查数据库"
- 包含排查流程 + 排查中修改文件时转入 worktree 流程（红线已在 SYSTEM.md 全局生效，无需 co_loads）

### 4. 收紧触发短语

| Skill | 当前问题 | 调整 |
|-------|---------|------|
| worktree-isolation | "改一下"过泛 | 移除泛化短语，保留"提交"、"提个 PR"、"commit"、"push"、"merge"、"把这个改动提交了" |
| otter-summon | 与 requirement-analysis 重叠 | 移除"帮我分析一下这个需求"、"做个技术方案"，保留明确的召唤/协作类短语 |
| core-workflow | 与 companion 重叠 | 收紧为查询类短语，移除排查类短语 |
| troubleshooting | 新 skill | 接收排查类短语："排查"、"分析问题"、"看看日志"、"查数据库" |

### 5. 提取 step 8 为引用

code-implementation 的 step 8（PR 对抗审视）有 5 个子步骤、~800 tokens。提取到 `_shared/review-protocol.md`，step 8 改为：

```markdown
### 8. PR 对抗审视

按 `_shared/review-protocol.md` 中的"代码 PR 审视协议"执行。
```

requirement-analysis 的 step 6 同理，引用 `_shared/review-protocol.md` 中的"方案审视协议"。

## 影响范围

- `.pi/SYSTEM.md`：追加"仓库安全红线"段落
- `.pi/skills/_shared/`：新增 2 个共享文件
- `.pi/skills/worktree-isolation/SKILL.md`：删除重复内容，收紧触发短语，移除 co_loads
- `.pi/skills/code-implementation/SKILL.md`：删除重复内容，step 8 改为引用
- `.pi/skills/requirement-analysis/SKILL.md`：step 6 改为引用
- `.pi/skills/core-workflow/SKILL.md`：拆分，只保留查询+记录
- `.pi/skills/troubleshooting/SKILL.md`：新增，接收排查流程
- `.pi/skills/otter-summon/SKILL.md`：收紧触发短语

## 风险与约束

| 风险 | 影响 | 缓解 |
|------|------|------|
| _shared/ 文件未被 LLM 主动加载 | 引用内容被忽略 | 在各 skill 的 Additional Resources 中显式列出，LLM 按流程纪律"先 read skill 再动手" |
| core-workflow 拆分后排查类任务漏路由 | 触发短语调整后需 LLM 重新学习 | troubleshooting 的触发短语从 core-workflow 原有短语中继承 |
| 消除 co_loads 后 skill 间依赖变隐式 | LLM 可能忘记加载相关 skill | SYSTEM.md 的全局红线确保安全约束始终生效；skill 间流转通过"后续动作声明"显式声明 |

## 不兼容更新

- `[Incompatible]` worktree-isolation 的 co_loads 从 `[code-implementation]` 改为 `[]`，依赖 SYSTEM.md 全局约束
- `[Incompatible]` code-implementation 的 co_loads 从 `[worktree-isolation]` 改为 `[]`
- `[Incompatible]` core-workflow 的排查流程移至 troubleshooting skill，原有排查类触发短语不再匹配 core-workflow

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| 红线放在哪里 | SYSTEM.md 全局约束 | 独立 skill | 红线不是流程，不需要 skill 的输入契约和工作流结构 |
| _shared/ 用引用还是内联 | 引用（文件路径） | 内联（复制到每个 skill） | 消除同步风险；虽然需要额外 read 调用，但 skill 文件本身更精简 |
| core-workflow 拆还是不拆 | 拆为 core-workflow + troubleshooting | 保持现状，收紧触发短语 | 查询和排查的心智模型不同，拆分后 LLM 路由更准确 |
| 弹性规则是否提取 | 不提取，保留在各 skill 内 | 提取到 _shared/ | 各 skill 的弹性边界是定制的，提取会丢失上下文 |

## 验收标准

- [ ] SYSTEM.md 包含"仓库安全红线"段落
- [ ] `_shared/` 下有 2 个文件（signature-convention.md, review-protocol.md）
- [ ] worktree-isolation 的 co_loads 为空，触发短语无重叠
- [ ] code-implementation 的 co_loads 为空，step 8 引用 `_shared/review-protocol.md`
- [ ] requirement-analysis 的 step 6 引用 `_shared/review-protocol.md`
- [ ] core-workflow 不含排查流程
- [ ] troubleshooting skill 存在且包含排查流程
- [ ] 所有 skill 的触发短语无跨 skill 重叠
- [ ] 各 skill 的署名约定和审视协议已替换为引用
- [ ] 弹性完成规则和异体执行原则保留在各 skill 内（未提取）

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `.pi/SYSTEM.md` | 修改 | 追加"仓库安全红线"段落 |
| `.pi/skills/_shared/signature-convention.md` | 新增 | 提取署名约定 |
| `.pi/skills/_shared/review-protocol.md` | 新增 | 提取对抗审视协议 |
| `.pi/skills/worktree-isolation/SKILL.md` | 修改 | 删除署名约定重复内容，收紧触发短语，移除 co_loads |
| `.pi/skills/code-implementation/SKILL.md` | 修改 | 删除署名约定+审视协议重复内容，step 8 改为引用，移除 co_loads |
| `.pi/skills/requirement-analysis/SKILL.md` | 修改 | step 6 改为引用 |
| `.pi/skills/core-workflow/SKILL.md` | 修改 | 拆分，只保留查询+记录 |
| `.pi/skills/troubleshooting/SKILL.md` | 新增 | 接收排查流程 |
| `.pi/skills/otter-summon/SKILL.md` | 修改 | 收紧触发短语 |

---

## 二轮优化：SKILL.md 模板精简

### 问题

每个 skill 有 20-35% 是跨 skill 相同的样板（输入契约、后续动作声明、异体执行原则、弹性完成规则）。这些是**模板约定**，不是**技能内容**，不应内联到每个 skill 中。

### 模板设计

一个 skill 只回答 5 个问题：

| 问题 | 模板段落 |
|------|----------|
| 何时触发？ | 触发（含排除 + 输入） |
| 如何做？ | 工作流（约束内联到步骤） |
| 产出什么？ | 产出表 |
| 之后交给谁？ | 产出表的"下一步 + 执行者"列 |
| 参考什么？ | 参考 |

砍掉的段落及去向：
- Core Principles → 并入工作流步骤约束
- 输入契约 → 简化为"触发"下的 3 行表
- Behavioral Rules → 并入工作流步骤约束
- 问题处理决策树 → 并入工作流步骤分支
- 后续动作声明 + 异体执行原则 → 合并为"产出"表
- 弹性完成规则 → SYSTEM.md 弹性约定
- Additional Resources → "参考"一行

### SYSTEM.md 新增约定

```markdown
### 产出约定

- 每个 skill 的"产出"表定义该 skill 的交付物和后续动作
- "执行者"列可以是：当前獭、检视獭（异体）、搭档、-
- 异体执行规则：审视类动作的执行者不得是实现者，单 agent 场景下降级为搭档确认
- 搭档不在场 → 记录状态到 memory，不阻塞

### 弹性约定

- 搭档说"行了"/"就这样" → 流程可提前终止，记录决策
- 搭档说"跳过审视" → 显式决策，记录后放行
- 安全红线不可弹性，但搭档可以喊停任何流程（记录决策后放行）
```

### 验收标准（二轮）

- [ ] 所有 skill 使用统一模板（触发、工作流、产出、参考）
- [ ] 无独立的 Core Principles / Behavioral Rules / 异体执行原则 / 弹性完成规则段落
- [ ] SYSTEM.md 包含"产出约定"和"弹性约定"
- [ ] _shared/SKILL-TEMPLATE.md 记录模板规范
