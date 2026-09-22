---
id: F20260922slan
title: sleep 工具化：bash 守卫拦截裸 sleep + wait 工具封装（理由自证 + 可选苏醒检查）
summary: 海獭裸跑 bash sleep 对搭档是长时间静默黑盒。按梯度哲学收编：bash 守卫拦截 sleep 命令并指向 wait 工具；wait 工具参数带 reason（不强制，靠描述+回显引导），可选 until 苏醒检查（过守卫、禁元字符）终结轮询心智。拦截力度已经搭档拍板：硬拦 abort（merge_pr 同型，doAbort `bash_sleep:` 专属前缀 + retry-policy 新增 sleep 文案分支）。
change_type: feature
capability_test: tests/capability/sleep-announce.capability.test.ts
tags: [bash-guard, sleep, wait-tool, ux, gradient-guard, tool-factory]
modules: [src/frameworks/agent/bash-safety-guard.ts, src/interface-adapters/agent-runtime/tools/tool-factory.ts, src/frameworks/agent/tool-description-overrides.ts, src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts, src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts, src/frameworks/agent/circuit-breaker-helpers.ts, tests/frameworks/agent/bash-safety-guard.test.ts]
from: [F20260922pmgd]
created_in_conversation: 82ab2e1c-65ec-4f39-84b6-4022f7dacbf2
created_at: 2026-09-22T12:16:00Z
intent:
  problem: "海獭裸跑 bash sleep 时对搭档是长时间静默黑盒——不知道在等什么、还要等多久（搭档原话：我只感觉到海獭一直没说话、然后执行很长一段时间）"
  expected_effect: "裸 sleep ≥5s 被守卫拦下并指向 wait 工具；獭等待前先 speak 说明理由；轮询场景用 until 苏醒检查终结两拍心智；搭档不再面对无交代的静默"
  verify_by:
    type: capability_test
---

# sleep 工具化：bash 守卫拦截裸 sleep + wait 工具封装

## 背景

搭档原话（意图锚）：

> 我现在遇到一个场景，海獭们经常会sleep等待一些操作，但是，对用户我来说，我的体验很差，我只感觉到海獭一直没说话、然后执行很长一段时间。所以，我期望说如果海獭要sleep，必须speak先说一声、并且要给出 需要sleep以及设置这个时长的理由

> 我建议还是按 咱们蛮成熟的梯度哲学来做。1.tool层拦截sleep，并指向用xx tool，并且先speak说一声再调用tool 2.封装一个tool，参数有理由（不强制，但借助工具描述、参数描述来促使海獭做出咱们想要的效果

痛点本质：长时间静默等待对搭档是黑盒——不知道海獭在等什么、还要等多久。

## 目标

- T1：bash 中的裸 `sleep`（总时长 ≥ 5s）被守卫检测并拦截，拦截文案引导：先 speak 说明理由 → 用 wait 工具
- T2：新增 `wait` 工具：`seconds` 必填 + `reason` 可选（描述+回显引导填）+ `until` 可选（苏醒检查命令，过守卫、禁 shell 元字符），工具内完成 sleep
- T3：5s 以下微 sleep 不拦截（重试抖动等场景搭档无感，防误伤脚本）
- T4：现有含 sleep ≥5s 的脚本（alpha.sh 等）不因本特性中断运行

## 非目标

- 不拦截 5s 以下的微 sleep（`sleep 0.5`、`sleep 2`）
- 不处理 build/部署等天然长命令的静默问题（sleep 是最典型触发场景，先聚焦）
- 不强制 reason 必填（搭档明确：不强制，靠描述引导）
- 不在系统代码层做「等待中进度播报」（speak 一声即解决黑盒，过度设计不追）

## 未决问题

无（拦截力度已经搭档 2026-09-22 21:00 拍板：B 硬拦 abort——见决策史）。

## 现状分析

- 海獭的 sleep 全部来自 LLM 自己写的 bash 命令（`sleep 30 && gh pr checks` 轮询形态），不是系统代码——行为规范 + 工具收编即可覆盖
- 现成模式：merge_pr（F20260922pmgd）= bash 守卫拦 `gh pr merge` + 文案引导到 merge_pr 工具——本方案同型（alpha.sh「拦 + 给正道」哲学）
- 守卫拦截机制：circuit-breaker-helpers.ts 在 tool_execution_start 事件对 `toolName === "bash"` 调 `checkBashCommandSafety`，命中 → `doAbort(bash_safety:reason)`；#731 二拦终态后自动回发控制信号给 LLM 自纠。非中断提醒通道是 `session.steer`（circuit-breaker-helpers.ts:266 的 steer 分支与 :274 编排守卫两处先例）
- per-event 熔断：tool_execution_start→end 计时窗，maxPerEventTimeMs 默认 600_000ms，超时 doAbort("circuit_break:event_timeout")（circuit-breaker-helpers.ts:227-229）

