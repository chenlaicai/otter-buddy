---
id: F20260831aksp
title: 防误杀本系统机制完整设计：脚本杀伐校验 + 守卫拦截闭环 + 拦截可观测
date: 2026-08-31
status: implemented
summary: 三层防线统一设计——①otter-buddy.sh 杀伐前校验端口归属（8/29 误杀路径）②bash 守卫拦截后带上下文引导 LLM 自纠（修复「拦截即停摆」）③拦截全程可观测（healing 落账）+ 守卫归一化堵引号拼接绕过 + 误拦只引导语义替代（R1 审视修正）
created_in_conversation: cb80d695-bce9-4b83-9f2a-98618242acd0
capability_test: "n/a: 纯 A 类改动（shell 脚本 + 守卫重试链路），不涉及 LLM 行为"
---

# F20260831aksp: 防误杀本系统机制完整设计

## 背景

搭档原话（意图锚）：

> 「昨天应该是另外有一个对话中修复了，应该就是你找到的611。刚才另外另外一个对话又发生了一次大獭想Bash杀自己然后被拦了，但是我看到系统消息只中断，但没让海獭继续，这有点不太好，理想中，应该是系统拦截然后提示海獭，海獭继续行动，而不是系统拦截然后对话就停下了（还得我去手动再拉起话头）。这一点你也列为思考，然后按照你要修的点，完整把这整个防止误杀本系统的机制 分析设计完整、优雅！」

终审反馈（8/31，口径修正）：

> 「等等，"告知搭档执行"，一般情况下，不可能需要自己正在运行中，然后要求重启自己的；如果是需要验证某个新特性分支，那也应该是在worktree然后用其他端口来启动验证。所以，一般情况肯定都是海獭们准备"误杀"主进程，这种场景，需要拦，并且告知正在触发的命令是不被允许的，然后让海獭再次思考分析」

核心修正：**不存在海獭需要重启/停止主进程的合法场景**——海獭自己就运行在主进程里；验证新特性分支的正道是 worktree + 独立端口隔离实例。拦截文案不应提供任何「重启主服务」出口（含转手版），应宜截声明不允许 + 指明 worktree 正道 + 引导重新思考分析。

三起真实事故构成完整证据链（全部有日志/DB 锚点）：

| # | 时间 | 现场 | 凶器 | 结果 |
|---|------|------|------|------|
| A | 8/29 16:16:59 | mimo-p1 在主仓目录执行 `cd /Users/orca/ai/otter-buddy && bash scripts/otter-buddy.sh stop -p 3002` | 脚本 PID 文件分支：主仓 `.otter-buddy.pid` 存着 3000 主服务 PID，`-p 3002` 未参与决策，`kill -15` 直发主服务 | 主服务死亡 6 小时（message_events 08:16:59 toolcall 与 SIGTERM 同秒） |
| B | 8/30 13:04:28 | 小獭 7708a033 在 failed 消息上继续跑（91 次 toolcall），bash 直接 `kill 42877` + `nohup node dist/src/main.js` 重启 | LLM 直接 kill 主进程 PID | 主进程死亡（#611 已修 failed-abort + 守卫拦截） |
| C | 8/31 09:28 | 同一只 7708a033 在另一对话 `kill 87647`，被 #611 守卫拦截 → 自动重试 → **再撞一次** `kill 87647; sleep 3; ...` → 第二次拦截不再重试 | LLM 直接 kill 主进程 PID（明知故犯或不知被拦） | 消息 aborted，对话停摆，搭档手动拉起（logs L355558-355609，msg b56a3dba 终态 aborted） |

事故 C 暴露的是 #611 修复的**半闭环**：拦得住刀，救不活场。

## 根因分析

### 根因 1：脚本的杀伐决策不看端口参数（事故 A）

`scripts/otter-buddy.sh` 的 `cmd_stop`（当前 main 版本）：

```bash
my_pid=$(get_pid)            # 读 $PROJECT_DIR/.otter-buddy.pid
if [ -n "$my_pid" ] && kill -0 "$my_pid" 2>/dev/null; then
  kill -15 "$my_pid" ...     # ← 直接杀，PORT 参数完全不参与
fi
```

