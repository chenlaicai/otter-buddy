---
id: F20260717wx6q
title: pi-agent-core-cleanup
doc_type: feature

# 记忆索引
summary: |
  pi-agent-core 迁移遗留清理，删除死代码、统一接口定义、清理陈旧注释。
  代码质量优化，不涉及功能性变更。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260716sq6e   # pi-agent-core vs coding-agent

# 元数据
status: locked
change_type: refactor
tags: [cleanup, code-quality, refactor, pi-agent-core]
modules: [src/frameworks/agent/, src/interface-adapters/agent-runtime/]

# 时间
created_at: 2026-07-17
---


### 变更 2：统一 `DynamicContext` 接口定义

**文件**：
- `src/frameworks/agent/system-prompt-builder.ts`（删除 — 变更 1 覆盖）
- `src/interface-adapters/agent-runtime/agent-invoke-port.ts`（保留为权威定义）

**操作**：修改 `pi-session-factory.ts` 的 import 路径：

```diff
- import type { DynamicContext } from "./system-prompt-builder";
+ import type { DynamicContext } from "@interface-adapters/agent-runtime/agent-invoke-port";
```

**验证命令**：
```bash
grep -r "DynamicContext" src/ --include="*.ts" | grep "system-prompt-builder"
# 预期：无结果
```


### 变更 3：清理陈旧注释

**文件与操作**：

| 文件 | 行号 | 当前内容 | 修改后 |
|------|------|----------|--------|
| `src/frameworks/agent/pi-session-factory.ts` | 4 | `替代 PiHarnessFactory（pi-agent-core 路径）` | 移除对旧实现的引用 |
| `src/frameworks/llm/models-factory.ts` | 3 | `LLM 交互（chat/streamChat）由 AgentHarness 内部处理` | 移除对 AgentHarness 的引用 |
| `src/interface-adapters/agent-runtime/agent-invoke-port.ts` | 3-4 | `PiHarnessFactory (frameworks 层) 的 invoke()...main.ts 将 PiHarnessFactory 实例作为 AgentInvokePort 注入` | 更新为当前架构描述 |
| `src/interface-adapters/agent-runtime/agent-invoker.ts` | 169 | `中断 Agent 生成（UA-2: 调用 PiHarnessFactory.abort()）` | 更新为当前实现描述 |

**注**：Issue 描述列出了 3 个文件，实际审查发现 5 个文件含陈旧引用（新增 `agent-invoke-port.ts` 和 `agent-invoker.ts`）。`system-prompt-builder.ts` 的注释随文件删除一并清理。

**验证命令**：
```bash
grep -rn "pi-agent-core\|AgentHarness\|PiHarness" src/ --include="*.ts"
# 预期：无结果
```


## 变更影响分析

### 后端
- **代码**：删除 1 个文件（~62 行），修改 4 个文件的注释和 import
- **API**：无变更
- **数据模型**：无变更
- **配置**：无变更

### 前端
- 无影响

### 提示词/SOP
- 无影响


## 验收标准

| ID | 标准 | 验证方式 |
|----|------|----------|
| AC-1 | `system-prompt-builder.ts` 文件已删除 | `ls src/frameworks/agent/system-prompt-builder.ts` 返回不存在 |
| AC-2 | `DynamicContext` 仅在 `agent-invoke-port.ts` 中定义 | `grep -r "export interface DynamicContext" src/` 仅匹配 `agent-invoke-port.ts` |
| AC-3 | 源码中无 `pi-agent-core` / `AgentHarness` / `PiHarness` 引用 | `grep -rn "pi-agent-core\|AgentHarness\|PiHarness" src/` 无结果 |
| AC-4 | `pi-session-factory.ts` 的 `DynamicContext` import 指向 `agent-invoke-port.ts` | 代码审查确认 |
| AC-5 | TypeScript 编译无错误 | `npx tsc --noEmit` 通过 |
| AC-6 | 所有现有测试通过 | `npm test` 通过 |


## 关键决策记录

### 决策 1：删除整个 `system-prompt-builder.ts` vs 仅删除死代码

- **正方**：文件所有导出（`buildSystemPrompt`、`HarnessContext`、`DynamicContext`）均无独立价值 — `DynamicContext` 的权威定义在 `agent-invoke-port.ts`，其余两个从未被调用。删除整个文件最简洁。
- **反方**：如果未来需要 `buildSystemPrompt` 的逻辑（如 system prompt 组装），需要重新实现。
- **决策**：删除整个文件。
- **依据**：`pi-session-factory.ts` 的 `buildOtterPrompt()` 和 `buildMessageWithContext()` 已实现相同功能，`buildSystemPrompt` 是完全冗余的旧实现。

### 决策 2：是否清理 `system-prompt-config.ts`

- **正方**：`system-prompt-config.ts` 的唯一消费者是 `system-prompt-builder.ts`，删除后者后前者成为孤立文件。
- **反方**：`system-prompt-config.ts` 提供 `OtterPromptConfig` 的 re-export 和 `getPriorityWeight` 工具函数，可能被未来功能使用。保留无害。
- **决策**：不清理，保留 `system-prompt-config.ts`。
- **依据**：本变更为纯清理任务，不引入新功能。保留孤立但无害的文件比过度清理更安全。如后续确认无用，可单独清理。

### 决策 3：扩展注释清理范围

- **正方**：Issue 描述列出了 3 个文件，但 `agent-invoke-port.ts` 和 `agent-invoker.ts` 也含陈旧引用，应在同一 PR 中一并清理。
- **反方**：超出 Issue 描述范围。
- **决策**：扩展到 5 个文件。
- **依据**：同一清理主题，额外 2 个文件的改动量极小（仅注释），拆分 PR 无意义。


## 交叉审视记录

**架构师-1**：独立分析 + 草稿方案
**架构师-2**：对抗审视 + Gate 自检

审视结论：**方案可锁定，无阻塞问题。**

架构师-2 独立验证了草稿中所有事实性声明（5 项 grep 验证 + 1 项依赖分析），全部与代码事实一致。补充观察：删除 `system-prompt-builder.ts` 后 `system-prompt-config.ts` 成为死文件，但认可保守保留的决策。


## 不兼容更新

无。纯代码质量优化，不改变任何外部行为或 API。

## [merge-time]

（合入阶段填写）
