---
id: F20260916gtlr
title: 防自杀机制收敛：拦截归于 tool 层守卫，otter-buddy.sh 回归纯工具
summary: 按「不能让进程1的海獭杀掉进程1」唯一根因重构——海獭的一切命令都过 tool 管道，拦截职责全部收敛到 bash 安全守卫；删除 #970 加的脚本层主仓拒杀（保护集合为空、误伤搭档正常使用），守卫 SERVICE_SCRIPT_KILL 加主仓路径限定放行 worktree 自管实例；顺手修 bash 3.2 中文紧贴 $VAR 定界 bug。
change_type: fix
capability_test: tests/frameworks/agent/bash-safety-guard.test.ts 的 SERVICE_SCRIPT_KILL 路径限定用例组
created_in_conversation: bfb8a43f-6117-4588-916b-fae6028fff31
doc_type: feature
tags: [bash-guard, security, suicide-command, otter-buddy.sh, worktree, guard-refactor]
modules: [src/frameworks/agent/bash-safety-guard.ts, scripts/otter-buddy.sh, tests/frameworks/agent/bash-safety-guard.test.ts, README.md]
from: [F20260916gsrd, F20260831aksp, F20260914dsrv]
---

## 背景

搭档原话（意图锚，按时间序）：

> 「不是，那我咋重启呀。。。你这保护措施把我正常行为也拦住了呀。。。」

> 「不对，我认为你需要完整分析这个机制，然后梳理清晰业务场景，而不能这么打补丁，你如果有--force出口，那这还不是也暴露给海獭了？而且，如果是worktree环境，那海獭如何正常启动/关闭？要回归问题本质！到底问题是什么！」

> 「问题是，海獭会误杀自己的进程，导致自己和同仁全部挂掉。补充场景，但人类要正常启停系统，以及，worktree也有启停需求。所以，问题根因可以归纳为：不能让 进程1的海獭杀掉进程1。」

> 「我再给一个思路，海獭执行的所有命令，本质都是调用tool，所以海獭系统是能够感知拦截住的，所以，这个拦截机制应该约束在 tool拦截这一层，不要扩散到系统脚本上。」

> 「ok，你来做完这件事」

事故链：9/16 獭 7708a033 执行 `otter-buddy.sh restart` 杀掉主进程 31385（命令不含 kill 词元，kill 族守卫看不到）→ #970（F20260916gsrd）紧急加了两层封堵：守卫层 SERVICE_SCRIPT_KILL 全局文本拦 + 脚本层主仓拒杀。同日 16:10 搭档在主仓人工执行 `otter-buddy.sh stop` 被脚本层拦下，且拒绝文案踩 macOS bash 3.2 bug（中文紧贴 `$VAR` 时变量名被中文字节污染）显示为 `line 132: PROJECT_DIR?: unbound variable`，连拒绝原因都没显示出来。

## 问题本质

要保护的资产只有一个：**主仓运行中的主进程**（`node dist/src/main.js`，下简称进程1）。根因判据只有一条：「这个终止动作的目标是进程1 吗？是 + 发起者是海獭 → 拦」。目标 identity 是运行时事实（PID、路径、端口归属），与命令从哪个目录发起、长什么样无关。

现状五套机制里四套读命令字符串（守卫 kill 族/eval 变体/SERVICE_SCRIPT_KILL）或看目录（脚本层 is_primary_checkout），全是代理变量：

| 代理变量 | 误伤/绕过 |
|---|---|
| SERVICE_SCRIPT_KILL 全局文本拦 | worktree 海獭跑 `otter-buddy.sh stop` 管自己的进程2，与进程1 无关，照样被拦（11 个存量 worktree 脚本均无脚本层保护，唯一放行路径被守卫堵死） |
| 脚本层 is_primary_checkout 看目录不看人 | 搭档在主仓人工 stop/restart 被拦，只能裸 kill——保护机制把最需要它服务的人挡在门外 |