`PROJECT_DIR` 由脚本自身路径解析（`dirname $0/..`）——在主仓执行 `stop -p 3002` 时读到**主仓的 PID 文件**（3000 主服务），而调用者意图是停 3002。`-p` 参数在 stop 路径上是**死参数**：用户/LLM 以为它约束了杀伐范围，实际没有。误杀窗口 = 认知与行为的鸿沟。

注：stop 的端口兜底分支（PID 文件缺失时）自 #375（8/21）起只警告不杀，那段是安全的；危险的是 PID 文件分支。

### 根因 2：拦截后 LLM 收不到「为什么被拦」（事故 C）

守卫拦截路径（已核实代码）：

```
tool_execution_start (bash)
  → checkBashCommandSafety() 命中 → doAbort(`bash_safety:${原因}`)
  → orchestrator routeByReason → guard_abort 分支
  → isRetryableGuardAbort('bash_safety:...') === true → handleAutoRetry
  → buildAutoRetryMsg(reason) 注入重试 userMessage
```

**缺陷点**：`buildAutoRetryMsg`（src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts:46-58）只有 streaming_timeout / first_byte_timeout / circuit_break 三个分支，**没有 bash_safety 分支**，落到兜底文案：

> `[系统提醒] 你上一轮执行异常，已被系统自动重试。请继续完成你的发言。`

LLM 看到的是「执行异常，请继续」——它不知道命令被安全守卫拦了、不知道为什么、不知道该怎么改。上下文里唯一的新信息是工具结果没回来，于是最合理的行为就是**把命令再发一遍**（LLM 视角：可能是瞬时故障）。第二次触发拦截时 `retryCount===1`，`isRetryableGuardAbort` 分支不再命中（条件是 `retryCount === 0`），走 `abortTerminal` → 消息 aborted → 对话停摆，等搭档手动拉起。

讽刺的细节：守卫的**终态**文案（`buildGuardAbortBody` retry-policy.ts:82）是有 bash_safety 分支且信息充分的——「检测到危险命令（如 kill 主进程），已自动中断。请改用 otter-buddy.sh restart 或报告大獭」——但这段话只写给**终态**（不再重试时）；重试路径（LLM 真正能自纠的那次机会）用的却是不知所云的兜底文案。信息有了，送错了地方。

### 根因 3：守卫拦截与误拦完全不可观测

- 拦截只写 pino 日志（`[bash-safety-guard] BLOCKED ...`），不落 healing_events——搭档不看日志就不知道发生过拦截（事故 C 的搭档是看到「系统消息只中断」才发现的）
- 守卫无退出通道：误拦（如 8/30 14:11 大獭自己的 SQLite 查询语句含 `'%kill%'` 字符串被间接 PID 模式误伤，log L354235）时，LLM 没有任何合法方式表达「这条命令是安全的」——只能绕路（改写命令）或认命

## 目标

- **T1（杀伐校验）**：`otter-buddy.sh` 的 stop/restart 在杀 PID 文件进程前，校验该进程**实际监听的端口**与 `$PORT` 一致，不一致拒杀并给出可操作提示——关闭事故 A 的误杀窗口
- **T2（拦截闭环）**：bash 守卫拦截后，重试注入的提示**携带拦截原因与替代路径**，让 LLM 一次自纠成功（知道被拦、知道为什么、知道该怎么做）；持续危险不再无限重试（现有 retryCount 语义保留）
- **T3（可观测）**：守卫每次拦截落 healing_events（搭档在对话界面可见）；误拦提供明确退出信号（LLM 可声明绕行，大獭侧可裁决）
- **T4（优雅性）**：三层防线语义统一——「脚本管物理杀伐、守卫管 LLM 命令、观测管全局」，每层的职责边界与文案口径一致（拦截提示推荐的替代方案必须是真正安全的路径）

## 非目标

- 不做 OS 级进程隔离（sandbox、容器、独立用户）——超出本项目范围
- 不追杀 base64/多层转义等文本分析盲区——守卫文档已如实声明这是纵深防御一层而非绝对防线（#611 R2 决策保留）
- 不改 failed-abort 与 resume 容错（#611 已修，本方案不翻案）
- 不引入新的守护进程或常驻监控——守卫钩子在现有 tool_execution_start 事件链上，不增加运行时组件