## 方案设计

### 梯度分层

| 层 | 措施 | 载体 |
|---|---|---|
| L0 软引导 | bash 描述追加「等待用 wait 工具，不用裸 sleep」 | tool-description-overrides.ts |
| L1 拦截+指路 | 守卫检测裸 `sleep`（总时长 ≥ 5s），返回拦截文案 | bash-safety-guard.ts |
| L2 正道工具 | wait 工具（seconds + reason + until） | tool-factory.ts |

### L1：守卫检测 sleep

新增检测函数 `checkSleepCommand(command: string): string | null`，挂在 `checkBashCommandSafetyOnText` 主链（与安全检测并列，返回 reason 字符串）：

**匹配形态**：`sleep` 在命令位置（复用位置感知逻辑：段首/shell 操作符后/`$(` 内；COMMAND_PREFIX_WORD 剥除覆盖 `timeout 30 sleep 5` 等前缀包装），后随可静态解析的时长参数。

**时长解析规则**（平台实测语义，检视 S5 修订）：
- 单位：无后缀=秒、`s`=秒、`m`=分、`h`=时、`d`=天（GNU sleep 全支持，本机 /bin/sleep 实测 `0.1m`=6s、`1h` 真实存在）
- 小数值合法：`sleep 0.1m`=6s——按换算后总时长判定，不是按字面值
- 多参数求和：`sleep 5 6`=11s（实测求和语义）——总时长 = 各参数换算之和，`sleep 2 30`（=32s）必须拦
- `sleep infinity` / `sleep inf`（GNU 同义词）= 无限等待——必拦（最长静默形态）
- 真不可解析形态（`sleep $X`、`sleep $(cat t)`）保守不拦——变量无法判断时长，宁漏勿误，归 R1 逃逸面

**阈值**：总时长 ≥ 5s 才拦。5s 以下静默搭档基本无感（重试循环抖动）。

**拦截文案**：
> 检测到你使用了 sleep 等待（约 N 秒）。裸 sleep 会让搭档看到长时间静默黑盒。请先 speak 说明你要等什么、为什么要等这么久，然后改用 wait 工具（wait 的 seconds/reason/until 参数支持等待+理由自证+可选的苏醒检查命令）。

**对脚本的影响**（代码级核实，bash-safety-guard.ts 只扫命令字符串）：`bash scripts/alpha.sh` 形态——脚本内 sleep 不在命令行字符串内，守卫不可见，**零影响**。残余受影响形态只有 heredoc/inline 脚本（`bash -c '... sleep 30 ...'`、`bash <<EOF`——sleep 出现在命令文本内，`\n` 是命令位前导会检出），此类形态全部是 LLM 现场自写，恰是拦截对象；系统脚本不经此形态执行（T4 兑现）。引号内数据位的 `bash -c 'sleep 30'` 是否检出取决于位置感知判定——若漏检归 R1 同族逃逸面，接受。

### 关键设计决策：硬拦 abort（merge_pr 同型）——搭档已拍板

**搭档裁决（2026-09-22 21:00，本对话决策简报卡回执）：选 B 硬拦。**

sleep 命中走 `doAbort(bash_sleep:reason)`——专属 reason 前缀（delta 复审 D1 决策，与 kill 域 `bash_safety:` 分流）：守卫拦截 → retry-policy 的 `bash_sleep:` 分支自动重试（一拦自纠）→ #731 bounce 自动回发（二拦，orchestrator 三门适配后生效）→ LLM 自纠后 speak 说明理由 → 改用 wait 工具重发。单次事件 100% 兑现「speak 先行」。

**发射点（circuit-breaker-helpers.ts:253）**：`doAbort(\`bash_safety:${safetyBlock}\`)` 无条件加 kill 域前缀——新增前缀分流：守卫返回的 sleep reason 带识别标记（如守卫内部返回 `{ kind: 'sleep', text }` 结构化结果或文案约定），发射点据此前缀为 `bash_sleep:` 或 `bash_safety:`。此发射点是 `bash_sleep:` 的唯一产源，不改则新前缀永远发不出（D5a）。