关键架构事实：**海獭的一切命令都经 tool 调用管道（tool_execution_start hook），「发起者是海獭」在 tool 层是免费且 100% 准确的判据；人不经 tool 管道，天然不在拦截域内**。脚本层防的 threat（海獭经脚本杀进程1）已被 tool 层全覆盖——脚本层保护的集合是空集（不经 tool 层的调用者只有人，人不该被拦），误伤的集合是人的正常使用，纯负资产。

## 目标

T1: 拦截职责全部收敛到 tool 层守卫（bash-safety-guard），系统脚本不携带任何防海獭逻辑
T2: 搭档人工启停主服务（主仓 `otter-buddy.sh stop/restart`）恢复正常，无任何人工出口设计（人压根不进拦截域）
T3: worktree 海獭/搭档用 `otter-buddy.sh start/stop -p <port>` 管理自己的隔离实例不被误拦
T4: 海獭从任意目录（主仓/worktree）通过脚本路径调用杀进程1 仍被拦（安全能力不回退）
T5: 修复 scripts/otter-buddy.sh 中 bash 3.2 中文紧贴 `$VAR` 的定界 bug 及同类写法

## 非目标

- 不改 kill 族/eval/pipe/脚本语言/pkill 等既有守卫规则（①②⑤ 层保持原样）
- 不改 #844 端口白名单机制（allowed-service-ports）的语义与格式
- 不处理守卫对其他脚本（restart-service.mjs 等）的判定逻辑
- 不迁移 `.claude/worktrees/` 存量旧 worktree（无运行时实例，无实际影响）

## 方案设计

### 涉及模块

1. `src/frameworks/agent/bash-safety-guard.ts` — SERVICE_SCRIPT_KILL 判定加主仓路径限定
2. `scripts/otter-buddy.sh` — 删除主仓拒杀保护 + 修 bash 3.2 定界 bug
3. `tests/frameworks/agent/bash-safety-guard.test.ts` — 用例重构
4. `README.md` — 启动脚本章节同步

### 改动 1：守卫 SERVICE_SCRIPT_KILL 主仓路径限定

现状（bash-safety-guard.ts:77, 298-301）：正则全局匹配 `otter-buddy.sh stop|restart`，命中即拦，不看路径。

改为：命中正则后，从匹配片段提取脚本路径词元（可选的 `[\w.~/-]*\/` 前缀 + `otter-buddy.sh`），按规则解析为绝对路径：

- 绝对路径：直接规范化
- 相对路径：基于守卫 projectRoot（调用点已传 `process.cwd()`= 主仓，pi-session-factory.ts:668）resolve
- `~` 前缀：不展开（守卫同步路径不引 os.homedir 外部依赖之外的新解析，保守按拦截处理——`~/` 形态指向主仓副本的可能性极低，且海獭正常场景用相对路径）

判定：**解析结果的 dirname 等于 projectRoot/scripts → 拦（目标是主仓脚本，其 PID 文件指向进程1）；否则 → 放行**（worktree 脚本管自己的实例，scripts/otter-buddy.sh 内部 F20260831aksp 杀伐校验会继续兜底防跨实例误杀）。

projectRoot 缺失时（GuardOptions 未传）：退化为现状全局拦（保守）。

**mainPid 为 null 时（PID 文件缺失/损坏/不可读）**：SERVICE_SCRIPT_KILL 不受 `checkBashCommandSafety` 第一行 `mainPid === null → return null` 短路影响——脚本路径判定不依赖 PID 信息，仍需正常执行路径限定拦截（在短路之前先行判定，或将 SERVICE_SCRIPT_KILL 检查移出 mainPid 短路的作用域）。理由：mainPid=null + 主仓脚本 stop 的组合下，PID 文件缺失时脚本走 "Not running" 无害，但 PID 文件内容损坏（非数字）时守卫放行即直通主进程——本方案删除脚本层兜底后，此组合必须仍由守卫覆盖。

