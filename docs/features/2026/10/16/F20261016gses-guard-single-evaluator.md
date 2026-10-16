---
id: F20261016gses
title: 守卫单一求值器终态——主仓写判定升级为语义求值器判据（同一套守卫的规则更新），影子记账下线，棘轮清零，issue 族谱闭环
summary: 搭档 10/15 定调（「你是架构师，按你的设计来。第一性原理就是让海獭系统变得更好，不要有残留」+ 口径修正「不应该叫 v1/v2，而是主仓判定这一类规则更新了，整体还是这一套 bash 守卫；观察够了，正式更新」）——同一套 bash 守卫的主仓写判定规则从文本启发式升级为语义求值器判据（evaluateWriteVerdict）：影子记账（观察期对照机制）随转正下线删除，棘轮 145→0 并升格 CI 验收门，12 条 OPEN 误拦 issue 族谱逐条复核闭环（#1438 为总账收编）。非重叠字面危险面（kill PID/pkill otter/otter-buddy.sh/gh merge/U5/rm data）与非安全门（sleep 感知等）各守各域保留。
change_type: refactor
capability_test: tests/frameworks/agent/guard-touchstone-exam.test.ts 棘轮清零（145→0）+ 全守卫族测试全绿 + 拦截回执文案正迁移断言 + shadow 删除零残留断言
risk_and_residual: |
  主风险=裁决链切换期的行为漂移：V1 main_write 面与 v2 判据口径不完全等价（V1 有部分启发式场景覆盖），切换须以考试 988 条全量复跑+影子期对照数据为差分证据，逐条裁决。残余面=exam-gaps 145 条按族归整正向证明通道逐个闭合（载荷族 87 为最大头）。
mechanism_budget: |
  新增机制：无（纯收敛删除+路由切换）。删除机制：shadow-eval-recorder（374 行）+ bash-safety-guard main_write 重叠面（预估 -300~500 行）+ 棘轮 fixture（清零后删除清单随考试转 CI 门）。净方向：守卫族代码量从 3196 行继续单调下降。
created_in_conversation: 9993f9b1-bea7-41b6-9313-bc33ba23f77e
causal_links:
  - F20261013gev2（求值器 v2 语义模型基座，本文档在其上转正）
  - F20261015gsub（守卫收敛决策：直白形态拦截 + 物理隔离兜底，本文档把「直白」面进一步收敛到「语义求值器唯一裁决」）
  - issue #1438（预注册工单，本文档为其实施载体）
  - issue #844（白名单/受控脚本方向，物理隔离兜底线的承接）
  - PR #1515 / F20261015glfp（git -C worktree 豁免——文本规则链对齐求值器 -C 落点语义的最新补丁，实证语义求值器已是落点判定口径基准；本特性是其趋势的一次性收口，P0 删除重叠面时该补丁逻辑随主仓写判定面一并退役）
---

## 问题陈述

守卫系统的主仓写判定当前是双轨记账制：
- **文本启发式规则面**（bash-safety-guard.ts 2199 行）：运行时实际裁决，靠词元/形态启发式
- **语义求值器**（write-target-evaluator.ts 1207 行 + write-verdict.ts 判据）：只跑影子记账（shadow-eval-recorder），判完不算数只攒证据

双轨是残留的典型形态：两套判据口径漂移即审视红线（write-verdict.ts 头注释明示「与影子投影同用本判据，口径不得分叉」）、误拦族谱 30+ issue 军备循环（gsub 已收敛一轮但 V1 骨架仍在）、影子系统 374 行纯记录无裁决价值。

搭档 10/15 定调（本特性意图锚）：
> 「你是架构师，按你的设计来。第一性原理就是让海獭系统变得更好，不要有残留」
> 「不应该叫 v1 和 v2，而是主仓判定这一类规则更新了，整体还是这一套 bash 守卫。现状是之前的观察够了，所以现在要正式更新」

承接 gsub 的方向（「守卫只拦常见直白形态，绕过面由物理隔离兜底」），第一性原理推导的终态：**同一套守卫内，主仓写判定规则升级为语义求值器判据（观察期证据攒够，正式转正），直白字面危险面瘦身保留，非安全门各自独立，影子记账/棘轮/族谱清零闭环。**

