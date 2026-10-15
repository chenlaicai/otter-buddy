---
id: F20261015phys
title: 物理隔离加强——bash 沙箱包裹獭执行面（主仓只读 + 进程信号隔离）
summary: |
  守卫收敛（F20261015gsub）后绕过面由物理隔离兜底。实现：sandbox-exec 包裹獭 bash
  执行面——主仓 deny file-write*（只读），白名单可写（workspaces/worktrees/alpha/tmp），
  deny process*（进程信号隔离）。注入点：SDK baseToolsOverride + spawnHook，不改 SDK 源码。
  实证：deny file-write 生效（/tmp 符号链接坑发现——profile 必须 realpath）；deny process*
  语义明确未实证（守卫拦探针，收敛后保留规则在起作用）。
change_type: feature
capability_test: tests/frameworks/agent/bash-sandbox.test.ts
created_in_conversation: 0d48b657-825d-46d5-bae1-6e13fc0fac7f
created_at: 2026-10-15T13:15:00+08:00
intent:
  problem: "bash 守卫收敛后（F20261015gsub），绕过面（间接引用/eval 包装/混淆形态）无防护——守卫只拦常见直白形态，绕过面需物理隔离兜底"
  expected_effect: "獭的 bash 执行面被 sandbox-exec 包裹：写主仓物理被拒（Operation not permitted），kill 主进程被拒，写工作区/worktree/alpha/tmp 放行——绕过面归零"
  verify_by:
    type: capability_test
causal_links:
  - F20261015gsub
---

# 物理隔离加强——bash 沙箱包裹獭执行面

## 目标

守卫收敛后，绕过面（间接引用/eval 包装/混淆形态）由 OS 层硬边界兜底——
獭的 bash 执行面物理上无法写主仓、无法 kill 主进程，无论命令形态如何。

## 非目标

- write/edit 工具的写面——由守卫的 write-target-evaluator 覆盖，不在本沙箱范围
- gh merge 拦截——不是文件系统操作，保留在守卫层
- 主服务自身 bash——主服务不经过 createAgentSession，不受影响

## 方案设计

### 注入点

pi-coding-agent SDK 的 `createAgentSession` 支持 `baseToolsOverride` 覆写内置工具集，
`createBashTool(cwd, { spawnHook })` 支持 `spawnHook` 钩子在每条 bash 命令执行前改写 command。

改动点：`pi-session-factory.ts` 的 `createAgentSession` 调用加 `baseToolsOverride`。

### sandbox-exec Profile

```lisp
(version 1)
(allow default)
(deny file-write* (subpath "<主仓 realpath>"))
(allow file-write* (subpath "<data/workspaces realpath>"))
(allow file-write* (subpath "<.otter/worktrees realpath>"))
(allow file-write* (subpath "<~/.otter/alpha realpath>"))
(allow file-write* (subpath "<tmpdir realpath>"))
(deny process*)
```

**关键设计决策**：
- deny 优先级高于 allow——先 deny 主仓全集，再 allow 白名单子路径
- 所有路径必须 realpath 解析（实证坑：macOS /tmp 是 /private/tmp 符号链接，
  profile 写 /tmp 不拦，写 /private/tmp 才拦）
- 非 macOS 平台降级为 no-op（spawnHook 原样透传）
- OTTER_BASH_SANDBOX=off 显式禁用（调试/排障逃生口）

### 包裹语义

```
sandbox-exec -p '<profile>' /bin/bash -c '<原命令>'
```

- 原命令通过 JSON.stringify 转义（双引号 + 内部转义），交给 /bin/bash -c 执行
- sandbox-exec 是 OS 层拦截，进程内无法逃逸——獭无法在 bash 内脱掉沙箱
- spawnHook 由 SDK 在每次 execute 时调用，獭无法跳过

## 影响范围

| 面 | 影响 |
|----|------|
| 獭 bash 执行 | 写主仓物理被拒（Operation not permitted），写白名单路径放行 |
| 獭进程信号 | kill 任何进程被拒（Operation not permitted） |
| 主服务 | 不受影响（不经过 createAgentSession） |
| 搭档终端 | 不受影响 |
| 非 macOS | 降级为无沙箱（行为同旧） |

## 取舍

| 取舍 | 选择 | 理由 |
|------|------|------|
| sandbox-exec 废弃状态 | 仍采用 | 当前可用（macOS 26.7），未来移除时迁移到 APFS 方案 |
| baseToolsOverride vs shellCommandPrefix | baseToolsOverride | prefix 是多行脚本前置（bash.js:173），不是 exec 包裹——语义不对 |
| 全量 7 工具覆写 vs 只覆写 bash | 全量覆写 | SDK baseToolsOverride 语义是「覆写后工具集 = override keys」，只传 bash 会丢其他 6 个 |
| deny process* 粒度 | 全禁 | macOS 无 PID namespace，deny process* 语义等价但更粗——有效 |
| 配置化开关 | 环境变量 OTTER_BASH_SANDBOX=off | 不进 config.yaml——调试逃生口，不需要正式配置面 |

## 验证

### 单测

`tests/frameworks/agent/bash-sandbox.test.ts`：10 用例全绿——
profile 构建（deny/allow 语义、白名单路径、缓存）、isSandboxEnabled（macOS/非 macOS/环境变量）、
spawnHook 包裹语义（命令转义、cwd 透传）、createSandboxedTools（7 工具齐全、非 macOS 降级）。

### 实证（调研阶段完成）

- sandbox-exec 存在且可用（macOS 26.7，`SANDBOX_EXEC_WORKS`）
- deny file-write* 子路径保护生效（保护目录写入 Operation not permitted，非保护目录放行）
- **realpath 坑**：profile 写 /tmp 不拦（符号链接），写 /private/tmp 才拦——已纳入实现

### 未实证项

- deny process* 对 kill 主进程的实际效果——探针命令含 kill 字面被守卫拦
  （收敛后保留规则在起作用，非误拦）。语义明确（Apple 文档 + 社区验证），
  落地后由 e2e 测试覆盖。

## 已知限制

1. **sandbox-exec 已废弃**——Apple 官方标记 deprecated，未来 macOS 版本可能移除。
   迁移路径：APFS 独立卷只读挂载（调研文档 R20261015phys §3.3）。
2. **write/edit 工具不受沙箱覆盖**——它们不经过 bash spawnHook，写面由守卫覆盖。
   若需物理隔离 write/edit，需 SDK 支持 write/edit 的 operations 覆写（当前不支持）。
3. **alpha.sh 实例未沙箱化**——本特性只覆盖獭会话 bash，alpha 实例（隔离验证环境）
   的进程隔离需单独处理（同样可用 sandbox-exec deny process* 包裹 alpha.sh 启动命令）。

## 负面向验收

本次变更**没有**破坏任何旧契约：
- 獭的合法写面（workspaces/worktrees/alpha/tmp）全部放行
- 主服务 bash 不受影响
- 非 macOS 行为不变
- 守卫规则不变（沙箱是 OS 层补充，不是替代）

**绕过的既有保护**：无——沙箱是新增 OS 层保护，不绕过任何既有机制。

## 最简实现检查

已过最简检查：
- 仓库已有实现？无——首次引入物理隔离
- stdlib/平台原生？sandbox-exec 是 macOS 原生工具
- 已装依赖？SDK 已导出 createBashTool + spawnHook——无需新依赖
- 新代码量：bash-sandbox.ts 约 100 行 + pi-session-factory.ts 改动 5 行 + 测试约 120 行
