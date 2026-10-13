---
id: F20261013cwsp
title: 海獭 bash cwd 切换对话工作区（主仓从默认落点降级为显式目标）
change_type: refactor
created: 2026-10-13
created_in_conversation: f3567df1-e24b-49cd-a020-cdb39572f853
summary: 海獭写类工具（bash 写命令/write/edit）默认落点从主仓根切换到对话工作区，读类留主仓（非对称默认）；bash 从 buildPiBuiltinToolDefinitions 拆出独立构造传工作区 cwd；守卫 projectRoot 显式注入解耦；池键加 conversationId 解跨对话复用错位；命令向量守卫 rewrite 闭环
status: draft
---

## 对抗审视处置（检视獭-cwd · MiMo · round 1 → v2 → round 2 → v3 → round 3 → v4）

### Round 1（2026-10-13 18:09）

重对抗门结论：**确认治本（限定范围）**——写向量治本，命令向量治标残留。

| 发现 | 级别 | 处置 |
|---|---|---|
| S1 整搬过重 | 严重 | 采纳 → 非对称默认 |
| S2 命令向量治标残留 | 严重 | 采纳 → 守卫 rewrite（改动点 9） |
| S3 工具归属标错 | 严重 | 采纳 → write/edit 归改动点 1，read 五件套归改动点 3 |
| J1-J5 | 建议 | 4 采纳 1 部分采纳 |

### Round 2 delta（2026-10-13 18:29）

Delta 结论：**未通过**——两条新严重发现均在改动点 10（ctx.cwd）。

| 发现 | 级别 | 处置 |
|---|---|---|
| S4 改动点 10 主注入点指错 ctx 对象 | 严重 | 采纳——pi-agent-core agent-loop.js:574 确认工具 execute 只传 4 参（无 ctx）。改动点 10 删除 |
| S5 统一 ctx.cwd 与非对称自相矛盾 | 严重 | 采纳——`ctx?.cwd \|\| cwd` 优先级高于构造 cwd，统一注入覆盖读类主仓 cwd |
| J6/J7/J8 | 建议 | 全采纳 |

**v3 转向**：砍 ctx.cwd，改构造期分裂 + 池键加 conversationId。

### Round 3 delta（2026-10-13 21:11）

Delta 结论：**未通过**——S6 构造点归属错误，bash 被误分组。

| 发现 | 级别 | 处置 | 修订落点 |
|---|---|---|---|
| S6 bash 分组归属错误 | 严重 | **采纳**——tool-description-overrides.ts:74-82 确认 bash 在 buildPiBuiltinToolDefinitions 五件套里（行 77），与 read/grep/find/ls 共用单一 cwd 参数；agent-session.js:2831-2835 确认 customTools override 同名 base——bash 被 override 回主仓 cwd，方案失效。**修正：bash 从五件套拆出，独立构造传工作区 cwd** | v4 改动点 3/4 重写 |
| J9 bash 移出 override 需保留 [cwd:] 前缀 | 建议 | **采纳**——bash 独立构造后仍经 wrapBashWithCwdPrefix 包装 | 改动点 4 |
| J10 池键切换后 eviction/onEvict 按新键清理 | 建议 | **采纳** | 改动点 10 补 eviction 对齐 |

**v4 核心修正（S6 采纳）**：v3 的「两组天然分离构造点」断言错误——`createAllToolDefinitions(cwd)`（tools/index.js:89）构造全部 8 件，`buildPiBuiltinToolDefinitions(cwd)`（tool-description-overrides.ts:74-82）构造 5 件（**含 bash**，行 77），bash 与 read/grep/find/ls 共用同一个 cwd 参数，无法构造期分裂。

**v4 解法：bash 从 buildPiBuiltinToolDefinitions 拆出**，独立 `createBashToolDefinition(workspaceCwd)` + wrapBashWithCwdPrefix 包装（J9 保留感知前缀），经 customTools override 同名 base。read/grep/find/ls 四件套维持主仓 cwd。构造期分裂的真实分界 = 「write/edit（createAllToolDefinitions(this._cwd) 独占不被 override）+ bash（独立构造）→ 工作区」vs「read/grep/find/ls（buildPiBuiltinToolDefinitions 四件套）→ 主仓」。

