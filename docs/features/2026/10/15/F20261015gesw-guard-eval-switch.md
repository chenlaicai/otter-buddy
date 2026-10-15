---
id: F20261015gesw
title: main_write 换岗——写落点求值器转正（观察期达标切换）
summary: gwte 方案模块 3 终章：观察期 3 天 1405 条旁听（红线 0 / 23-23 裁决全对 / EVAL_GAIN 7）达标后，checkMainCheckoutWrite 接求值器主判——真写落主仓→终局 BLOCK、真写全在树外且非载荷面→终局 ALLOW、空真写/known-gap/载荷面→旧链全量兜底（fail-closed 不旁路）。切换修复三处求值器语义 bug（段级 cwd、只读披露 write=false、工作区 sandbox）。预注册 BC 落地（BC-1/BC-3；BC-2 新增）。嵌套载荷不接主判；脚本解释器载荷一律不终局放（delta eba7c738：处置中 15 形态漏拦 + 复审 6 形态击穿证明门，两轮实测全类归口）。语料 21 条真实命令钉回归夹具：实测修复面 3 终局修复 + 15 残余 expected-BLOCK（宣称订正，残余收编 v2）。回退开关 OTTER_GUARD_EVAL_SWITCH=0。#1363 灰区闭合、#1416 负门保持；#1395 非载荷面修复保持（载荷面回落残余归 v2）。
created_in_conversation: 9993f9b1-bea7-41b6-9313-bc33ba23f77e
status: review
modification_class: mechanism-addition
intent:
  problem: "旧链 main_write 词面判定误拦率高（观察期 23/23 裁决全是旧链误拦）且 #1395/#1363/#1416 家族反复修补；求值器观察期达标但未接管"
  expected_effect: "main_write 维度判定从「猜命令词」换为「看写落点」：正道命令（外部项目/tmp/worktree 操作）放行，cd 后写主仓等灰区闭合；其他维度（kill/data/sleep）零改动"
  verify_by:
    type: behavior_check
capability_test: "tests/frameworks/agent/guard-eval-switch.test.ts"
change_type: feature
tags: [guard, evaluator, switch, main-write]
causal_links:
  - F20261009gwte（方案 v2 模块 3）
  - F20261009phs2（Phase 2 窄提取）
  - F20261010gshw（影子接线与观察期）
  - F20261010pyro（#1416 止血——枚举滞后例证）
  - issue #1363（灰区闭合）/ #1395（误拦家族修复）
---

# main_write 换岗：写落点求值器转正

## 背景

观察期（10-10 至 10-12，F20261010gshw 影子接线）3 天数据达标：
- 旁听 **1405** 条真实命令，聚合口径回落率 15.2%（判据 ≤50%）
- 人工裁决 23 条「新旧分歧」：**23/23 求值器全对**（全是旧链误拦的正道命令——colink/kelp 外部项目操作、curl -o /tmp、worktree 测试/提交）
- **红线（求值器错放）0 条**
- EVAL_GAIN 7 条（旧链漏拦的 cd worktree 后写主仓灰区——#1363 家族）
- 语料 141 例 shadow 三跑四判据全过（族内 91.7% / 回落 19.3% / 红线 0 / 误放 0）

搭档拍板换岗（10-12）：主仓写判定由求值器主判，旧链降级为回落兜底。

## 设计

### 主判三态（checkMainCheckoutWrite 入口，depth≥3 且顶层平面命令）

```
evaluateWriteTargets(command, projectRoot)
├─ evaluated + 真写 targets 非空
│   ├─ 任一真写落主仓树内（pathWithinMain）→ 终局 BLOCK
│   └─ 真写全在主仓树外（worktree/tmp/外部）→ 非载荷段终局 ALLOW；载荷段一律回落（见下——载荷面禁终局放）
├─ known-gap 词面/knownGap target（curl -o / wget -O / install / dd of=）→ 旧链全量兜底（不终局——建议3：终局短路封死）
├─ evaluated + 真写空（零披露或只读披露）→ 旧链全量兜底（fail-closed：零目标 ≠ 只读——git commit/push --dry-run 写 .git 无文件参数可提取；回落面 = 与切换前同等既有面，不扩大不缩小）
└─ unevaluated（$VAR 拼接/动态路径/heredoc 载荷族）→ 旧链全量兜底
```

