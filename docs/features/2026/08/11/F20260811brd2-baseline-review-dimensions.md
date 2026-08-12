---
id: F20260811brd2
title: baseline-review-dimensions
doc_type: feature

summary: |
  检视维度增加基础维度（CI 状态、文档完整性、全链路验证），
  作为每次检视的地板。基础维度不占焦点名额，每次检视都必须覆盖。
  检视流程优化：PR 为检视意见 single source of truth，
  检视獭先 post PR review comment，再在 otter 对话中发轻量通知。
  code-implementation 自检步骤增加 CI 验证要求。

causal_links:
  from:
    - F20260810ka23  # Skill 系统优化（检视结论 post 到 PR）
    - F20260811rtrd  # 检视模板重设计（消灭「记录」黑洞）

status: development
change_type: prompt
tags: [skills, review, prompt]
modules:
  - .pi/skills/adversarial-review/
  - .pi/skills/code-implementation/
capability_test: "n/a: 纯 prompt/协议文档变更，无运行时代码逻辑；行为验证依赖真实审视场景中的 LLM 遵从度，非自动化测试可覆盖"
---

# F20260811brd2: 检视维度增加基础维度

## 背景

搭档在多个对话中反复指出同类问题：

1. **CI 失败反复发生**：每次都是搭档发现 CI 挂了，然后告诉系统去修。
2. **特性文档缺失**：代码提交后没有特性文档，搭档要手动检查。
3. **检视獭视野太窄**：检视维度全是代码质量，缺少交付完整性维度。

核心问题：**系统没有自动化的质量保障，搭档成了唯一的质量关口。**

## 设计决策

### 决策 1：基础维度 vs 焦点维度

**问题**：搭档反对固定的 Definition of Done checklist，担心 AI 会只检查这几项就完事。

**方案**：拆分为两层：
- **基础维度（地板）**：CI 状态、文档完整性、全链路验证——每次都必须检查，不占焦点名额
- **焦点维度（天花板）**：正确性、边界条件、安全性、架构合规、测试覆盖、可维护性——根据 PR 特点选 1-3 个深入

**理由**：基础维度是"地板"不是"天花板"，检视獭在此基础上自由发挥。

### 决策 2：PR 为检视意见 single source of truth

**问题**：检视獭在 otter 对话中输出完整报告，然后又 post 到 PR 上，存在重复。

**方案**：
- 检视獭先 post PR review comment
- 在 otter 对话中只发轻量通知
- PR 是检视意见的 single source of truth

**理由**：减少重复，PR 作为唯一真相源。

### 决策 3：CI 验证作为前置条件

**问题**：CI 失败的 PR 进入检视，浪费检视獭注意力。

**方案**：code-implementation 自检步骤增加 CI 验证要求，CI 失败时立即修复。

**理由**：CI 状态是检视的前置条件，不是检视内容。

## 改动范围

| 文件 | 改动 |
|------|------|
| `.pi/skills/adversarial-review/SKILL.md` | 步骤 2 增加基础维度说明，步骤 3 拆分基础维度和焦点维度，步骤 5 改为先 post PR review comment 再发轻量通知 |
| `.pi/skills/adversarial-review/references/review-dimensions.md` | 增加基础维度章节（B1/B2/B3），增加按 PR 类型的验证指引 |
| `.pi/skills/code-implementation/SKILL.md` | 步骤 5 增加 CI 验证要求 |

## 验证

- [x] 验收标准 1：验证检视獭在审视时会检查基础维度（本次检视已验证）
- [ ] 验收标准 2：验证 CI 失败时检视獭会标记为阻断性问题（需模拟 CI 失败场景，当前 CI 通过无法验证）
