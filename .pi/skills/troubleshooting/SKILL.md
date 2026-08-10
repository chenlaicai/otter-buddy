---
name: troubleshooting
description: >-
  This skill should be used when the user asks to "排查", "分析问题",
  "看看日志", "查数据库",
  or needs to debug issues, investigate problems, or analyze system behavior.
  Covers structured troubleshooting workflow, root cause analysis, and
  the transition to worktree isolation when fixes are needed.
  For simple information retrieval (searching memory, conversation history),
  use core-workflow instead.
triggers:
  phrases:
    - "排查"
    - "分析问题"
    - "看看日志"
    - "查数据库"
co_loads: []
---

# Troubleshooting

结构化的问题排查流程：从现象到根因，从分析到修复。

> **触发短语**：排查 | 分析问题 | 看看日志 | 查数据库
> **共加载**：无（安全红线已在 SYSTEM.md 中全局生效）
> **排除**：简单的信息查询（搜记忆、查对话历史）→ 使用 `core-workflow`

## 输入契约

本 skill 需要以下输入才能开始工作：

| 输入 | 必选/可选 | 来源 | 缺失时处理 |
|------|----------|------|-----------|
| 问题描述 | 必选 | 搭档 | 停下来问搭档要排查什么 |
| 已有线索 | 可选 | 搭档或当前上下文 | 主动收集：日志、错误信息、复现步骤 |
| 排查范围 | 可选 | 搭档 | 默认从问题现象出发，逐步缩小范围 |

## 排查流程

### 1. 收集信息

- 读取相关文件、日志、配置
- 查询 memory 中的历史决策和类似问题
- 确认复现条件和影响范围

### 2. 分析根因

- 基于收集的信息，提出可能的根因假设
- 逐一验证假设：读代码、查日志、对比配置
- 区分症状和根因——修复根因，不修症状

### 3. 形成结论

输出结构化的排查结论：

```markdown
## 问题现象

[搭档描述的问题 + 复现条件]

## 根因分析

[根本原因，附 file:line 引用]

## 修复建议

[具体修复方案，或"无需代码修复"说明]

## 影响范围

[修复会影响哪些功能]
```

### 4. 需要修复时

排查结论若需要改动仓库（提交修复、提 PR，无论多小）→ 转入 worktree-isolation 流程：

1. 读取 `worktree-isolation` skill，执行其最小流程创建 worktree
2. 在 worktree 内进行修复
3. 修复完成后走 worktree-isolation 的提交流程

### 排查中需要修改文件验证假设时

如果排查过程中需要修改文件来验证假设（如加 log、改配置），立即转入 worktree-isolation 流程：

1. 停止当前排查步骤
2. 读取 `worktree-isolation` skill，执行其最小流程创建 worktree
3. 在 worktree 内进行临时修改和验证
4. 验证完成后，决定是否提交修改：
   - 如果修改有价值 → 走 worktree-isolation 完整流程提交 PR
   - 如果修改是临时的 → 在 worktree 内 revert，不影响主目录
5. 继续排查流程

## Behavioral Rules

- 先用工具读取相关文件/数据，再基于读取内容分析——不凭印象判断
- 排查结论必须附 file:line 引用，不能只有"可能是因为..."
- 修复建议必须具体可执行，不能是"建议优化一下"

## 后续动作声明

| 产出类型 | 下一步动作 | 执行者 | 触发条件 | 不满足时处理 |
|----------|-----------|--------|----------|-------------|
| 排查结论（需提交修复） | worktree-isolation 流程 | 当前獭 | 结论涉及仓库改动时 | 正常终止，结论记录到 memory |
| 排查结论（无需修复） | 记录 | 当前獭 | 结论确认后 | 正常终止，结论记录到 memory |

### 异体执行原则

troubleshooting 不涉及审视类动作，无异体执行要求。
