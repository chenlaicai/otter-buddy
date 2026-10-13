---
id: F20261013gev2
title: bash 求值器 v2 能力补全 1-8——judge 考试基线、读写判据区分与开发棘轮
summary: 主体工程（派工单 2026-10-13：求值器能力补全 1-8）的验收门先立：judge 考试 harness 对 988 条试金石全量复跑（放行 763 必须正面 ALLOW / 拦截 52 必须 BLOCK / 条件期望 106 双态），加开发棘轮（只许单调缩小，能力完成后清零删除）。判据基建：WriteTarget.access 读写区分（能力 8 先行，修影子实战「读当写」误判）+ evaluateWriteVerdict 终局裁决助手（考试与影子同判据）+ startCwd 双态维度。基线缺口 247 = 放行 191（heredoc 载荷 fail-closed 141 大头）/ 拦截 22 全放水 / 条件 34——能力 1-8 作战地图。
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
date: 2026-10-13
status: development
modification_class: narrow-fix
---

# bash 求值器 v2 能力补全 1-8（judge 考试基线）

## 背景 / 意图锚

- 派工单（大獭 2026-10-13）：「主体工程：求值器能力补全 1-8」——PR #1448（试金石 988 条）已合入 main，基于 main 新开 worktree 做求值器 v2 能力补全；「每步全量试金石复跑——一步都不许带红前进」；「试金石全绿的质量比速度重要」
- 方案真相源：`bash-guard-one-shot-plan.md` §三.2 能力清单（1-8，含 2026-10-13 影子实战新增 7/8）+ §3.2.1 证明演算三条规则 + §4.2.1 组合负门
- 试金石方法论（搭档原话）：「咱们运行的实际数据作为验证用例……这些数据就是试金石」
- 北极星（fact 17b1447f）：同一套机制，规则可增减；每个规则的拦截判断逻辑「追求精准狠，减少误判错判多判」

## 目标 / 非目标

- 目标：能力 1-8 逐个落进求值核（write-target-evaluator），每步过 judge 考试且棘轮只减不增；能力矩阵三态测试（放行侧/拦截侧/负门）；§4.2.1 组合形态专项负门；终态棘轮清零删除、考试升级为 CI 验收门
- 非目标：#1433 换岗接线（求值器接入守卫主链）不在本特性——另一条线（feat/guard-eval-switch）；规则文案/引导语；影子台账流程改造

## 本基线交付（第一个 commit）

| 交付 | 内容 | 治什么 |
|---|---|---|
| `WriteTarget.access: "write" \| "read"` | 读/写访问位（能力 8 判据基建） | 只读披露不构成写证据——影子实战发现的「读当写」误判（30517746 只读版本号打印病灶）同源修 |
| `evaluateWriteVerdict()` | 终局裁决助手：evaluated+写落点∩主仓=BLOCK(positive) / evaluated+无=ALLOW(positive) / unevaluated=BLOCK(fail-closed §3.3) | 「judge 考试」与影子投影同判据，口径不分叉（审视红线） |
| `startCwd` 参数 | evaluateWriteTargets/evaluateWriteVerdict 可选起始 cwd | 条件期望双态维度（worktree 态→ALLOW / 主仓态→BLOCK）；缺省 projectRoot，既有调用零变化 |
| `guard-touchstone-exam.test.ts` | 988 条全量复跑：放行 763 必须**正面 ALLOW**（fail-closed 不算过）/ 拦截 52 必须 BLOCK（正面落点或 fail-closed 终局）/ 条件 106 双态各跑 | 「一步都不许带红前进」的机械护栏 |
| `guard-touchstone-exam-gaps.json` | 开发棘轮：247 条已知缺口（键→原因），EXAM_REGEN=1 机械再生 | 见「设计取舍」防注水设计 |

## 能力 1-8 落点规划（plan §三.2 → 求值核函数）

| # | 能力 | 落点 | 基线缺口对应 |
|---|---|---|---|
| 1 | 脚本载荷窄提取 v2 + 证明演算三条规则（路径调用三分类 / exec 类一律不可证 / 非路径调用不参与证明；import/require 拆分） | `evalScriptPayloadNarrow` 重写 | allow 141 + block 放水（node -e new Function 等 residual_face、exec 类藏载荷） |
| 2 | 写词面命令族通道（perl -pi/-ne、ruby -pi、sed -i 原地编辑；curl -o/wget -O/install/dd of=/ln/chmod/chown/truncate 参数即落点） | `evalSegment` 词表扩展 | block 放水（载荷写×汇点写） |
| 3 | 隐式写词面（元操作）：git commit/push/merge/rebase/amend、npm install、pip install、make=隐式写落点（cwd/仓）；push 远端目标=非写（双签口径 §一） | `evalGitWrite` 扩展 + 元操作族 | block 放水（c097/747bd520 checkout 段、隐式写×显式写混合） |
| 4 | 无落点正向证明：无写词面+无隐式写词面+载荷可证只读 → ALLOW | 与能力 1 同体重构 | allow 191 主体 |
| 5 | 段级 cwd + 引号载荷完整解析（切分不切碎多行载荷） | `command-lexer`/`command-model` | allow/cond heredoc-script-payload、parse-failed 8 |
| 6 | 路径归一化（evalPath 拒 `..`）折叠进 v2 核 | 已有（#1381/#1411），归位 | dynamic-path 12 |
| 7 | 排除区补 `data/workspaces`（沙箱目录） | `pathWithinMain` OTTER_RUNTIME_REGIONS | cwd-unresolvable 14 + 数据夹具写误拦 |
| 8 | 只读 require/import 披露不构成写证据 | 已在本基线落 access=read；能力 1 时并入证明演算规则 3 | 本 commit 治「读当写」判据面 |

## 设计取舍