## 方案设计

整体结构：**三层防线 + 一条观测线**。

```
第1层 脚本杀伐校验（otter-buddy.sh）     —— 物理杀伐的最后闸门（修 T1）
第2层 bash 守卫拦截（bash-safety-guard） —— LLM 命令的实时闸门（#611 已有，补 T2 闭环）
第3层 引导自纠（重试提示注入）           —— 拦截后的行为矫正（修 T2）
观测线  healing 落账 + 误拦退出信号      —— 全局可见与人工裁决（修 T3）
```

### 一、脚本杀伐校验（T1）

改动 `scripts/otter-buddy.sh` 的 `cmd_stop`（约 15 行）：

```bash
# 杀伐校验：PID 文件里的进程必须确实是 $PORT 的监听者（F20260831aksp T1）
# 插入位置：cmd_stop 的 kill -15 之前（此时 my_pid 已过 kill -0 存活检查，必然存活）
if command -v lsof >/dev/null 2>&1; then
  listen_pids=$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
  if ! echo "$listen_pids" | grep -qx "$my_pid"; then
    echo "[error] Refusing to stop: PID file ($PID_FILE) points to PID $my_pid,"
    echo "        but it is NOT listening on port $PORT (listener: ${listen_pids:-none})."
    echo "        Likely wrong directory or PID file from another instance."
    echo "        If you are SURE this process should die:  kill $my_pid"
    return 1
  fi
fi
# lsof 不可用：跳过校验（真降级放行——增强闸门不做硬依赖，R1 发现2 采纳）
```

语义（关键：走到这里的 `my_pid` 必然存活——前置 `kill -0`（cmd_stop 第 112 行）已过滤死进程）：

- PID 文件进程存活 **且** 在 `$PORT` 监听者名单里 → 正常杀（当前行为）
- `$PORT` 有监听者但不是 `my_pid` → 拒杀（杀错对象）
- `$PORT` **无人监听**但 `my_pid` 存活 → **拒杀**——这不是「进程已死 PID 残留」（那种已被 kill -0 拦截），而是「活着的进程不是 $PORT 的服务」= 事故 A 的确切形态（主仓 PID 文件指向存活主服务、3002 静默）。拒杀提示附 override（`kill $my_pid`）——服务挂起等罕见合法场景用户可自行手动处理，闸门不困人
- 多监听者（SO_REUSEPORT 等）：`grep -qx` 精确行匹配 `my_pid` 在名单中即放行（lsof -t 多行输出下字符串全等比较会恒不等，行匹配才正确）
- `lsof` 缺失：`command -v` 前置检查 → 跳过校验，保持现状行为（R1 发现2 采纳：原稿代码在 lsof 缺失时会因空串恒不等而拒杀，与「降级放行」声明矛盾——修正为显式 command -v 分支）
- `cmd_restart` 调 `cmd_stop` 自动继承保护；`cmd_stop` 返回 1 时 restart 中止（`set -euo pipefail` 下非 0 退出，restart 不会继续 start，符合预期）

> **对 R1 发现 2 的部分反驳**（R2 已复核认可）：检视者 R1 建议「port_pid 为空时不拒杀、交给 kill -0 处理」——但 kill -0 检查的是**进程存活**而非**端口归属**，且它先于本校验执行；事故 A 中主服务活得好好的，该建议会把 8/29 误杀原样放行。空监听 + 存活 PID 的组合只能拒杀（附 override 提示平衡罕见合法场景）。误杀代价（8/29 实测 6 小时宕机）>> 拒杀代价（一条提示 + 手动命令）。

`cmd_start` 的端口冲突检测已有（`port_owner_pid`），无需改。

### 二、守卫拦截闭环（T2）——核心

两个互补修复，缺一不可：

#### 2a. 重试提示携带拦截上下文（治「不知为何被拦」）

`buildAutoRetryMsg`（retry-policy.ts）补 bash_safety 分支：

