---
id: F20261021eche
title: echo -e 转义假重建逃逸收编——echo 内容重建与 printf 同基座对齐（M-e4a199a1）
summary: segmentStdoutContent 的 echo 分支三处假重建（谎报内容=逃逸面）修复：-e 旗标被无条件丢弃致 \xHH/\0nnn 转义不解码谎报良性（matter 主诉实证：echo -e 'touch \x2f…' bash 输出载荷执行 vs 判定 ALLOW）、一切 - 开头词被丢、-- 被丢。修法=新增 echoFormatContent（bash echo 旗标语义实测口径：前导 /^-[nEe]+$/ 旗标、e/E 后者覆盖、实参原样 join），-e 解码走 PRINTF_ESCAPES 白名单、白名单外（\xHH/\nnn/\c/未知）→ null 不猜（delta2 S2 保守路同口径）。21 用例含拼写变体矩阵。
capability_test: "n/a: 判定语义变更由单测钉死——write-target-evaluator 186 例（21 例 echo 两侧+变体矩阵、4 例修复轮 1 边界、11 例修复轮 2 分歧闸）+ 全量 6590 passed 零失败（修复轮 2 终态）。golden 豁免声明（沿 #1318/#1377 先例，F20261014gvbx 对账口径）：本 PR 不涉 golden_replay 断言面，golden-results.jsonl 无本 PR 记录系按设计不落账而非漏跑，不计缺记录"
change_type: fix
intent:
  problem: "M-e4a199a1：echo -e \\xHH 假重建逃逸（echo 分支三代未动，实测 ALLOW vs bash 输出载荷执行）——segmentStdoutContent 的 echo 分支 args.join(' ') 零转义处理，-e 旗标被 filter(!startsWith('-')) 无条件丢弃，bash 实测 echo -e 解码 \\xHH/\\0nnn（bash 3.2 实测：echo -e '\\x41'→A），重建谎报字面转义=假良性 → 判定误放，载荷写脚本/管道喂入 bash 可执行真载荷。printf 族已收口（delta2 S2 白名单 fail-closed），echo 同族同病独立收编"
  expected_effect: "echo -e \\xHH/\\0nnn 载荷写脚本执行形态判定 BLOCK（修复前 ALLOW）、\\c 截断 fail-closed；字面/旗标/中后部 - 词/-- 精确重建不误伤（evaluateWriteVerdict 断言 toBe('BLOCK')/toBe('ALLOW') 21 用例钉死）"
  verify_by:
    type: capability_test
modules:
  - src/frameworks/agent/write-target-evaluator.ts
from:
  - F20261019wvcp
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
created_by: 守卫修复獭
---

## 问题（M-e4a199a1，实证）

**主诉**：`echo -e 'touch \x2frepo\x2fdata\x2fpwn' > /tmp/g.sh && bash /tmp/g.sh`（或管道 `| bash`）——bash 实测 echo -e 解码 \xHH（bash 3.2.57 实测 `echo -e '\x41'` → `A`；\0nnn 八进制同解），脚本内容是真实 `touch /repo/data/pwn` 载荷；但 segmentStdoutContent 的 echo 分支重建 `touch \x2frepo\x2fdata\x2fpwn`（字面转义=谎报），下游判「无主仓写载荷」→ ALLOW。载荷执行=真逃逸面。

**假重建三面**（echo 分支 `vals.filter(!startsWith("-")).join(" ")` 实证）：
1. **-e 旗标被无条件丢弃** → 转义不解码谎报良性（主诉）
2. **一切 - 开头词被丢**：`echo foo -e` bash 输出 `foo -e`，重建 `foo`（丢实参谎报）
3. **`--` 被丢**：bash echo 不识别 -- 终止符（实测 `echo -- -e foo` → `-- -e foo`），重建丢之

