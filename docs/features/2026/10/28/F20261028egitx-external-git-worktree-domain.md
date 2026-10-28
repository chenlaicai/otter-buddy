---
id: F20261028egitx
title: 外部仓隔离 worktree 的 Git 写执行域与真实沙箱装配
summary: 修复 #1682 跨仓提交回归；从目标真实 Git 注册表识别受控隔离 worktree，并补齐 SDK 丢弃 baseToolsOverride 造成的物理沙箱断链。
change_type: fix
capability_test: "n/a: 确定性 Git 执行域与工具装配由单元、真实沙箱及真实 SDK 集成测试覆盖"
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
causal_links:
  - F20261027gscv
tags: [bash-guard, git, cross-repo, bugfix]
modules: [src/frameworks/agent/git-execution-policy.ts, src/frameworks/agent/bash-sandbox.ts, src/frameworks/agent/pi-session-factory.ts, src/interface-adapters/agent-runtime/tools/tool-factory.ts]
---

## 目标

修复 #1682：CoLink 等外部项目已登记在 `<repo>/.otter/worktrees/<name>` 的 worktree 可执行既有白名单 Git 工作流。补齐同一执行链上独立审计发现的生产沙箱装配断链，保持主目录、未登记路径与 `.git` 指针的默认拒绝。

## 非目标

不放开外部主目录、main/develop 直写、任意 Git 元数据写或复杂 Shell；不新增 Git 子命令语义，不建立通用特权 broker。`restart_service` 仅复用现有 dev server 白名单脚本，不新增 `--add`、任意 PID 或主服务重启权限；主进程保护不减弱。本 PR 不代表旧运行进程已加载新代码。

## 设计与取舍

机制判定：命中②权限约束，修复已有授权事实源，不改豁免集合；④涉及既有 Git 执行域扩展。只承认真实 `git worktree list` 中、直接位于外部仓 `.otter/worktrees/` 的已登记 worktree，主目录和普通外部目录不认。退役条件：若跨仓执行上下文由宿主提供受信任 repo/worktree 注册源，可删除只读 Git 探测适配；授权与拒绝边界保留。

### Git 执行域（L1）

linked worktree 的 `rev-parse --show-toplevel` 返回 worktree 根，不是主仓根。解析器用 `git rev-parse --path-format=absolute --git-common-dir` 定位公共 Git 根，再按行读取 `worktree list --porcelain -z` 的 worktree 项。只读探测失败 fail-closed；按 NUL 字段解析，拒绝路径内控制字符，换行不能伪造注册表条目。grant 记录外部 worktree 根，profile 同时保留宿主只读/自治区与外部最小 Git 写域；普通写 allow 先于通用 `.git` deny，防止重开指针。外部目标只开放 add/commit，不扩到 fetch/push/worktree/branch-delete。

### SDK 装配（L1）

实测本仓锁定的 1.1.0 与最新 1.4.0 `createAgentSession` 均不转发 `baseToolsOverride`。`tools=[] + 同名 customTools` 亦被 allowlist 过滤，不能作为替代。第一版手工 `Agent` 装配在独立检视中证实漏掉 thinking 默认链、context 扩展等语义，已整段撤回。

最终采用锁定 1.1.0 的 `patch-package` 最小补丁：`sdk.d.ts` 声明已有构造器支持的 `baseToolsOverride`，`sdk.js` 仅向 `AgentSession` 转发该字段。生产其余 thinking/context/retry/cache/model 恢复仍走原 `createAgentSession`，不复制第二份装配。`postinstall` 应用补丁；build/start 前置 `check-sdk-patch.mjs` 校验锁定版本和转发存在，缺失即失败。升级 SDK 时必须重验补丁与标准装配测试，未自动支持 1.4.0。

### 受控重启（L1）

