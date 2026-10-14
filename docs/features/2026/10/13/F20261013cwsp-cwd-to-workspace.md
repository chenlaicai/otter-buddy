---
id: F20261013cwsp
title: 海獭 cwd 统一切换对话工作区（主仓从默认落点降级为显式目标）
change_type: refactor
created: 2026-10-13
created_in_conversation: f3567df1-e24b-49cd-a020-cdb39572f853
summary: 海獭全部工具（bash/read/write/edit/grep/find/ls）cwd 统一从主仓根切换到对话工作区（data/workspaces/<conversationId>/）；一处 resolveSessionCwd 供给、两处构造点（:451+:1253）接入；守卫 projectRoot 显式注入解耦；池键加 conversationId 解跨对话复用错位；命令向量守卫 rewrite 闭环
status: draft
---

## 对抗审视处置（检视獭-cwd · MiMo · round 1-4 + 搭档否决）

### Round 1-4（2026-10-13 17:36 - 21:27）

四轮对抗审视围绕「非对称默认」（写→工作区、读→主仓）展开，逐轮修正了 ctx.cwd 机制（S4/S5）、bash 分组归属（S6）、this._cwd 耦合（S7）。Round 4 基本通过。

### 搭档否决（2026-10-13 21:39）

> 「不对，读写要一致；没必要读留在主仓啊。你留在主仓的目的是什么。重新讨论方案！第一性原理！不要臆造需求！」

**否决理由（第一性原理）**：cwd 是獭的工作位置，不是读写分裂的技术参数。非对称默认制造「獭需要时刻分辨当前工具是读类还是写类」的认知负担——与 9/22 事故链（獭需要记住 cd 不跨命令保持）同构，只是换了形态。**一致性本身就是防错的架构属性**。

「读留主仓」的论据（「污染来自写不来自读」「零迁移成本」）经不起追问：
- 「读主仓代码高频」→ 獭读代码写的是绝对路径或 cd 到目标位置，不是靠 cwd 默认在主仓
- 「零迁移成本」→ 懒不是架构理由，35 处读类引用改绝对路径是一次性成本
- 獭要读主仓代码，就像人要读图书馆的书——去图书馆读，不是把图书馆搬回家

### 处置：推翻非对称，统一 cwd = 对话工作区

方案从「非对称默认（构造期分裂）」改为「**统一 cwd = 对话工作区**」。改动大幅简化：
- 不需要 bash 从五件套拆出、不需要 write/edit 独立构造——`SessionManagerClass.create(workspaceCwd)` 一处搞定全部 8 件工具
- S6/S7 的问题自动消失（没有分裂就没有分组归属问题）
- 迁移成本回归诚实的工作量（~51 处全部扫改，不分读写类）

## 背景

搭档 2026-10-13 主目录污染排查（5 个 untracked 文件：check_birthdays.py / p2-selftest.mjs / data/feishu / data/quota-browser / data/otter-buddy 空文件）后提出：

> 「我现在在思考，是否应该将海獭们的启动cwd设置到各个对话的工作区目录下？」

> 「bash守卫也一直反复在改还做不到（治理住写入面）。所以我思考，是否切换到工作区其实也能带来更好的架构」

9/22 历史答案（F20260922scwd）：「让 agent 知道当前在哪」——感知对齐。落地 3 周后守卫 denylist 持续误拦不收敛。本方案是「换默认起点」——safe-by-default。

## 目标

T1: 獭全部工具 cwd 统一切换到当前对话工作区（`data/workspaces/<conversationId>/`），盲写污染结构性关闭
T2: 守卫 projectRoot 与进程 cwd 解耦——主仓路径显式注入
T3: 主仓从「默认落点」降级为「显式目标」——落主仓的写命令需獭显式写绝对路径，守卫拦截语义不变
T4: 感知对齐机制保留并简化——[cwd:] 前缀显示工作区路径，无双 cwd 分叉
T5: 主仓相对命令由守卫 rewrite 为 projectRoot 绝对路径后放行

## 非目标

- 不改主服务自身的 `./data` 相对路径落盘（app.ts:181）
- 不改 worktree 开发流程
- **工作区膨胀回收机制**：必需配套但非本特性交付——独立特性立项

## 未决问题

U1（解法：池键加 conversationId）: 池键从 otterId 改为 `otterId + conversationId`。膨胀因子 = 同獭活跃对话数（通常 1-2）。旧池 session 一次性清理或自然过期。

U2: 定时任务獭的 cwd → 系统级工作区 `data/workspaces/_system/`。

## 方案设计（v6，统一 cwd = 工作区）

### 改动点全景

```
                        现状                              目标（v6）
session _cwd      process.cwd()（主仓根）         resolveSessionCwd(conversationId)（工作区）
全部 8 件工具     this._cwd / 构造 cwd = 主仓根   统一 = 工作区（SessionManager 一处传入）
守卫 projectRoot  process.cwd()（与 cwd 同源）    显式注入主仓绝对路径（app.ts 传入）
池键              otterId                          otterId + conversationId
[cwd:] 前缀       显示主仓根                       显示工作区路径（无双 cwd 分叉）
```