**bash echo 旗标语义（实测口径，探针在案）**：前导连续 `/^-[nEe]+$/` 词是旗标（-n 去尾换行=内容判定无关、-e 解码、-E 禁解码，e/E 按出现序后者覆盖——实测 `echo -e -E 'a\nb'` 字面 vs `echo -E -e 'a\nb'` 解码）；此后一切词（含 -x 等未知旗标词、--）全是实参；实参字面 join 单空格。\uHHHH echo 不解码（字面输出实测）。

## 修法（narrow-fix，机制识别检查点全否）

与 printf 族 delta2 S2 同口径（「同一重建基座」对齐）：新增 `echoFormatContent`——

| 形态 | 处理 | 依据 |
|---|---|---|
| 前导旗标 `/^-[nEe]+$/` | 解析（e=decode 开、E=decode 关（后者覆盖）、n=忽略） | bash 实测 |
| 第一个非旗标词起 | 全部实参（含 -xxx/--）字面保留 | bash 实测（-x 当实参、echo 无 -- 语义） |
| decode=off（默认/-E 赢） | 实参字面 join——精确重建 | bash 不解码任何转义 |
| decode=on（-e 赢） | **ECHO_ESCAPES 收窄子表**（PRINTF_ESCAPES 去 e/'/" 三键——修复轮严重 1）解码；白名单外（\xHH/\0nnn 八进制/\c 产生性截断/\'/\"/\e/未知）→ **null 不猜** | delta2 S2 保守路同口径（#1513 不军备化之尺——转义形态穷举=军备化反面，漏一个=谎报=逃逸面） |

**白名单外 fail-closed 的取舍**（诚实记档）：\xHH/\0nnn bash 实测可精确解码（理论上可精确重建），但走形态穷举=军备化反面（printf S2 的论据）；归 null 后保守侧误拦良性 `echo -e '\x41'`（输出 A）类命令——fail-closed 保守侧可接受，与 printf 族一致。版本差异表述（修复轮措辞收窄，检视獭1597 建议 1）：白名单**外**的「不猜」口径不依赖版本行为；但白名单**内**的 `\e` 恰是版本差异项（bash 3.2 字面/5.x 可能解码）——故修复轮把 `\e` 出表归 fail-closed（新 bash 良性 ANSI 色码会被保守拦，取舍在此记档）。

**修复轮严重 1（白名单错配收窄，检视獭1597）**：初版 echo decode 直接复用 PRINTF_ESCAPES——把 printf 专属的 `\'` `\"` 与版本差异项 `\e` 带进 echo 白名单，而 bash echo 对这三者不解码（实测 od 字节级：`echo -e 'a\'b'` → `a \\ ' b` 字面）。端到端实证：`echo -e "ok ; touch \\' x \\'"` 落盘 `\'` 是活命令结构，旧表 `\'→'` 制造假引号串吞命令结构可漏判——同族第 4 面假重建，恰是「同基座对齐」时照抄 printf 表带进来的。修法=新增 ECHO_ESCAPES 收窄子表（去三键）+ 4 条边界用例钉死（`\'`/`\"`/`\e` fail-closed + 吞命令结构端到端）——修错配非军备化扩张。

**下游同收益**：segmentStdoutContent 被 redirectWriteContent（重定向写面内容重建）+ bash-safety-guard stdinShellFeederVeto（管道喂入 shell 载荷判定）共用——一处修复两面收益。

**被否路径**：精确解码 \xHH/\0nnn（军备化反面）；只拦 -e 不修丢词（假重建面 2/3 留洞）；echo 归 null 全 fail-closed（误伤字面 echo 常态命令）。

机制识别检查点逐项全否（判定函数语义内修，无新配置/状态/定时任务/信号/持久化/跨模块调用）→ 修法决策树①。