**只认真写 targets**：`WriteTarget.write` 新增布尔标记——redirect/git/词表写命令/脚本写调用 = true（缺省）；只读披露（open('data/x') 读、路径字面量）= false。**只读披露绝不构成拦截依据**（否则 #1416 家族回归——只读解析载荷全被误拦，初版实测 96 例失败的主因）。

### 嵌套载荷不接主判（hasNestedPayload 收窄）

`bash -c ...` / heredoc（`<<`）/ 包装词（timeout/env/sudo/nohup/watch/xargs）命中的命令仍走旧链全量判定。**实测回归坐实**：初版对 `bash -c 'mv data/metrics /tmp/'` 求值器判 /tmp 终局放行——旁路了 judgeShellCSegment 内挂的 data 破坏载荷感知（基线 BLOCK → 初版 PASS）。嵌套载荷的求值器语义覆盖未过观察期验证，切换首版不扩大攻击面。

### 载荷面禁终局放（delta eba7c738 收口——载荷证明门退化为禁放闸）

脚本解释器载荷（`python3 -c` / `node -e` / `perl -e` / `ruby -e` / `eval`）**不入 hasNestedPayload 外部门**——入外部门会使求值器的 BLOCK 方向一并失效（#1363 `cd wt && node -e 写主仓绝对路径` 灰区重开，实测红灯坐实）。

处置初版在 ALLOW 出口设两道闸（真实非汇点树外写证明 + 嵌套执行面词表）。**delta 复审实测击穿（eba7c738 附录，6 形态 old=BLOCK → new=ALLOW）**：①拼接变形（`__import__('o'+'s')` / `import_module('sub'+'process')`）绕字面量；②词表外执行面（getattr 拿 system、ruby `open('|…')` 管道）；③未知写动词（truncateSync/linkSync 不入提取集）——**类不可枚举**，词表追补 = 与攻击者比词汇量（#1207→#1304、#1170→#1360 修复-回归循环同族教训）。

**收口**：载荷面一律 `return null`（回落旧链关键词网，与切换前同判——类闭合，不再有词表军备面）：

- BLOCK 方向不受此门限制（mainWriteHit 前置终局拦）——#1363 灰区闭合保持；
- rescue 3/21 一条不少（cp 复制 + ssh-add 管道族全为非载荷面，夹具双态实证）；
- 代价：合成 `node -e 真写 /tmp` 演示与 #1395 载荷形态（`node -e 写 worktree | tail`）翻 expected-BLOCK（5 处既有测试期望同步翻转，如实钉住）——载荷形态误拦残余收编 v2（#1438 预注册「载荷只读正向证明」即其回收路径）；
- delta 6 形态逃逸全部入夹具负门（`delta-e1`~`delta-e6`，双态断言）。

### 零披露放行臂收回（空真写一律回落）

处置中的临时臂「零披露 + 非载荷 → 终局 ALLOW」实测打破三条既有负门（`{ git commit -m x; }`、`git push origin main --dry-run`、`bash -o pipefail -c` 空载荷——零目标 ≠ 只读，git 写意图无文件参数可提取）→ 收回，空真写一律回落旧链（与提交基线同语义）。审视建议 A 的完整形态（read/unknown/write 三态正向认定）收编求值器 v2。

### 切换实测修复（求值器三处语义 bug，观察期未暴露因旧链在生产）

1. **段级 cwd**（原 trackCwd 只跟踪最终 cwd）：`git commit && cd /tmp` 旧算法把 commit 算到 /tmp（漏拦）；`cd /wt & git commit` / `cd /wt | git commit` 旧算法让右段继承左侧 cd（& 并发/管道右段真实 cwd 在主仓）。新 `evalSegmentCwds`：段 i 的 cwd = 之前主链 cd 的累积；& / | 段回退到 fork 基准（不继承左侧链内 cd）
2. **只读披露 write=false**（见上）
3. **工作区 sandbox**：`/data/workspaces/` 进 OTTER_RUNTIME_REGIONS（F20260923hsyn 重定向豁免面在求值器侧等价保留——否则工作区写全被误拦）

### 预注册 BC 落地