**retry-policy 新增 `bash_sleep:` 文案分支**（D1 修复——第 1 轮已实证现有 `bash_safety:` 文案硬编码 kill 域措辞，sleep 走该链会让搭档看到「检测到针对主进程的不允许命令」的误导陈述，retry-policy.ts:38/65-66/141/112-113/117）：
- `isRetryableGuardAbort`：`bash_sleep:` 同 `bash_safety:` 可重试（一次自纠机会）
- `buildRetryFailBody`（对话流可见）：「检测到长时间静默等待（sleep），已拦截并引导海獭说明理由后改用 wait 工具」
- `buildAutoRetryMsg`（LLM 可见）：透传守卫 reason（sleep 引导文案），提示「先 speak 说明你在等什么、为什么是这个时长，然后改用 wait 工具」，无 kill 域样板
- `buildGuardAbortBody`（终态可见）：「[系统保护] 检测到长时间静默等待（sleep），已自动中断。等待请用 wait 工具并先向搭档说明理由。」
- `buildGuardBounceFailBody` / `buildGuardBounceEscalationMsg`（bounce 链）：入参化/前缀分流——sleep 域文案「长时间静默等待（自纠后仍裸 sleep）…」「…仍在裸 sleep——请人工介入核实守卫是否误拦或任务是否需要长等待」，不再硬编码 kill 域「进程管理」措辞

**orchestrator 三门适配**（D5b——sleep 纳入 #731 bounce 全链，与 kill 域同纪律：拦截是反馈信号不是断头台，多类命令共享上限互不干扰）：
- `:467` shouldGuardBounce：`startsWith` 覆盖 `bash_sleep:`——否则二拦自动回发门恒 false，回发半链静默失效
- `:839` isGuardBounceTerminal：同上——sleep 二拦终态归类不漂移
- `:1113-1114` recordRetrySafe 指标 kind 映射：补 `bash_sleep:` → `'bash_sleep'` 分支——否则落 else 把整段拦截文案当指标标签记账

代价（已接受）：heredoc/inline 自写脚本会被打断 + 多一轮自纠往返——此类形态全部是 LLM 现场自写，恰是拦截对象；`bash scripts/alpha.sh` 文件形态脚本零影响（守卫只扫命令字符串）。

被否的 A（warn 经 session.steer 提醒不 abort）：对单次静默事件零改善，「必须先 speak」永不机械兑现；且原支撑论据「硬拦误伤脚本」被检视实证证伪（文件形态脚本不进守卫视野）。若未来硬拦摩擦实证过大，可降级为 warn 过渡（steer 通道 + `bash_warn:` 前缀精确分流——retry-policy 全部耦合 abort→重试链、文案硬编码安全向，不兼容提醒语义，不可复用）。

### L2：wait 工具

在 tool-factory.ts 新增 `createWaitTool`，注册进全獭工具集（大獭小獭通用，与 speak/yield 同级）：

```
name: "wait"
description: 等待指定时长（替代裸 sleep）. When: 需要等待异步操作完成（CI 检查、服务启动、退避重试）时——先 speak 告诉搭档你在等什么，再调用本工具. Not for: 5 秒以下的短等待（搭档无感，可直接 bash sleep）. 等待即黑盒——reason 参数是你对搭档的交代，不填理由的等待会让搭档看着进度条干着急. Output: 等待完成确认（+ until 检查命令的输出）.
parameters:
  seconds: number 必填，等待秒数（5-600；<5 拒绝（搭档无感的等待用 bash sleep）；>600 拒绝——超过 10 分钟触发 per-event 熔断，应拆多次轮询（带 until 的 wait 循环）或改用 create_scheduled_task 定时任务）
  reason: string 可选，「为什么在等 + 为什么是这个时长」——如「等 CI 跑完，平均 3 分钟，取 2 分钟首轮轮询」。工具描述引导：不强制，但搭档能看到这个理由，填了 = 交代，不填 = 黑盒
  until: string 可选，苏醒检查命令（单命令，禁管道/重定向/分号等 shell 元字符）——等待结束后执行并把输出返回。轮询场景（等 CI/等服务起）推荐带上：返回值让你立刻知道「等的东西好了没」。带过滤需求请让命令自身支持（如 gh pr checks --json）或接受全量输出自行判读
```

**execute 实现**：
1. 参数校验：seconds ∈ [5,600]；**带 until 时 seconds ≤ 560**（预算闭合留裕量：seconds + until 30s + ε ≤ maxPerEventTimeMs 600s，D3/D6 修复——570+30 压线与计时器竞争，setTimeout 只晚不早 + until kill 前摇会使满载路径 >600s 微弱复活 event_timeout）
2. Node 侧 `setTimeout` promise sleep（不经 bash）
3. 若带 until：**先过 `checkBashCommandSafety`（复用主链，含全部安全防线）**——命中即拒绝并透传拦截文案（与 bash 同文案同纪律）；再过元字符检查——含 `| & ; > < \` $ ( )` 及单双引号即拒绝并提示「until 只支持单命令、无 shell 展开，引号/管道/重定向不可用」（引号显式拒绝口径：D4③——`sh -c '…'` 形态经空白切 argv 语义扭曲，显式拒绝给出可操作提示优于静默失能）；通过后 `execFileAsync`（无 shell 展开，timeout 30s，输出截断 2KB 返回；非零 exit 不抛错，exit code + stderr 截断一并返回——苏醒检查「还没好」是正常答案）
4. 回显 reason：返回文本以「等待原因：<reason>」开头；缺 reason 时附一句轻提示（「未填理由——搭档看到的是无交代的等待」），不增强制而增牵引

