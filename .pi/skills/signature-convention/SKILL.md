---
name: signature-convention
description: >-
  Use when: 任何 commit/PR/报告/评审场景需要署名标识责任主体时.
  Not for: 审视流程编排 → review-protocol. 闲聊讨论 → companion.
  Output: 正确署名的 commit author / PR description 署名行 / review 报告署名.
  能力摘要：海獭署名约定查表——身份获取规则与三处署名位置的格式.
co_loads: []
category: reference
---

# 海獭署名约定

无论大獭还是小獭，在交付物上署名以标识责任主体。本 skill 是查表约定：遇到署名场景时查阅对应位置与格式。

## 触发

**触发条件**：需要署名标识责任主体时——commit、PR description、review 报告、评审意见。

**排除**：审视流程的编排（召唤检视獭、处置报告、复审循环）→ `review-protocol`。

**输入**：
| 输入 | 必选 | 缺失时 |
|------|------|--------|
| 海獭身份（名号） | 是 | 向父 agent 确认后再署名，不得自行猜测 |

## 工作流

1. **确认身份**：
   - **大獭**（Claude Code 主进程）：身份为"大獭"，从 MEMORY.md 或用户指令中确认
   - **子 agent**（检视獭、开发獭等）：身份由父 agent 在启动时通过 prompt 显式指定，格式示例："你是检视獭，对 PR #N 进行对抗检视"
   - **缺失身份时**：子 agent 不得自行猜测，必须向父 agent 确认后再执行署名操作

2. **按位置署名**：
   1. **Commit author**：用 `--author` 参数指定当前海獭身份，格式 `名号 <otter-buddy>`
      - 大獭：`git commit --author="大獭 <otter-buddy>"`
      - 开发獭：按召唤时的 name 署名，例如 `开发獭-需求名 <otter-buddy>`（连字符是名号的一部分，非邮箱格式）
   2. **PR description**：末尾署名行使用 `../code-implementation/references/commit-convention.md` 的 PR Description 模板，`[海獭名号]` 替换为实际名号
   3. **Review report**：使用 adversarial-review skill 的"产出模板"章节，`[海獭名号]` 替换为实际名号

## 产出

| 产出 | 下一步 | 执行者 |
|------|--------|--------|
| 署名完成的 commit / PR / 报告 | 随宿主流程继续（审视/终审） | 当前獭 |

## 参考

- `../code-implementation/references/commit-convention.md` — 步骤 2 之 PR Description 署名模板
