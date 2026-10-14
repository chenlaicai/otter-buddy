---
id: F20261013cwsp
title: 海獭 cwd 统一切换对话工作区（描述层非重绑，createAgentSession 唯一事实源）
change_type: refactor
created: 2026-10-13
created_in_conversation: f3567df1-e24b-49cd-a020-cdb39572f853
summary: 海獭全部工具 cwd 统一切换对话工作区——createAgentSession({cwd}) 唯一事实源；描述层非重绑（override 只 patch description，execute 委托 SDK base）；bash [cwd:] 前缀修复（S9：9/22 感知对齐从未生效）；守卫 projectRoot 显式注入；池键加 conversationId；命令向量守卫 rewrite
status: draft
---

## 对抗审视处置（检视獭-cwd · MiMo · round 1-7 + 搭档两次拍板）

### Round 1-5（2026-10-13 17:36 - 14/10 08:50）

围绕「非对称默认」展开四轮，S1-S7 逐轮修正。Round 5 通过（无严重发现）。搭档否决非对称（「读写要一致」），方案转向统一 cwd。

### Round 6（2026-10-14 09:34）

S8：`buildPiBuiltinToolDefinitions(piCodingAgent, process.cwd())`（:1253）硬编码主仓，五件套 override 盖回主仓——`createAgentSession({cwd})` 一个参数不够，读写分裂静默复活。v8 修正为「一处 resolver 两处注入」。

### Round 7（2026-10-14 09:50）

**S9（严重）**：`buildToolDescriptionOverrides` 调用点（pi-session-factory.ts:1252-1255）只传 2 参，缺 `sessionCwd` → `if (name === "bash" && sessionCwd)` 恒 false → `wrapBashWithCwdPrefix` 从不执行。**9/22 的 bash 感知对齐（[cwd:] 前缀）从未生效。**

**重对抗门判断：v8 是治标-leaning。** 「两处注入」保留冗余重建、给两处都喂工作区，没消解「两处必须同步」的脆弱（正是 9/22 cwd 漂移同类）。**治本 = 描述层非重绑**——override 只 patch description，execute 委托 SDK base（base 已正确绑 `createAgentSession({cwd})` 的 cwd）。`createAgentSession({cwd})` 成为唯一事实源。

**搭档拍板（09:55）**：「按你说的来」——采纳治本路线（B）。

### 处置：推翻「两处注入」，描述层非重绑

v9 核心：**消解第二处构造点**——`buildPiBuiltinToolDefinitions` 不再重建工具定义（不再传 cwd），改为纯 description patch + bash 前缀包装（委托 base execute）。`createAgentSession({cwd: workspacePath})` 一处搞定全部 8 件工具。

## 背景

搭档 2026-10-13 主目录污染排查后提出 cwd 切换工作区。9/22 感知对齐（F20260922scwd）落地 3 周不收敛——**round 7 发现根因：bash [cwd:] 前缀从未生效（S9），獭全靠守卫硬拦，守卫 denylist 天生漏**。

## 目标

T1: 獭全部工具 cwd = 对话工作区——`createAgentSession({cwd})` 唯一事实源
T2: 守卫 projectRoot 与进程 cwd 解耦——显式注入主仓路径
T3: 主仓从「默认落点」降级为「显式目标」——守卫拦截语义不变
T4: bash [cwd:] 前缀修复（S9）——感知对齐真正生效
T5: 主仓相对命令由守卫 rewrite 为 projectRoot 绝对路径后放行

## 非目标

- 不改主服务 `./data` 相对路径落盘
- 不改 worktree 开发流程
- **工作区膨胀回收机制**：配套但非本特性交付——独立特性立项

## 未决问题

U1: 池键加 conversationId。膨胀因子 = 同獭活跃对话数（1-2）。
U2: 定时任务獭 cwd → `data/workspaces/_system/`。

## 方案设计（v9，描述层非重绑）

### 改动点全景

```
                        现状                              目标（v9）
session _cwd      process.cwd()（主仓根）         createAgentSession({cwd: workspacePath}）
全部 8 件工具     主仓根                          工作区（SDK 统一分发，唯一事实源）
override 组       buildPiBuiltinToolDefinitions   纯 description patch（不重绑 execute cwd）
                  (process.cwd()) 重建 5 件        + bash 前缀包装（委托 base execute）
守卫 projectRoot  process.cwd()                   显式注入主仓绝对路径
[cwd:] 前缀       从未生效（S9）                   修复第三参，真正生效
池键              otterId                          otterId + conversationId
```

