---
id: F20260821a5cc
title: html-card 卡片数量检测
summary: 在 speak 工具中增加执行时检测，如果检测到 3+ 张卡片就拒绝执行，并提示 LLM 合并卡片或分多次 speak 输出。
change_type: feature
status: active
created_at: 2026-08-21
modules:
  - src/interface-adapters/agent-runtime/tools/tool-helpers.ts
  - src/interface-adapters/agent-runtime/tools/html-card-contract-tool.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - tests/interface-adapters/speak-tool.test.ts
tags:
  - agent-tools
  - html-card
  - validation
capability_test: n/a（单元测试覆盖）
---

# html-card 卡片数量检测

## 问题描述

当前 html-card 卡片在前端有硬性限制（CARD_MAX_PER_MESSAGE = 2），第 3 张起会自动降级为源码块（不可读）。但 LLM 在生成内容时可能没有意识到这个限制，导致生成了 3+ 张卡片才发现用户看不到内容。

## 解决方案

在 speak 工具中增加执行时检测，如果检测到 3+ 张卡片就拒绝执行，并提示 LLM 合并卡片或分多次 speak 输出。

## 修改内容

### 1. tool-helpers.ts

增加卡片数量检测逻辑：
- 增加 `CARD_MAX_PER_MESSAGE = 2` 常量
- 增加 `HTML_CARD_FENCE_GLOBAL` 常量（全局匹配版本）
- 增加 `countCardFences` 函数（使用正则表达式统计卡片数量）
- 在 `validateSpeakBody` 中增加卡片数量检测，超过 2 张会返回错误提示

### 2. html-card-contract-tool.ts

在契约开头增加醒目的警告：
- "⚠️ **硬性限制**：一条消息最多 2 张卡片，单卡 ≤4KB。第 3 张起用户会看到降级的源码块（不可读）。如果需要展示超过 2 张卡片的内容，请合并为 2 张，或分多次 speak 输出。"

### 3. tool-factory.ts

在 speak 工具的 description 中更突出限制：
- "**一条消息最多 2 张，单卡 ≤4KB；写在 speak 之外文本里的卡片搭档看不到，系统会检测并拒绝该次调用**"

### 4. speak-tool.test.ts

为新增的卡片数量检测功能添加测试：
- 添加 6 个测试用例，覆盖各种场景（1 张、2 张、3 张、4 张、回执不计入数量等）
- 恢复被删除的位置校验测试（6 个测试用例）

## 验证

- 所有测试已通过（33 个测试）
- 构建成功
- 代码合并冲突已解决
- 特性编号冲突已修复

## Discovered Issues

- #360：前后端 CARD_MAX_PER_MESSAGE 常量无编译时对齐检查

## 决策史

- 2026-08-21：初始实现，使用 F20260821a5cb 特性编号
- 2026-08-21：发现特性编号冲突，改为 F20260821a5cc
- 2026-08-21：解决代码合并冲突，保留 main 分支的 speak description 更新
