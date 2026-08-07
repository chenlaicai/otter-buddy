---
id: F20260807rsaf
title: worktree-isolation-trigger-optimization
doc_type: feature

# 记忆索引
summary: |
  worktree-isolation skill 触发时机优化。
  核心问题：海獭们在主目录直接修改文件，不遵循 worktree 隔离原则。
  优化方向：触发时机从"提交前"前移到"文件操作前"，强化触发描述，
  排除非 git 追踪文件，覆盖排查中途变写入场景。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260728skrp   # worktree-isolation skill 初始设计

# 元数据
status: design
change_type: feature_update
tags: [skills, worktree-isolation, worktree, prompt-engineering]
modules: [.pi/skills/]

# 时间
created_at: 2026-08-07
---

## 问题背景

### 现象

海獭们（AI 代理）在主目录直接修改文件、切换分支，而不是先创建 worktree。worktree-isolation skill 明确写了"主目录零改动"的红线，但 LLM 在实际执行时经常跳过这个步骤。

### 根因分析

worktree-isolation skill 的触发设计存在两个问题：

1. **"should"措辞过弱**：当前 description 写的是"should be used for ANY task that mutates a git repository"，这是建议而非强制。LLM 可以合理地认为"我的场景不典型，不需要触发"。虽然描述已包含"editing or creating tracked files"，但"should"的强度不足以让 LLM 在每次文件修改前都触发。

2. **输入契约隐含"改动已存在"假设**：当前输入契约要求"要提交的改动"，并"检查 git status，无改动则不执行"。这隐含了改动已经发生的假设，导致 skill 被定位为"提交时"而非"文件操作前"。实际上，worktree 应该在文件修改前就创建，而不是在提交前才创建。

### 与现有机制的关系

- SYSTEM.md 的"搭档优先"原则明确搭档可以喊停流程，这是正确的——搭档优先级最高
- skill 的作用是在搭档不干预时让 LLM 自然触发 worktree 隔离
- 两者不冲突，不需要修改 SYSTEM.md

## 设计决策

### D1: 修正根因分析——拆分为两个子问题

**决策**：将根因拆分为两个精确的子问题，分别处理。

**子问题 (a): "should"措辞过弱**
- 当前 description 已包含"editing or creating tracked files"，语义覆盖正确
- 但"should be used for"是建议而非强制，LLM 可以合理忽略
- 解决方案：由 D2 处理，改为"MUST trigger BEFORE"

**子问题 (b): 输入契约隐含"改动已存在"假设**
- 当前输入契约要求"要提交的改动"，并"检查 git status，无改动则不执行"
- 这隐含了改动已经发生的假设，导致 skill 被定位为"提交时"触发
- 解决方案：修改输入契约，从"要提交的改动"改为"要执行的任务"

### D2: 触发描述从"建议"改为"强制"

**决策**：触发描述从"should be used for"改为"MUST trigger BEFORE"。

**理由**：
- "should"是建议，LLM 可以合理忽略
- "MUST"是强制，LLM 需要更强的理由才能跳过
- 符合 `feedback_mechanism_vs_llm_understanding.md` 的原则：让 LLM 理解为什么必须做

**与"搭档优先"的关系**：
- SYSTEM.md 的"搭档优先"原则明确搭档可以喊停流程，这是正确的——搭档优先级最高
- worktree-isolation 的 "MUST" 是 skill 层面的强制，当搭档显式要求跳过时（"别建 worktree 了，直接改"），按 SYSTEM.md "搭档优先"原则执行，记录决策后放行
- 当前 worktree-isolation 的弹性规则已覆盖此场景："搭档说'不用建 worktree 了' → 不可以"是 skill 内部的硬规则，但搭档显式喊停时仍可放行
- 两者不冲突：skill 在搭档不干预时强制执行，搭档干预时可放行

### D3: 明确排除非 git 追踪文件

**决策**：触发描述明确说明不适用于非 git 追踪文件（memory、.env、local config）。