**为什么统一优于非对称**：cwd 是獭的工作位置，不是读写分裂的技术参数。非对称制造「分辨当前工具是读类还是写类」的认知负担（与 9/22 cd 不跨命令保持同构），统一 cwd 让「獭的工作位置 = 工作区」成为唯一事实。读主仓代码用绝对路径（獭已大量这么写），写文件落工作区（正确默认）——一致性本身就是防错。

### 关键改造点（file:line 基于 75736f68）

1. **pi-session-factory.ts:451** — `SessionManagerClass.create(process.cwd(), ...)`：改为 `resolveSessionCwd(conversationId)`（新纯函数：有 conversationId → `data/workspaces/<convId>/` 绝对路径；无 → `data/workspaces/_system/`）。**一处 resolveSessionCwd 供给、两处构造点接入**（W1 采纳：改动点 1 管 write/edit 经 `createAllToolDefinitions(this._cwd)`，改动点 3 管 read/bash/grep/find/ls 经 `buildPiBuiltinToolDefinitions(cwd)`——两处都改才能全工具一致，缺一即 S6 复活）

2. **pi-session-factory.ts:935, 982** — 守卫/影子评估的 `projectRoot = process.cwd()`：改为构造期注入的 `mainRepoRoot`

3. **pi-session-factory.ts:1253** — `buildPiBuiltinToolDefinitions(..., process.cwd())`：cwd 参数改为 `resolveSessionCwd(conversationId)` 结果（工作区）——五件套（read/bash/grep/find/ls）统一跟随

4. **tool-description-overrides.ts:55** — `wrapBashWithCwdPrefix(base, workspaceCwd)`：前缀显示工作区路径。无双 cwd 分叉（全部工具同一 cwd）

5. **cwd-awareness.ts:6-9 头注释** — 架构断言更新：「全部工具 cwd = 对话工作区（SessionManager 统一传入）」；BASH_STATELESS_SUFFIX 保留

6. **bash-safety-guard.ts:233** — projectRoot 来源从 process.cwd() 改为注入值，规则组不动

7. **工作区目录预创建**（W3 采纳）—— resolveSessionCwd 时 mkdir -p，覆盖 `<convId>/` 与兜底 `_system/` 两路（SDK bash.js:57 对不存在 cwd 抛错）

8. **alpha 实例** — 独立数据根，天然隔离

9. **命令向量守卫 rewrite**（W2 采纳）——bash-safety-guard 判定白名单脚本时，若命令形态为相对路径且 cwd 已切换（≠projectRoot），rewrite 为 projectRoot 绝对路径后放行。**语义假设显式声明：「相对路径 = 工作区相对」**——cwd=工作区后，獭写的相对路径天然是工作区相对；守卫 resolveScriptPath 解析到主仓 scripts/ 仅当工作区下不存在同名脚本时才 rewrite 为主仓绝对路径（防同名脚本被劫持：工作区有 `foo.mjs` + 主仓 scripts/ 也有 `foo.mjs` → 工作区优先，不 rewrite）

10. **池键加 conversationId**——poolMeta 键从 otterId 改为 `${otterId}:${conversationId}`；全部 6 处 delete 调用点按新键清理（J10）

### 獭行为变化对照

| 场景 | 现状 | 切换后（v6 统一） |
|---|---|---|
| worktree 开发 | `cd .otter/worktrees/X && npm test` | 同左（cd 仍需要） |
| 写脚本/临时文件 | 不写路径 → 落主仓根（污染源） | 不写路径 → 落工作区 |
| 读主仓代码 | `grep foo src/` | `grep foo /Users/orca/ai/otter-buddy/src/`（绝对路径） |
| sqlite3 查库 | `sqlite3 data/otter-buddy.db` | `sqlite3 /Users/orca/ai/otter-buddy/data/otter-buddy.db` |
| 主仓相对脚本 | `node scripts/foo.mjs` | 守卫 rewrite 为主仓绝对路径后正常执行 |
| 工作区相对脚本 | `node foo.mjs`（脚本在工作区） | 正常执行（cwd=工作区） |
| 主仓写 | 拦 | 拦（语义不变） |

## 影响范围

- 獭全部工具默认落点（统一切换）
- 守卫判定基准（锚点来源变化 + rewrite 能力）
- session 池（键加 conversationId）
- prompt/skill 迁移：**全部相对路径引用（~51 处）扫改**，不分读写类；lint-prompt-paths 回归护栏

## 风险与约束

R1: **工作区垃圾无显形机制**——工作区是獭堆临时文件的设计语义；膨胀回收由配套机制覆盖

