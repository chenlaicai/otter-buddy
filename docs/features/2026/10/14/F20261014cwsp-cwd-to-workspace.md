---
id: F20261014cwsp
title: 海獭 cwd 统一切换对话工作区（删 override，createAgentSession 唯一事实源）
change_type: refactor
created: 2026-10-14
created_in_conversation: f3567df1-e24b-49cd-a020-cdb39572f853
summary: 海獭全部工具 cwd 统一切换对话工作区——createAgentSession({cwd}) 唯一事实源 + invoke 入口重置 cwd（池复用时跟随当前对话）；删除整套工具 override（描述引导未生效 15% bash grep、bash [cwd:] 前缀从未生效 S9、统一工作区下冗余）；守卫 projectRoot 显式注入；命令向量守卫 rewrite
status: implemented
capability_test: tests/frameworks/agent/bash-guard-session-cwd.test.ts
---

## 对抗审视处置（检视獭-cwd · MiMo · round 1-8 + 搭档两次拍板）

### Round 1-5（10/13 17:36 - 14/10 08:50）

围绕「非对称默认」展开四轮，S1-S7 逐轮修正。Round 5 通过。搭档否决非对称（「读写要一致」），转向统一 cwd。

### Round 6-7（10/14 09:34-09:50）

S8：`buildPiBuiltinToolDefinitions(process.cwd())` 硬编码主仓，五件套 override 盖回主仓——`createAgentSession({cwd})` 一个参数不够。S9：bash [cwd:] 前缀从未生效（调用点缺第三参）。Round 7 提出治本路线 B（描述层非重绑）。

### Round 8（10/14 10:07）

检视獭提出**选项 3（删整套 override）**——比非重绑更简。决策点留给搭档，搭档授权大獭拍板。

**数据支持的拍板**（近两天工具调用）：

| 工具 | 调用次数 | bash 中含 grep/cat/ls/find/head/tail |
|---|---|---|
| bash | 9,439 | 1,425 次（15%）以这些命令开头；4,306 次（46%）含 grep |
| read | 796 | — |
| grep | 262 | — |
| find | 5 | — |
| ls | 4 | — |

- 描述引导「用 grep 工具不用 bash grep」**基本没生效**（15% bash grep）
- bash [cwd:] 前缀**从未生效**（S9）
- 统一工作区下前缀**冗余**（cwd 恒=工作区，前缀永远显示同一个值）

**拍板：删 override（选项 3）。** 唯一保留的是 bash 无状态提示（BASH_STATELESS_SUFFIX「每条命令独立 shell，cd 不跨命令保持」）——挪到 SYSTEM.md 或 identity 注入，不在工具描述里。

### 实现层 round-1（10/14 12:21，检视獭-cwd-impl · mimo-pro，PR #1480）

6 项严重发现，4 项修复 + 1 项澄清 + 1 项仲裁上报：

- **S1 守卫逃逸（修复）**：`gitWriteInWorkspace` 整体跳过 checkWriteChannels 收窄为 cwd 上移豁免（`skipGitLiteral` 仅跳过 git 字面 pattern[8] + 结构通道 git 段，one-liner/heredoc 照常跑）；豁免条件收窄为「sessionCwd 绝对路径 ∧ 在 `.otter/worktrees/` 显式 git 工作树内」——树外任意目录 fail-closed（落点不确定）、会话工作区（树内非 git 树）不豁免（git 写族向上发现主仓 .git，正是要根治的污染面）。resolver 绝对化堵相对 cwd 锚点。
- **S2 旗舰修复失效（修复）**：`resolvesToMainData` 加树内 `data/workspaces/` 落点豁免（F20260923hsyn 重定向豁免同构）；重定向相对目标经 sessionCwd 解析到 workspaces 内放行。fixture 改生产真实形态（树内），树外场景仅作豁免面边界测试。
- **S3 交付面拆分（声明）**：T4（SYSTEM.md 无状态提示）/ T5 完整 rewrite（cwd 上移语义已随 S1 处置落地，旧含义的文本 rewrite 不需要）/ ~51 处 prompt 扫改 / lint-prompt-paths 均不在本 PR——拆分为合入后跟随任务，本 PR 交付守卫 cwd 感知 + resolver + factory 接线。
- **S4 CI 红（修复）**：PR 标题补 `[session]` 模块段。
- **S5 撞车（上报）**：open PR #1433（写落点求值器转正）与本 PR 同文件域——S1 修复刻意最小侵入（GuardCwdCtx 打包收窄参数面、cwd 感知集中在 checkMainCheckoutWrite/judgeSegment 两点），降低归一冲突；合入顺序呈搭档仲裁。
- **S6 半完成态（修复）**：`_resetSessionCwd` 改先 build 后赋 `_cwd`，build 失败保旧值下次重试。