**until 安全纪律**（检视 S1 修订）：「工具内部 exec 可信」类比不成立——merge_pr 的 exec 是固定 argv 模板（tool-factory.ts:448），until 是 LLM 自由文本，可信前提失效。因此 until 必须过守卫主链：bash 守卫只拦 toolName==="bash"（circuit-breaker-helpers.ts:238），wait 不过守卫则 `until: "rm -rf data/metrics"`（argv 直执行无 shell 也成立）将绕过 F20260830bsgr/#1038/F20260916gsrd 全家族防线。

**until 通道机制四问**（S1 补答）：①谁需要它：轮询场景的獭（等 CI/服务起，最高频等待场景）与搭档（少一轮无信息往返）；②失败后果：until 命令执行失败→返回错误文本，獭自行判读重试，无系统损害；守卫误拦合法 until→獭收到拦截文案改用全量输出，退化可用；③后续机制：until 元字符白名单可能随真实需求放宽（如允许 `|`）——每次放宽都是守卫绕过面的再评估，须走审视；④退役条件：轮询需求被事件推送机制（如 CI webhook 驱动唤醒）取代后可退役。

### wait × per-event 熔断对齐（检视 S4 修订）

execute 内 sleep 落在 tool_execution_start→end 计时窗，maxPerEventTimeMs 默认 600s——`wait(seconds=3600)` 会在 600s 处被 `circuit_break:event_timeout` 熔断，且该 reason 属可重试类，LLM 重调 wait 形成「10 分钟一刀」循环。决策：**seconds 上限对齐为 600s**（不豁免 per-event 计时——豁免会让 wait 成为熔断逃逸通道，真正的挂死（如 until 卡死）将无人兜底）。>10 分钟的等待需求由「带 until 的轮询循环」（每轮 ≤600s、until 提前苏醒）或 create_scheduled_task 承载，语义反而更健康。

### L0：bash 描述追加

tool-description-overrides.ts 的 bash suffix 追加一句：
> Waiting: use the wait tool (not `sleep` in bash) for any wait ≥5s — speak your reason first, then call wait. Bare sleep ≥5s will be intercepted by the safety guard.

## 影响范围

| 文件 | 变更 | 行为变化 |
|---|---|---|
| src/frameworks/agent/bash-safety-guard.ts | +checkSleepCommand +时长解析（单位/求和/inf|infinity） | bash 裸 sleep ≥5s 被检测 |
| src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts | +`bash_sleep:` 文案分支 ×6 函数（含 bounce 两函数） | sleep 拦截的对话流/LLM/bounce 文案为 sleep 语义，不再误示 kill 域措辞 |
| src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts | 三门适配 `bash_sleep:`（:467/:839/:1113） | sleep 二拦回发/终态归类/指标记账不漂移 |
| src/frameworks/agent/circuit-breaker-helpers.ts | :253 发射点前缀分流（sleep reason → `bash_sleep:`） | `bash_sleep:` 唯一产源 |
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | +createWaitTool（until 过守卫+元字符/引号检查） | 全獭新增 wait 工具 |
| src/frameworks/agent/tool-description-overrides.ts | bash suffix 追加 | 软引导 |
| tests/frameworks/agent/bash-safety-guard.test.ts | +sleep 检测用例（边界全集） | — |
| tests/ 下 wait 工具测试（路径实现阶段定） | 新增 | until 守卫拦截/元字符拒绝/非零 exit 路径 |

对现有脚本：`bash scripts/alpha.sh` 形态零影响（脚本内 sleep 不在命令行字符串）；残余受影响形态是 LLM 自写 heredoc/inline 脚本（恰是拦截对象）。

## 风险与约束

- **R1 逃逸通道**：`perl -e 'sleep 30'`、`read -t 30`、`sleep $X` 等变体不在检测范围——接受，引导型方案不追求完美封堵（同 merge_pr 的「字面量黑名单必输但正道引力足够」哲学）；`bash -c 'sleep 30'` 引号内形态若漏检同族接受
- **R2 until 注入面**：已被设计纪律收敛——过守卫主链 + 禁元字符 + execFileAsync 无 shell 展开（见 until 安全纪律段）
- **R3 提醒疲劳**：若某獭反复裸 sleep，每轮都被拦/提醒——可接受（提醒本身就是设计目的；顽固不化者在每日 review 现形）

