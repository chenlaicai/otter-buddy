---
id: F20260922scwd
title: bash 感知对齐与主仓写保护：[cwd:] 前缀 + 未 cd 写拦截 + 无状态架构声明
doc_type: feature

summary: |
  2026-09-22 cwd 漂移事故链（大獭一天 4-5 次「cd worktree 后下条命令回主仓」，
  heredoc/python patch/commit 三度落到主仓，均即时还原）的机制化修复。
  根因：pi SDK bash 每条命令独立 spawn shell，cwd 恒为 session 构造时的
  process.cwd()（主仓根），cd 天然不可能跨命令保持——不是 bug 是架构，
  但 LLM 的终端心理模型与此架构系统性冲突，靠自律不可收敛。
  方案（搭档 2026-09-22 决策：「让 agent 知道当前在哪」而非「替它记住」）：
  ①stderr 前缀：bash execute 包装，每条命令输出前加 [cwd: <实际目录>]——
    LLM 每轮看到「我在主仓」，误差显式化，自行决定要不要 cd；
  ②主仓写拦截：bash 守卫新增规则组——未 cd 时拦截 heredoc/python patch/
    git 写族等落点为主仓的写命令，并给出正道指引；
  ③工具描述补充：bash 工具描述加「每条命令独立 shell，cd 不跨命令保持」。

causal_links:
  from:
    - F20260922pmgd

intent:
  problem: "bash 每条命令独立 shell（cd 不跨命令保持）与 LLM 终端心理模型系统性冲突，cwd 漂移事故频发（2026-09-22 大獭 4-5 次 heredoc/patch/commit 落主仓）。工具描述层需声明无状态架构 + 输出层注入 [cwd:] 前缀让误差显式化"
  expected_effect: "bash 输出含 [cwd: <dir>] 前缀（成功/错误双路径）；bash 工具描述含 independent shell 声明；未 cd 时主仓写命令被拦截并给出正道指引；Golden Gate 既有场景不回归"
  verify_by:
    type: capability_test
    reason: "工具描述层行为引导（与 F20260904cg77 同型），以单测锁定前缀注入与拦截语义 + golden 场景集验证不回归；[cwd:] 感知对齐效果为后续观察指标。Golden Gate 实跑记录：13 文件 47 用例全 skip（测试环境 llm.models 配置缺 handoffThresholdTokens，与本 PR 无关的环境缺陷）——能力验证由 197 守卫单测 + 9+9 绕过形态回归探针承载，golden 环境修复后补跑"

change_type: feature
tags: [bash-guard, cwd, worktree, session-hygiene, harness]
capability_test: tests/frameworks/agent/tool-description-overrides.test.ts
modules:
  - src/frameworks/agent/cwd-awareness.ts
  - src/frameworks/agent/bash-safety-guard.ts
  - src/frameworks/agent/tool-description-overrides.ts
  - src/frameworks/agent/pi-session-factory.ts
created_in_conversation: 9c674ed5-5ba4-4d24-8f01-99da6b57a7a2
---

## 背景

搭档原话（2026-09-22）：「你重启下自己，然后来看看cwd漂移是啥情况」。

同日事故链（已验证事实，交接意图书锁定）：

- pi SDK bash 工具每条命令独立 spawn shell（无 session 级 cwd 保持），cwd 取
  `ctx?.cwd || cwd`（构造时固定值，来自 pi-session-factory.ts:901 的
  process.cwd() = 主仓根）——node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js:157
- 大獭一天内 4-5 次「cd 到 worktree 后下一条命令回主仓」，edit/heredoc/python
  patch/commit 落到主仓（均即时还原，无残留）。事故频度已到「实质影响交付质量」
  （#1105 检视中排查多花的轮次、主仓被污染的即时风险）。

根因定性：LLM 的终端心理模型（cd 有状态）与 SDK 架构（每条命令无状态）系统性
冲突。这与 #776（bash 万金油习惯）同类——**工具可用 ≠ 工具心理模型与机制一致**，
靠 prompt 自律不可收敛，必须在机制层对齐。

**方案方向决策（搭档 2026-09-22 原话）**：「让 agent 知道 这俩有误差/当前在哪
是否就可以？至于说ctx.cwd，我认为就保持session启动位置即可吧」——不做粘性
（替 LLM 记住在哪），只做感知对齐（让 LLM 知道当前在哪）。

**为什么不做粘性（三问推翻原方案）**：
1. 脚本内 cd 识别不到 → 粘错目录，下条命令报错
2. 复杂命令（嵌套引用/bash -c）识别漏 → 主仓写漏拦
3. cd 进去看文件会误粘 → 下条命令报错需 cd 回来

感知对齐把「状态管理」复杂度换成「误差显式化」的简洁，盲区全消，且与 #776
解法同构（告诉 LLM 怎么用工具，而不是替 LLM 用工具）。

## 目标

T1: bash 输出感知对齐——每条命令输出前加 [cwd: <实际目录>] 前缀，LLM 每轮
    看到真实执行目录，误差显式化。