## 背景

搭档 2026-10-13 主目录污染排查（5 个 untracked 文件：check_birthdays.py / p2-selftest.mjs / data/feishu / data/quota-browser / data/otter-buddy 空文件）后提出：

> 「我现在在思考，是否应该将海獭们的启动cwd设置到各个对话的工作区目录下？」

> 「bash守卫也一直反复在改还做不到（治理住写入面）。所以我思考，是否切换到工作区其实也能带来更好的架构」

第一问的历史答案（F20260922scwd，搭档 9/22 决策）：「让 agent 知道当前在哪」而非「替它记住」——感知对齐（[cwd:...] 前缀 + 主仓写拦截）。落地 3 周后的事实：拦截规则组持续误拦/补丁叠加（本次排查过程自身被拦 4 次），「让獭知道」没有收敛「獭写对地方」。守卫是 denylist 天生漏，改默认是 safe-by-default——**答案不是把守卫改完美，而是把默认改对，守卫降为第二道线**。

## 目标

T1: 獭写类工具（bash 写命令 / write / edit）默认落点 = 当前对话工作区（`data/workspaces/<conversationId>/`），盲写污染结构性关闭
T2: 守卫 projectRoot 与进程 cwd 解耦——主仓路径显式注入，不再从 process.cwd() 派生
T3: 主仓从「默认落点」降级为「显式目标」——落主仓的写命令需獭显式写绝对路径，守卫拦截语义不变
T4: 已有感知对齐机制（[cwd:] 前缀、无状态提示）保留
T5: 主仓相对命令（`node scripts/foo.mjs`）由守卫 rewrite 为 projectRoot 绝对路径后放行——命令向量闭环

## 非目标

- 不改主服务自身的 `./data` 相对路径落盘（app.ts:181）
- 不改 worktree 开发流程
- **工作区膨胀回收机制**：必需配套但非本特性交付——独立特性立项，本特性合入前需有对应 issue 跟踪

## 未决问题

U1（v3+ 解法：池键加 conversationId）: 池键从 otterId 改为 `otterId + conversationId`——session 构造时 cwd 按 conversationId 解析，池键匹配保证同对话复用、跨对话不串。膨胀因子 = 同一獭同时活跃对话数（通常 1-2），可接受。旧池 session 一次性清理或自然过期。

U2: 定时任务獭（无对话工作区）的 cwd → 系统级工作区 `data/workspaces/_system/`。

## 方案设计（v5，构造期分裂 + 写三件套独立构造 + this._cwd 归位主仓）

### Round 4 delta（2026-10-13 21:27）

Delta 结论：**基本通过**——机制健全、S6 闭环、非对称达成，四轮首次无方案失效级缺陷。S7 建议级（非阻断）。

| 发现 | 级别 | 处置 | 修订落点 |
|---|---|---|---|
| S7 write/edit 靠 this._cwd 过度耦合 | 建议 | **采纳**——write/edit 也独立构造传工作区 cwd，`this._cwd` 归位主仓。SDK 的 this._cwd 驱动三类非工具关注点（system-prompt.js:110 前缀显示、agent-session.js:2626 扩展发现、:609 fork/newSession），让它=工作区会引入感知分叉（read 类展示主仓但前缀说工作区）。write/edit 可独立导出（tools/index.js:2,10），独立构造后 this._cwd 归位主仓，工作区精确限定 bash/write/edit 三件，副作用最小化 | v5 改动点 1/3/4 重写 |

### 改动点全景

```
                        现状                              目标（v5）
session _cwd      process.cwd()（主仓根）         维持主仓根（S7 采纳：SDK 非工具关注点归位）
write/edit        this._cwd（主仓根）             独立构造 cwd = 工作区（改动点 3 拆出）
bash              构造 cwd = 主仓根（五件套之一）   独立构造 cwd = 工作区（改动点 3 拆出）
read/grep/find/ls 构造 cwd = 主仓根               维持主仓根（四件套 process.cwd() 不变）
守卫 projectRoot  process.cwd()（与 cwd 同源）    显式注入主仓绝对路径（app.ts 传入）
池键              otterId                          otterId + conversationId
[cwd:] 前缀       显示主仓根                       显式化双 cwd（S7 收尾：写落工作区 / 读解析主仓）
```