J1 块级 eslint-disable 已随 GuardCwdCtx 打包消除（complexity/max-params 警告归零）。J2（session-restore `opts.cwd` 死参数）保留待清——删除涉及 restore 签名重排，与 J3（wait sessionCwd 语义）一起在 round-2 处置范围内部分修正（J3：wait 通道撤 sessionCwd 传参，守旧保守拦）。J4 测试名已对齐。J5 status→implemented。

### 实现层 round-2（10/14 12:50，检视獭-cwd-impl delta 复核）

- **S7（S6 修反了，纠正）**：`_resetSessionCwd` 改「先赋 `_cwd` 后 `_buildRuntime()`，build 失败回滚」——SDK 按调用时 `this._cwd` 重建工具（agent-session.js:2910），round-1 的「先 build 后赋」使重建工具绑上一个对话工作区（成功路径必坏）。
- **S8（豁免面过宽，收窄）**：`resolvesToMainData` 的 workspaces 豁免从「整树无条件」收窄为「sessionCwd 子树」——跨对话工作区破坏（`rm -rf ../OTHER-conv`）恢复拦截，无 sessionCwd 形态守旧行为。wait 工具 until 通道撤 sessionCwd 传参（合法形态是状态查询，无写场景；传 process.cwd() 会放开 data/ 全树）。
- 具名化：`GIT_WRITE_LITERAL_PATTERN` 常量替代魔法索引 pi===7。

## 背景

搭档 2026-10-13 主目录污染排查后提出 cwd 切换工作区。9/22 感知对齐（F20260922scwd）落地 3 周不收敛——round 7 发现根因：bash [cwd:] 前缀从未生效（S9），獭全靠守卫硬拦，denylist 天生漏。

## 目标

T1: 獭全部工具 cwd = 对话工作区——`createAgentSession({cwd})` 唯一事实源
T2: 守卫 projectRoot 与进程 cwd 解耦——显式注入主仓路径
T3: 主仓从「默认落点」降级为「显式目标」——守卫拦截语义不变
T4: bash 无状态提示**激活**——挪到 SYSTEM.md/identity 注入（W8 修正：BASH_STATELESS_SUFFIX 与 S9 同因休眠，挪 identity 是激活不是保留现状）
T5: 主仓相对命令由守卫 rewrite 为 projectRoot 绝对路径后放行

## 非目标

- 不改主服务 `./data` 相对路径落盘
- 不改 worktree 开发流程
- **工作区膨胀回收机制**：配套但非本特性交付——独立特性立项

## 未决问题

U1（v10 修订：invoke 入口重置 cwd + rebuild）: 池键维持 otterId 不变。invoke 入口（`_acquirePooled` 池命中后）重置 `session._cwd = resolveSessionCwd(conversationId)` 并调 `session._buildRuntime()`——SDK 的 `_buildRuntime`（agent-session.js:2901）每次调用都用 `this._cwd` 重建全部工具定义（`createAllToolDefinitions(this._cwd)` :2910）并经 `_refreshToolRegistry`（:2931）注册。池复用时 cwd 跟随当前对话，不需要池键加 conversationId。**膨胀因子 = 0**（池键不变）。
U2: 定时任务獭 cwd → `data/workspaces/_system/`。

## 方案设计（v10 终稿，删 override）

### 改动点全景

```
                        现状                              目标（v10）
session _cwd      process.cwd()（主仓根）         createAgentSession({cwd: workspacePath}）
全部 8 件工具     主仓根                          工作区（SDK 统一分发，唯一事实源）
override 组       buildPiBuiltinToolDefinitions   删除整套（描述引导未生效 + 前缀冗余）
                  (process.cwd()) 重建 5 件
bash 无状态提示    BASH_STATELESS_SUFFIX          挪到 SYSTEM.md/identity 注入
                  （工具描述里，从未生效 S9）
守卫 projectRoot  process.cwd()                   显式注入主仓绝对路径
池键              otterId                          维持不变（invoke 入口重置 cwd 替代）
```

