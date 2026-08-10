---
name: troubleshooting
description: >-
  Structured troubleshooting: from symptoms to root cause, from analysis to fix.
  For simple information retrieval, use core-workflow instead.
triggers:
  phrases:
    - "排查"
    - "分析问题"
    - "看看日志"
    - "查数据库"
co_loads: []
---

# Troubleshooting

结构化的问题排查：从现象到根因，从分析到修复。

## 触发

**触发条件**：搭档需要排查问题、调试、分析系统行为时。

**排除**：简单的信息查询（搜记忆、查对话历史）→ `core-workflow`。

**输入**：
| 输入 | 必选 | 缺失时 |
|------|------|--------|
| 问题描述 | 是 | 停下来问搭档 |
| 已有线索 | 否 | 主动收集：日志、错误信息、复现步骤 |
| 排查范围 | 否 | 从问题现象出发，逐步缩小 |

## 工作流

1. **收集信息**：读取相关文件、日志、配置；查询 memory 中的历史决策和类似问题；确认复现条件和影响范围。
2. **分析根因**：提出假设 → 逐一验证（读代码、查日志、对比配置）。区分症状和根因——修根因，不修症状。
3. **形成结论**：输出结构化结论（问题现象 + 根因分析附 file:line + 修复建议 + 影响范围）。
4. **需要修复时**：转入 `worktree-isolation` 流程创建 worktree，在 worktree 内修复并提交。
5. **排查中需改文件验证假设时**：立即转入 worktree，验证完成后决定提交或 revert，继续排查。

> 约束：先读文件/数据再分析，不凭印象。结论必须附 file:line 引用。修复建议必须具体可执行。

## 产出

| 产出 | 下一步 | 执行者 |
|------|--------|--------|
| 排查结论（需修复） | worktree-isolation 流程 | 当前獭 |
| 排查结论（无需修复） | 记录到 memory | 当前獭 |
