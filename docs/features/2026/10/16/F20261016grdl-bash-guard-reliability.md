---
id: F20261016grdl
title: bash 守卫基建——止血（V1 链排除区对齐+ruleId 指纹）+ 职责切分换血（沙箱接防、守卫写面条件退役）
summary: bash 守卫「反复修改一直出问题」的基建方案。诊断三根因：D1 双链不对称（排除区语义只在 V2 求值器，heredoc/动态路径回落的 V1 兜底链没有——今晨 13 条误拦全来自 V1 链，代码注释自认「近 7 天 main_write 误拦大头」）；D2 ruleId=unknown 指纹断裂（#844 误报聚合跑不起来）；D3 沙箱已默认开启但守卫写面预判成冗余误拦源。修法：排除区语义下沉双链共用+ruleId 指纹+误报分账止血；沙箱可用性探测+守卫写面条件退役换（真写主仓由沙箱物理拒+落账，拦截语义从预判降为事证，删代码）；单表 P2 骨架。验收：棘轮 shrink_only+沙箱兜底/降级实证+误报率 7 天对比。采纳 glm-会诊修正：直接病根是修复落点不对称，「不做语义裁判」路线结论不变。
created_in_conversation: 98bd9fdd-8e28-4de8-b782-b59f46e733dd
date: 2026-10-16
status: development
modification_class: docs-config
intent:
  problem: "bash 守卫反复修改一直出问题（搭档 2026-10-16 原话：「咱们的 bash守卫一直在反复修改、一直在出问题。dots中有相应的设计方案吗」）。今晨 6h 内 13 条误拦 open 事件：heredoc 写工作区被拦、worktree 路径写被拦、纯只读命令被「写主仓」拦、curl POST 进写族——V1 兜底链缺排除区语义是主根因"
  expected_effect: "T1 止血：排除区写命令 V1 放行，D1 六例误拦形态归零；T2 ruleId 指纹落台账，误报可聚合；T3 换血：沙箱可用时守卫写面退役（删代码），主仓写防护从预判变事证（物理级零误拦），沙箱不可用回位降级不降安全；T4 误报率可测（修复前后 7 天对比呈搭档）"
  verify_by:
    type: capability_test
---

# bash 守卫基建：止血 + 职责切分换血

## 背景 / 意图锚

> 搭档原话（2026-10-16 11:12）：「你先不要去思考新功能。你先聚焦到 安全/可靠性这些方面。比如说，咱们的 bash守卫一直在反复修改、一直在出问题。dots中有相应的设计方案吗」
> 范围拍板（2026-10-16 11:58 搭档「ok」确认默认通过）：止血 + 路线换血为主，单表只做 P2 骨架；「守卫误报率可测」做验收指标；基建先行（排在转世承诺保全之前）。

dots 生态调研结论（research 报告 :55-59）：invisible_dots 策略闸（可判定规则）/ codexia OS 沙箱（物理强制）/ open-dots 执行环境回调——**没有任何一家做「命令字符串语义裁判」**。本方案把该结论落到 bash 守卫的改造上。方案主笔 glm-会诊（glm），大獭整合；采纳 glm-会诊对大獭「路线病」论断的修正（见诊断前言）。

## 诊断：误拦的结构根因（不是规则不够聪明，是修复落点不对称 + 守卫与沙箱职责未切分）

**诊断前言（修正记录）**：大獭初判「路线病」（语义猜测路线注定拟合不完）；glm-会诊 读码修正为「双链不对称」——今晨误拦的直接病根是 V2 修复没同步到 V1 兜底链（工程病）。两者不矛盾：不对称是今日流血点，语义裁判天花板是长期病；但**处置优先级按不对称修**（小时级止血），路线换血靠沙箱让位实现（沙箱已就位，无需新建物理边界）。

### D1 双链不对称——修复落 V2，V1 兜底链吃不到（今晨仍在流血的主根因）