| BC | 内容 | 结果 |
|---|---|---|
| BC-1 | `cd 主仓 && git commit` 放行→拦 | **落地**（显式意图豁免退役，落点事实优先；$W 溯源同族） |
| BC-3 | npm install | **基线订正**：现役旧链实测本就 ALLOW（预注册「保守拦」假设不成立）——切换维持现状（无写 token 回落旧链） |
| BC-2（新增） | `echo '文本' >> notes.md` 重定向落主仓 cwd | **拦**（引号内文本豁免不再旁路落点判定——#1038 语义收窄，落点事实优先） |
| worktree 约定 A | 豁免锚定 `.otter/worktrees/` 标准目录 | 已是求值器现状（OTTER_RUNTIME_REGIONS），纯函数无运行时依赖 |

### 回退通道（预注册回退条件）

- **回退条件**：生产出现 1 例真误放（求值器终局放行但人工裁该拦）→ 回退
- **开关**：`OTTER_GUARD_EVAL_SWITCH=0` 环境变量（每次判定读取，无缓存；重启进程生效）→ 旧链全量判定
- 回归测试钉住开关双态（=0 时 BC-1 形态回退为旧链放行）

## 切换后行为变化全表（测试逐条钉死）

| 形态 | 旧链 | 换岗后 | 依据 |
|---|---|---|---|
| cd worktree && git 提交族 | 放（cd 豁免） | **放**（落点事实） | 语义等价继承 |
| 外部项目操作（colink/kelp 非载荷段，npm run/git 操作）| **拦（误拦）** | 放 | 观察期裁决 + 语料 r 族实测 |
| kelp node -e 只读探针（载荷无真实写）| **拦（误拦）** | 拦（载荷面一律回落，残余） | 语料 r001/r002 等 expected-BLOCK 钉住，修复面收编 v2 |
| curl -o /tmp、touch /tmp | touch：拦→放；curl -o：拦（known-gap 回落，与旧链同判）| 同左 | 建议3：known-gap 不终局 |
| node -e 写 worktree \| tail | **拦（V1 管道杀豁免，#1395 家族）** | 放 | 观察期裁决 |
| cd 主仓 && git commit（BC-1）| 放（显式意图） | **拦** | 预注册采纳 |
| $W=主仓; cd $W && commit | 放 | **拦** | BC-1 同族 |
| git add -A（未 cd）| 放（枚举缺口） | **拦** | Phase 2 index 语义补位转正 |
| cd wt 后写主仓（#1363 灰区）| 放（灰区） | **拦** | EVAL_GAIN 转正（7 条实证） |
| echo 引号文本 >> 主仓 cwd（BC-2）| 放（#1038） | **拦** | 落点事实优先 |
| 只读脚本载荷（open 读）| 白名单放 | 放（write=false） | #1416 家族不回归 |
| os.remove 等未枚举写 | 拦（关键词网命中） | 拦（空真写回落，与切换前同判） | fail-closed 不旁路；「回落旧链 = 与切换前同等既有面，不扩大不缩小」（既有漏归词表收编 issue） |
| npm install | 放（基线订正） | 放（回落旧链） | 现状维持 |
| 重定向落 data/workspaces/ | 放（hsyn 豁免） | 放（REGION 扩展） | 豁免面等价保留 |
| bash -c/heredoc/包装词载荷 | 旧链 | **旧链**（不接主判） | data 感知旁路回归坐实 |
| 脚本载荷面（execSync/subprocess/反引号/拼接变形/未知写动词等 15+6 形态）| 拦（关键词网） | **拦**（载荷面一律回落） | 焦点(a)+delta eba7c738 两轮实测：曾终局放行的面全类封口 |
| 零目标写意图（git commit / push --dry-run 无文件参数）| 拦 | **拦**（空真写回落） | 零披露放行臂收回，三条既有负门回归 |

## 设计取舍

**主判限「求值器证明有写」而非「证明无写」**：脚本载荷的写 API 枚举（SCRIPT_WRITE_TOKENS）永远追不上真实形态（os.remove/subprocess/未枚举面）——「无写 token → 放行」会把旧链的关键词网防线旁路（初版实测 `python3 -c "os.remove('data/x')"` 漏拦）。收窄为「有真写 targets 才终局」，未证明面全回落旧链——回落面 = 与切换前同等既有面（不扩大不缩小，既有漏归词表收编 issue，不冒充防线）。

**宣称订正（审视严重1 处置，实测口径）**：初版宣称「23 条误拦族全修复」被复跑证伪。处置后权威口径：观察期裁决语料反查 21 条真实命令（禁合成替代）钉进 `tests/fixtures/guard-observed-rulings.json`——**实测修复面 3 条终局修复**（cp 复制 + ssh-add 管道族，双态断言锁终局语义）/ **15 条残余 expected-BLOCK + 3 条 parity-allow（#1487 归一）**（载荷只读面、known-gap 回落、零披露面——如实钉住防两向漂移）。残余修复面收编求值器 v2（两份 issue 预注册）。