```typescript
if (reason.startsWith('bash_safety:')) {
  return `[系统提醒] 你刚才的 bash 命令被安全守卫拦截：${reason.slice('bash_safety:'.length)} 该命令不允许：主进程是所有海獭（包括你）的运行环境，任何情况下都不得终止——你不存在需要重启或停止主进程的合法场景。若你的目的是验证代码变更：请在 worktree 中用独立端口启动隔离实例验证；若你观察到服务异常：请报告搭档处理。请基于以上约束重新分析当前任务，调整方案继续执行，不要重复原命令。`;
}
```

关键点（终审口径修正后）：`reason` 是 `bash_safety:${checkBashCommandSafety 的返回文案}`——守卫的拦截原因（如「命令目标是主进程 PID」「目标为变量或命令替换」）**原样进入 LLM 上下文**（PID 数字已在守卫文案层脱敏为占位表述，见 3b——透传不泄露真实 PID，堵「试探→回显→精准打击」链）。引导文案四要素：①宜截声明「该命令不允许」②说明为什么不存在合法场景（主进程=自身运行环境）③给出唯一正道（worktree + 独立端口验证；服务异常→报告搭档）④引导重新分析任务继续执行。**不提供任何 restart 出口**（含「告知搭档执行 restart」转手版）——终审反馈指出：提供该出口暗示了「重启主服务」是海獭的潜在合法需求，会诱导 LLM 围绕重启打转；实际上验证需求由 worktree 隔离实例满足，LLM 自己就能完成，闭环更完整。LLM 第一次重试就知道：被拦了、为什么、正道在哪、继续干什么。

这与现有架构零冲突：`buildAutoRetryMsg` 的三个既有分支就是按 reason 精确分文案的，bash_safety 只是补齐第四个分支——模式完全同构。

#### 2b. 拦截提示同时可见于对话流（治「搭档看不见」+ 终态文案同步修正）

`handleAutoRetry` 里 bash_safety 路径的 `failBody` 当前是通用的「执行异常, 正在自动重试」。改为在 `buildRetryFailBody` 补 bash_safety 分支：

```typescript
if (reason.startsWith('bash_safety:')) return '检测到针对主进程的不允许命令，已拦截并引导海獭重新分析任务';
```

这样消息流里搭档看到的是事实（危险命令被拦）而非误导（执行异常）。

**同步修正终态文案 buildGuardAbortBody**（架构审视发现1 补规格；终审反馈直接引用的正是这句）：现行 bash_safety 终态文案（retry-policy.ts:82）是「检测到危险命令（如 kill 主进程），已自动中断。请改用 otter-buddy.sh restart 或报告大獭」——后半句既在教 LLM 用事故 A 的凶器，又暗示重启是合法需求。终版文案（与 §2a 同口径）：

> 检测到针对主进程的不允许命令（主进程是海獭运行环境，任何情况下不得终止），已自动中断。若需验证代码变更请在 worktree 用独立端口启动隔离实例；服务异常请报告搭档。

注：终态文案写给对话流（搭档与后来者看），重试文案写给 LLM 自纠（§2a），两者受众不同但口径同源——均无 restart 出口。

#### 为什么不用 steer 而用 abort+retry

评估过替代方案：拦截时用 `session.steer()` 注入提示让 LLM 在同一 session 内转向（不打断流）。
- 优点：不丢上下文，无重试开销
- 缺点：steer 只在**下一次 LLM 调用边界**生效，当前 toolcall 已在执行管道里（bash 工具是真实进程，必须阻止执行——steer 阻止不了已提交的执行），且 steer 与工具结果的时序竞争在 pi SDK 内未验证
- 结论：abort+retry 是已验证路径（#611 R2-1 已让 bash_safety 可重试），本方案只修文案层，不动执行模型——改动面最小、风险最低

### 三、拦截可观测（T3）

#### 3a. 拦截落 healing_events（记录点两处，severity 分级机制落地——R1 发现3 采纳）

拦截上下文（命令文本）在框架层，retryCount 在编排层——单一记录点无法同时拿到两者，且跨层传递状态会增加耦合。设计为**两层各记各的**：

- **框架层**（circuit-breaker-helpers.ts 的 bash_safety 拦截点）：每次拦截记一条，含命令前缀（观测价值），severity 恒 `medium`——拦截成功=防线正常工作的样本：