版本核实（10/15 13:08 搭档提醒后全量复核）：守卫族最近改动全部纳入认知——#1448 试金石冻结 / #1466 语义模型基座 / #1487 import-require 豁免（已被 #1466 吸收）/ #1509 文本形态修（已被 #1513 吸收）/ #1513 军备收敛 / **#1515 git -C 豁免（13:03 刚合入，V1 链对齐求值器落点语义的最新补丁）**。无在途 PR 冲突。

## 终态架构

```
bash 命令进来
  ├─ 非安全门（独立保留，与写裁决解耦）：
  │    sleep-command-guard（感知问题：裸 sleep 黑盒等待）
  │    output-guard、circuit-breaker、git-readonly-whitelist（各守各域）
  │
  └─ 主仓写判定（规则升级为语义求值器判据 evaluateWriteVerdict）：
       ├─ unevaluated → BLOCK（fail-closed，§3.3 读不出终局）
       ├─ evaluated 且 write ∩ 主仓树 ≠ ∅ → BLOCK（positive 落点证据）
       └─ evaluated 且无主仓写 → ALLOW（positive，含证明无写/只读披露）

  字面危险兜底（非重叠保留面，bash-safety-guard 瘦身后保留）：
       kill 字面 PID / pkill otter 特征 / otter-buddy.sh stop·restart 字面 /
       gh pr merge 字面（partner-gate）/ U5 bash <file> / rm data/ 主仓破坏
```

**路由切换点**：pi-session-factory 的主仓写判定从 checkBashCommandSafety 的写落点规则族切换到 evaluateWriteVerdict；非重叠保留面继续在 bash-safety-guard（瘦身后）。

## 实施分期（每步考试全量复跑，棘轮只减不增）

> **2026-10-15 顺序修订（切换前差分审计结论，L1 裁决）**：988 条×双态 V1×v2 四象限实测：收益面 274 现役误拦翻正 + 23 漏拦补上；回归面 40 条真新增误拦（heredoc/node -e 内联载荷窄提取缺口主族）+ 7 条 V1拦×v2放 + fixture TOCTOU 污染（TS-291c5634 等：absent 声明是建库时快照，换机器 fs 自查会翻转）。**若先切路由，切换当天海獭高频载荷命令（分析脚本）大面积被拦**——牙3 注释的硬验收项「生产链路必须真实注入载荷」先落地。修订后顺序：**载荷能力补全（原 P2 载荷族）→ 运行时载荷 sourcing 接线 → 路由切换（原 P0）→ 影子下线（原 P1）**。差分数据：对话工作区 p0-diff-baseline.json / p0-diff-nopayload.json。

1. **P0 载荷能力补全 + 路由切换**：evalScriptPayloadNarrow 按 v2 文档规则 1-3 重写（heredoc/node -e/python3 -c 正向证明通道，87 条棘轮主族）；运行时 payload sourcing（裁决链接入真实载荷注入：内联载荷解析 + 外置脚本 fs 读取/缺席证明，防 TOCTOU 静默退化）；完成后 tool-factory 挂 evaluateWriteVerdict 为主仓写裁决，bash-safety-guard 删除 main_write 语义重叠面（git 写族/重定向落点/one-liner 写/heredoc 写）；保留面原样。拦截回执文案迁移到 verdict 结构化输出。
2. **P1 影子系统下线**：shadow-eval-recorder.ts 删除 + tool-factory 挂点摘除 + healing 落账 kind=shadow_eval 清理（历史数据保留，写入路径删）。
3. **P2 棘轮清零（余族）**：cwd-unresolvable 13 → dynamic-path 9 → block 放水 10 → cond 25 → 载荷族余量。每族闭合后复跑考试，棘轮单调收敛；清零后 fixture 删除清单执行，考试升格 CI 验收门。**fixture TOCTOU 污染修复**：absent 声明条目的考试断言改为「absent 声明即信」或标注沙箱依赖，换机器不漂移。
4. **P3 issue 族谱闭环**：12 条 OPEN 误拦 issue 逐条复核（命中面是否已随 v2 裁决消失）→ 逐条 close 留痕（理由引用本特性 + 实证）；#1438 作为总账收编关闭。
5. **P4 壳函数清理**（gsub 遗留 housekeeping）：checkCommandLevelPatterns / judgeCmdLevelModel 恒 null 占位删除。

## 关键设计取舍