**间接调用保守拦截**（对齐 kill 族 INDIRECT_PID_PATTERNS 先例，检视严重发现 1 处置）：命令中含 `otter-buddy.sh` 词元但 SERVICE_SCRIPT_KILL 正则不匹配（stop/restart 被 `$VAR`、`$()`、反引号、变量赋值等间接形态隐藏，如 `S=stop && scripts/otter-buddy.sh $S`、`bash -c "$CMD"`）时，保守拦截。收窄条件避免误伤：仅当命令同时含脚本引用（`/otter-buddy\.sh/`）**且**含间接引用特征（`/\$[{(]/` 或反引号）时才拦——纯字面 `otter-buddy.sh logs/status/start` 无 `$` 不拦；`otter-buddy.sh $S`、`bash -c "$CMD"` 拦。

拦截文案按形态区分：

- 主仓形态：「该脚本解析到主仓（<path>），其 stop/restart 会终止主进程——你不存在需要重启或停止主进程的合法场景。验证代码变更请在 worktree 用独立端口启动隔离实例（使用 worktree 绝对路径调用脚本）；服务异常请报告搭档。」
- 间接形态：「命令包含 otter-buddy.sh 引用与间接调用特征（变量/命令替换），无法静态确认安全性。请使用字面命令：worktree 绝对路径 + 字面子命令。」
- 不再对 worktree 形态输出任何文案（放行即静默）。

### 路径提取规格（检视建议发现 4 处置）

- **提取方式**：不改原 SERVICE_SCRIPT_KILL 正则（避免破坏匹配语义），用独立的捕获正则 `SCRIPT_PATH_EXTRACT = /((?:[\w.~/-]*\/)?(?:scripts\/)?otter-buddy\.sh)\s+(?:stop|restart)\b/` 对命令做 exec 取 group(1)。两个正则保持路径词元口径一致——代码注释互相引用，测试用例同时过两条正则防漂移。
- **多脚本形态**：exec 循环取全部匹配，**任一**解析到主仓 scripts → 拦；全部不在主仓 → 放行。
- **`bash -c` 内嵌**：内嵌引号中的脚本路径以命令字符串字面为准 resolve（守卫只能静态看文本）；`bash -c 'scripts/otter-buddy.sh stop'` 的相对路径按 projectRoot 基准 resolve = 主仓 → 拦（正确）。
- **归一化**：resolve 后用 `path.normalize` 消除 `..`、`.`、`//`；不做 realpath（守卫同步路径不做 IO）——符号链接指向主仓的形态超出静态判定能力，在风险节声明。

cwd 说明（检视建议发现 2 处置，修正方案措辞）：bash 工具的 cwd 恒为主仓根（tool-description-overrides.ts:66，bash 工具以主进程 cwd 创建），海獭直接执行 `scripts/otter-buddy.sh stop` 解析到的就是主仓脚本——拦它是**正确行为，不是误拦**。真正的误拦残留仅限海獭「先 cd 进 worktree 再用相对路径调用」（`cd /path/to/worktree && scripts/otter-buddy.sh stop`），此形态守卫视角仍解析到主仓。缓解：拦截文案写明「worktree 内操作请使用该 worktree 的绝对路径」——引导路径即合法路径（绝对路径解析后不在主仓即放行）。

### 改动 2：脚本 otter-buddy.sh 回归纯工具

- 删除 `main_repo_root()` / `is_primary_checkout()` 两个函数（脚本头部）及 `cmd_stop` 中的主仓拒杀保护块（#970 加的整段）
- 修复 bash 3.2 定界 bug：全文件扫描「中文字符（含全角括号）紧邻 `$VAR`」写法，统一改 `${VAR}` 定界。当前命中：拒绝文案整段随保护块删除而消失；需逐个核查剩余字符串（如 `echo "Stopping Otter Buddy (PID $my_pid) ..."`——`$my_pid` 后是 `)` 半角字符不触发，但统一防御性定界）
- 保留 F20260831aksp 的端口归属杀伐校验（那是防「脚本杀错实例」的运行时 identity 校验，管的是正常功能正确性，不是防海獭，属于脚本本职）

### 改动 3：测试重构

tests/frameworks/agent/bash-safety-guard.test.ts 中 SERVICE_SCRIPT_KILL 用例组（现有 13 个）按新语义重写：