```typescript
errorType: "guard_intercept",
severity: "medium",
description: `bash 守卫拦截：${safetyBlock}（命令前缀：${command.substring(0, 120)}）`,
suggestion: "LLM 已收到引导提示；若同一 otter 短时间内多次被拦，先排查是否误拦——误拦率上升会侵蚀 LLM 对引导的信任（第四类风险，架构审视发现4）",
```

- **编排层**（orchestrator.ts 的 abortTerminal，`guardReason.startsWith('bash_safety:')` 且 `retryCount > 0` 的终态路径）：此处天然持有 retryCount，补录 `severity: high`——同消息二拦 = 自纠失败前兆 = 事故 C 停摆前兆，搭档须关注

两层不需要去重协调：medium 是统计样本，high 是告警信号，语义不同各记各的。`manage_healing_events` 按 `errorType=guard_intercept` 查询时两条并存，语义清晰。**演化路标（架构审视发现2）**：若未来 severity 分级超过两级、或框架层需要感知重试上下文，重构为「框架层只 emit 事件、编排层统一落账定级」——当前两级场景下双写是最简方案，事件驱动是过度设计，但超过两级时反转。

#### 3b. 误拦退出信号 + 守卫归一化（R1 严重1 修正：只引导语义替代，不教授文本规避）

误拦真实存在且已常态化三例：大獭 8/30 被 `'%kill%'` SQL 字符串误伤（log L354235）；检视獭-aksp 本轮复核守卫正则时，构造含 kill 模式的验证命令又被拦（对话可见）。**原设计在此犯了个错**：提议在拦截文案里教 LLM「引号拼接/变量间接」等规避技巧，论证是「改写后的命令仍过判定」——R1 审视证伪了这个论证：`ki''ll`（空引号拼接）不匹配 `KILL_COMMANDS`（`\bkill\b` 词边界），也不匹配 `INDIRECT_PID_PATTERNS`（无 $()/管道/eval/hex），却能以完整 kill 语义执行——**技巧既保留语义又绕过判定**，守卫自己会变成攻击面教材。修正后的设计：

- **拦截文案只引导语义替代**：`如确认此命令本意安全（如查询语句恰好含 kill 字样），请改用保持原语义的不含敏感字样的方式达成目的（如换检索关键词，不得用模糊匹配/字符替换变相达成原检索）；无法规避时告知搭档人工执行。`——不出现任何拼接技巧示例（架构审视发现3：明确「保持原语义」并禁止模糊匹配/字符替换，防语义层绕过侵蚀守卫可观测性）
- **守卫归一化检测（新增 §2c 规格，配套堵通道）**：`checkBashCommandSafety` 匹配前对命令副本做归一化——移除空引号对（`''`/`""`）与字母间反斜杠（`k\ill` → `kill`），原始与归一化两份文本都过既有正则。`ki''ll 87647`/`k\ill 87647` 归一化后命中 `kill 87647` → 拦截。归一化只影响检测，不改日志留存（日志记原始命令）。误拦面评估：归一化新增的 kill 词命中仍需通过后续 PID/间接模式判定才会拦截（如 `grep 'ki''ll' file` 无数字 PID → 放行），不扩大误拦
- **守卫拦截文案去 PID 数字（R1 建议2 顺带落地）**：`kill ${mainPid}（主进程 PID）` 改为「主进程 PID」占位表述——堵「错误 PID 试探 → 拦截文案回显真实 PID → 精准二次打击」链路；结构化日志字段 `commandPids` 保留数值不损排查能力（§2a 重试提示同步脱敏）

不做硬白名单/跳过开关——跳过开关一旦被 prompt 注入利用就是防线全失；语义替代引导 + 归一化堵通道后，真正能通过守卫的改写只剩「不含 kill 语义」一种，正是设计想要的。

### 四、防御纵深全景（优雅性收束）

修复后的三层各自语义与失效模式：