1. **考试语义两档严格度**：放行池必须「正面 ALLOW」（evaluated 且写落点∩主仓=∅，fail-closed 不算过）——对应验收语义「非回落恰好放行」；拦截池认 fail-closed 为过——残余面 7 条的设计语义就是「真实误拦但 fail-closed 仍拦，如实钉 BLOCK 防未来放宽误当」，fail-closed 是 v2 的终局态不是回落
2. **开发棘轮防注水三件套**：①只许单调缩小——任何新缺口/回归=红（机械护栏，不靠自觉）；②键→一句话原因，评审 diff 可见每条缺口的存在理由；③能力完成后清零并**删除清单与 fixture**（不留永久放水口）。EXAM_REGEN=1 再生模式仅限开发期重定基，评审看 diff
3. **读写区分先行于能力 1**：考试判据（「写落点∩主仓」）需要读/写位才能正确计算；且它直接修影子实战的误判病灶（日报发现的「新裁判把读当写」）——判据基建不是抢跑能力 1，是考试 harness 的前提
4. **考试与影子同判据**：evaluateWriteVerdict 是唯一裁决函数，shadowEvaluate 投影与之同源——口径分叉即审视红线（防「考试绿但线上判法不同」）
5. **startCwd 缺省=projectRoot**：既有调用零行为变化；条件期望双态由考试显式传参，不给生产入口开 cwd 旋钮

## 机制判定（动手前，修法决策树）

修法决策树 **① 在既有机制语义内修/补全**：求值器机制已存在（#1381/#1411/#1433 基座在 main），能力 1-8 是同一机制内的规则补全（北极星明文「规则是可以增加/减少的，关键核心的机制要做好」）——不走④新增机制，无需机制预算四问。

机制识别检查点逐项：新增配置字段/枚举/开关 ✗；新增状态生命周期 ✗；新增定时任务/后台进程 ✗；新增信号类型/消息格式 ✗；**新增持久化 ✓（guard-touchstone-exam-gaps.json 开发棘轮清单）**——为何命中但不涉净新增机制：该文件是开发期测试夹具（能力完成即删的临时棘轮，退役条件已写死在文件头与本节），非生产机制面、无运行时消费者；不为它开机制预算，收尾时随棘轮清零一并删除。

## 验证

- `npx vitest run tests/frameworks/agent/guard-touchstone-exam.test.ts`：3/3（棘轮态，247 缺口基线）
- `npx vitest run tests/frameworks/agent/write-target-evaluator.test.ts shadow-eval-recorder.test.ts`：既有 69 用例全绿（access 位与影子写过滤零回归）
- 全仓 `npx vitest run`：5404/5404

## 基线缺口分析（247 条，能力补全作战地图）

| 池 | 数 | 分布 |
|---|---|---|
| 放行 191 | heredoc-script-payload fail-closed ×141、正面 BLOCK 误报 ×18、cwd-unresolvable ×13、dynamic-path ×11、parse-failed ×8 | 能力 1/4/5 主战场 |
| 拦截 22 | 全部放水（求值器判 ALLOW 但必须拦） | 能力 1/2/3：residual_face 的 new Function exec 类、heredoc-quoted 被当纯数据跳过（bash - <<'EOF' 实为脚本）、checkout/隐式写段 |
| 条件 34 | heredoc fail-closed ×15、放水 ×14、正面 BLOCK 误报 ×3、dynamic-path ×1、cwd-unresolvable ×1 | 双态各有短板 |

## 死因诊断（2026-10-13 诊断抽样，代表性缺口逐条透视）

1. **parseOk=false 无条件回落**（TS-e484b255 等大头）：引号内嵌套引号（`-c "…open('f')…"`）触发词法 fail-closed → parseOk=false；段级求值其实已成功（读侧目标已入账）但入口层对 parseOk=false 统一回落 `heredoc-script-payload` → 能力 5（引号载荷完整解析）治本，能力 1 载荷窄提取 v2 消化残留
2. **引号载荷被切碎**（TS-7c8e2cd5）：多行 node -e 载荷内嵌 `\"` 转义引号，被按 `;`/换行切碎成 36 个伪段（console.log/注释行全成了 argv0）→ 能力 5 核心现场（切分不得切碎引号载荷）
3. **`~` 展开判 dynamic-path**（TS-21cee677）：`mv ~/Desktop/... ~/.Trash/...$(date +%s)` ——落点静态前缀（~/）可证树外，尾部动态段不改写落点归属，却被整段判不可求值 → 能力 4/6（无落点正向证明 / 路径归一化：前缀可证树外即无主仓写面）
4. **读侧 require/import 披露被当写或回落**（TS-b6c006fd）：`require('/ext/…/package.json').version` 只读版本披露——literal module 路径应走规则 3 非路径调用/读披露 → 能力 1+8（import/require 拆分）
5. **拦截池放水的两型**：heredoc-quoted 被当纯数据跳过（`bash - <<'EOF'` 体内是真脚本）；exec 类（new Function/递归可调用）无检出 → 能力 1（exec 类一律不可证）+ 能力 3（隐式写词面）

## 下一步（派工单节奏：每 2-3 个能力报进展）

1. 能力 5（段级 cwd + 引号载荷完整解析）+ 能力 1（窄提取 v2 + 证明演算）先行——heredoc-script-payload 141 条是最大缺口面
2. 能力 2/3（写词面族 + 隐式写元操作）清拦截池放水
3. 能力 4/6/7/8 收尾 + §4.2.1 组合负门专项（perl -pi 藏 exec / 载荷写×汇点写 / 隐式写×显式写混合）
4. 棘轮清零 → 删除清单 → 考试升级 CI 验收门 → PR 交对抗审视（检视獭1360，含其欠的 2 条补签）