**为什么描述层非重绑是治本**：`buildPiBuiltinToolDefinitions` 重建工具定义时 spread 保留了绑主仓的 execute 闭包——它本不该重绑 cwd（只为加描述文本），却顺带把 execute 拽回主仓。非重绑后 execute 委托 SDK base（base 已正确绑 `createAgentSession({cwd})`），唯一事实源成立。

### 关键改造点（file:line 基于 75736f68）

1. **pi-session-factory.ts:1274** — `createAgentSession({ cwd: resolveSessionCwd(conversationId), ... })`——唯一事实源。sdk.js:70 分发给 SessionManager/AgentSession/`createAllToolDefinitions(this._cwd)`/全部 8 件工具

2. **pi-session-factory.ts:451** — `SessionManagerClass.create(workspaceCwd, ...)`——保证 `sessionManager.getCwd()` 也返回工作区（fallback 链第二路）

3. **pi-session-factory.ts:1252-1255 + tool-description-overrides.ts:42-67**（v9 核心，S8+S9 一并修复）——**消解 `buildPiBuiltinToolDefinitions`**：
   - 不再重建工具定义（不再传 cwd，不再生成 execute 闭包）
   - `buildToolDescriptionOverrides` 改为纯 description patch：`{ name, description: base.description + suffix }`——**不动 execute**（委托 SDK base）
   - bash 额外包装 `wrapBashWithCwdPrefix(base, workspaceCwd)` 保留 [cwd:] 前缀（S9 修复：调用点补传第三参）
   - SDK base 工具定义从 `session.getToolDefinitions()` 或 `createAllToolDefinitions(this._cwd)` 获取（base 已正确绑 cwd）
   - customTools 只传 `{ name, description }` 覆写（不重绑 execute）

4. **bash-safety-guard.ts:233** — projectRoot 来源从 process.cwd() 改为注入值

5. **cwd-awareness.ts:6-9** — 头注释更新：「全部工具 cwd = 对话工作区（createAgentSession 唯一事实源）；bash [cwd:] 前缀经 wrapBashWithCwdPrefix 委托 base execute 注入」

6. **工作区目录预创建** — resolveSessionCwd 时 mkdir -p（含 `_system/` 兜底）

7. **alpha 实例** — 独立数据根，天然隔离

8. **命令向量守卫 rewrite**——相对路径 rewrite 为 projectRoot 绝对路径后放行。语义假设：「相对=工作区相对」，同名脚本工作区优先

9. **池键加 conversationId**——poolMeta 键改为 `${otterId}:${conversationId}`；全部 delete 调用点按新键清理

### 獭行为变化对照

| 场景 | 现状 | 切换后（v9） |
|---|---|---|
| worktree 开发 | `cd .otter/worktrees/X && npm test` | 同左 |
| 写脚本/临时文件 | 不写路径 → 落主仓根（污染源） | 不写路径 → 落工作区 |
| 读主仓代码 | `grep foo src/` | `grep foo /Users/orca/ai/otter-buddy/src/` |
| bash [cwd:] 前缀 | **从未生效**（S9） | 生效——每条 bash 输出前显示 `[cwd: 工作区路径]` |
| 主仓相对脚本 | `node scripts/foo.mjs` | 守卫 rewrite 后正常执行 |
| 主仓写 | 拦 | 拦（语义不变） |

## 影响范围

- 獭全部工具默认落点（统一切换，唯一事实源）
- bash [cwd:] 前缀从休眠变为生效（S9 修复的副作用——獭首次看到前缀输出）
- 守卫判定基准（锚点来源 + rewrite）
- session 池（键加 conversationId）
- prompt/skill 迁移：全部相对路径引用扫改（~51 处）+ lint-prompt-paths 回归护栏

## 风险与约束

R1: 工作区垃圾无显形机制——设计语义；膨胀回收配套机制独立立项
R2: 池键切换 session 孤儿——一次性 drain 或自然过期
R3: **描述层非重绑的实现路径需 spike 验证**——customTools 覆写是否支持「只传 name+description 不重绑 execute」？SDK 的 customTools 机制（agent-session.js:2831-2835 `definitionRegistry.set`）整体替换同名 base——如果只传 `{ name, description }` 会丢 execute。**实际实现可能需要从 session 拿 base 工具定义后 patch description 再覆写**（`const base = session.getToolDefinitions()[name]; override = { ...base, description: base.description + suffix }`——spread 保留 base 的 execute 闭包，只覆盖 description 字段）。这与现状的 `buildPiBuiltinToolDefinitions` 重建不同——现状是从 SDK 工厂函数重新构造（execute 绑传入的 cwd），v9 是从 session 已构造的 base 上 patch（execute 绑 session 的 cwd）
R4: session 文件目录编码——显式传 sessionDir 不受影响
R5: 獭读主仓代码路径变长——已大量使用绝对路径；prompt/skill 扫改后相对路径引用消失