| 层 | 拦什么 | 拦截后 | 失效模式 | 兜底 |
|----|--------|--------|----------|------|
| 脚本杀伐校验 | 物理进程杀伐（kill 闸门） | 拒杀 + 目录提示 | lsof 缺失 → 放行 | 守卫层仍在（对 LLM 直接 kill 的路径） |
| bash 守卫 | LLM 命令文本（kill 族 + 间接模式 + 引号/反斜杠归一化） | abort + 带因重试 | 文本变形绕过（引号/反斜杠拼接已归一化堵死；base64 等多层转义仍超出文本分析能力——如实文档声明） | 脚本层（真跑到脚本时被杀伐校验拦） |
| 引导自纠 | —（第 2 层的续篇） | LLM 收到原因与替代路径，一次自纠 | LLM 无视提示再撞 | 第二次不再重试 → aborted 终态 + healing high |
| 观测线 | — | healing 落账，搭档界面可见 | 误拦率上升→LLM 对引导产生信任抗体→长期行为漂移（第四类风险，架构审视发现4；退出条件：同一 otter 多次被拦且均系误拦→人工审查守卫规则） | pino 日志仍在（双写） |

**文案口径统一**（T4，终审修正后）：三处涉及拦截引导的文案（守卫终态文案 buildGuardAbortBody、buildAutoRetryMsg 新分支、脚本拒杀提示）统一遵循两条原则：

1. **对 LLM 不提供任何主进程操作出口**——修复前守卫文案推荐 LLM「请使用 otter-buddy.sh restart」，而脚本恰是事故 A 的凶器；原修订版收软为「告知搭档执行」，终审反馈指出这仍暗示重启是潜在合法需求。终版口径：宜截声明「该命令不允许」+ 说明不存在合法场景 + 正道是 worktree 独立端口验证 + 服务异常报告搭档——LLM 的验证需求由隔离实例闭环满足，不需要任何人代它重启主进程
2. **脚本拒杀提示面向人类**（开发者直接读终端）：保持 override 提示（确需手动 kill 时给出确切命令），不套用 LLM 话术——受众不同，口径各归其位

## 影响范围

| 模块 | 影响 |
|------|------|
| `scripts/otter-buddy.sh` | cmd_stop 增加杀伐校验（~15 行）；stop/restart 行为变更：跨目录误杀场景从「静默杀错进程」变为「拒杀报错」 |
| `src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts` | buildAutoRetryMsg 补 bash_safety 分支；buildRetryFailBody 补 bash_safety 分支（纯文案） |
| `src/frameworks/agent/circuit-breaker-helpers.ts` | bash_safety 拦截处增加 recordHealingEvent 回调（需从 attachGuards 参数链传入或复用现有回调通道） |
| `src/frameworks/agent/bash-safety-guard.ts` | 拦截文案追加误拦退出引导（纯文案）；不改正则与判定逻辑 |
| 消费方：messages 流 / healing_events | 搭档可见性提升；manage_healing_events 查询多一种 errorType=guard_intercept |

**无 schema 变更**（healing_events 表已有 errorType 字段，guard_intercept 是新枚举值非新字段）。

**行为变更说明**：脚本 stop 在「PID 文件与端口不一致」时从杀变为不杀——这是有意的破坏性收窄（破坏的正是误杀行为本身）。

## 风险与约束

1. **重试提示进入 LLM 上下文的信息泄露面**：拦截原因含命令描述（如「命令包含主进程 PID」占位表述——PID 数字已在守卫文案层脱敏，见 3b）——守卫判定中使用的主进程 PID 信息进入 LLM 上下文理论上给恶意 LLM 提供目标线索。评估：该 LLM 本来就在尝试 kill 主进程（它发的命令里就有 PID），提示不增加新攻击面；且提示同时给出正确行为引导，收益大于风险。
2. **LLM 无视提示三连撞**：第二次拦截即终态（现状保留），不会无限循环。最坏情形与事故 C 相同（aborted + 搭档手动），但概率显著降低（第一次就有了充分信息）。
3. **脚本校验的 lsof 依赖**：macOS/Linux 开发机标配；缺失时降级放行（不比现状差）。
4. **healing 落账增加写量**：仅拦截时触发（低频：三起事故/三天），无性能影响。
5. **误拦退出引导被滥用**：原设计教授引号拼接等规避技巧并论证「改写后仍过判定」——R1 严重1 证伪：`ki''ll` 不匹配任何现有模式却保留致命语义，论证前提（拼接属于 INDIRECT_PID_PATTERNS 拦截范围）不成立，守卫文案会成为攻击面教材。处置：删除全部技巧教授，只留语义替代引导；守卫增加归一化检测把引号/反斜杠拼接通道物理堵死（见 3b）。修正后能通过守卫的改写只剩「不含危险语义」的命令。