守卫是双链架构：V2 词法模型解析成功（parseOk=true）才走语义求值；**heredoc / 未闭合引号 / $() 嵌套等形态 parseOk=false，全量回落 V1 文本正则链**（bash-safety-guard.ts:2165「parseOk=false（未闭合引号/$(/heredoc/…）走 V1 判定链全量兜底」、:2206）。

而 10/13~10/15 的关键修复——worktrees/workspaces 排除区语义——落在 V2 求值器（write-target-evaluator.ts:92-124 `OTTER_RUNTIME_REGIONS = ["/.otter/worktrees/", "/.otter/workforms", "/data/workspaces/"]`）——**V1 文本链没有同等的排除区判定**。这不是推测：bash-safety-guard.ts:1674 代码注释原文自认「（语义、V1 兜底链未同步的复发面，近 7 天 main_write 误拦大头）」。

**今晨 10/16 healing 台账实证（全部 V1 链吃掉的工作区/worktree 合法写）**：

| 时间 | 事件 | 命令 | 误拦机制 |
|---|---|---|---|
| 03:08 | 043bb7e9 | `cat > <工作区>/commit-msg-delta2.txt <<'EOF'…` | heredoc 多行 → parseOk=false → V1 文本链见主仓根前缀字样判「落点主仓」——排除区语义 V1 没有 |
| 02:12 | 2828e798 | `cat >> <主仓>/.otter/worktrees/review-1519/tests/…/probe.test.ts <<'EOF'` | 同上，worktree 路径整段在命令文本里仍被拦 |
| 03:08 | 9e7fbc08 | `cd <worktree> && python3 -c "…os.remove(f) for f in glob…"` | 动态路径（glob 变量）不可静态求值 → 不可证回落 V1 → V1 按 session cwd 判 |
| 02:37 | 0765e2e7 | `python3 -c …json.load(open('/tmp/…'))…`（纯只读分析） | 6h 第 5 次被拦（high），只读载荷被当写嫌疑 |
| 02:21 | 8aa58060 | `PAT=$(cat …); curl -s -X POST https://…` | curl 不写本地文件——写族词表污染 |
| 03:08 | bc49f605 | `cd <主仓外无关目录> && ls src/logos/ && file public/` | **纯只读命令被「写主仓」拦**——主仓外的无关目录 |

bc49f605 最能说明问题：目标根本不是海獭主仓，`ls`/`file` 零写面，仍报「写命令落点解析到主仓」——V1 链的写面判定已污染到只读族。

### D2 ruleId=unknown——守卫自观测闭环断裂

上述事件 `context.ruleId` 全部为 `unknown`（guard-intercept-classify.ts 仅 80 行，未覆盖 main_write 规则族）。后果：#844「误报聚合→白名单」路线跑不起来——今天 6h 内 13 条 open guard_intercept 无法按指纹归并。**「守卫误报率可测」的验收指标没有地基**。

### D3 职责未切分——沙箱已上线，守卫还在跟它抢活（且拦对了也不如沙箱）

F20261015phys（PR #1517 已合入）：**sandbox-exec 物理沙箱已包裹獭 bash 执行面且默认开启**（bash-sandbox.ts:121-125，仅 OTTER_BASH_SANDBOX=off 逃生口）——主仓 deny file-write*（排除区 allow）、deny signal（kill 主进程物理被拒，检视 D4 实测 Operation not permitted）。

但守卫的写面判定没有因此退役：**守卫 fail-closed 拦掉的操作，沙箱本来能安全放行**——真写主仓时沙箱给 Operation not permitted（错误信息天然教育 LLM，无需守卫预判）。动态路径写 worktree（D1 第三行 os.remove 案例）：静态求值永远证不出落点，守卫只能保守拦，沙箱却可以精确判（worktree 在 allow 白名单）。**静态语义裁判对「不可证」形态永远输给物理边界**——invisible_dots 的设计正是如此：不做语义裁判，allow/deny/ask 三态可判定规则 + 物理边界 + 问人。

## 目标

- **T1（止血）**：V1 兜底链对「落点在排除区（worktrees/workforms/workspaces）」的写命令放行——排除区语义与 V2 对齐，今晨 6 例误拦形态归零
- **T2（止血）**：main_write 规则族 ruleId 指纹落台账（unknown → 具名），#844 误报聚合路线打通
- **T3（换血）**：守卫写面判定与沙箱职责切分——沙箱可用时，bash 文件写面由沙箱接防，守卫退役该判定面（**删代码，不是收窄**）；沙箱不可用时（非 macOS / =off）守卫写面回位
- **T4（验收）**：守卫误报率可测——healing 台账 guard_intercept 按误拦/合法引导分账，修复前后对比呈报（「误报率从 X 到 Y」）；试金石棘轮 shrink_only 保持

## 非目标

- 不做 invisible_dots 的 ask/审批流（工具级人工审批）——多用户/第三方 bot 场景错配，单机单人收益低，**P2 骨架也不做**，只预留架构位
- 不做转世承诺保全（另案，排本方案后）
- 不改 write/edit 工具面的 write-target-evaluator 判定（无 V1/V2 双链问题，沙箱不覆盖非 bash 工具——现状保持）
- 守卫的引导类规则（sleep → wait 工具引导等 habit 层）不动——今晨 03:15 sleep 事件是合法引导非误拦

## 未决问题

本方案无硬未决项；实施中设两个 **stop-and-ask 验证门**（不归因/不对表不放行）：

| # | 验证门 | 说明 |
|---|---|---|
| G1 | D1 第 5/6 例归因 | curl 进写族词表的来源（疑 $( 命令替换特征误伤）、主仓外目录为何进主仓判定（疑 V1 路径归属 bug）——**禁止不归因就加豁免规则** |
| G2 | 沙箱 profile 排除区口径对表 | 沙箱 allow 清单与 V1/V2 排除区（worktrees/workforms/workspaces/tmp/alpha）逐项对表——口径不一致会「退役后裸奔」 |

## 方案设计

### 第一步：止血（T1+T2，纯收窄拦截方向，零新机制）

**1a. V1 兜底链排除区对齐**：V1 文本链在产出「落点解析到主仓」判定前，对候选落点路径（命令文本中的绝对路径字样 / cd 目标 / 重定向目标）统一过 `pathWithinMain()`（复用 write-target-evaluator 现有函数，含排除区）。落点在排除区 → 放行。把 V2 已有的排除语义**下沉为双链共用的判定基元**——不是加新规则，是修 V1 的判定完备性。先例：#1515（F20261015glfp）已做过同方向单点（git -C 豁免 V1 对齐 V2），本次是该模式的全形态推广。
- 预期覆盖：heredoc cat/echo 重定向、cd && 写、动态路径不可证回落——D1 表 1/2/3 例
- D1 表 5/6 例（curl 词表污染、主仓外只读误拦）走验证门 G1 归因后逐条修

**1b. ruleId 指纹补齐**：guard-intercept-classify.ts 补 main_write 规则族名映射，healing context.ruleId 落具体名（main_write_heredoc / main_write_literal / main_write_dynamic…按形态分指纹）。#844 聚合立即受益。

**1c. 误报台账分账**：healing guard_intercept 事件补可统计维度（误拦 vs 合法引导），验收时输出修复前后对比。

### 第二步：换血（T3，职责切分——删为主）

**2a. 沙箱可用性探测**：运行时探测（平台 macOS 且 OTTER_BASH_SANDBOX≠off 且 profile 注入成功）。探测结果决定守卫写面启停。
**2b. 守卫写面条件退役**：沙箱可用时，bash 工具的「文件写落点」判定整体不启用（V2 求值器 + V1 兜底链的 main_write 族对 bash 面 let-through）；真写主仓由沙箱兜底（Operation not permitted + 命中即 healing 落账——**拦截语义没丢，从预判降为事证**）。沙箱不可用 → 守卫写面原样回位（降级不降安全）。
**2c. 守卫保留面（沙箱覆盖不了）**：gh merge 等网络/git 服务面、引导类（sleep→wait）；沙箱 deny 范围内的写面可一并退役，网络面保留。
**2d. 退役量预期**：bash-safety-guard.ts 2314 行 + write-target-evaluator 1245 行中 bash 写面判定部分预期显著缩减——**本步修改类 = deletion 为主**，与 gsub 收敛方向同棘轮。

**沙箱盲区清单（实现前必须核实，防退役后裸奔）**：
- write/edit 工具面（非 bash spawn，无沙箱）→ 由 write-target-evaluator 继续判（现状保持）
- 主服务自身 bash → 不经 createAgentSession，本就不在守卫面（现状）
- 沙箱 profile 的排除区与 V1/V2 排除区口径一致性 → 验证门 G2 逐项对表
- 沙箱执行失败（profile 解析崩溃 exit 65 曾实测）时的 fallback 语义 → 必须保守（fail-closed 到守卫写面）
- 边界诚实声明：沙箱判「写成功与否」物理不可能误判，但「该不该写」仍由 allow 清单决定——清单口径错=误放，故 G2 对表是退役前提

### 第三步（P2 骨架，不做实装）

工具-权限单表（invisible_dots permissions.py 形态）的架构位：策略闸作为工具调用的唯一执行点（allow/deny/ask 三态）。**只留接口设计文档，不写代码**——当前守卫+沙箱组合已覆盖单机场景。

## 机制四问（第二步「沙箱可用性探测→守卫写面启停」命中新增决策分支，必答）

- **① 谁需要它**：獭（减少误拦即减少任务中断）、搭档（基建可靠性——原话「一直在反复修改、一直在出问题」）
- **② 失败后果**：探测误判沙箱可用而实际没包住 → 真写主仓漏拦。缓解：沙箱 deny 是物理级（内核拒绝），探测仅决定守卫是否叠加；沙箱注入失败有 exit 65 类显式报错，可据此 fail-closed
- **③ 后续机制**：新增状态「守卫写面启用/停用」可能探测抖动（时好时坏）→ 修法：探测结果缓存 + healing 落账观测
- **④ 退役条件**：守卫写面永久退役条件 = 沙箱全平台覆盖且稳定运行 N 周（healing 零沙箱失效事件）→ 届时删探测分支与 V1/V2 写面死代码

## 新增 schema 字段声明消费方

无新增 schema。healing context.ruleId 字段值域扩充（unknown → 具名指纹），消费方：#844 误报聚合、每日体检、验收对比报表。

## 影响范围

- 獭的 bash 写命令链路（worktree/workspaces 写放行面扩大——均为 R1 允许区）
- 主仓写防护从「守卫预判」变「沙箱事证」（拦截时机后移，拦截能力不降——沙箱物理级更强）
- healing 台账分类（ruleId 补齐影响 #844 聚合与每日体检）
- write/edit 工具面不动

## 风险与约束

- **R-1**：V1 排除区对齐若做成「主仓字样前缀排除」，嵌套 decoy（/repo/x/data/workspaces/ 是主仓内容区）会误放——**必须复用 pathWithinMain 的 root 级锚定语义**（write-target-evaluator.ts:92-100 注释已论证），不新写前缀判断
- **R-2**：守卫写面退役后，LLM 写主仓将收到沙箱 Operation not permitted——错误文案的引导性（告诉 LLM 用 worktree）需在沙箱层补充，否则 LLM 可能反复重试
- **R-3**：非 macOS 部署（若存在）完全依赖守卫写面回位——探测分支的测试覆盖必须含「模拟沙箱不可用」用例
- **R-4**：12+ 条 open 守卫误拦 issue（gsub 时批量处置过一批）需随 1a 落地重新对账归并

## 设计取舍表

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| V1 排除区对齐 vs V1 链整体废弃 | 对齐 | 废 V1（沙箱可用时） | 废链是第二步的事；第一步先止血，非 macOS/=off 依赖 V1 |
| 写面退役 vs 收窄求值器 | 退役（沙箱可用时） | 继续收窄语义模型（smrj 路线） | smrj 已证明语义模型能减误拦但治不了「不可证形态」（动态路径永远 fail-closed）；物理边界是 dots 生态的真答案 |
| main_write 事证化 vs 保留预判 | 事证化（沙箱 deny 命中→healing） | 双层都预判 | 双层预判=双层误拦面；事证零误拦（物理判「写成功与否」不可能误） |
| ask 审批流 | 不做（P2 骨架也不实装） | 照搬 invisible_dots | 多用户场景错配（glm-会诊判断，大獭采纳） |

## 不兼容更新

**无**（[Incompatible] 级）：排除区对齐只放行 R1 允许区写（收窄拦截方向）；守卫写面退役有沙箱物理兜底+降级回位；ruleId 值域扩充对既有台账数据兼容（旧事件保持 unknown，新事件落具名）。无 schema 迁移、无行为语义破坏。

## 验证

1. 试金石棘轮（tests/frameworks/agent/guard-touchstone-exam.test.ts）：D1 六例形态入 corpus，修复后 ALLOW 且棘轮 shrink_only=PASS
2. 沙箱兜底实证：退役面命令实测写主仓 → Operation not permitted（bash-sandbox.test.ts 扩用例）
3. 降级实证：OTTER_BASH_SANDBOX=off 下同命令 → 守卫拦截（写面回位）
4. 误报率对比：healing 台账 guard_intercept 修复前后 7 天窗口误拦/合法引导分账（验收呈搭档「从 X 到 Y」）
5. 全量：vitest 全绿

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/agent/bash-safety-guard.ts | 修改（V1 链复用 pathWithinMain）→ 第二步大幅删减 | 1a 排除区对齐；2b 写面条件退役 |
| src/frameworks/agent/write-target-evaluator.ts | 第二步删减 | bash 写面判定退役部分（write/edit 面保留） |
| src/frameworks/agent/guard-intercept-classify.ts | 修改 | 1b ruleId 指纹 |
| src/frameworks/agent/bash-sandbox.ts | 修改 | 2a 可用性探测 + R-2 错误引导文案 |
| tests/frameworks/agent/guard-touchstone-corpus.test.ts | 修改 | D1 六例入 corpus |
| tests/frameworks/agent/bash-sandbox.test.ts | 修改 | 验证用例 2/3 |

## 测试声明

需要测试（capability_test）：试金石棘轮 corpus 扩充 + 沙箱兜底/降级双路径用例 + ruleId 指纹断言；全量 vitest 门。