物理沙箱恢复后 `(deny signal)` 重新承重。注册窄 `restart_service(port, projectDir?)`，由宿主直接 `execFile(process.execPath, [固定脚本, ...])`，不经 bash，不开放任意 signal。manifest 全局 deferred，大小獭经 `tool_search` 按需激活；manifest 与 fallback 均覆盖。

## Modification-Class 与机制预算

`Modification-Class: mechanism-addition`。检查点：新增 `restart_service` 工具、固定 argv 执行器与 manifest 项；新增 `externalWorktreeRoot` 授权状态；新增 SDK 补丁安装/启动检查。①所有獭与外部已登记 worktree 需要它，否则 #1682 阻断，且物理沙箱断链没有真实承重。②没有它则回到主目录裸写/跨仓不能提交，风险已复现；失败时补丁检查 fail-closed、未登记与管理写仍拒绝。③后续机制只有已有受控脚本与现有 Git envelope/profile，不新增 broker 或 Shell parser；`patch-package` 安装链和启动检查是同一补丁的必要交付。④上游原生转发 `baseToolsOverride` 并升级验证后，删除本地补丁及版本锁定检查；跨仓可信上下文由宿主提供后，删除只读注册表适配，保留拒绝边界。

## 验收标准

| 场景 | 操作 | 预期 |
|---|---|---|
| #1682 原样回归 | 对外部已登记隔离 worktree 执行 `git -C … commit` / `cd … && git commit` | 真实 add/commit 成功 |
| 外部主目录 | `git -C <external-repo> add/commit` | 文本层与物理层均拒绝 |
| 未登记路径 | 伪造 `.git` 指针目录执行 commit | resolver null，沙箱拒绝 |
| 宿主逃逸 | 外部 Git pre-commit 钩子写宿主仓 | 文件不存在 |
| 元数据边界 | 外部 Git pre-commit 钩子写 worktree `.git` 指针 | 指针不变 |
| SDK 装配 | 经标准 `createAgentSession` 创建真实 AgentSession，执行 bash/write/edit | 宿主 bash 写拒绝；write 守卫生效；授权区 edit 成功 |
| 主链语义 | 固定模型默认/恢复 thinking；inline context 扩展改写消息 | 默认 medium、恢复 high、消息被实际改写；未复制 SDK 装配 |
| 重激活 | `setActiveToolsByName([])` 后恢复工具名单 | bash 仍为沙箱实现 |
| 受控重启 | 固定参数调用、相对路径拒绝 | 不经 bash；不开放 PID/`--add`；脚本原校验保留 |

## 验证

红链：#1682 外部集成原返回 null；授权组合初测暴露宿主只读域丢失与 `.git` 指针重开；真实 SDK 测试证实原生产接线丢弃覆盖工具，`tools=[] + customTools` 激活后为空。均已以落点/注册表/退出码复核，不以 mock 入参代替行为。

交付前执行：`npm run build`、`npm test`（含标准 SDK 与临时外部仓沙箱集成）、干净安装后 postinstall 补丁检查。最简实现检查：独立检视证明手工装配非最简且破坏语义，已撤回；最终为两处依赖补丁、一个安装/启动检查，无第二份 SDK 工厂。负面向：外部管理写未新增，主目录/未登记路径与宿主 `.git` 保护未绕过；主服务重启权限未扩大。当前运行实例仍是旧进程；合入并通过既有受控运维流程重启后才宣称生产恢复。

## 独立检视 r1 处置

S1/S2 采纳：撤回手工装配，标准工厂恢复 thinking/context/retry 等主链，新增语义集成测试。S3 采纳：本 commit 改声明为 mechanism-addition，补四问。S4 采纳：文档改为 manifest 全局 deferred。A1 采纳：NUL 字段解析并拒绝控制字符。A2 采纳最小授权：外部 fetch/push/worktree/branch-delete 拒绝，worktree add 错位入口因此不可达。A3 已记录：补丁锁定 1.1.0，升级 SDK 必须复核。