## 不兼容更新

- [Incompatible] `otter-buddy.sh stop/restart` 在 PID 文件与监听端口不一致时行为变更：杀 → 拒杀（exit 1）。依赖旧「盲杀」行为的自动化脚本（若有）会得到非 0 退出码。检索仓库内无调用方依赖此行为（脚本唯一调用场景是开发者/LLM 手动）。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|----------|------|
| 拦截后的续跑机制 | abort + 带因重试（补文案） | steer 同 session 转向 | steer 阻止不了已提交的工具执行，且时序竞争未验证；abort+retry 是 #611 已验证路径，只修文案层风险最小 |
| 杀伐校验的实现层 | shell 内 lsof 比对 | PID 文件加端口字段（元数据校验） | lsof 比对的是**运行时事实**（进程此刻监听什么），元数据校验的是**写入时的意图**——事实比意图可靠；且不改 PID 文件格式，零迁移 |
| 误拦退出通道 | 文案引导改写 | 白名单/配置/跳过开关 | 跳过开关一旦被注入利用即防线全失；归一化堵死文本规避通道后，引导绕开语义而非绕过判定 |
| 第二次拦截的处置 | 终态 aborted（现状） | 无限重试 / 熔断重启 | 无限重试=资源黑洞；熔断重启（清上下文）对「就想杀进程」的 LLM 过重且丢任务进度；aborted+healing high+搭档可见是正确的人力介入点 |
| 重试提示的信息量 | 全量拦截原因+替代路径（PID 脱敏） | 只说「命令被拦」 | 事故 C 证明不充分信息导致复撞；脱敏堵试探链（风险 1） |
| healing severity 定级 | 首拦 medium / 同消息二拦 high | 一律 high | 拦截成功=防线正常工作（medium 供观察）；同消息二拦=自纠失败前兆（high 须关注） |

## 验证

| 验证项 | 方法 | 通过标准 |
|--------|------|----------|
| 脚本杀伐校验 | 手动：主仓目录跑 `scripts/otter-buddy.sh stop -p 3002`（3002 无监听） | 拒杀 + exit 1 + 目录提示；3000 主服务存活 |
| 脚本正常路径 | worktree 内 stop/restart 自己的实例 | 正常杀/重启（校验通过） |
| 守卫拦截引导 | 集成测试：mock 守卫命中 → 断言重试 userMessage 含拦截原因与「告知搭档」引导 | 文案断言（含 bash_safety: 前缀原因透传） |
| 事故 C 复现回归 | 测试：第一次拦截 → 重试含原因；第二次拦截 → aborted 终态 + healing high | 不出现「通用文案重试」；终态 healing severity=high |
| ki''ll / k\\ill 归一化回归 | 单测：`ki''ll <mainPid>` / `k\\ill <mainPid>` 过守卫 | 归一化后命中拦截（R1 严重 1 配套）；`grep 'ki''ll' file` 等无 PID 场景仍放行（不扩大误拦） |
| lsof 缺失降级 | 测试：PATH 置空跑 cmd_stop | command -v 短路 → 跳过校验不拒杀（真降级） |
| 空监听 + 存活 PID（事故 A 形态） | 测试：mock lsof 空输出 + my_pid 存活 | 拒杀 + exit 1 + override 提示 |
| 多监听者 | 测试：mock lsof 返回多行含 my_pid | grep -qx 命中 → 放行正常杀 |
| 误拦退出 | 手动：含 `'%kill%'` 字符串的 SQL 查询走守卫 | 拦截提示含语义替代引导（不改判定） |
| 端到端闭环（架构审视补） | 集成测试：真实 agent 环境构造守卫命中→拦截→带因重试→LLM 改道 worktree 验证路径 | 全链路无人工介入不停摆（事故 C 形态不复现） |
| 单元回归 | 既有 bash-safety-guard.test.ts 39 用例 + retry-policy 测试 | 全绿 |
| 全量 | npm test | 0 failed |

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `scripts/otter-buddy.sh` | 修改 | cmd_stop 杀伐校验（~15 行）+ 拒杀提示 |
| `src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts` | 修改 | buildAutoRetryMsg / buildRetryFailBody / buildGuardAbortBody 三处补/改 bash_safety 文案（重试引导 + failBody + 终态文案，含去 restart 推荐——终审反馈直接引用的就是终态那句「请改用 otter-buddy.sh restart 或报告大獭」） |
| `src/frameworks/agent/circuit-breaker-helpers.ts` | 修改 | bash_safety 拦截处 recordHealingEvent（medium，回调通道接线） |
| `src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts` | 修改 | abortTerminal 的 bash_safety 终态路径补录 healing（high，R1 发现3） |
| `src/frameworks/agent/bash-safety-guard.ts` | 修改 | 归一化检测（空引号对/字母间反斜杠，原始+归一化双文本过既有正则）+ 拦截文案去 PID 数字 + 误拦语义替代引导（判定正则不改） |
| `tests/frameworks/agent/bash-safety-guard.test.ts` | 修改 | 文案断言 + 事故 C 回归用例 |
| `tests/usecases/conversation/agent-turn-orchestrator/retry-policy.test.ts` | 修改 | bash_safety 分支文案测试 |
| `docs/features/2026/08/31/F20260831aksp-*.md` | 新增 | 本文档 |