**理由**：
- 减少 LLM 的判断负担——不需要判断"这个文件是否需要 worktree"
- 避免过度触发——非 git 追踪文件不需要 worktree 隔离
- 触发范围清晰，减少误判

### D4: 覆盖"排查中途变写入"场景

**决策**：在 core-workflow skill 中增加转换节点，排查中需要修改文件时立即转入 worktree-isolation 流程。

**理由**：
- 常见场景：排查问题时发现需要加 log 或改配置来验证假设
- 当前 core-workflow 的 co_loads 包含 worktree-isolation，但那是"排查结论需提交时"才触发
- 排查过程中的临时修改不在"提交"范畴内，但如果不在 worktree 里做，会污染主目录

### D5: 增加 cwd 验证步骤

**决策**：在 worktree-isolation 最小流程中增加 cwd 验证，确认操作在 worktree 内进行。

**理由**：
- memory 中有记录：小獭的 cwd 是主仓，相对路径会解析到主仓旧代码
- 如果 LLM 在主目录的 cwd 下执行文件操作，实际写入的可能是主目录
- 验证步骤可以防止路径解析错误

### D6: 明确 worktree 创建机制

**决策**：在 skill 中明确推荐使用 EnterWorktree 工具（Claude Code 环境）或 `git worktree add`（Pi SDK 环境）。

**理由**：
- 避免 LLM 自行选择 worktree 创建方式
- 统一执行路径，减少出错概率
- 与现有工具集成

### D7: worktree-isolation 为 worktree 创建的单一事实源

**决策**：worktree-isolation skill 保持为 worktree 创建步骤的唯一事实源，code-implementation 和 core-workflow 通过引用 worktree-isolation 获取步骤，而非直接复制。

**理由**：
- 维护三份相同的步骤是漂移隐患，任何一处修改都需要同步其他两处
- worktree-isolation 已经定义了完整的 worktree 创建流程，其他 skill 引用即可
- 保持单一事实源，减少维护负担
- code-implementation step 1 改为"执行 worktree-isolation 最小流程"，而非直接写步骤
- core-workflow 转换节点也引用 worktree-isolation 最小流程

## 实现方案

### S1: 优化 worktree-isolation SKILL.md 触发描述

**文件**：`.pi/skills/worktree-isolation/SKILL.md`

**改动**：

```yaml
# frontmatter description
description: >-
  MUST trigger BEFORE modifying any git-tracked file (code, docs, config, lockfile).
  This skill creates worktree isolation — the FIRST step before writing any file.
  If you are about to edit, create, or delete any file tracked by git, load this skill FIRST.
  Does NOT apply to non-git files (memory, .env, local config).
```

```markdown
# body 开头
> **触发时机**：准备修改任何 git 追踪文件之前（不是提交时）
> **触发短语**：改一下 | 修这个 bug | 改配置 | 更新文档 | 提交
> **排除**：非 git 追踪文件（memory、.env、local config）不需要此 skill
> **搭档喊停**：搭档显式要求跳过 worktree 时，记录决策后放行
```

注意：触发短语移除了与 code-implementation 重叠的"写代码"、"实现功能"。功能开发场景应由 code-implementation 入口，通过 co_loads 自动加载 worktree-isolation。

### S2: 优化 worktree-isolation 最小流程

**文件**：`.pi/skills/worktree-isolation/SKILL.md`

**改动**：优化最小流程，增加条件验证、已在 worktree 内的处理、失败降级