## 不兼容更新

无（选 B 硬拦已经搭档拍板：LLM 自写 heredoc/inline 脚本内含裸 sleep ≥5s 会被打断——这是设计意图内的行为变更，非系统兼容性破坏）。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 拦截力度 | **B 硬拦 abort（搭档 9/22 21:00 拍板）** | A warn（steer 提醒不 abort） | 意图锚「必须」+ 检视实证误伤论据不成立（文件形态脚本不进守卫视野）；warn 对单次事件零改善。warn 保留为未来摩擦过大时的降级路径（steer 通道，retry-policy 不可复用——S3） |
| 阈值 | 总时长 ≥5 秒才检测 | 全量拦截 / ≥10 秒 | 5s 以下搭档无感（重试抖动）；10s 会漏掉 5-10s 的明显等待 |
| reason 必填 | 可选，描述+回显引导 | 必填（merge_pr partnerApproval 同型） | 搭档明确指示不强制；且 wait 不是授权闸，无伪造追责需求。execute 回显 reason/缺省附轻提示增牵引（A2） |
| until 参数 | 纳入 v1，过守卫+禁元字符 | 砍掉 / 自由文本不过守卫 | 轮询是 sleep 最高频场景；不过守卫=绕过全家族防线（S1），禁元字符是 execFileAsync 无 shell 展开的真实约束（A1） |
| 工具粒度 | 独立 wait 工具 | bash 包装 / speak 参数 | 收编为正道工具才有描述引导的着力点；speak 参数混淆职责 |
| 微 sleep 处理 | <5s 不拦 | 也拦 | 防误伤脚本与重试抖动，阈值即防线 |
| seconds 上限 | 600s（对齐 per-event 熔断） | 3600s / 豁免熔断计时 | 3600 会在 600s 被 event_timeout 熔断成「10 分钟一刀」重试循环（S4）；豁免会让 wait 成熔断逃逸通道，挂死无人兜底 |
| 时长解析 | 全单位（s/m/h/d）+小数+多参求和+inf/infinity 拦 | 仅首参 ≥5 数值 | 实测 `sleep 2 30`=32s、`sleep 1h` 是真实逃逸主形态（S5）；不可解析形态（$X）保守不拦 |
| 电路接线 | doAbort(`bash_sleep:`) 专属前缀：发射点分流 + retry-policy 6 函数分支 + orchestrator 三门适配 | 复用 `bash_safety:` kill 域链 / steer 提醒（warn 降级路径备用） | delta 实证：`bash_safety:` 文案硬编码 kill 域（retry-policy.ts:38/65-66/141/112-113/117），且 6 个消费点不全适配则新前缀发不出/回发死/指标漂移（D5 全库 grep 读码核实）；专属前缀全链闭合与 kill 域语义清晰分流 |
| sleep 是否纳入 #731 bounce | 纳入（与 kill 域同纪律） | 一次自纠即终态 | bounce 哲学「拦截是反馈信号不是断头台」对 sleep 同样成立——顽固裸 sleep 也应见人；bounce 计数按獭按窗口统计（types.ts:150 getRecentGuardBounces 无类型参数），多类命令共享同一额度（混类共用 GUARD_BOUNCE_MAX=3/10min 滑窗）（D5 选型 (i)、D7 措辞实证） |
| until 引号口径 | 显式拒绝（含单双引号） | 静默失能（空白切 argv 自然失效） | `sh -c '…'` 形态经 argv 切分语义扭曲，显式拒绝给出可操作提示优于静默报错（D4③） |
| wait 预算闭合 | 带 until 时 seconds ≤ 560（留 ε 裕量） | seconds ≤ 570 压线 / ≤ 600 无差别 | seconds+until 30s+ε ≤ maxPerEventTimeMs 600s——570+30 恰 600 与计时器压线竞争，setTimeout 只晚不早 + kill 前摇使满载 >600s（D6） |

机制识别检查点判定：**涉及净新增机制**——☑ 新增决策分支（sleep 检测分支）☑ 新增执行通道（wait/until）。机制预算四问：

- ① 谁需要它：搭档（等待黑盒的感知者）；执行獭（被拦截/提醒后转向正道工具）
- ② 失败后果：sleep 检测失效 → 退回现状（裸 sleep 静默），无新增损害；sleep 检测误拦 → 獭被 abort 后收 #731 回发提醒，自纠重发，损失一轮往返；until 守卫绕过 → 已用过主链纪律收敛
- ③ 后续机制：until 元字符白名单可能随真实需求放宽（如允许 `|`）——每次放宽都是守卫绕过面的再评估，须走审视
- ④ 退役条件：检测长期保留（拦截即正道执行）；若硬拦摩擦实证过大可降级 warn 过渡（观测口径：守卫日志 sleep 命中引发的自纠往返频率）