R2: **池键切换的 session 孤儿**——旧池 session 不再命中。缓解：一次性 drain 或自然过期

R3: **SDK 工具链已验**——全部 8 件工具统一跟随 SessionManager 构造 cwd（write/edit 经 `createAllToolDefinitions(this._cwd)`，read/bash/grep/find/ls 经 `buildPiBuiltinToolDefinitions(cwd)` override），无双 cwd 分叉

R4: **session 文件目录编码**——session-manager.js:287-297 用 cwd 编码目录名，otter-buddy 显式传 sessionDir 不受影响

R5: **獭读主仓代码的路径变长**——从 `grep foo src/` 变为 `grep foo /Users/orca/ai/otter-buddy/src/`。缓解：獭已大量使用绝对路径（样本 15%）；prompt/skill 扫改后相对路径引用消失；identity 注入的对话工作区路径每轮可见，主仓路径同理可注入

## 不兼容更新

[Incompatible] prompt/skill 中全部相对路径引用失效（~51 处，不分读写类）。一次性扫改 + lint-prompt-paths 回归护栏防静默重新引入。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| cwd 策略 | **统一 cwd = 对话工作区** | 非对称默认（写→工作区、读→主仓）——搭档否决（第一性原理：读写要一致，一致性是防错的架构属性） | cwd 是獭的工作位置，不是读写分裂的技术参数 |
| 实现路径 | SessionManager 一处传入 | 写三件套独立构造（v5 遗产，统一 cwd 下不需要） | 统一 cwd 下一处搞定全部 8 件，无分组归属问题 |
| U1 解法 | 池键加 conversationId | ctx.cwd per-invoke（S4/S5 砍掉）；identity 兜底（J1 判不成立） | 结构性解法 |
| 守卫锚点 | 显式注入主仓路径 | 继续 process.cwd() | 解耦 |
| 命令向量 | 守卫 rewrite（拦+修） | 仅靠 [cwd:] 前缀（S2 判不收敛） | 结构性闭环 |
| 工作区位置 | 维持 data/workspaces/ | 挪出 data/ | 运行时豁免区已半通 |

## 机制预算四问

机制识别检查点命中：**新增决策分支（session cwd 按 conversationId 解析 + 池键维度扩展）** + **新增跨模块调用路径（invoke 入口 → workspace 解析 → session 构造）**。

① **谁需要它**——每只獭的每次工具调用（9/22 事故链 + 10/13 污染事件 + 300 条样本 60%+ 手写 cd 前缀）。

② **失败后果**——最坏 = 池键错位 → session 不复用 → 冷启动开销（轻度）；resolveSessionCwd 解析错目录 → 写进错误工作区（轻度，workspace_list 可查）。守卫拦截语义不变。

③ **后续机制**——池键切换后旧 session 孤儿（R2，一次性 drain）；工作区膨胀（配套机制，独立特性）；prompt/skill 残留（lint-prompt-paths 护栏）。

④ **退役条件**——pi SDK 支持 per-command cwd 参数时可重议；或獭运行时容器化时 cwd 语义整体重议。**本机制是永久承诺**——呈搭档确认。

## 验证

V1: 单测锁 resolveSessionCwd 纯函数（有/无 conversationId 两路）+ 池键生成
V2: 集成验证：worktree 内起 alpha 实例——獭 bash `pwd` 显示工作区；`echo x>foo.txt` 落工作区；write 工具写文件落工作区；read 工具读 `/Users/orca/ai/otter-buddy/src/app.ts` 正常（绝对路径）；`node scripts/foo.mjs` 守卫 rewrite 后正常执行；`node foo.mjs`（工作区脚本）正常执行不触发 rewrite；session 构造早于工作区 mkdir 的时序边界
V3: 回归：现有守卫单测全绿 + 新增单测锁「全部 8 件工具 execute cwd 闭包 = 工作区」
V4: lint-prompt-paths 回归护栏

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/agent/pi-session-factory.ts | 修改 | session cwd 解析（1）+ projectRoot 注入（2）+ 工具构造 cwd（3）+ 池键扩展（10） |
| src/frameworks/agent/tool-description-overrides.ts | 修改 | buildToolDescriptionOverrides 第三参传 workspaceCwd（4） |
| src/frameworks/agent/cwd-awareness.ts | 修改 | 头注释架构断言更新（5） |
| src/frameworks/agent/bash-safety-guard.ts | 修改 | projectRoot 来源（6）+ 命令 rewrite（9） |
| src/app.ts | 修改 | 启动时解析 mainRepoRoot 显式注入 |
| src/frameworks/agent/session-cwd-resolver.ts | 新增 | resolveSessionCwd 纯函数 |
| SYSTEM.md + .pi/skills/*/SKILL.md + prompts/scheduled/*.md | 修改 | 全部相对路径引用扫改（~51 处） |
| scripts/lint-prompt-paths.mjs | 新增 | 回归护栏 |
