---
id: F20260826wspw
title: "workspace 工具 path traversal 误报修复"
summary: |
  workspace_write / workspace_read / workspace_list（带 path）自 8/24 起全量恒报
  "Path traversal not allowed"。根因：NodeWorkspaceGateway.resolveSafe 拿
  path.resolve() 的绝对路径与可能为相对路径的 root（app.ts 默认 dataDir="./data"）
  做 startsWith 比较，恒为 false，所有正常路径被误判为穿越攻击。修复：workspaceRoot()
  统一用 path.resolve() 归一化为绝对路径。附相对 dataDir 回归测试 2 例。
change_type: fix
status: active
capability_test: "n/a: 纯代码修复，无 LLM 行为依赖"
created_in_conversation: 9ee76bfa-4a06-4162-9c2b-05b9f1057232
tags: [workspace, path-traversal, security, bugfix]
modules:
  - src/frameworks/file-system/node-workspace-gateway.ts
from: []
supersedes: []
---

## 背景

2026-08-26 搭档报告 workspace_write 任何路径都报 "Path traversal not allowed"。实测复现：`probe-root.txt` 等最普通路径也被拒绝，故障面覆盖 workspace_write / workspace_read / workspace_list（带 path 参数）三个工具；workspace_info 不走 resolveSafe 校验故正常。

## 根因

`src/frameworks/file-system/node-workspace-gateway.ts` 的 `resolveSafe()`：

```ts
const root = this.workspaceRoot(conversationId);       // 相对路径："data/workspaces/xxx"
const resolved = path.resolve(root, relativePath);     // 绝对路径："/Users/.../data/workspaces/xxx/probe.txt"
if (!resolved.startsWith(root + path.sep) && resolved !== root) {
  throw new Error("Path traversal not allowed");       // 恒触发
}
```

- `app.ts:144` 默认 `dataDir = "./data"`（相对路径），`workspaceRoot()` 用 `path.join` 拼接保留相对性
- `path.resolve()` 恒返回绝对路径，`"/Users/.../probe.txt".startsWith("data/workspaces/...")` 恒为 false
- 结果：安全校验把一切正常读写误判为攻击，fail-safe 方向（拒绝写入），无数据泄漏/越权写入风险

测试未抓住的原因：现有测试全部用 `os.tmpdir()` 构造**绝对路径** dataDir，从未覆盖相对 dataDir 场景。

## 修复

```diff
  private workspaceRoot(conversationId: string): string {
-   return path.join(this.dataDir, "workspaces", conversationId);
+   // dataDir 可能是相对路径（app.ts 默认 "./data"），必须归一化为绝对路径：
+   // resolveSafe 中 path.resolve() 的结果恒为绝对路径，与相对 root 做 startsWith
+   // 比较恒为 false，会导致所有正常读写被误判为 path traversal（2026-08-26 故障）
+   return path.resolve(this.dataDir, "workspaces", conversationId);
  }
```

单点修复：`workspaceRoot()` 是全 gateway 唯一的路径拼接出口（ensureWorkspace / removeWorkspace / exists / readFile / writeFile / listDir / getWorkspacePath 全部经由它），归一化一处即覆盖全部调用方。

副作用评估：`getWorkspacePath()` 与 `ensureWorkspace()` 的返回值从相对路径变为绝对路径。经查调用方（工具层经 `getWorkspacePath` 暴露给 agent 的 workspace_info），绝对路径是更强的契约——agent 拿到可直接用于 bash 操作，且测试断言 `path.join(tmpDir, ...)` 在 tmpDir 为绝对路径时结果不变（tmpdir 场景 join 与 resolve 等价）。全量 1638 测试通过，无破坏。

## 回归测试

`tests/frameworks/file-system/node-workspace-gateway.test.ts` 新增 describe 块「相对 dataDir（app.ts 默认 ./data）」：

1. `writeFile/readFile/listDir 用相对 dataDir 正常工作`——精确复现故障场景（chdir 后用 `"./data"` 构造 gateway），修复前必挂
2. `相对 dataDir 下 .. 穿越仍被拒绝`——确认修复没有放松安全校验

## 验证

- `npx vitest run tests/frameworks/file-system/node-workspace-gateway.test.ts`：18/18 通过
- `npx vitest run` 全量：137 文件 / 1638 测试全部通过
- 实测：修复前 `workspace_write("probe-root.txt")` 报 Path traversal；修复后正常写入（待部署后验证）

## 影响范围

- 修复对象：workspace 工具族（write/read/list 带 path）——影响所有对话的工作区读写
- 引入时间：路径校验代码随 PR #375（R20260821tutv）于 8/24 合入，即故障自 8/24 起
- 无 schema 变更、无 API 变更、无破坏性变更（返回绝对路径视为增强而非破坏）