## 实现记录（2026-08-31）

全部按方案落地，T1-T4 四目标 + 守卫归一化 + 两层 healing：

| 方案项 | 实现结果 | 验证 |
|--------|----------|------|
| T1 脚本杀伐校验 | cmd_stop 插入 lsof 监听者名单校验（command -v 降级 + grep -qx 多监听行匹配 + 拒杀附 override） | 沙箱三场景全过：事故 A 形态拒杀（dummy 存活）/正常路径放行停止/lsof 缺失降级 |
| T2a 重试文案 | buildAutoRetryMsg 补 bash_safety 分支：透传拦截原因 + 四要素引导（不允许声明/无合法场景/worktree 正道/重新分析）+ 无 restart 出口 | 单测断言四要素与透传 |
| T2b 终态文案 | buildGuardAbortBody 去「请改用 otter-buddy.sh restart」；buildRetryFailBody 补 bash_safety 事实文案 | 单测断言不含 restart/不含 PID 数字 |
| T3 框架层 healing | circuit-breaker-helpers 新增 onGuardIntercept 回调参数；pi-session-factory.buildGuardInterceptHook 组装 medium 事件（fire-and-forget，失败仅记日志） | 类型接线 + tsc 全绿 |
| T3 编排层 healing | orchestrator.abortTerminal 补 guard_intercept high（bash_safety 终态 + retryCount>0） | 类型接线 |
| 归一化检测（§2c） | checkBashCommandSafetyOnText 抽取，原始+归一化双过全量正则；normalizeForDetection（空引号对/字母间反斜杠） | 单测：引号/反斜杠拼接+主 PID 拦截；无 PID 拼接查询放行（不扩大误拦） |
| PID 脱敏 | 字面量命中文案改占位表述；日志 commandPids 保留数值 | 单测断言文案不含 42877 |
| 误拦语义替代 | 间接目标拦截文案加「保持原语义 + 不得模糊匹配/字符替换」 | 文案断言 |
| errorType 枚举 | HealingErrorType + HealingEventInput 补 guard_intercept | tsc |

**测试**：188 文件 / 2286 用例全绿（含新增 13 用例：归一化回归 6 + retry 文案 5 + 脱敏/无 restart 断言 2）；tsc --noEmit 零错；lint 0 error（5 warning 为存量 React Hooks 项）。

**最简实现检查**：已过——零新依赖（复用存量 healingRepo.create / lsof / 纯字符串归一化），零新源文件（除测试）；文案内联于既有分支模式（与现有三分支同构，不引入注册机制——架构审视确认权宜优于抽象）。

**实现期间实测**：大獭自身 3 次被现行守卫拦截（grep 验收含待检词/沙箱测试命令含拼接样本），验证了误拦场景的真实性与 T3 落账的必要性。
