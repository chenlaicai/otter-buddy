---
name: otter-summon
description: >-
  This skill should be used when the task requires multiple specialized agents
  to collaborate — e.g., "帮我分析一下这个需求", "做个技术方案", "审查这个 PR",
  "写代码并 review", "调研几个方向", "模拟多角色讨论", "排查一下这个问题",
  or any task involving requirement analysis, code implementation + review,
  parallel research, multi-role discussion, or debugging that benefits from
  dedicated agents working together.
  Covers summon decision framework, systemPrompt template, multi-round
  collaboration orchestration, and output integration.
---

# Otter Summon Protocol

大獭召唤小獭的决策框架和协作编排指南。

## 何时召唤

| 场景 | 小獭名字 | systemPrompt 要点 |
|------|---------|-------------------|
| 需求分析/方案设计 | 分析獭 | 指定要分析的需求，说明约束和背景，期望输出结构化方案 |
| 代码实现 | 开发獭 | 指定方案编号和实现范围，说明仓库和分支，期望可运行代码 |
| 代码/方案检视 | 检视獭 | 指定要检视的产出（PR/方案/文件），期望结构化检视报告 |
| 模拟多角色讨论 | 按立场命名 | 指定角色立场和关注点，期望该视角的独立观点 |
| 并行调研多个方向 | 按方向命名 | 指定调研方向和范围，期望调研结论 |
| 调试/排查 | 排查獭 | 指定问题现象、已有线索、排查范围，期望根因分析和修复建议 |

### 不召唤的情况

简单问答、快速修改、直接能做的事——自己上手，不要多此一举。

## systemPrompt 与身份层的关系

你写的 systemPrompt 会叠加在小獭的身份 prompt（SMALL_OTTER.md）之后注入小獭上下文。不需要在 systemPrompt 中重复身份信息（"你是小獭"等），身份层已覆盖。只写任务相关的内容。

## 召唤原则

- **召唤要有明确任务**：systemPrompt 必须包含——具体任务、背景信息、预期产出、完成标准
- **传递上下文**：不要让小獭从零开始，把相关背景、已有结论、约束条件写进 systemPrompt
- **小獭说完要接住**：小獭发言后，根据其产出决定下一步（整合、追问、交给搭档、或再召唤其他獭）

## systemPrompt 模板

创建小獭时，按以下结构写 systemPrompt：

```
你的任务：[一句话说清要做什么]

背景信息：
- [相关上下文]
- [已有结论或前置依赖]
- [约束条件]

预期产出：[你期望小獭输出什么格式的内容]

完成标准：[什么情况算做完]
```

**示例**：

```
你的任务：分析"大獭召唤小獭"功能的实现方案，输出结构化技术设计文档

背景信息：
- 当前大獭有 create_otter/dissolve_otter 工具，但缺乏使用指引
- 用户期望大獭能自主决定何时召唤小獭
- 相关代码在 src/interface-adapters/agent-runtime/tools/tool-factory.ts

预期产出：结构化技术方案，包含问题分析、设计方案、改动清单、验收标准

完成标准：
- 覆盖所有已知场景（需求分析、代码实现、方案检视、多角色讨论、并行调研）
- systemPrompt 模板具体可执行
- 与现有架构（skill/tool/identity 三层）一致
```

## 接住小獭产出

小獭发言后，发言石会回到你。你要：

- 审视小獭的产出质量——结论是否清晰、是否回答了问题
- 将有价值的产出整合到当前工作中
- 发现小獭遗漏的问题，决定是自己补还是再召唤
- 向搭档汇报进展（如果搭档在等结果）

小獭的产出是你的输入，不是最终交付物。你负责把关。

## Additional Resources

### Reference Files

- **`references/collaboration-patterns.md`** — 多轮协作编排详细模式（开发↔检视循环等）