**write=false 语义混合记档（审视建议4）**：`write=false` 实际语义是「不在写词面表」而非「证明只读」——`os.remove('data/x')` 实测被标 w=false。任何未来「全只读 → 终局放」的放松都会踩雷；本版空真写一律回落正是避开该雷区，三态正向认定（read 白名单/unknown 回落/write）收编 v2。

**载荷证明门 vs 修复面取舍**：载荷只读探针族（kelp node -e）从「终局放行」回退为「回落残余」——载荷只读性静态不可证（15 形态实测漏拦是反例集），用不可证的放行换修复面会把误放风险（不可逆）置于误拦摩擦（可恢复）之上，与 fail-closed 取向相悖。修复面数字如实记 3/21，宁可少修不误放。

**delta 轮收口（eba7c738）**：处置版两道闸再被 6 形态击穿（证明门的两组词表本身是词表军备）→ 终版「载荷面一律回落」。备选 deny-list（保 6/21 修复面）经 delta 评估**否决**——同词表病且去掉诱饵门槛，更差。终版修复面 3/21 不变、漏拦类整体闭合；5 处既有测试期望（#1395 载荷形态 ALLOW）如实翻 BLOCK 钉住，非载荷面 rescue 由夹具 3 条双态锁。

**嵌套载荷不接主判**：judgeShellCSegment 内挂 data 载荷感知、heredoc 体负门、包装词递归——多道纵深防线寄生在 main_write 通道内部，求值器终局放行会全部旁路（bash -c mv data 实测坐实）。嵌套形态留给求值器 v2（需要把 data 感知等收编进求值器语义后才能安全接管）。

**段级 cwd 修复进求值器而非补丁**：& | 右段 cd 语义是 shell 事实（并发/管道右段不继承），旧 trackCwd 的「最终 cwd 反向套」是算法性错误——观察期没暴露只因这些形态被旧链误拦（never reached）。换岗前实测修复 + 回归钉死。

**族内成功率双口径**：语料 141 例 shadow（91.7% ✅ 判据正式口径）vs 台账观察口径（分子=同判拦+确认误拦裁决，分母含未裁决回落族）——台账口径是观察工具不是判据（回落族由旧链兜底行为正确），写进报告脚本注释防误读。

### 机制识别检查点判定与机制预算四问（审视严重2 处置——mechanism-addition 依据）

本特性未经 RA 流程（搭档直接驱动），机制判定前置补做：

- **① 净新增机制？** 是——main_write 维度判定权交接：求值器主判 + `OTTER_GUARD_EVAL_SWITCH` 回退开关（diff 实增配置面，每次判定读取）+ 载荷面禁放闸/known-gap 闸。
- **② 既有机制内修？** 部分——载荷面禁放闸、空真写回落属既有求值器主判的语义内修（结构性补位），随主机制入档，不单列。
- **③ scope-reduction？** 否——旧链管辖确收窄为回落网，但伴随新配置面与判定权交接，非纯收窄。
- **判定结论**：`mechanism-addition`（commit 与本 frontmatter 同步声明；原声明 `structural` 不在 commit-convention 枚举内，属严重2 违规已订正）。

机制预算四问：

| 问 | 答 |
|---|---|
| 谁需要这个机制？ | main_write 维度（bash 守卫）——旧链词面正则误拦率高（观察期新旧分歧 23/23 全是旧链误拦）且 #1363 类灰区词面修补无效 |
| 失败后果？ | 误拦 → 獭向搭档报告（可恢复，摩擦成本）；误放 → 主仓被写（数据损失不可逆）——故所有「证明不了」的形态恒回落旧链，失败方向单侧 fail-closed |
| 后续机制？ | 求值器 v2：载荷只读正向证明 + read/unknown/write 三态 + 写词表收编（两份 issue 预注册）；影子旁听记录器继续 |
| 退役条件？ | 预注册回退：生产 1 例真误放 → `OTTER_GUARD_EVAL_SWITCH=0` + 重启（免 rebuild）；v2 收编载荷/known-gap/三态面后，本版各收窄闸逐个评估退役 |

## 验证