大版本重构判断：否（增量特性，非协作机制级重构）。

## 决策史（审视循环留痕）

**第 1 轮审视**（检视獭-sleep / mimo，异模型；重对抗门结论：疑似治标——warn 对单次静默事件零改善、自设退役条件=过渡脚手架语义、机制接线悬空）：

| 发现 | 分级 | 处置 | 判断与理由 |
|---|---|---|---|
| S1 until 绕过守卫全家族防线 | 严重 | 接受并修订 | 更好。「与 merge_pr 同型」类比不成立（merge_pr 是固定 argv 模板可信路径，until 是 LLM 自由文本）——until 过 checkBashCommandSafety 主链 + 禁元字符，补 until 通道四问 |
| S2 warn 与意图锚「必须」语义落差 + 论据与 V3 矛盾 | 严重 | 部分接受→呈搭档裁决 | 论据失稳属实（守卫只扫命令字符串，文件形态脚本零影响——原「硬拦误伤脚本」论据被证伪）；warn vs 硬拦是行为力度取舍，呈搭档拍板（推荐 B），文档论据已按真实理由改写 |
| S3 bash_warn 接线指错先例 | 严重 | 接受并修订 | 更好。retry-policy 全部耦合 abort→重试链、文案硬编码安全向（实测佐证）；正解 session.steer（circuit-breaker-helpers.ts:266/:274 先例），接线方案已落纸 |
| S4 wait×per-event 熔断冲突 | 严重 | 接受并修订 | 更好。seconds 上限 3600→600 对齐 maxPerEventTimeMs；不豁免计时（防熔断逃逸通道），>10 分钟需求由轮询循环/定时任务承载 |
| S5 sleep 检测覆盖缺口（多参求和/h/d/infinity） | 严重 | 接受并修订 | 更好。平台实测 `sleep 5 6`=11s 求和、`1h` 真实支持——时长解析规则全量修订，「保守不拦」限定为真不可解析形态 |
| S6 intent 块缺失 | 严重 | 接受并修订 | 更好。frontmatter 补 intent（problem/expected_effect/verify_by=capability_test） |
| A1 until 解析策略与失败路径未定义 | 建议 | 接受并修订 | 更好。禁元字符 + 错误返回语义（exit code + stderr 截断返回）已写入规格 |
| A2 reason 牵引力只在描述层 | 建议 | 接受并修订 | 更好。execute 回显 reason、缺省附轻提示，零成本增牵引不违反「不强制」底线 |
| A3 seconds 上限依据未进取舍 | 建议 | 接受并修订 | 更好。已随 S4 并入设计取舍表 |
| A4 frontmatter modules 漏项 | 建议 | 接受并修订 | 更好。补 tool-description-overrides.ts 与 tests 域 |
| A5 未决问题未显式声明 + 残余形态未记录 | 建议 | 接受并修订 | 更好。补「未决问题」段（拦截力度）+ heredoc/inline 残余形态记录（影响范围段） |

**Delta 复核（第 2 轮，检视獭-sleep / mimo）**：S1-S6、A1-A5 共 11 条核对——10 条落实，S3 文案半边残留（D1）；新增 3 建议（D2-D4）。处置：

| 发现 | 分级 | 处置 | 判断与理由 |
|---|---|---|---|
| D1 retry-policy 文案链 kill 域误导 + 缺席 scope | 严重 | 接受并修订 | 更好且是已实证事实（非假设）——doAbort 前缀改 `bash_sleep:` 专属分流，retry-policy 四函数补 sleep 文案分支，两张 scope 表补 retry-policy.ts |
| D2 改动范围表残留 warn 条目自相矛盾 | 建议 | 接受并修订 | 更好。改动范围表已对齐 B 裁决 |
| D3 wait 预算 600+30>600 边界未闭合 | 建议 | 接受并修订 | 更好。带 until 时 seconds ≤ 570 |
| D4 三处小口径（summary 已拍板/inf 别名/引号口径） | 建议 | 接受并修订 | 更好。三处均已修订 |

**Delta-2 复核（第 3 轮，检视獭-sleep / mimo）**：D2/D3/D4 闭合确认；D1 前缀方案正确但消费点闭合不完整（D5 严重——全库 grep + 读码核实 6 个 `bash_safety:` 消费点，v4 只覆盖 4 个）+ D6 建议。处置：