| 用例 | 命令形态 | 预期 |
|---|---|---|
| 主仓相对路径 | `scripts/otter-buddy.sh stop` / `./scripts/otter-buddy.sh restart` / `bash scripts/otter-buddy.sh stop` | 拦 |
| 主仓绝对路径 | `/Users/x/otter-buddy/scripts/otter-buddy.sh stop` | 拦 |
| worktree 绝对路径 | `/Users/x/otter-buddy/.otter/worktrees/w1/scripts/otter-buddy.sh stop` | 放行 |
| cd + 相对路径（误拦残留形态） | `cd /worktree && scripts/otter-buddy.sh stop` | 拦 + 文案引导绝对路径 |
| bash -c 单引号内嵌 | `bash -c 'scripts/otter-buddy.sh stop'` | 放行（与 #970 语义一致：前导约束不匹配 -c 后引号，单引号载荷不展开——行为不变，非本方案引入的缺口） |
| 变量隐藏子命令 | `S=stop && scripts/otter-buddy.sh $S` | 拦（间接引用保守拦截） |
| 变量隐藏全命令 | `CMD="scripts/otter-buddy.sh stop" && bash -c "$CMD"` | 拦（间接引用保守拦截） |
| 命令替换隐藏 | `bash -c "$(echo scripts/otter-buddy.sh stop)"` | 拦（间接引用保守拦截） |
| 安全子命令不误拦 | `scripts/otter-buddy.sh status` / `logs` / `cat scripts/otter-buddy.sh` | 放行（无 `$` 间接特征 + 无 stop/restart 字面） |
| sudo/命令替换 + 主仓路径 | 既有变体用例保留 | 拦 |
| ~ 前缀 | `~/scripts/otter-buddy.sh stop` | 拦（保守，不展开） |
| 多脚本混合 | `worktree绝对路径 stop && 主仓相对路径 stop` | 拦（任一命中主仓） |
| 中文语境数据文本 | 既有反向用例保留（#858 脱敏路径） | 放行 |
| projectRoot 缺失 | 未传 GuardOptions | 全局拦（保守退化） |
| mainPid=null + 主仓脚本 | PID 文件缺失场景模拟 | 拦（SERVICE_SCRIPT_KILL 不受 mainPid 短路影响） |

脚本层：bash 手动验证矩阵（主仓人工 stop 不拦、worktree stop 正常、端口归属校验仍生效、bash 3.2 下报错文案正常显示）。

### 改动 4：README 同步

启动脚本章节删除 #970 加的「主仓保护」说明，改为一句：脚本是无差别工具，防海獭误杀由 agent 运行时守卫负责（指向 F20260916gtlr）。

### 机制识别检查点

- □ 新增配置字段/枚举/开关——无
- □ 新增状态生命周期——无
- □ 新增定时任务/后台进程——无
- □ 新增信号类型/消息格式——无
- □ 新增持久化存储——无
- □ 新增决策分支——路径比对分支的结果只决定当次拦/放，不被记住，纯运行时临时分支
- □ 新增跨模块调用路径——无（GuardOptions.projectRoot 既有字段复用）

判定：**不涉及净新增机制**（本方案是 ③ 删除机制 + ② 收窄管辖）。跳过四问与重对抗门，此判定留痕供每日清单验证。

### 大版本重构判断

不属于大版本重构（单守卫规则收窄 + 单脚本保护删除，不涉及协作机制级重做），不触发零基重推。

## 影响范围

| 场景 | 之前 | 之后 |
|---|---|---|
| 海獭主仓 `scripts/otter-buddy.sh stop/restart` | 拦（守卫+脚本双层） | 拦（守卫单层）——安全能力不回退 |
| 海獭间接形态（`$S`、`$()`、`bash -c "$CMD"`）调脚本 stop/restart | 脚本层兜底拦 | 拦（守卫新增间接引用保守拦截，对齐 INDIRECT_PID 先例） |
| 海獭主仓绝对路径调主仓脚本 | 拦 | 拦 |
| 海獭 worktree 绝对路径调自己脚本 | **误拦** | 放行 ✅ |
| 海獭 cd 进 worktree 后相对路径调脚本 | **误拦** | 拦 + 文案引导改用绝对路径（cwd 恒为主仓根，静态不可区分，可接受残留） |
| mainPid=null（PID 文件损坏）时海獭调主仓脚本 | 脚本层兜底拦 | 拦（SERVICE_SCRIPT_KILL 移出 mainPid 短路作用域） |
| 搭档主仓人工 stop/restart | **误拦**（只能裸 kill） | 正常 ✅ |
| 搭档 worktree 人工启停 | 正常（人不走 tool 管道；脚本层 worktree 本就放行） | 正常（不变） |
| 海獭直接 kill 进程1（PID/pid 文件/pkill 形态） | 拦（kill 族既有规则） | 拦（不变） |