```markdown
## 最小流程

0. **验证环境**（条件步骤）：如果不确定当前是否在 worktree 内，执行以下验证：
   - 执行 `git rev-parse --show-toplevel` 获取 git 根目录
   - 执行 `pwd` 获取当前目录
   - 如果当前目录就是 git 根目录，说明在主目录，需要先创建 worktree
   - 如果当前目录在 `.claude/worktrees/` 下，说明已在 worktree 内，跳过 step 1
1. 基于最新 `origin/main` 在 `.claude/worktrees/` 下创建 worktree：
   - 使用 `EnterWorktree` 工具（Claude Code 环境）
   - 或使用 `git worktree add .claude/worktrees/<name> -b <branch-name> origin/main`（Pi SDK 环境）
   - **失败处理**：如果 worktree 创建失败，向搭档报告失败原因，由搭档决定是否在主目录继续（记录决策后放行）或中止任务
2. 后续所有改动与验证都在 worktree 内进行，主目录保持原样
3. 按提交模板 commit
4. `git push -u origin <branch>` + `gh pr create`，把 PR 链接交给搭档审查
5. 收尾记录：worktree 名、分支名、PR 号
```

### S3: 优化 code-implementation step 1

**文件**：`.pi/skills/code-implementation/SKILL.md`

**改动**：

```markdown
### 1. Prepare Environment

第一步：执行 worktree-isolation 最小流程创建 worktree 隔离环境。

- 读取 `worktree-isolation` skill，执行其最小流程
- 记录上下文：worktree 名、分支名、特性编号
- 后续所有文件修改必须在 worktree 内进行，主目录只允许只读操作
```

注意：不再直接写 worktree 创建步骤，而是引用 worktree-isolation 的最小流程，保持单一事实源。

### S4: core-workflow 增加转换节点

**文件**：`.pi/skills/core-workflow/SKILL.md`

**改动**：在排查流程中增加文件修改转换节点

```markdown
### 排查中需要修改文件时

如果排查过程中需要修改文件来验证假设（如加 log、改配置），立即转入 worktree-isolation 流程：

1. 停止当前排查步骤
2. 读取 `worktree-isolation` skill，执行其最小流程创建 worktree
3. 在 worktree 内进行临时修改和验证
4. 验证完成后，决定是否提交修改：
   - 如果修改有价值 → 走 worktree-isolation 完整流程提交 PR
   - 如果修改是临时的 → 在 worktree 内 revert，不影响主目录
5. 继续排查流程
```

注意：转换节点引用 worktree-isolation 最小流程，而非直接写 worktree 创建步骤，保持单一事实源。

### S5: 修改 worktree-isolation 输入契约

**文件**：`.pi/skills/worktree-isolation/SKILL.md`

**改动**：修改输入契约，从"要提交的改动"改为"要执行的任务"

```markdown
## 输入契约

本 skill 需要以下输入才能开始工作：

| 输入 | 必选/可选 | 来源 | 缺失时处理 |
|------|----------|------|-----------|
| 任务描述 | 必选 | 搭档或当前上下文 | 停下来问搭档 |
| 涉及的文件类型 | 可选 | 从任务描述推断 | 判断是否为 git 追踪文件，非 git 追踪文件不需要此 skill |
```

注意：输入契约不再要求"要提交的改动"已存在，而是要求"任务描述"，强调在文件修改前就触发。

## 验证方式

### V1: 触发时机验证

**场景**：搭档说"改一下这个 bug"

**预期行为**：
1. LLM 识别到"改一下"是触发短语
2. LLM read worktree-isolation skill
3. LLM 执行最小流程，创建 worktree
4. LLM 在 worktree 内修改文件

**验证方法**：检查主目录是否有未提交的改动（`git status` 应该干净）

### V2: 排除场景验证

**场景**：搭档说"更新一下 memory"

**预期行为**：
1. LLM 识别到 memory 文件不在 git 追踪范围内
2. LLM 不触发 worktree-isolation
3. LLM 直接更新 memory 文件

**验证方法**：检查是否创建了不必要的 worktree

### V3: 排查中途变写入验证

**场景**：搭档说"查一下这个问题"，排查中需要加 log

**预期行为**：
1. LLM 进入 core-workflow 走排查流程
2. 排查中发现需要加 log
3. LLM 停止排查，转入 worktree-isolation 流程
4. LLM 创建 worktree，在 worktree 内加 log
5. 验证完成后，LLM 决定是否提交