**为什么删 override 是最优**：
- 描述引导（F20260904cg77）15% bash grep 证明没生效——删掉不损失什么
- bash [cwd:] 前缀（F20260922scwd）从未生效（S9）——删掉不少什么
- 统一工作区下前缀冗余——cwd 恒=工作区，前缀永远显示同一个值
- `createAgentSession({cwd})` 一处搞定全部 8 件——獭的心智模型字面成立
- 如果未来需要「用 grep 工具」引导，正确位置是 SYSTEM.md 工具描述段（已在那里），不是工具 override

### 关键改造点（file:line 基于 75736f68）

1. **pi-session-factory.ts:1274** — `createAgentSession({ cwd: resolveSessionCwd(conversationId), ... })`——唯一事实源。sdk.js:70 分发给全部 8 件工具

2. **pi-session-factory.ts:451** — `SessionManagerClass.create(workspaceCwd, ...)`——fallback 链第二路覆盖

3. **pi-session-factory.ts:1252-1255 + tool-description-overrides.ts**（v10 核心）——**删除整套 override**：
   - `buildPiBuiltinToolDefinitions` 删除（不再重建工具）
   - `buildToolDescriptionOverrides` 删除（不再 patch description）
   - `wrapBashWithCwdPrefix` 保留在 cwd-awareness.ts（前缀逻辑可复用于未来需要），但不再从 override 链路调用
   - `BASH_STATELESS_SUFFIX` 挪到 SYSTEM.md 或 identity 注入（T4）
   - `DESCRIPTION_SUFFIXES` 删除（描述引导未生效）
   - `customTools` 不再包含 descriptionOverrides（:1278 只剩 filteredCustomTools + tool_search）

4. **bash-safety-guard.ts:233** — projectRoot 来源从 process.cwd() 改为注入值

5. **cwd-awareness.ts:6-9** — 头注释更新：「全部工具 cwd = 对话工作区（createAgentSession 唯一事实源）；bash 无状态提示挪到 identity 注入」

6. **工作区目录预创建** — resolveSessionCwd 时 mkdir -p（含 `_system/` 兜底）

7. **alpha 实例** — 独立数据根，天然隔离

8. **命令向量守卫 rewrite**——相对路径 rewrite 为 projectRoot 绝对路径后放行。语义假设：「相对=工作区相对」，同名脚本工作区优先

9. ~~池键加 conversationId~~（v10 修订删除）——invoke 入口重置 cwd 替代。`session._cwd = resolveSessionCwd(conversationId)` + `session._buildRuntime()` 在 `_acquirePooled` 池命中后执行，cwd 跟随当前对话。池键维持 otterId 不变，零膨胀

### 獭行为变化对照

| 场景 | 现状 | 切换后（v10） |
|---|---|---|
| worktree 开发 | `cd .otter/worktrees/X && npm test` | 同左 |
| 写脚本/临时文件 | 不写路径 → 落主仓根（污染源） | 不写路径 → 落工作区 |
| 读主仓代码 | `grep foo src/` | `grep foo /Users/orca/ai/otter-buddy/src/` |
| bash [cwd:] 前缀 | **从未生效**（S9） | **不再存在**（统一工作区下冗余） |
| bash 无状态提示 | 工具描述里（从未生效） | SYSTEM.md/identity 注入（每轮可见） |
| 主仓相对脚本 | `node scripts/foo.mjs` | 守卫 rewrite 后正常执行 |
| 主仓写 | 拦 | 拦（语义不变） |

## 影响范围

- 獭全部工具默认落点（统一切换，唯一事实源）
- 工具 override 机制整体删除（描述引导 + bash 前缀）
- 守卫判定基准（锚点来源 + rewrite）
- session 池（键加 conversationId）
- prompt/skill 迁移：全部相对路径引用扫改（~51 处）+ lint-prompt-paths 回归护栏
- SYSTEM.md/identity 注入新增 bash 无状态提示

## 风险与约束

R1: 工作区垃圾无显形机制——设计语义；膨胀回收配套机制独立立项
R2: ~~池键切换 session 孤儿~~（v10 修订：池键不变，无孤儿问题）
R3: **删 override 后描述引导消失**——15% bash grep 证明工具描述里的引导没生效，且 SYSTEM.md 本无 grep 工具选择引导（W7 修正：唯一涉 grep 处是 line 106 记忆先行原则「grep/bash 翻目录是第二步」= 检索顺序非工具选择）。删掉后獭完全不知道「有 grep 工具可用」。缓解：**SYSTEM.md 真正新增 grep 引导**（不是「已在」）；獭的 tool_search 可发现工具。残余风险低
R4: session 文件目录编码——显式传 sessionDir 不受影响
R5: 獭读主仓代码路径变长——已大量使用绝对路径；prompt/skill 扫改后相对路径引用消失

