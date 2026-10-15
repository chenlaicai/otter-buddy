---
id: F20261015phys
title: 物理隔离加强——bash 沙箱包裹獭执行面（主仓只读 + 进程信号隔离）
summary: |
  守卫收敛（F20261015gsub）后绕过面由物理隔离兜底。实现：sandbox-exec 包裹獭 bash
  执行面——主仓 deny file-write*（只读），白名单可写（workspaces/worktrees/alpha/tmp/
  主仓 .git——worktree git 操作链），deny signal（进程信号隔离）。注入点：SDK
  baseToolsOverride + spawnHook，不改 SDK 源码。
  实证：deny file-write 生效（/tmp 符号链接坑——profile 必须 realpath）；kill 被
  (deny signal) 拦（检视 delta 复核 D4 实测 Operation not permitted）。
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
(version 1) (allow default) (deny file-write* (subpath "<主仓 realpath>")) (allow file-write* (subpath "<workspaces realpath>")) (allow file-write* (subpath "<worktrees realpath>")) (allow file-write* (subpath "<主仓 .git realpath>")) (allow file-write* (subpath "<~/.otter/alpha realpath>")) (allow file-write* (subpath "<tmpdir realpath>")) (deny signal)
```

profile 必须单行空格分隔——多行经 JSON.stringify 后 \n 变字面两字符，SBPL
解析器报 unbound variable 崩溃（exit 65，检视发现 1 实测）。

**关键设计决策**：
- SBPL 顺序覆盖语义（后写胜出）——先 deny 主仓全集，再 allow 白名单子路径写在 deny 之后才生效（初版「deny 优先级高于 allow」是错误心智模型，检视发现 7 订正）
- 所有路径必须 realpath 解析（实证坑：macOS /tmp 是 /private/tmp 符号链接，
  profile 写 /tmp 不拦，写 /private/tmp 才拦）
- 非 macOS 平台降级为 no-op（spawnHook 原样透传）
- OTTER_BASH_SANDBOX=off 显式禁用（调试/排障逃生口）

### 包裹语义

```
sandbox-exec -p '<profile>' /bin/bash -c '<原命令>'
```

- 原命令通过 escapeCommand 转义（JSON.stringify + 追加转义 `\$` 与 `` \` ``）交给 /bin/bash -c 执行——JSON.stringify 不转义 $ 和反引号，外层无沙箱 bash 可经 $()/`` 命令替换逃逸（检视发现 2 严重）；追加转义后命令替换被推入内层沙箱执行，deny 域写入被 OS 拒（delta 复核 D2/D3 实测）
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
| (deny process*) vs (deny signal) | deny signal | deny process* 连 sandbox-exec 自身 exec 内层 bash 都拦（exit 71，检视发现 3 实测）；deny signal 只拦信号发送不影响进程执行，隔离目标等价达成 |
| 主仓 .git 白名单 | 全集（含 config） | worktree 的 .git 是文件指向主仓 .git/worktrees，deny 则獭 git commit 断链（检视发现 4）；残留面见已知限制 4 |
| 配置化开关 | 环境变量 OTTER_BASH_SANDBOX=off | 不进 config.yaml——调试逃生口，不需要正式配置面 |

## 验证

### 单测

`tests/frameworks/agent/bash-sandbox.test.ts`：19 用例全绿——
profile 构建（deny/allow 语义、单行格式、白名单路径、缓存）、isSandboxEnabled（macOS/非 macOS/环境变量）、
spawnHook 包裹语义（命令转义、cwd 透传）、createSandboxedTools（7 工具齐全、非 macOS 降级）、
以及 4 个 macOS 集成 smoke 真执行（it.skipIf 非 macOS 跳过）：逃逸闭合（deny 域标记不出现）、
kill 被拦、worktree git 链可用、多行/复合命令存活——真执行而非字符串断言，正是初轮 CI 假象的补课（检视发现 5）。

### 实证（调研阶段完成）

- sandbox-exec 存在且可用（macOS 26.7，`SANDBOX_EXEC_WORKS`）
- deny file-write* 子路径保护生效（保护目录写入 Operation not permitted，非保护目录放行）
- **realpath 坑**：profile 写 /tmp 不拦（符号链接），写 /private/tmp 才拦——已纳入实现

### 未实证项

初版未实证项「deny process* 对 kill 主进程的实际效果」已闭合：检视 delta 复核 D4
实测 (deny signal) 下 kill 被拦（Operation not permitted）。

## 已知限制

1. **sandbox-exec 已废弃**——Apple 官方标记 deprecated，未来 macOS 版本可能移除。
   迁移路径：APFS 独立卷只读挂载（调研文档 R20261015phys §3.3）。
2. **write/edit 工具不受沙箱覆盖**——它们不经过 bash spawnHook，写面由守卫覆盖。
   若需物理隔离 write/edit，需 SDK 支持 write/edit 的 operations 覆写（当前不支持）。
3. **alpha.sh 实例未沙箱化**——本特性只覆盖獭会话 bash，alpha 实例（隔离验证环境）
   的进程隔离需单独处理（同样可用 sandbox-exec (deny signal) 包裹 alpha.sh 启动命令）。
4. **主仓 .git 在白名单内且 config 可写**——白名单收全集是为 worktree git 操作链
   （检视发现 4）。当前实际防线是 hooksPath 重定向到 .githooks（deny 域，獭不可写）；
   残留攻击链：改 .git/config 的 core.hooksPath 回 .git/hooks 并放置钩子，等待
   用户在主仓跑 git 触发——链长且需等待窗口，风险中低（检视 delta 复核发现 A，实测
   .git/config 写入无拦截）。可选加固：白名单收窄到 .git/objects、.git/worktrees、
   .git/refs 子目录。

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