## 不兼容更新

[Incompatible] prompt/skill 中全部相对路径引用失效（~51 处）。一次性扫改 + lint-prompt-paths 回归护栏。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| cwd 策略 | **统一 cwd = 对话工作区** | 非对称默认——搭档否决 | 一致性是防错的架构属性 |
| 实现路径 | **createAgentSession({cwd}) 唯一事实源 + 描述层非重绑** | 两处注入（v8，round 7 判治标-leaning——没消解「两处必须同步」的脆弱） | 消解第二处构造点，execute 委托 SDK base |
| override 机制 | **从 session 已构造 base patch description** | buildPiBuiltinToolDefinitions 重建（S8 根源——重建时 execute 绑传入 cwd） | base 已正确绑 cwd，patch 只动 description |
| U1 解法 | 池键加 conversationId | ctx.cwd（S4/S5 砍掉） | 结构性解法 |
| 守卫锚点 | 显式注入主仓路径 | 继续 process.cwd() | 解耦 |
| 命令向量 | 守卫 rewrite（拦+修） | 仅靠 [cwd:] 前缀（S2 判不收敛） | 结构性闭环 |

## 机制预算四问

① **谁需要它**——每只獭的每次工具调用（9/22 事故链 + 10/13 污染 + S9 发现感知对齐从未生效——獭全靠守卫硬拦，denylist 天生漏）。

② **失败后果**——最坏 = resolveSessionCwd 解析错目录 → 写进错误工作区（轻度）；或描述层 patch 丢失 execute（R3 已标注 spike 验证点）。守卫拦截语义不变。

③ **后续机制**——池键切换旧 session 孤儿（R2）；工作区膨胀（配套机制）；prompt/skill 残留（lint-prompt-paths）。

④ **退役条件**——pi SDK 支持 per-command cwd 时可重议；或容器化时 cwd 语义整体重议。**本机制是永久承诺**——呈搭档确认。

## 验证

V1: spike 验证描述层非重绑路径——从 session 拿 base 工具定义 patch description 再覆写，execute 闭包是否保持绑 session cwd（R3）
V2: 单测锁 resolveSessionCwd 纯函数 + 池键生成
V3: 集成验证：alpha 实例——bash `pwd` 显示工作区；`echo x>foo.txt` 落工作区；write 工具写文件落工作区；read 工具读绝对路径正常；**bash 输出含 [cwd: 工作区] 前缀（S9 修复验证）**；**相对路径 read/grep 落工作区（S8 逃逸堵）**；`node scripts/foo.mjs` 守卫 rewrite 后正常执行
V4: 回归：守卫单测全绿 + 新增单测锁「全部 8 件工具 execute cwd 闭包 = 工作区」+ 「bash [cwd:] 前缀注入生效」
V5: lint-prompt-paths 回归护栏

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/agent/pi-session-factory.ts | 修改 | createAgentSession cwd（1）+ SessionManager cwd（2）+ 描述层非重绑（3）+ projectRoot 注入（4）+ 池键（9） |
| src/frameworks/agent/tool-description-overrides.ts | 重写 | buildPiBuiltinToolDefinitions 删除；buildToolDescriptionOverrides 改为纯 description patch（3） |
| src/frameworks/agent/cwd-awareness.ts | 修改 | 头注释更新（5） |
| src/frameworks/agent/bash-safety-guard.ts | 修改 | projectRoot 来源（4）+ 命令 rewrite（8） |
| src/app.ts | 修改 | mainRepoRoot 显式注入 |
| src/frameworks/agent/session-cwd-resolver.ts | 新增 | resolveSessionCwd 纯函数 |
| SYSTEM.md + .pi/skills/*/SKILL.md + prompts/scheduled/*.md | 修改 | 全部相对路径引用扫改（~51 处） |
| scripts/lint-prompt-paths.mjs | 新增 | 回归护栏 |