| 验证项 | 结果 |
|---|---|
| 切换专项测试 | 三态主判 + 段级 cwd + 嵌套收窄 + 旧链防线 + #1395 家族负门 + 回退开关（原 24 例） |
| 语料夹具（新，审视严重1 处置 + delta 收口） | `guard-observed-rulings.test.ts` **49/49**：21 条真实命令回放（3 终局修复双态锁 + 15 残余 BLOCK）+ 焦点(a) 15 形态 + delta 6 形态逃逸负门 + known-gap/os.remove 负门 |
| 既有测试 | agent 目录 **1539/1539**（含 B 臂收回三条负门回归 + delta 收口 5 处载荷 ALLOW 期望翻转：#1395 载荷形态族） |
| 语料 141 例 shadow | 四判据全过（族内 91.7% / 回落 19.3% / 红线 0 / 误放 0） |
| 报告脚本 | 族内分子含确认误拦裁决（r1 处置顺手修）|
| 全仓 | 待跑（见 PR） |
| 观察期数据归档 | 3 天 1405 条 / 23-23 裁决 / 红线 0 / EVAL_GAIN 7（healing_events + 本文档） |

## 风险与遗留

- **词表外写命令终局放行漏拦**（MiMo 初轮 F1）：`TARGET_ARG_COMMANDS={tee,cp,mv,touch,mkdir}`，`truncate`/`sed -i`/`rsync`/`ln` 不产生 target——`touch /tmp/x && truncate -s 0 /repo/evil` → eval=ALLOW（truncate 写主仓漏）。文档已认「未知写动词不可枚举」并对载荷面禁终局放，但未对顶层词表外写命令同处理（推理不对称）。**未归类的终局放行漏拦**，违背「未证明面全回落」契约。预注册求值器 v2 收编（#1438）
- **mv source 删除面不追**（MiMo 初轮 F2）：`destArgs=slice(1)` 对 cp/mv 同用，`mv /repo/src/file /tmp/` 只记 dest、不记 source 删除 → 漏。cp 用 slice(1) 对（source 是读），mv 漏。预注册 v2
- **cmdsub 子模型不继承段级 tracked cwd**（F20261015cwsp 归一 MiMo delta F2）：外层 `cd` 链对 `$( )` 载荷落点失效——`cd /repo/sub && echo $(touch evil)` 落点算成 `/repo/evil`（真实 `/repo/sub/evil`）；sessionCwd=ROOT=BLOCK、sessionCwd=worktree=ALLOW 分叉（探针 J/J2）。窄形态漏拦，预注册求值器 v2 收编（#1438）
- **嵌套载荷仍是旧链**——#1395 家族的 bash -c/heredoc 形态误拦仍存在（收窄换取 data 感知不旁路，取舍记录在案）；求值器 v2 收编 data 语义后解除
- **S1 覆盖边界**（MiMo delta 跟进2）：git 写族回落修复闭合的是**求值器看得见的词表写**（cp/mv/tee/touch/mkdir）；`curl -o`/`wget -O`/`install`/`dd of=` 走 KNOWN_GAP 早退绕过整个 evaluator——`git commit && curl -o /repo/evil` 仍 ALLOW（先前既有，非本 PR 引入）。curl -o 类残余补进 #1438 范围
- **write token 枚举面**（SCRIPT_WRITE_TOKENS）仍是枚举——但失败方向已反转（漏枚举→回落旧链保守拦，不是放行）
- **回退开关依赖重启生效**（进程 env）——回退操作手册：设 env → 重启（特性文档 + PR body 写明）
- **语料残余 15 条 expected-BLOCK + 3 条 parity-allow（#1487 归一）**（载荷只读探针/known-gap/零披露面）——已钉夹具防放宽，修复面收编 v2（issue 预注册）；载荷面一律回落后无词表军备面（新变形面由回落旧链关键词网与切换前同判兜底）；#1395 载荷形态误拦（node -e 写 worktree 管道族）同入残余
- **write=false 语义混合**（= 不在写词面表，非证明只读）——三态正向认定收编 v2，期间禁止任何「全只读→放」放松
- **既有漏两族**（curl -o 主仓、eval 词面）旧链本就不拦——归词表收编聚合 issue，非本 PR 引入
- kill/data/sleep 维度零改动（本 PR 不碰）；影子记录器继续旁听（切换后 EVAL_GAIN 面自然归零观察）