**严重 2 治标防线（双引号反斜杠分歧闸，检视獭1597 第 2 轮 delta 实锤 + 大獭双轨裁决）**：「残余记档」原记「echo decode 层 fail-closed 兜住、本 PR 面不受损」被 attack/control 差分实验**证伪**——单反斜杠源码形态端到端 ALLOW（一条 `\'` 翻转守卫）。真相：反斜杠在**词法层**就被丢（`"a\'b"` → 词 `a'b`，bash 真值 `a\'b` 两字符），decode 根本看不到被丢的转义；假引号串吞命令结构 → 递归判读读到无害 → 谎报 ALLOW。本 PR 面治标（根修归 M-f89f1ff3 独立立案，公共词法层不动刀）：

| 项 | 内容 | 依据 |
|---|---|---|
| 闸位 | `segmentStdoutContent` 入口 `wordDivergesFromBash`——echo/printf/重定向写面/管道喂入/载荷递归判读同基座同收益 | 单点真相源 |
| 判据 | 词任一 escape part 双引号态且后随字符非 bash 五符特殊（`$` `` ` `` `"` `\` 换行）→ 词面与 bash 真值分歧 → null 不猜 | bash 引用语义：双引号内反斜杠仅五符前特殊，其余字面保留 |
| 对位 | part.text 保原文两字符位，part 级即天然对位——不做字符串下标映射 | escape 折叠 2→1 后下标对位是伪对位 |
| 治标口径 | 只判「可否重建」不修词义；良性双引号转义造-执对（`printf "#!/bin/bash\necho hi\n"`）随 null 走 fail-closed 保守拦 | 不复制词法语义进求值器=双真相源（大獭裁决：不采纳「求值器内修正重算」） |

**设计取舍（治标方案三问）**：
1. **为什么闸放 `segmentStdoutContent` 基座而不按处方放 `echoFormatContent` 内部**——printf 同族同病（`printf '%s' "a\'b"` 同丢反斜杠假重建），基座单点覆盖 echo+printf 双族 + 重定向/管道喂入/递归判读三通道；放 echo 内部则 printf 面漏。`echoFormatContent` 仍是唯一 echo 语义实现（注释已注明闸在上游，不重复判）。
2. **为什么 part 级对位而不是「词面孤立引号 + 原文对位反斜杠」字符串扫描**——part 自带原文字符位（WordPart.text），对位是结构事实不是扫描启发式；孤立引号判据会漏无引号的分歧面（`echo -e "a\nb"` 修复前谎报 `anb`，无一个引号）。分歧判据直接落「词义是否可能与 bash 不一致」这个根属性，比引号形态穷举窄而准。
3. **为什么 fail-closed 而不在求值器内按 bash 语义补回反斜杠（修正重算）**——那等于把词法层语义复制进求值器，双真相源漂移风险 > 收益；根因修在 command-lexer（M-f89f1ff3 独立 PR + 全变体矩阵审视），修完本闸自动降级纵深冗余（判据恒不触发）。治标合入即把该面从「活跃逃逸」降级为「保守拦」，不等根修排期。

**机制识别检查点（修复轮 2，逐项机械判断）**：新增配置字段/枚举/开关——否（DQ_SPECIAL_AFTER 是函数级语义常量集非配置开关，不可外部注入）；新增状态生命周期——否（纯函数无状态）；新增定时任务/后台进程——否；新增信号类型/消息格式——否；新增持久化存储——否；新增决策分支（结果被记住并在后续影响行为）——否（wordDivergesFromBash 纯运行时临时分支，返回值即时消费不落账）；新增跨模块调用路径——否（调用方不变，wordDivergesFromBash 是本模块私有函数）。全否 → 修法决策树①（既有判定函数语义内修/补位）。

## 影响范围

- echo 静态重建语义变更：-e 解码、实参保真；字面 echo 行为不变（精确重建同旧 join）；printf 分支零改动
- 重定向写面/管道喂入两处判定同步收紧（\xHH 载荷从放行转 fail-closed 拦）
- 拦截面收严 = 修逃逸（非收严误伤）；放行面（字面/旗标/中后部 - 词）经 11 用例钉不误伤

## 验证