## 风险与约束

1. **单层防线依赖**：脚本层兜底删除后，主仓脚本形态只剩守卫一层。论证：tool 层是全集通道（海獭命令必过），双层本来就是同 threat 的冗余；kill 族/eval/pipe 等旁路规则仍在，脚本形态外的攻击面无变化。残余风险：守卫本身 bug 漏拦某形态——由既有测试矩阵（102 用例）+ 新增路径限定用例覆盖。
2. **cd 进 worktree 后相对路径误拦残留**：bash 工具 cwd 恒为主仓根（检视核实），海獭 `cd worktree && scripts/otter-buddy.sh stop` 在守卫视角仍指向主仓。接受理由：文案引导绝对路径后操作可达成；cd 是命令内动作，静态不可知。
3. **mainPid=null 残余风险**：PID 文件内容损坏（非数字）时若 SERVICE_SCRIPT_KILL 未移出短路作用域则直通主进程——方案已处置（路径判定移出 mainPid 短路）。处置后残余：PID 文件缺失时脚本走 "Not running" 路径无害，无需额外防线。
4. **符号链接指向主仓**：`ln -s` 形态超出守卫静态判定能力（不做 realpath IO）。声明接受：属已知残余风险，海獭构造符号链接需多步操作，非事故形态（9/16 事故是直接调用）。
5. **约束**：守卫同步路径不引入新外部依赖（路径解析用 node:path 既有 import），不做文件系统 IO（无 realpath/lsof）。

## 不兼容更新

[Incompatible] `scripts/otter-buddy.sh` 在主仓的 stop/restart 从「拒绝执行 exit 1」恢复为「正常执行」——恢复 #970 之前的行为。#970 commit 已检索确认无自动化调用方依赖拒杀行为；搭档人工使用正是本方案要恢复的场景。

## 设计取舍

本方案部分取代 F20260916gsrd（#970）：删除其脚本层主仓拒杀（B 层），保留并收窄其守卫层 SERVICE_SCRIPT_KILL（加路径限定）。取代理由与过程见「问题本质」节。

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 脚本层主仓拒杀 | 删除 | 保留 + 加 TTY 交互确认人工出口 | 搭档裁决：拦截约束在 tool 层，不扩散到系统脚本。脚本层保护的集合为空（不经 tool 层的只有人），TTY 出口是在脚本里重造人/獭区分，多余 |
| 守卫路径限定基准 | projectRoot（=主仓）做相对路径 resolve | 透传 bash 工具真实 cwd | bash 工具 cwd 恒为主仓根（tool-description-overrides.ts:66，检视核实），透传无增量价值；cd 形态静态不可知，文案引导兜底 |
| 人工出口 | 不设计 | --force 参数 / 交互确认 | 人不进 tool 管道，拦截域内无人——出口需求本身消失（搭档指出的 --force 打洞问题随之不存在） |
| cd+相对路径误拦 | 接受 + 文案引导 | 全量 cwd 追踪 | cd 是命令内动作，静态不可知；有明确可操作解法（绝对路径） |
| 变量隐藏绕过 | 新增间接引用保守拦截（脚本引用 + `$` 特征） | 不管（认为概率低）/ 全量拦 `bash -c` | 检视严重发现 1：脚本层删除后此路径直通主进程，必须堵；对齐 kill 族 INDIRECT_PID_PATTERNS 先例；收窄条件避免误拦 logs/status 安全子命令 |
| mainPid=null 组合 | SERVICE_SCRIPT_KILL 移出 mainPid 短路作用域 | 维持短路（认为 PID 损坏概率低） | 检视建议发现 3：删除脚本层兜底后此组合直通主进程，路径判定不依赖 PID 信息，移出零成本 |
| 机制识别 | 不涉及净新增机制 | — | 逐项机械判定见「机制识别检查点」，本方案为删除机制+收窄管辖（间接引用拦截是既有规则族的形态补齐，与 INDIRECT_PID_PATTERNS 同族，非新机制） |

