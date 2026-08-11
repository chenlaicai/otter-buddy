---
id: F20260810tools
title: small-otter-coding-tools
doc_type: feature

summary: |
  开放小獭（small otter）的编码工具权限：write/edit/bash。
  之前小獭只有 read 工具，无法完成实际工作（写代码、评论 PR、执行命令）。
  管理类工具（invite_participant/create_otter/dissolve_otter/manage_healing_events）继续限制给大獭。

causal_links:
  from:
    - F20260805rsto   # 重启獭生 session 机制
  to: []

status: development
change_type: feature_update
tags: [agent, tools, permissions, small-otter]
modules:
  - src/frameworks/agent/session-helpers.ts
  - tests/frameworks/agent/coding-tools.test.ts
capability_test: "n/a: 纯 A 类改动，工具列表是确定性逻辑，不涉及 LLM 行为"
---

# F20260810tools: 小獭编码工具权限开放

## 背景

搭档原话：
> "你去查一下今天的几个对话，我发现所有的小獭都在说自己是只读，没有权限。但比如说 检视獭，检视意见是需要评论到pr上的。你排查下，这个 只读 权限是啥"

当前状态：`session-helpers.ts` 的 `getCodingToolsForOtterType` 函数对 small otter 只返回 `["read"]`，导致：
- 开发獭无法写代码
- 检视獭无法执行 `gh pr comment` 评论到 PR
- 任何需要 bash 的操作都无法执行

## 目标

- **T1**: small otter 获得全部编码工具 `read`/`write`/`edit`/`bash`
- **T2**: 管理类工具（`invite_participant`/`create_otter`/`dissolve_otter`/`manage_healing_events`）继续限制给 big otter
- **T3**: 新增测试验证工具列表正确性

## 非目标

- 不改变 `getOtterToolNamesForType` 的行为（管理类工具隔离已存在）
- 不改变 big otter 的工具权限
- 不引入新的 otterType 变体（如 medium otter）

## 方案设计

### 1. 修改 `getCodingToolsForOtterType`

```typescript
// src/frameworks/agent/session-helpers.ts
export function getCodingToolsForOtterType(_otterType: string | undefined): string[] {
  // big 和 small otter 均启用全部编码工具
  return ["read", "write", "edit", "bash"];
}
```

- 函数现在返回常量数组，`_otterType` 参数保留以减少调用方改动
- 注释说明决策理由（Why: small otter 需要写代码、评论 PR、执行构建命令）

### 2. 新增测试

```typescript
// tests/frameworks/agent/coding-tools.test.ts
describe("getCodingToolsForOtterType", () => {
  it("big otter 应包含全部编码工具", () => { ... });
  it("small otter 应包含全部编码工具", () => { ... });
  it("undefined otterType 应按 big otter 处理", () => { ... });
  it("空字符串 otterType 应按 big otter 处理", () => { ... });
});

describe("getOtterToolNamesForType", () => {
  it("big otter 应包含所有工具", () => { ... });
  it("small otter 应包含消息/记忆/上下文/术语/产物/参与者/工作区工具，不含管理类工具", () => { ... });
  it("undefined otterType 应按 big otter 处理", () => { ... });
});
```

## 影响范围

- 所有 small otter（开发獭、检视獭等）将获得 write/edit/bash 权限
- 不影响 big otter 和 HTTP API

## 风险与约束

- **安全性**：small otter 获得 bash 权限意味着可以执行任意 shell 命令。这是设计意图（需要执行 `gh pr comment` 等命令），安全边界从"编码工具隔离"转移到"管理工具隔离（`getOtterToolNamesForType`）"
- **破坏性变更**：无。之前 small otter 只读，现在可读写，是功能增强

## 不兼容更新

无

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|----------|------|
| `getCodingToolsForOtterType` 参数处理 | 保留 `_otterType` 参数 | 移除参数 | 保留以减少调用方改动，后续如有多个 otterType 变体再考虑 |
| `getOtterToolNamesForType` 中管理工具隔离 | 保持现有隔离 | 无 | 已存在且测试覆盖 |

## 验收标准

- [x] small otter 获得 read/write/edit/bash 工具
- [x] 管理类工具（invite_participant/create_otter/dissolve_otter/manage_healing_events）继续限制给 big otter
- [x] 新增测试验证工具列表正确性
- [x] 全量测试通过（87 个测试文件，1049 个测试）

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/frameworks/agent/session-helpers.ts` | 修改 | `getCodingToolsForOtterType` 返回全部编码工具 |
| `tests/frameworks/agent/coding-tools.test.ts` | 新增 | 验证工具列表正确性 |
| `docs/features/2026/08/10/F20260810tools-small-otter-coding-tools.md` | 新增 | 特性文档 |