- **拦截侧**（5 用例）：\xHH 主诉、\0nnn 八进制、管道喂入、\c 截断、白名单内转义载荷（\n 拼接）——全 BLOCK/拦
- **放行侧**（11 用例）：纯字面、-n、中后部 -e、无 -e 字面转义、-E 字面、--、-x 归实参、多空格、空参、printf 回归 2——全 ALLOW
- **拼写变体矩阵**（派工纪律 fact 84708931）：-ne/-en 组合、-e -E（E 赢字面放行）、-E -e（e 赢解码拦）、双引号同语义、printf S2 回归——全覆盖钉死
- **严重 2 治标防线（修复轮 2，11 用例）**：attack 单反斜杠端到端 fail-closed BLOCK（修复前 ALLOW 谎报良性）、control 同构纯字面 positive BLOCK（差分对照同判=差分收口）、printf 同族造-执对 fail-closed BLOCK、管道喂入变体拦；分歧单元 3（`echo "it\'s"` / `echo -e "a\nb"`（修复前谎报 anb）/ `printf '%s' "a\'b"`）→ null；反证 2 不吃闸（双反斜杠 `a\'b` 精确重建、单引号 decode 白名单不受影响）；不误伤 2（良性双引号转义写落工作区 ALLOW）
- write-target-evaluator **186/186 绿**（171 初版 + 4 修复轮 1 边界 + 11 修复轮 2）；全量 410 files **6590 passed + 6 skipped 零失败**
- 全等语义对齐探针（bash 3.2 实测）：\x41→A、\0101→A、foo -e 保参、-- 保参、e/E 覆盖序、-en 组合、\uHHHH 字面——文档「问题」节表格

## 活体旁证（开发途中实录）

开发期间守卫把 echo 语义探针命令（`bash -c "echo -e 'a\ub041c'"`）按「写命令落点解析到主仓」误拦——echo 形态是守卫敏感面的同族旁证（误拦侧，非本 PR 修面，归误拦台账）。

## 残余记档

- echo 旗标还有 POSIX xpg_echo 环境差异（SHELLOPTS xpg_echo 下无 -e 也解码）——判定按 bash 默认口径（bash -c 单测实测基线），xpg_echo 场景罕见不入本单
- printf 分支的「选项位歧义 → null」口径与 echo 的「前导旗标解析」不同（bash printf 支持 -- 终止符而 echo 不支持）——两族语义差异属实测事实，各自忠实实现，非口径漂移
- **解析层附带发现已升级严重 2 并双轨处置（检视獭1597 第 2 轮 delta 实锤；原文「echo decode 层对此已 fail-closed 兜住（本 PR 面不受损）」记档不实，此处撤回校准）**：command-lexer 双引号扫描对 `\'`（一反斜杠+引号）解成 `'`（丢反斜杠），与 bash（双引号内 \ 后 ' 非特殊对→反斜杠字面保留）错配——不止「词面微差」，是**活跃逃逸面**：单反斜杠源码形态端到端 ALLOW（attack `echo -e "… \' ; touch 主仓 … \'"` 落盘 `\'` 是活命令结构 vs control 同构纯字面 BLOCK，差分只有那条反斜杠）。两层处置：①**本 PR 治标**=segmentStdoutContent 双引号反斜杠分歧闸（见修法节严重 2 段，分歧即 null fail-closed，echo/printf 同收益，attack 形态已钉 BLOCK 用例）；②**根因独立立案**=词法层 bash 双引号反斜杠语义对齐，公共词法层影响面大 → **M-f89f1ff3** 独立 PR + 全变体矩阵审视（大獭裁决：不并入本 PR——command-model 大修会撑爆 M-e4a199a1 的审视面）。残余：词法层分歧仍影响非内容重建面（evalPath 落点词/脚本路径词，如 `bash "g\'s.sh"` 路径词错位）——同归 M-f89f1ff3，根修合入后本闸降级纵深冗余