## 验证

### 实现期验证结果（2026-09-16）

- **守卫单测**：bash-safety-guard.test.ts 120/120 通过（含 15 个 SERVICE_SCRIPT_KILL 路径限定 + 间接拦截用例）
- **全量测试**：258 文件 3139 用例全绿，0 error
- **lint**：改动文件 0 error（主入口圈复杂度拆分 helper 后合规）
- **脚本 bash 3.2 验证**（macOS 系统 bash 3.2.57 实测）：`bash -n` 语法通过；`bash -u scripts/otter-buddy.sh status` / `stop -p 3009`（无实例端口）正常输出无 unbound variable 乱码——定界 bug 修复生效
- **实现期发现与修正**（测试驱动暴露）：
  1. sanitizer 敏感词表缺 `otter-buddy.sh`（#970 新增守卫词元时未同步 #858 词表）→ 引号数据文本（grep 'otter-buddy.sh restart' README.md）被路径限定误拦 → 补词表
  2. SCRIPT_PATH_EXTRACT 初版无前导约束 → 中文语境裸文本提及误拦 → 对齐 SERVICE_SCRIPT_KILL 前导分组
  3. 间接特征正则 `/\$[{(]|\`/` 不匹配裸 `$VAR` → 补 `A-Za-z_`
  4. `bash -c '...'` 单引号内嵌：#970 原语义即不拦（前导约束不匹配 `-c` 后引号）——方案用例表初版误标为拦，实现期核实后修正为「放行（行为不变）」

### 自动化测试

- bash-safety-guard.test.ts：SERVICE_SCRIPT_KILL 用例组按上表重写，全量回归 0 失败
- agent 全量测试 0 失败

### 手动验证矩阵（bash 3.2 环境）

| # | 操作 | 预期 | 实测 |
|---|---|---|---|
| M1 | worktree 内 `bash -u scripts/otter-buddy.sh status` | 正常显示，无乱码 | ✅ |
| M2 | `bash -u scripts/otter-buddy.sh stop -p 3009`（无实例端口） | 「Not running」正常路径 | ✅ |
| M3 | worktree stop 端口被占提示 | F20260831aksp 杀伐校验行为不变 | ✅（3001 被占提示正常） |
| M4 | 主仓人工 stop 主服务 | 正常停止，无拒绝文案 | 合入后由搭档按需自然验证（不在开发期动生产主服务） |

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/agent/bash-safety-guard.ts | M | SERVICE_SCRIPT_KILL 判定加主仓路径限定（SCRIPT_PATH_EXTRACT 捕获组提取 + resolvesToMainCheckout 比对）；间接调用保守拦截（SCRIPT_REFERENCE + INDIRECT_CALL_FEATURE）；mainPid=null 快速通道（checkWhenMainPidMissing）；圈复杂度拆分 helper |
| src/frameworks/agent/quoted-text-sanitizer.ts | M | 敏感词表补 otter-buddy\.sh（#970 未同步 #858 词表的遗留缺口，实现期测试暴露） |
| scripts/otter-buddy.sh | M | 删 main_repo_root/is_primary_checkout/主仓拒杀块；$VAR 定界修复 |
| tests/frameworks/agent/bash-safety-guard.test.ts | M | SERVICE_SCRIPT_KILL 用例组重写（13→18）+ 新增路径限定 describe（12 用例），总 102→120 |
| README.md | M | 启动脚本章节：主仓保护说明改为守卫职责指向 |
| docs/features/2026/09/16/F20260916gtlr-guard-tool-layer-convergence.md | A | 本文档 |
