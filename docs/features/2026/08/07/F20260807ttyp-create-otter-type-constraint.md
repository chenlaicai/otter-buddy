---
id: F20260807ttyp
title: create-otter-type-constraint
doc_type: feature

summary: |
  移除 create_otter 工具的 type 参数，从 schema 层面杜绝大獭创建大獭的可能。
  根因：工具 schema 暴露 enum: ["big", "small"] 给 LLM，大獭可传 type: "big" 创建大獭。
  硬编码 type: "small" as const，LLM 无需也无法指定类型。

change_type: fix
tags: [agent, tools, safety]
modules:
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - tests/interface-adapters/create-otter-tool.test.ts

capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
---

# F20260807ttyp: create_otter 工具移除 type 参数

## 根因

create_otter 工具的 schema 定义了 `enum: ["big", "small"]` 的 type 参数，LLM 可以传 `type: "big"` 创建出大獭，违反设计约束：**大獭只能创建小獭，小獭不能创建任何子獭**。

小獭侧已正确实现（无 create_otter 工具），大獭侧缺失约束。

## 修复方案

1. **Schema 层面**：从 `properties` 和 `required` 中移除 type 参数
2. **Execute 层面**：硬编码 `type: "small" as const`，不从 params 读取
3. **测试更新**：
   - 新增 2 个测试验证 type 始终为 small（含 LLM 幻觉传入 type: "big" 的场景）
   - 移除所有现有测试中的 `type: "small"` 传参

## 验证

- `npx vitest run tests/interface-adapters/create-otter-tool.test.ts` — 9/9 通过
- `npx tsc --noEmit` — 无类型错误
- Pre-commit hook（lint + build + docs lint）全部通过