| 发现 | 分级 | 处置 | 判断与理由 |
|---|---|---|---|
| D5 `bash_sleep:` 消费点闭合不完整（发射点缺席/orchestrator 三门/bounce 两函数少算） | 严重 | 接受并修订 | 更好且全部读码实证——选 (i) sleep 纳入 #731 bounce：circuit-breaker-helpers:253 发射点前缀分流 + orchestrator :467/:839/:1113 三门适配 + bounce 两函数 sleep 文案；circuit-breaker-helpers.ts 回补 scope 表与 modules（D2 修订时误删） |
| D6 预算等式压线 race | 建议 | 接受并修订 | 更好。带 until 时 seconds ≤ 560（570+30 压线，setTimeout 只晚不早 + kill 前摇使满载 >600s） |

**Delta-3 收口复核（第 4 轮，检视獭-sleep / mimo）：通过（delta 复核）——闸门打开。** D5/D6 闭合确认；附 1 条非阻塞建议：

| 发现 | 分级 | 处置 | 判断与理由 |
|---|---|---|---|
| D7 bounce 措辞「互不干扰」与计数实现不符（共用同一额度） | 建议 | 接受并修订 | 更好。读码实证（types.ts:150 无类型参数、混类共用 GUARD_BOUNCE_MAX）——取舍表措辞已改「共享同一额度」，顺手订正 S1 行「不成立成立」笔误 |

发射点实现备注（delta-3 审查者备注，非发现）：识别标记若选「文案约定」，判定须精确匹配（startsWith/结构化字段）勿用 includes——kill 域文案当前不含「sleep」词元属巧合非设计保证。

重对抗门复核说明：S3 接线落纸（`bash_sleep:` 专属前缀 + retry-policy 文案分支，D1 闭合）+ S2 已经搭档裁决（选 B）——「疑似治标」三理由全部消解：warn 通道不建（度量错位对象消失、无自设退役条件的过渡机制）、接线经 delta 复核闭合（不再悬空）。

**搭档裁决（2026-09-22 21:00）**：S2 拍板选 B 硬拦 abort。裁决留痕于本决策史与「关键设计决策」段。

## 验证

- V1：`checkBashCommandSafety` 对 `"sleep 30 && gh pr checks"` 返回 wait 引导文案；`"sleep 5"`（边界）拦；`"sleep 2"` 放行；`"sleep 2 30"`（求和 32s）拦；`"sleep 1h"`/`"sleep 0.1m"`(6s) 拦；`"sleep 0.001h"`(3.6s) 放行；`"sleep infinity"`/`"sleep inf"` 拦；`"sleep $X"` 放行
- V2：wait 工具单测：seconds=5 正常返回；seconds=3/601 拒绝；带 until 时 seconds=561 拒绝（D6 预算裕量）；until 含 `|`/引号 拒绝；until 命中守卫（`rm -rf data/x`）拒绝并透传拦截文案；until 非零 exit 返回错误文本不抛错；回显含 reason / 缺省附轻提示
- V5：retry-policy 单测：`bash_sleep:` reason 在 isRetryableGuardAbort 可重试；buildRetryFailBody/buildAutoRetryMsg/buildGuardAbortBody/buildGuardBounceFailBody/buildGuardBounceEscalationMsg 返回 sleep 语义文案、不含 kill 域措辞；orchestrator 三门单测：sleep 二拦触发 bounce 回发、终态归类正确、recordRetrySafe 记账 kind='bash_sleep'
- V3：`bash scripts/alpha.sh` 形态脚本内 sleep 不触发拦截（命令字符串级核实）；heredoc 形态检出（设计意图内）
- V4：capability 测试：模拟獭在需要等待的场景，断言其先 speak 再调 wait（行为收敛验证）

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/agent/bash-safety-guard.ts | M | +sleep 检测函数 +时长解析（单位/求和/inf|infinity） |
| src/frameworks/agent/circuit-breaker-helpers.ts | M | :253 发射点前缀分流（D5a） |
| src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts | M | +`bash_sleep:` 文案分支 ×6 函数（D1/D5c） |
| src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts | M | 三门适配 `bash_sleep:`（:467/:839/:1113，D5b） |
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | M | +createWaitTool（until 过守卫+元字符/引号检查+回显） |
| src/frameworks/agent/tool-description-overrides.ts | M | bash suffix 追加 wait 引导 |
| tests/frameworks/agent/bash-safety-guard.test.ts | M | +sleep 用例（边界全集） |
| tests/（wait 工具测试，路径实现阶段定） | A | wait 行为测试 |


## 实现记录（2026-09-22，开发獭-sleep / kimi-k28）

按方案「改动范围」表全量实现。以下为实际落点与实现要点（新增段落，上方方案设计段不变）。

### 文件变更（实际 diff）