## 不兼容更新

[Incompatible] prompt/skill 中全部相对路径引用失效（~51 处）。一次性扫改 + lint-prompt-paths 回归护栏。工具 override 删除——如果有外部系统依赖 DESCRIPTION_SUFFIXES 的文本（如文档引用），需同步更新。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| cwd 策略 | **统一 cwd = 对话工作区** | 非对称默认——搭档否决 | 一致性是防错的架构属性 |
| 实现路径 | **createAgentSession({cwd}) 唯一事实源** | 两处注入（v8，round 7 判治标-leaning）；描述层非重绑（v9，round 8 提出更简选项 3） | 删 override 后一处搞定全部 8 件 |
| override 存废 | **删整套**（选项 3） | 保留非重绑（v9/v8 收敛） | 描述引导 15% bash grep 证明没生效；bash 前缀从未生效（S9）且统一工作区下冗余 |
| bash 无状态提示 | **挪到 SYSTEM.md/identity 注入** | 留在工具描述里（从未生效 S9） | 每轮可见 > 工具描述里睡着 |
| U1 解法 | **invoke 入口重置 cwd + _buildRuntime** | 池键加 conversationId（15+ 处调用点且多处拿不到 conversationId）；ctx.cwd（S4/S5 砍掉） | 最简——SDK `_buildRuntime` 已支持运行时重建工具，`_cwd` 赋值即可 |
| 守卫锚点 | 显式注入主仓路径 | 继续 process.cwd() | 解耦 |
| 命令向量 | 守卫 rewrite（拦+修） | 仅靠 [cwd:] 前缀（S2 判不收敛） | 结构性闭环 |

## 机制预算四问

① **谁需要它**——每只獭的每次工具调用（9/22 事故链 + 10/13 污染 + S9 发现感知对齐从未生效——獭全靠守卫硬拦，denylist 天生漏）。

② **失败后果**——最坏 = resolveSessionCwd 解析错目录 → 写进错误工作区（轻度）；或删 override 后獭不知道有 grep 工具（R3，SYSTEM.md 已有引导缓解）。

③ **后续机制**——invoke 入口重置 cwd 的时序边界（session 构造早于工作区 mkdir 时 mkdir -p 前置）；工作区膨胀（配套机制）；prompt/skill 残留（lint-prompt-paths）。

④ **退役条件**——pi SDK 支持 per-command cwd 时可重议；或容器化时 cwd 语义整体重议。**本机制是永久承诺**——呈搭档确认。

## 验证

V1: 单测锁 resolveSessionCwd 纯函数
V2: 集成验证：alpha 实例——bash `pwd` 显示工作区；`echo x>foo.txt` 落工作区；write 工具写文件落工作区；read 工具读绝对路径正常；**相对路径 read/grep 落工作区（S8 逃逸堵）**；`node scripts/foo.mjs` 守卫 rewrite 后正常执行；**bash 输出不再含 [cwd:] 前缀（删 override 验证）**
V3: 回归：守卫单测全绿 + 新增单测锁「全部 8 件工具 execute cwd 闭包 = 工作区」
V4: lint-prompt-paths 回归护栏

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/agent/pi-session-factory.ts | 修改 | createAgentSession cwd（1）+ SessionManager cwd + invoke 入口重置（2）+ 删 override 链路（3）+ projectRoot 注入（4） |
| src/frameworks/agent/tool-description-overrides.ts | **删除** | 整套 override 机制（3） |
| src/frameworks/agent/cwd-awareness.ts | 修改 | 头注释更新（5）；wrapBashWithCwdPrefix 保留可复用但不再从 override 链路调用 |
| src/frameworks/agent/bash-safety-guard.ts | 修改 | projectRoot 来源（4）+ 命令 rewrite（8） |
| src/app.ts | 修改 | mainRepoRoot 显式注入 |
| src/frameworks/agent/session-cwd-resolver.ts | 新增 | resolveSessionCwd 纯函数 |
| SYSTEM.md | 修改 | 新增 bash 无状态提示（T4） |
| .pi/skills/*/SKILL.md + prompts/scheduled/*.md | 修改 | 全部相对路径引用扫改（~51 处） |
| scripts/lint-prompt-paths.mjs | 新增 | 回归护栏 |