**构造期分裂的真实分界**（S6+S7 修正后）：SDK 两组构造点——`createAllToolDefinitions(this._cwd)`（agent-session.js:2910）构造全部 8 件；`buildPiBuiltinToolDefinitions(cwd)`（tool-description-overrides.ts:74-82）构造 5 件（read/bash/grep/find/ls）经 customTools override 同名 base。**v5 把写三件套（bash/write/edit）全部拆出独立构造**传工作区 cwd，read/grep/find/ls 四件套维持主仓 cwd。`this._cwd` 归位主仓（SDK 非工具关注点不受影响：system-prompt 前缀显示主仓、扩展发现扫主仓、fork 用主仓——全部正确语义）。
守卫 projectRoot  process.cwd()（与 cwd 同源）    显式注入主仓绝对路径（app.ts 传入）
池键              otterId                          otterId + conversationId
[cwd:] 前缀       显示主仓根                       显示 bash 实际 cwd（J7+J9）
```

**v5 构造期分裂兑现**：写三件套（bash/write/edit）独立构造传工作区 cwd——bash 用 `createBashToolDefinition(workspaceCwd)` + wrapBashWithCwdPrefix 包装（J9），write/edit 用 `createWriteToolDefinition(workspaceCwd)` / `createEditToolDefinition(workspaceCwd)`（S7 采纳，tools/index.js:2,10 可独立导出）。四件套（read/grep/find/ls）维持 `buildPiBuiltinToolDefinitions(process.cwd())` 主仓。全部七件经 customTools override 同名 base。

### 关键改造点（file:line 基于 75736f68）

1. **pi-session-factory.ts:451** — `SessionManagerClass.create(process.cwd(), ...)`：**维持 process.cwd() 不变**（S7 采纳——this._cwd 归位主仓，SDK 非工具关注点：system-prompt.js:110 前缀、agent-session.js:2626 扩展发现、:609 fork 全部正确指向主仓）。工作区路径由改动点 3 的独立构造传入，不经 this._cwd

2. **pi-session-factory.ts:935, 982** — 守卫/影子评估的 `projectRoot = process.cwd()`：改为构造期注入的 `mainRepoRoot`（app.ts 启动时显式解析）

3. **pi-session-factory.ts:1253**（S6+S7 修正，v5 核心）— 写三件套拆出独立构造：
   - `buildPiBuiltinToolDefinitions` factories 移除 bash/write/edit → 四件套（read/grep/find/ls）维持 `process.cwd()`（主仓）
   - bash 独立：`createBashToolDefinition(workspaceCwd)` + wrapBashWithCwdPrefix 包装（改动点 4）
   - write 独立：`createWriteToolDefinition(workspaceCwd)`（S7 采纳，tools/index.js:2,10 可独立导出）
   - edit 独立：`createEditToolDefinition(workspaceCwd)`
   - 全部七件（四件套 + 写三件套）经 customTools override 同名 base（agent-session.js:2831-2835）

4. **tool-description-overrides.ts:55**（J7+J9+S7 收尾）— `wrapBashWithCwdPrefix(base, workspaceCwd)`：bash 独立构造后经此包装保留 [cwd:] 前缀感知（J9）。**前缀显式化双 cwd（S7 收尾）**：「[cwd: 工作区路径 — 写落此处; read/grep/find/ls 解析主仓]」——非对称的单值前缀固有感知成本，显式标注两组 cwd 消除分叉。system-prompt.js:110 取 this._cwd=主仓（S7 归位后），与前缀的「写落工作区」互补不矛盾

5. **cwd-awareness.ts:6-9 头注释** — 架构断言更新：「bash/write/edit cwd = 对话工作区（独立构造），read/grep/find/ls cwd = 主仓根（构造期分裂）；session _cwd = 主仓根（S7 归位）」；BASH_STATELESS_SUFFIX 保留

6. **bash-safety-guard.ts:233** — projectRoot 来源从 process.cwd() 改为注入值，规则组不动

7. **工作区目录预创建** — resolveSessionCwd 时 mkdir -p（SDK bash.js:57 对不存在 cwd 抛错）

8. **alpha 实例** — 独立数据根，天然隔离

9. **命令向量守卫 rewrite**（S2+J6）——bash-safety-guard 判定白名单脚本（resolveScriptPath 解析到主仓 scripts/）时，若命令形态为相对路径且 bash cwd 已切换（≠projectRoot），将相对路径 rewrite 为 projectRoot 绝对路径后放行。**语义假设（J6）：「相对路径 = 主仓相对」**——工作区相对路径脚本不触发 rewrite（resolveScriptPath 解析不到主仓 scripts/），按 cwd=工作区正常执行

10. **池键加 conversationId**（U1 解法 + J10 eviction 对齐）——pi-session-factory.ts:271 `poolMeta: Map<string, ...>` 键从 otterId 改为 `${otterId}:${conversationId}`；`_acquirePooled`（758 行）按新键查找；`pool.onEvict`（312 行）、`_destroyInternal`（378 行）、`_resetInternal`（431 行）等全部 `poolMeta.delete(otterId)` 调用点改为新键（J10 采纳：eviction 按新键清理防跨对话僵尸 session）

### 獭行为变化对照

| 场景 | 现状 | 切换后（v4） |
|---|---|---|
| worktree 开发 | `cd .otter/worktrees/X && npm test` | 同左（cd 仍需要） |
| 写脚本/临时文件 | 不写路径 → 落主仓根（污染源） | 不写路径 → 落工作区 |
| 读主仓代码 | `grep foo src/` | **不变**（read/grep 构造 cwd=主仓） |
| sqlite3 查库 | `sqlite3 data/otter-buddy.db` | **不变**（bash 只读命令不受影响） |
| 主仓相对脚本 | `node scripts/foo.mjs` | 守卫 rewrite 为主仓绝对路径后正常执行 |
| 工作区相对脚本 | `node foo.mjs`（脚本在工作区） | 正常执行（cwd=工作区，不触发 rewrite） |
| 主仓写 | 拦 | 拦（语义不变） |

## 影响范围

- 獭写类工具默认落点（bash 写命令 / write / edit）——构造期分裂
- 守卫判定基准（锚点来源变化 + 新增 rewrite 能力）
- session 池（键从 otterId 改为 otterId+conversationId）
- prompt/skill 迁移：仅 bash 写命令示例（~14 处）需改；lint-prompt-paths 回归护栏

## 风险与约束

R1: **工作区垃圾无显形机制**——工作区本来就是獭堆临时文件的设计语义；膨胀回收由配套机制覆盖

R2: **池键切换的 session 孤儿**——旧池 session 不再被命中。缓解：切换时一次性 drain 或自然过期。影响窗口 = 一次进程重启周期

R3: **SDK 工具链已验（S6+S7 修正后）**——真实分界：写三件套（bash/write/edit）独立构造传工作区 cwd，经 customTools override 同名 base；read/grep/find/ls 四件套维持 override 主仓 cwd；this._cwd 归位主仓（SDK 非工具关注点不受影响）。残余验证：写三件套独立构造 + override 后行为与现状一致（V4 单测锁定）

R4: **session 文件目录编码**——session-manager.js:287-297 用 cwd 编码目录名，otter-buddy 显式传 sessionDir 不受影响

## 不兼容更新

[Incompatible] prompt/skill 中 bash 写命令示例的相对路径写法失效（~14 处）。读类引用（~35 处）在非对称方案下不破。回归护栏 lint-prompt-paths。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| cwd 分裂时机 | **构造期**（写三件套独立构造；read 类维持主仓） | 运行时 ctx.cwd per-invoke 注入（S4/S5 判不成立） | 构造期分裂零运行时状态；SDK 构造点可拆分 |
| bash/write/edit 归属 | **三件套全部独立构造传工作区 cwd** | write/edit 随 this._cwd（S7 判过度耦合——this._cwd 驱动 SDK 非工具关注点，=工作区引入感知分叉） | this._cwd 归位主仓，工作区精确限定写三件套 |
| U1 解法 | **池键加 conversationId** | ctx.cwd per-invoke（S4/S5 砍掉）；identity 兜底（J1 判不成立） | 结构性解法；膨胀因子 = 同獭活跃对话数（1-2） |
| 守卫锚点 | 显式注入主仓路径 | 继续 process.cwd() | 解耦本来就是该有的样子 |
| 命令向量 | 守卫 rewrite（拦+修） | 仅靠 [cwd:] 前缀（S2 判不收敛） | 结构性闭环 |
| 工作区位置 | 维持 data/workspaces/ | 挪出 data/ | 10/12 求值器已列入运行时豁免区 |

## 机制预算四问

机制识别检查点命中：**新增决策分支（session cwd 按 conversationId 解析 + 池键维度扩展 + bash 独立构造）** + **新增跨模块调用路径（invoke 入口 → workspace 解析 → session 构造 → bash 独立构造）**。

① **谁需要它**——每只獭的每次 bash 写操作（9/22 事故链 + 10/13 污染事件 + 300 条样本 60%+ 手写 cd 前缀）。

② **失败后果**——最坏 = 池键错位 → session 不复用 → 冷启动开销（轻度）；或 resolveSessionCwd 解析错目录 → 写进错误工作区（轻度，workspace_list 可查）。守卫拦截语义不变。

③ **后续机制**——池键切换后旧 session 孤儿（R2，一次性 drain）；工作区膨胀（配套机制，独立特性）；prompt/skill 残留（lint-prompt-paths 护栏）。

④ **退役条件**——pi SDK 支持 per-command cwd 参数时可重议；或獭运行时容器化时 cwd 语义整体重议。**本机制是永久承诺**——呈搭档确认。

## 验证

V1: ~~spike 验证 ctx.cwd 透传链~~（v3 砍掉 ctx.cwd，无需透传验证）
V2: 单测锁 resolveSessionCwd 纯函数 + 池键生成（otterId+conversationId 组合）
V3: 集成验证（J8+round3-B4 采纳）：worktree 内起 alpha 实例——獭 bash `pwd` 显示工作区；**`echo x>foo.txt` 落工作区（bash 盲写断言，S6 配对）**；**python3 `open('foo.txt','w')` 落工作区（bash 盲写断言 2）**；`grep foo src/` 读主仓正常且**结果非空**；write 工具写文件落工作区；`node scripts/foo.mjs` 守卫 rewrite 后正常执行；`node foo.mjs`（工作区脚本）正常执行不触发 rewrite；session 构造早于工作区 mkdir 的时序边界用例
V4: 回归：现有守卫单测全绿 + 新增单测锁「写三件套独立构造后经 customTools override 同名 base，execute cwd 闭包 = 工作区；read 四件套 execute cwd 闭包 = 主仓」（S6+S7 修正后的核心行为）
V5: lint-prompt-paths 回归护栏

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/agent/pi-session-factory.ts | 修改 | session cwd 解析（1）+ projectRoot 注入（2）+ bash 独立构造（3）+ 池键扩展（10） |
| src/frameworks/agent/tool-description-overrides.ts | 修改 | buildPiBuiltinToolDefinitions 移除 bash/write/edit + 写三件套独立构造传 workspaceCwd（3+4） |
| src/frameworks/agent/cwd-awareness.ts | 修改 | 头注释架构断言更新（5） |
| src/frameworks/agent/bash-safety-guard.ts | 修改 | projectRoot 来源（6）+ 命令 rewrite（9） |
| src/app.ts | 修改 | 启动时解析 mainRepoRoot 显式注入 |
| src/frameworks/agent/session-cwd-resolver.ts | 新增 | resolveSessionCwd 纯函数 |
| prompts/scheduled/*.md（~14 处 bash 写命令示例） | 修改 | 相对路径→绝对路径 |
| scripts/lint-prompt-paths.mjs | 新增 | 回归护栏 |