**验证方法**：检查主目录是否有未提交的改动

### V4: cwd 验证

**场景**：小獭在主目录 cwd 下执行文件操作

**预期行为**：
1. LLM 执行 `git rev-parse --show-toplevel` 和 `pwd`
2. LLM 发现当前在主目录
3. LLM 先创建 worktree，再进行文件操作

**验证方法**：检查文件是否修改在 worktree 内

## 实现计划

### Phase 1: worktree-isolation 触发描述优化（纯文本）

- [ ] 优化 SKILL.md frontmatter description
- [ ] 优化 SKILL.md body 开头的触发说明
- [ ] 增加 cwd 验证步骤
- [ ] 明确 worktree 创建机制

### Phase 2: code-implementation step 1 优化（纯文本）

- [ ] 将 step 1 从间接引用改为直接写步骤
- [ ] 明确 worktree 创建机制

### Phase 3: core-workflow 转换节点（纯文本）

- [ ] 在排查流程中增加文件修改转换节点
- [ ] 明确临时修改的处理方式

### Phase 4: 验证

- [ ] 用典型场景走完整链路
- [ ] 检查主目录是否有未提交改动
- [ ] 检查非 git 追踪文件是否被误触发

## 风险与缓解

### R1: 触发范围扩大导致过度触发

**风险**：优化后的触发描述可能让 LLM 在不需要 worktree 的场景也触发 worktree-isolation

**缓解**：触发描述明确排除非 git 追踪文件，减少误判

### R2: LLM 仍然跳过触发

**风险**：即使优化了触发描述，LLM 仍可能跳过 worktree-isolation

**缓解**：这是 skill 层面能做的极限。如果仍不够，需要考虑机制层面的 Hard Gate（如 `worktree-isolation-hard-gate` worktree 的方案），但那是另一个决策点。

### R3: code-implementation step 1 过于具体

**风险**：直接写步骤可能让 skill 耦合到具体工具实现

**缓解**：改为引用 worktree-isolation 最小流程，保持单一事实源，避免耦合。

## 对抗审视记录

### 第 1 轮（检视獭，2026-08-07）

**焦点**：正确性、可行性、副作用、完整性、与现有机制冲突

**阻断性问题**：无

**重要问题**：

| # | 问题 | 处置 | 理由 |
|---|------|------|------|
| 1 | D1 根因分析不精确——真正的问题是"should"措辞过弱和输入契约隐含"改动已存在"假设 | 接受并修复 | 拆分为两个子问题，分别处理 |
| 2 | D2 "MUST"与 SYSTEM.md "搭档优先"原则存在张力 | 接受并修复 | 显式声明：搭档可喊停，记录决策后放行 |
| 3 | 三处重复写入 worktree 创建步骤，缺乏优先级与去重机制 | 接受并修复 | worktree-isolation 为单一事实源，其他 skill 引用 |

**次要问题**：

| # | 问题 | 处置 | 理由 |
|---|------|------|------|
| 4 | S2 step 0 每次文件操作前执行两个工具调用，性能开销需评估 | 接受并修复 | 改为条件步骤："如果不确定是否在 worktree 内" |
| 5 | 缺少"已在 worktree 内"的场景处理 | 接受并修复 | 增加分支逻辑：已在 worktree 内则跳过创建 |
| 6 | D4 转换节点依赖 LLM 主动中断当前推理链 | 呈搭档裁决 | 需要测试验证，先按当前方案实现 |
| 7 | 缺少 worktree 创建失败的降级处理 | 接受并修复 | 增加失败处理：报告搭档，由搭档决定 |
| 8 | S1 触发短语与 code-implementation 重叠 | 接受并修复 | 移除"写代码"、"实现功能"，聚焦 worktree-isolation 独特场景 |

**结论**：方案方向正确，三个重要问题已修复，可以进入实现阶段。
