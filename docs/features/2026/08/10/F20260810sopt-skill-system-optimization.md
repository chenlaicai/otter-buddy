---
id: F20260810sopt
title: skill-system-optimization
doc_type: feature

summary: |
  Skill 系统四项优化：清理死代码 triggers.phrases、优化 Reference 路由、
  强化对抗审视原则、增加 PR 留痕机制。

causal_links:
  from:
    - F20260810ka23  # Skill 系统结构优化

status: development
change_type: feature
tags: [skills, prompt, review]
modules: [.pi/skills/]
capability_test: "n/a: 纯 prompt/文档变更，无运行时行为"
---

# F20260810sopt: Skill 系统四项优化

## 背景

搭档 chen 在审视 skill 系统后提出四项优化点：

1. 检视后只在 otter 对话中出报告，PR 缺失 review 记录
2. 开发者对检视意见盲目听从，正文层未强调对抗精神
3. `triggers.phrases` 字段是什么机制？经源码确认是死代码
4. reference 结构是否过于简陋？

## 设计分析

### 优化 1：检视结论 post 到 PR

**问题**：PR 作为代码交付的唯一正式产物，缺失 review 记录。对话结束后检视结论无处可查。

**方案**：分层设计——结论 → PR（公开），过程 → otter 对话（内部）。

**实现**：adversarial-review 增加步骤 6"PR 留痕"，用 `gh pr review --comment` post 结论。

### 优化 2：开发者对抗审视强化

**问题**：`author-response-protocol.md` 已有完整设计，但正文层未显式强调。

**方案**：在 code-implementation 步骤 8 和 requirement-analysis 步骤 6 加 3-4 行提醒。

**核心原则**：检视发现不等于命令。照单全收等于把检视者的误读原样引入。

### 优化 3：Skill trigger 清理

**问题**：所有 SKILL.md 的 `triggers.phrases` 字段从未被 pi-coding-agent SDK 解析或使用。

**源码确认**：`loadSkillFromFile()` 只解析 `name`、`description`、`disable-model-invocation`。`formatSkillsForPrompt()` 输出 XML 只含 name + description + location。

**方案**：删除所有 SKILL.md 的 triggers 字段，更新 SKILL-TEMPLATE.md 说明触发机制真相。

### 优化 4：Reference 路由优化

**问题**："参考"节是静态列表，缺少步骤内显式引用点。

**方案**：每个 reference 的首次出现点必须在工作流步骤中，"参考"节只做索引，标注步骤号。

## 改动范围

| 文件 | 改动 |
|------|------|
| `.pi/skills/_shared/SKILL-TEMPLATE.md` | 删除 triggers，增加触发机制说明 |
| `.pi/skills/adversarial-review/SKILL.md` | 删除 triggers，步骤 3 内联 reference，增加步骤 6 PR 留痕，产出表更新 |
| `.pi/skills/code-implementation/SKILL.md` | 删除 triggers，步骤 3 内联 coding-principles，步骤 8 增加对抗审视提醒和处置留痕 |
| `.pi/skills/requirement-analysis/SKILL.md` | 删除 triggers，步骤 6 增加对抗审视提醒 |
| `.pi/skills/otter-summon/SKILL.md` | 删除 triggers，参考节加步骤标注 |
| `.pi/skills/worktree-isolation/SKILL.md` | 删除 triggers，参考节加步骤标注 |
| `.pi/skills/companion/SKILL.md` | 删除 triggers |
| `.pi/skills/core-workflow/SKILL.md` | 删除 triggers |
| `.pi/skills/troubleshooting/SKILL.md` | 删除 triggers |

## 设计决策

| 决策 | 结论 | 理由 |
|------|------|------|
| triggers 字段 | 删除 | SDK 不解析，是死代码 |
| PR 留痕内容 | 审查者+结论+问题清单 | 不放自省、维度扫视等内部细节 |
| 对抗审视提醒位置 | 正文步骤内 | 正文是第一层信息，reference 是第二层 |
| reference 路由 | 步骤内联+索引节 | LLM 需要明确的加载时机 |

## 验证

- [ ] 所有 SKILL.md 无 triggers 字段
- [ ] SKILL-TEMPLATE.md 包含触发机制说明
- [ ] 每个 reference 首次出现在工作流步骤中
- [ ] 参考节标注对应步骤
- [ ] code-implementation 和 requirement-analysis 包含对抗审视提醒
- [ ] adversarial-review 包含 PR 留痕步骤
- [ ] PR 留痕指引与模板一致