| 文件 | 操作 | 实现要点 |
|---|---|---|
| src/frameworks/agent/sleep-command-guard.ts | A | 新增 sleep 检测独立模块（控 bash-safety-guard.ts 行数）：时长解析（单位 s/m/h/d、小数、多参数求和、inf/infinity 必拦）+ 拦截文案。位置感知经依赖注入复用守卫主文件的 isKillAtCommandPosition（口径一致防漂移） |
| src/frameworks/agent/bash-safety-guard.ts | M | 挂 checkSleepCommand 进 checkBashCommandSafetyOnText 主链（pidFree 规则后、进程终止段检测前）；新增 SLEEP_REASON_PREFIX 标记 + stripSleepMarkerIfPresent（re-export 自 sleep-command-guard）。出口保留标记供发射点分流，诊断文案用干净文案 |
| src/frameworks/agent/circuit-breaker-helpers.ts | M | 发射点前缀分流：abortOnUnsafeBash 自 subscribe 回调拆出（控复杂度）；守卫返回带标记 reason 时发射 doAbort(bash_sleep:…)，否则 bash_safety:。bash_sleep: 唯一产源（D5a） |
| src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts | M | 6 函数补 bash_sleep: 分支：isRetryableGuardAbort / buildRetryFailBody / buildAutoRetryMsg / buildGuardAbortBody / buildGuardBounceFailBody / buildGuardBounceEscalationMsg（后两者入参化，进程终止域文案保持原样） |
| src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts | M | 三门适配：shouldGuardBounce / isGuardBounceTerminal 加 bash_sleep:；recordRetrySafe kind 映射补 bash_sleep 分支。同步改两 bounce 函数调用点传 guardReason |
| src/usecases/ports/agent-metrics-port.ts | M | RetryKind 补 "bash_safety" / "bash_sleep"（原 else 分支把整段文案当标签的 TS 收窄前提） |
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | M | 新增 createWaitTool（until 过守卫主链 + 禁元字符/引号 + execFileAsync 无 shell 展开 + reason 回显/缺省轻提示），注册进全獭工具集（与 speak/yield 同级） |
| src/frameworks/agent/tool-description-overrides.ts | M | bash suffix 追加 L0 段原文（Waiting: use the wait tool） |
| tests/frameworks/agent/bash-sleep-guard.test.ts | A | V5 发射点测试：裸 sleep 发射 bash_sleep:、微 sleep 放行、进程终止域仍 bash_safety:、复合命令命中 |
| tests/frameworks/agent/bash-safety-guard.test.ts | M | V1 守卫边界全集（15 用例：边界/求和/单位/inf/变量/前缀包装/数据位/文件形态） |
| tests/interface-adapters/agent-runtime/tools/wait-tool.test.ts | A | V2 wait 行为（11 用例：seconds 边界/带 until 561 拒/until 守卫/元字符/引号/非零 exit/reason 回显） |
| tests/usecases/.../retry-policy.test.ts | M | V5 retry-policy 6 函数 bash_sleep 文案断言 |
| tests/interface-adapters/agent-invoker-guard-bounce.test.ts | M | V5 sleep 域 bounce 集成（GB-sleep：bash_sleep 二拦自动回发自纠闭环，验证三门） |
| tests/frameworks/agent/tool-description-overrides.test.ts | M | L0 bash 描述含 wait 引导 |
| tests/capability/sleep-announce.capability.test.ts | A | V4 capability：等待场景断言獭先 speak 再调 wait（3 采样 ≥1） |

### 验证结果（自检）

- V1 守卫边界全集：15 用例全绿（sleep 5 边界拦 / 2 30 求和拦 / 1h 拦 / 0.001h 3.6s 放行 / inf 拦 / $X 放行 / timeout 前缀包装拦 / 文件形态脚本放行）
- V2 wait 行为：11 用例全绿（seconds 5 边界 / 3 拒 / 601 拒 / 带 until 561 拒 / until 守卫 rm -rf 拒 / 管道引号拒 / 非零 exit 返回错误文本 / reason 回显 / 缺省轻提示）
- V5 retry-policy + orchestrator 三门：bash_sleep 文案不含进程终止域措辞；sleep 域 bounce 集成闭环（GB-sleep）
- V4 capability：3 采样 1 成功（獭先 speak 再调 wait，无裸 sleep）——行为收敛验证通过
- 全量单测：279 文件 / 3837 用例零回归
- lint：0 error（9 warning 均 pre-existing，非本特性引入）
- lint:intent：本期文档 1/1 intent 存在，verify_by 100%（capability_test）

### 机制判定核对

方案期已完成机制识别检查点判定（设计取舍段含四问答案）——本步骤核对：判定结论已在「设计取舍」段，未跳步。

### 最简实现检查

已过。wait 工具复用 checkBashCommandSafety 主链（零重复安全逻辑）+ execFileAsync（已装依赖）+ Node setTimeout（stdlib），无新框架/依赖。sleep 检测复用位置感知（依赖注入），无重复实现。