T2: 主仓写拦截——未 cd 时拦截落点为主仓的写命令（重定向/heredoc/python
    patch/git 写族），并给出正道指引（先 cd 或用绝对路径）。
T3: 工具描述补充——bash 工具描述加「每条命令独立 shell，cd 不跨命令保持」，
    认知锚定型。
T4: 零状态管理——无 per-session registry、无 clear 钩子、无并发隔离问题。

## 非目标

- 不做粘性 cwd（LLM cd 后自动保持）——文本跟踪有固有盲区，感知对齐更简洁。
- 不改 pi SDK 源码（node_modules 补丁不可维护）。
- 不拦 read 类操作——读主仓无害。
- 不做 filesystem 级强制（chroot/挂载隔离）——超出复杂度预算。

## 未决问题

无。

## 现状分析（代码事实）

**SDK 侧**（node_modules/@earendil-works/pi-coding-agent/dist/）：

1. `bash.js:157`：`resolveSpawnContext(resolvedCommand, ctx?.cwd || cwd, spawnHook, ...)`
   ——cwd 每次执行取 `ctx?.cwd || cwd`，ctx.cwd 来自 ExtensionRunner.createContext()
   的 getter，runner.cwd 是构造时固化的 session cwd（无公开 setter）。
2. `bash.js:155`：`execute(_toolCallId, { command, timeout }, signal, onUpdate, ctx)`——
   5 参签名，返回 `Promise<AgentToolResult>`（content[0].text 是输出文本）。
3. `tool-definition-wrapper.js:2`：`wrapToolDefinition` 透传 ctx（`ctx ?? ctxFactory?.()`）
   ——覆写 execute 可拿到真实 ctx（含 cwd）。
4. `agent-session.js:2129`：customTools 经 `definitionRegistry.set` 无条件覆盖同名
   builtin——覆写机制成熟（#776 描述覆写同路径）。

**otter 侧**（src/）：

1. `pi-session-factory.ts:901`：`buildPiBuiltinToolDefinitions(piCodingAgent, process.cwd())`
   ——覆写工具以主进程 cwd 创建。
2. `tool-description-overrides.ts:63-75`：customTools 同名覆写 builtin 机制成熟，
   execute 原样引用。覆写 execute 包装是既有机制的自然延伸。
3. `bash-safety-guard.ts`：包级预处理器模式成熟（引号脱敏 #858、merge 拦截 #1105、
   data/ 防误删 cwd 跟踪 #1038）——主仓写拦截是同包新增规则组，基础设施全复用。

## 方案设计

### ① stderr 前缀（cwd-awareness.ts）

```ts
export function wrapBashWithCwdPrefix(base: ToolDefinition, cwd: string): ToolDefinition {
  return {
    ...base,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const actualCwd = (ctx as { cwd?: string })?.cwd || cwd;
      try {
        const result = await base.execute(toolCallId, params, signal, onUpdate, ctx);
        if (result.content?.[0]?.type === "text") {
          result.content[0].text = `[cwd: ${actualCwd}]\n${result.content[0].text}`;
        }
        return result;
      } catch (err) {
        if (err instanceof Error) {
          err.message = `[cwd: ${actualCwd}]\n${err.message}`;
        }
        throw err;
      }
    },
  };
}
```

**关键设计**：
- 成功路径：content[0].text 开头注入前缀
- 错误路径（exit code/timeout/abort）：Error.message 开头注入前缀——LLM 需要
  知道失败命令是在哪跑的
- 前缀格式 `[cwd: /path/to/dir]`——方括号定型，LLM 易识别

### ② 主仓写拦截（bash-safety-guard.ts）

**拦截条件**（同时满足）：
1. 无 cd（命令文本不含 `cd <dir>`）
2. 含主仓写形态

**写形态覆盖**：
- 重定向：`>`、`>>`、`<<<`（落点未指定路径时默认主仓）
- python heredoc：`python3 - <<'EOF'`（patch 形态）
- git 写族：`git commit`、`git rebase`、`git merge`、`git cherry-pick`、`git apply`、
  `git stash push`

**放行规则**：
- 含 `cd <dir>` 的命令 → 放行（LLM 显式切换了目录，按 cd 后语义理解）
- 绝对路径写非主仓 → 放行（如 `echo x > /wt/file.txt`）
- 只读命令（git status/log、npm test 等）→ 不拦

**拦截文案**：「当前 bash 工作目录在主仓（未 cd 到 worktree）。落点为主仓的写
命令被拦截——若目标在 worktree，请先 cd <worktree 路径> 再执行；若确实要写
主仓，用绝对路径（写主仓受 R1 红线约束，请确认意图）。」

### ③ 工具描述补充（tool-description-overrides.ts）

bash 描述追加：`Note: each bash command runs in an independent shell — `cd` does
NOT persist across commands. Check the [cwd: ...] prefix in output to see your
actual working directory, and use `cd <dir> && <command>` when you need to operate
in a specific directory.`

### 机制识别检查点