- **为什么不是「双系统替换」而是「规则升级」**（搭档 13:08 口径修正）：这是同一套 bash 守卫内「主仓写判定」这一类规则的更新——观察期（影子记账）攒够证据后正式转正。影子记账是观察期机制，转正后对照对象消失，随之下线。
- **为什么不保留旧文本规则当兜底**：同域双判据必然口径漂移（write-verdict.ts 注释已明示是审视红线）；保留面与语义求值器**不重叠**（kill 字面 PID 是进程域、gh merge 是 partner-gate、U5 是绕过面防护、rm data 是 R1 红线——都不是写落点判定），保留它们不构成双判据。
- **fail-closed 即 BLOCK 的严度**：gsub 收敛后绕过面由物理隔离兜底，求值器宁可误拦不可漏拦的定位与物理隔离线一致；误拦面由棘轮清零工程逐步闭合，不靠放宽判据。
- **影子系统为什么删**：转正后求值器就是裁决链本身，对照观察失去对象；历史 shadow 落账数据保留可查，写入路径删除。
- **startCwd 参数**：裁决链调用 evaluateWriteVerdict 时传 sessionCwd（cwsp 语义，F20261014cwsp），与影子期口径一致。

## 验收口径

- 考试 988 条全量复跑：放行 763 正面 ALLOW / 拦截 52 必须 BLOCK / 条件 106 双态——棘轮清零后 fixture 删除，考试转 CI 门
- 守卫族测试全绿（含回执文案迁移断言、shadow 删除零残留断言）
- 12 条 OPEN 误拦 issue + #1438 全部闭环（close 留痕引用本特性）
- bash-safety-guard.ts 行数较 2199 单调下降；shadow-eval-recorder.ts 从仓库消失
- tsc/eslint 零错误

## 风险与遗留

- 切换期行为漂移风险：**已于 2026-10-15 完成差分审计**（988 条×双态 V1×v2 四象限，数据见分期节修订注）——收益 274 翻正 + 23 漏拦补上；回归 40 新增误拦（载荷族先行补全后收敛）+ 7 放水（逐条复核：含 fixture TOCTOU 污染与 argv 传播口径差，P2 处置）
- 载荷族 87 条是最大工程面：heredoc 33 / node -e 17 / python3 -c 17 / other 19 子类逐个正向证明，预计占 P0 主要工时
- **TOCTOU（F3 记档，2026-10-16 检视确认）**：fsContentPlan 裁决时读、执行在后——脚本判读与执行间被替换则判读≠执行。代码与文档已记档，fail-closed + 物理隔离兜底下可接受；残余面显式记档：运行时脚本替换（mv/rm 后重建同路径）不在静态防线域，靠运行时 kill 域/审计日志兑底
- **F2 记档（#1438 族谱）**：.rb/.pl/.scpt 相对路径/变量写目标可能漏（绝对主仓路径靠字面量闸兜住；相对写由 File.write/perl open(F,">f") 词面负门兼底——完整解析待 P2 载荷 AST）
- 物理隔离 OS 层加固（gsub 非目标，另立调研）不在本特性范围

### 判定链三段真相源（2026-10-16 delta 复核 F-c 采纳，如实标注）

主仓写判定这一类规则升级为语义判据后的**运行时真实结构**：**plain one-liner/文件形态走求值器落点判，包装形态（sudo/env/timeout/nohup/未知包装词）走段首结构通道形态判，unparseable 形态落 V1 文本兜底保守拦**。求值器对包装形态确实无 argv 基座（F-a 实证：sudo env 包装写主仓求值器 ALLOW，结构通道是唯一拦截）——「单一求值器」指判定规则从双判据收敛为「求值器为主、包装/unparseable 两段保守兕底」，非求值器包打天下。求值器剥包装词根治待 P2。

### 求值器包装盲区（F-a 记档，2026-10-16 delta 复核）

- 求值器对包装形态瞎（无 argv 基座），结构通道是唯一拦截——必要互补非 bug；潜在残余：`strace python3 /tmp/x.py`（包装+脚本文件，非 one-liner）③d 不命中+求值器瞎 → 极 exotic，P2「求值器剥包装词」根治
- ③d over-block（F-b）：未知包装+写 tmp（如 `strace python3 -c 写/tmp`）被形态判拦——与包装保守同源，低频可接受，P2 随剥包装词根治

### F1 修复实录（2026-10-16，检视对抗审视 + 大獭 L1 裁决采纳方向 a）

