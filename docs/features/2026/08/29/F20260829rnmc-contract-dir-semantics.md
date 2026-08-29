---
id: F20260829rnmc
supersedes_id: F20260825csmt
title: api-contract 目录语义约定显式化
summary: |
  Issue #413（tech-debt）：PR #410 引入 api-contract 首个 value 导出（CARD_MAX_PER_MESSAGE），
  对抗审视指出目录语义从「type-only 契约」扩展为「含运行时值的契约」缺少显式约定。
  方案：新建 api-contract/README.md 声明目录定位、value 导出准入标准与决策留痕锚点。
change_type: feature
status: active
capability_test: "n/a: 纯文档变更（Design 类），无代码/LLM 行为改动"
created_in_conversation: 376077f2-7ebb-442b-943e-c7ce547f4f8a
---

# api-contract 目录语义约定显式化

## 背景与需求

### 问题描述

PR #410（Issue #360）引入 `api-contract/` 目录的首个 value 导出（`CARD_MAX_PER_MESSAGE`），此前该目录全部为 `import type` 消费的 DTO 类型。对抗审视（reviewer-410 建议发现 1）指出：目录语义从「type-only 契约」扩展为「前后端契约（含运行时值）」是目录级设计决策，缺少显式约定——后续贡献者无从判断什么能放进这个目录。

来源：Issue #413 ← PR #410 对抗审视建议发现 1。（本档 F20260829rnmc 取代 PR #420 初版的 F20260825csmt——见文末决策史）

### 待办核对（Issue #413）

- [x] 在 api-contract/README 显式声明目录语义：允许 value 导出 + 准入标准（仅限前后端共享的运行时契约值，禁止业务逻辑/工具函数）
- [x] 是否迁移独立共享包：**不迁移**。F20260824cpxa「Why api-contract 而非新建 workspace 包」已论证（workspace 基础设施成本与最简可行目标相悖，Issue #360 明确排除 monorepo 重构）；README 中锚定该决策及未来触发条件

## 方案设计

新建 `api-contract/README.md`，内容三块：

1. **目录定位**：前后端契约单一真相源，`api/`（REST DTO）+ `sse/`（事件契约），双端 `@contract/*` 别名消费
2. **准入标准**：类型契约 + 运行时契约值双轨声明；value 导出三禁（业务逻辑与工具函数 / 单端使用的常量类型 / 需要构建处理的代码）
3. **决策留痕锚点**：指向 F20260824cpxa 的「Why api-contract 而非新建 workspace 包」，并写明未来 value 导出增长到需要独立包时另立 issue 规划

关键取舍：README 写成**贡献指南**而非规范文档——回答「我能往这放什么」这个实际问题，准入标准用允许/禁止清单表达，不引入评审流程。

## 影响范围

- 零代码改动，零运行时行为变化
- 单文件新增：`api-contract/README.md`

## 验证

- 纯文档变更，无需构建/测试验证
- 内容与 F20260824cpxa 决策留痕一致（Why api-contract 章节）、与 Issue #413 待办逐条对应

## Discovered Issues

无。

## 决策史

- 2026-08-25：初始实现（大獭，glm）。README 三段式（定位/准入/留痕锚点）；待办 2 判定为不触发（前置决策已存在），README 锚定而非复制完整论证
- 2026-08-29：原 PR #420 因终审呈报断链搁置 4 天，main 已推进 70 commits。rebase 至当前 main（内容零冲突），特性编号 csmt→rnmc 顺延重编（搭档指令：编号须反映最新日期），文档同步迁至 08/29，补留取代链（supersedes csmt）。对抗审视结论（reviewer-420 初审 0 严重/1 建议→处置→delta 复核通过）对纯文档内容依然成立——审视对象是内容而非分支历史。审视发现 1 的登记义务已由 issue #427 闭合（#431 修复合入）