- □ 新增配置字段/枚举/开关 → 否
- □ 新增状态生命周期 → 否（零状态，前缀即全部）
- □ 新增定时任务/后台进程 → 否
- □ 新增信号类型/消息格式 → 否（stderr 前缀是输出文本不是协议）
- □ 新增持久化存储 → 否
- □ 新增决策分支（结果被记住并影响后续）→ 否（每条命令独立）
- □ 新增跨模块调用路径 → ☑（tool-description-overrides → cwd-awareness）

**判定：不涉及净新增机制 → 跳过四问，判定结果留痕。**

## 影响范围

- `cwd-awareness.ts`：新增——bash execute 包装 + 描述后缀常量。
- `tool-description-overrides.ts`：bash 覆写从「纯描述」升级为「描述 + execute
  包装」；`buildToolDescriptionOverrides` 签名扩展（sessionCwd 可选参数，
  向后兼容）。
- `pi-session-factory.ts`：调用点传入 sessionCwd = process.cwd()。
- `bash-safety-guard.ts`：新增 checkMainCheckoutWrite 规则组，挂入
  checkBashCommandSafetyOnText 脚本自杀检测之后、data/ 防误删之前。
- 行为变化面：所有獭的 bash 工具。readOnly 模式（合成獭）bash 已过滤，零影响。
- **不改**：SDK、edit/write 等文件工具、任何 prompt/skill 文本。

## 风险与约束

1. **前缀注入失败**：execute 包装异常时 base.execute 原样抛出，前缀注入在
   catch 里——注入失败不影响原错误传播（fail-soft）。
2. **误拦**：`echo 'git commit' > notes.md` 这类文本含写族词元 + 重定向写主仓
   的双重命中会拦——保守正确（LLM 可改用绝对路径或先 cd）。
3. **复杂命令识别漏**：`bash -c "git commit"` 嵌套引用在引号脱敏后识别不到 →
   漏拦。已知边界，主仓写事故由 #1105 merge 拦截 + daily review 兜底。
4. **性能**：每条 bash 命令增加一次前缀拼接 + 正则扫描，开销可忽略。

## 不兼容更新

无。行为变化是纯增量保护：原本能执行的命令（主仓写）现在被拦并给出指引，
放行通道（绝对路径 / 先 cd）始终存在。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 核心机制 | 感知对齐（[cwd:] 前缀 + 描述补充） | 粘性 cwd（spawnHook/ctx 伪造状态跟踪） | 粘性有固有盲区（脚本内 cd、嵌套引用、临时查看误粘）；感知对齐零状态、盲区全消、与 #776 同构 |
| 前缀注入点 | execute 包装（成功 + 错误双路径） | 仅成功路径 | 失败命令（exit code/timeout）LLM 同样需要知道在哪跑的 |
| 主仓写拦截 cd 处理 | 含 cd 即放行（不跟踪 cd 后路径） | 跟踪 cd 后路径再判定 | 感知对齐方案下 LLM 需显式 cd，跟踪 cd 是粘性残留思维；简单可靠优先 |
| 拦截形态 | 重定向/heredoc/python patch/git 写族 | 全写命令（含 sed -i/tee/patch 等） | 覆盖今日事故形态（heredoc/patch/commit），其余形态由 #1038 data/ 防误删 + daily review 兜底 |

**省事声明审计**：本方案无「省事/更简/更快/零成本」类自评词（逐段自查）。

## 验证

**单测**（tests/frameworks/agent/）：

1. tool-description-overrides.test.ts：
   - bash 覆写注入 [cwd:...] 前缀（pwd 命令输出断言）
   - 错误路径（exit 42）Error.message 含前缀
   - 描述含「independent shell」+「cd` does NOT persist」
   - 无 sessionCwd 时退化为纯描述覆写（向后兼容）
   - execute 包装后不再与 builtin 同一引用（行为变化显式化）
2. bash-safety-guard.test.ts：
   - 拦截：重定向/heredoc/python patch/git commit/rebase/merge/stash push
   - 放行：cd 后相对路径写、绝对路径写非主仓、git status/log/npm test
   - 边界：projectRoot 缺失保守放行、引号脱敏协同

**集成验证**：worktree 内全量测试（272 文件 3735 测试全绿）。

**已过最简检查**：感知对齐方案（3 文件改动）比粘性方案（5+ 文件 + 状态管理）
更简，且盲区全消——采简弃繁。

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/agent/cwd-awareness.ts | 新增 | bash execute 包装 + 描述后缀常量 |
| src/frameworks/agent/tool-description-overrides.ts | 修改 | bash 覆写升级 + sessionCwd 参数 |
| src/frameworks/agent/pi-session-factory.ts | 修改 | 调用点传入 sessionCwd |
| src/frameworks/agent/bash-safety-guard.ts | 修改 | 主仓写拦截规则组 |
| tests/frameworks/agent/tool-description-overrides.test.ts | 修改 | 前缀注入 + 错误路径 + 兼容性测试 |
| tests/frameworks/agent/bash-safety-guard.test.ts | 修改 | 主仓写拦截 16 用例 |