- ③a 收窄到**包装形态**（parseSegmentHead 新增 wrapped 标记——sudo/env/timeout/nohup 等前缀，求值器无 argv 基座的真盲区）；plain/纯赋值前缀交求值器落点判——F1 实证的「python3 -c 写 /tmp 求值器 ALLOW 整链 BLOCK」双判据冲突根除
- **负门族归位**（③a 形态判退位后的安全面承接，evalScriptPayloadNarrow 内）：kill 调用形态（os.kill(/process.kill(，裸 pkill 文本数据不收——TS-d41c4ce2/TS-acd4d18a 误伤实证）/ child_process 危险模块 / import 拼接（主仓字面量拼接 MAIN_LIT_CONCAT_IMPORT_FACE；相对字面量拼接保持披露保守面）/ open 实参区嵌套括号与解包（S1/r4 先例）/ dbm/shelve / os.* 写族词面（SCRIPT_WRITE_TOKENS 补齐）/ ruby-perl 写面词面 / 无引号裸词载荷（提取基座截断）
- **hasNarrowExtractableScriptSeg 精化**：负门命中（hadNegGate 标记）才算实质判定（proveNoWrite 先行短路曾绕过段级负门放行 os.kill(主PID)）；字面量闸回落不算（能力 8 披露正道不阻断，guard-v2-real-replay 实证）
- **归一化链原文 verdict 对照**：兜底链归一化文本判读翻转（剥引号使 mode 变裸词）不采纳——原文语义判 ALLOW 时归一化差异不构成拦截依据
- **F4 一致性锁**（guard-dual-chain-consistency 新 describe）：正向锁（非主仓 one-liner 写整链放）/ 包装写主仓拦 / kill 负门锁 / kill 文本数据不误拦四锁钉死
- 行为断言更新 9 条（旧形态判口径→落点语义口径，逐条注明 F1 修订语义）；1285 repro 落点对齐 projectRoot（虚构 /repo 错位修正）
- 棘轮 78→77（allow 48 / block 10 / cond 19）

### evalPath `..` 可静态爬升收窄（2026-10-16 rebase 回归修）

- **回归现场**：`git -C ../ commit` 从 worktree 子目录发车（bash-safety-guard-git-dashc.test.ts 第 6 例）rebase #1519 后翻红——#1515 时代 V1 豁免通道用 path.resolve 处理相对路径放行，P0 切求值器后 evalPath 对含 `..` 一律 null（首跑「不猜爬升」保守口径）→ dynamic-path fail-closed 误拦。大獭 13:50 裁决：`..` 爬升不是不可判（path.resolve 确定性），精确收窄。
- **修法**：evalPath 新增 climbPath 词法分段栈（空段/`.` 跳过、`..` 出栈、栈空再出=根 `/`；不触盘、不解析 symlink——全链词法口径同源）；动态形态（$/`/~）不进爬升（前置短路）不变。首跑「不猜」口径就此退役。
- **拦截面验证**：`<wt>/../../../main/y` 绝对爬升命中主仓 → evaluated 拦（reason 从回落变落点命中，更精确）；拼接形 `<wt>/x+'/../../../main/y'` 折叠落 `/repo/.otter/main/y` —— OTTER_RUNTIME_REGIONS 只豁免 worktrees/workforms/data-workspaces，.otter 杂散面属主仓判定域 → 仍拦。树外爬升（cd /repo/../elsewhere、/tmp/d/../x、../x.sh fs 缺席）→ 解析后零写面放行。
- **棘轮影响**：allow 池 TS-0bdb0b14/TS-c041（cwd-unresolvable）随收窄实测通过移出 gaps（77→75）；block 池 TS-c028（cd /repo/../elsewhere）实测 ALLOW 与守池 BLOCK 判决冲突——改判需动守池确定性判决=棘轮收缩工程，本修如实钉 block gaps（75→76），余 76（allow 46 / block 11 / cond 19）。净效果 77→76。
- **边界记档**：symlink 词法/fs 语义差异非新面（normalizePath/pathWithinMain 全链同口径）；TS-c028 型守池改判待 P2 棘轮收缩工单带守恒验收。

## 下一步（派工单节奏：每完成一期报进展）

1. P0 载荷能力补全 + 运行时 sourcing 接线 + 路由切换（本期 PR 主体，顺序修订后）
2. P1 影子下线（同 PR 或紧随 housekeeping PR）
3. P2 棘轮清零余族按族推进（每族一小步）+ fixture TOCTOU 修复
4. P3 issue 族谱闭环 + P4 壳清理（收尾 PR）
