---
id: F20260812r0tk
title: fix-restart-otter-tool-allowlist
doc_type: feature

summary: |
  修复 restart_otter 工具未加入允许列表的问题。
  F20260810rstart 实现了工具的完整链路（tool-factory 注册、访问控制、use case），
  但遗漏了将工具名加入 session-helpers.ts 的 allToolNames 列表，
  导致工具在运行时不可用。与 F20260811x7k3（PR230）同类 bug。

causal_links:
  from:
    - F20260810rstart

status: implemented
change_type: bugfix
tags: [agent, restart-otter, tool-allowlist, bugfix]
modules:
  - src/frameworks/agent/session-helpers.ts
  - tests/frameworks/agent/coding-tools.test.ts

capability_test: "n/a: 纯 A 类改动（工具白名单注册），无 LLM 参与行为"

created_at: 2026-08-12
---

# F20260812r0tk 修复 restart_otter 工具未加入允许列表的问题

## 问题描述

### 现象
- 大獭/小獭尝试调用 `restart_otter` 时反馈无此工具
- 实际上 F20260810rstart 已实现完整链路（tool-factory.ts:530 注册 + 访问控制 + use case）

### 根因分析
- F20260810rstart 实现了：
  1. 工具工厂注册（`createTools` 数组中的 `createRestartOtterTool(ctx)`）
  2. 访问控制（小獭只能重启自己，大獭可重启任意 Otter）
  3. use case 与 session 重启逻辑
- **遗漏**：未将 `"restart_otter"` 加入 `session-helpers.ts` 的 `getOtterToolNamesForType` 返回列表

### 影响范围
- 大獭和小獭均受影响（运行时白名单中查无此项 → 工具不可见）
- 与 PR #230 / F20260811x7k3 是同一类 bug：工具注册了但白名单没加

## 修复方案

### 修改文件
**`src/frameworks/agent/session-helpers.ts`**

1. `allToolNames`（big otter 全集）追加 `"restart_otter"`
2. small otter 返回列表追加 `"restart_otter"`

### 为什么小獭也要加
工具内部已有访问控制（`createRestartOtterTool` 第 292-294 行）：
小獭传入非自身 otterId 时直接返回错误。白名单只是"工具是否可见"，
访问控制是"能否对目标执行"——两层独立。若小獭白名单不加，
则工具内部的小獭访问控制分支成为死代码，且退化熔断等场景下
小獭无法自我重启（这是 F20260810rstart 设计的核心用例之一）。

### 验证方式
1. 重启 otter 服务
2. 大獭/小獭工具列表中应包含 `restart_otter`
3. 小獭调用 `restart_otter` 不传 otterId → 重启自己成功
4. 小獭调用 `restart_otter` 传其他 otterId → 收到访问控制错误
5. 大獭调用 `restart_otter` 传任意 otterId → 重启成功

## 测试

`tests/frameworks/agent/coding-tools.test.ts` 同步更新：
- big otter：新增 `expect(tools).toContain("restart_otter")`，长度 25→26
- small otter：同上，长度 23→24
- undefined（按 big 处理）：同上

全部 1091 个测试通过。

## 决策记录

| 决策 | 结论 | 理由 |
|------|------|------|
| 修复方式 | 一行 + 一行 | 最小改动，不引入新风险 |
| 小獭是否开放 | 是 | 工具内已实现访问控制；设计意图就是大小獭共用 |
| 是否需要额外测试 | 否 | 工具逻辑已有 F20260810rstart 测试覆盖，本 PR 只暴露工具名 |
| 是否需要特性文档 | 是 | 项目规范要求所有 PR 都有特性文档 |

## 关联

- Issue #231: https://github.com/chenlaicai/otter-buddy/issues/231
- 同类前例 PR #230 (F20260811x7k3): create_scheduled_task 工具允许列表遗漏

---

[大獭] 🦦
