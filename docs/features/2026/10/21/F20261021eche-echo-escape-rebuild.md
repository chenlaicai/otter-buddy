---
id: F20261021eche
title: echo -e 转义假重建逃逸收编——echo 内容重建与 printf 同基座对齐（M-e4a199a1）
summary: segmentStdoutContent 的 echo 分支三处假重建（谎报内容=逃逸面）修复：-e 旗标被无条件丢弃致 \xHH/\0nnn 转义不解码谎报良性（matter 主诉实证：echo -e 'touch \x2f…' bash 输出载荷执行 vs 判定 ALLOW）、一切 - 开头词被丢、-- 被丢。修法=新增 echoFormatContent（bash echo 旗标语义实测口径：前导 /^-[nEe]+$/ 旗标、e/E 后者覆盖、实参原样 join），-e 解码走 PRINTF_ESCAPES 白名单、白名单外（\xHH/\nnn/\c/未知）→ null 不猜（delta2 S2 保守路同口径）。21 用例含拼写变体矩阵。
capability_test: "n/a: 判定语义变更由单测钉死——write-target-evaluator 171 例（含新增 21 例 echo 两侧+变体矩阵）+ 全量 6575 passed 零失败。golden 豁免声明（沿 #1318/#1377 先例，F20261014gvbx 对账口径）：本 PR 不涉 golden_replay 断言面，golden-results.jsonl 无本 PR 记录系按设计不落账而非漏跑，不计缺记录"
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
| decode=on（-e 赢） | PRINTF_ESCAPES 白名单解码；白名单外（\xHH/\0nnn 八进制/\c 产生性截断/未知）→ **null 不猜** | delta2 S2 保守路同口径（#1513 不军备化之尺——转义形态穷举=军备化反面，漏一个=谎报=逃逸面） |

**白名单外 fail-closed 的取舍**（诚实记档）：\xHH/\0nnn bash 实测可精确解码（理论上可精确重建），但走形态穷举=军备化反面（printf S2 的论据）；归 null 后保守侧误拦良性 `echo -e '\x41'`（输出 A）类命令——fail-closed 保守侧可接受，与 printf 族一致。**该口径还有鲁棒红利**：bash 3.2 与 5.x 的 echo -e \xHH 解码行为存在版本差异（bash 手册未列 \xHH），「不猜」口径不依赖版本行为。

**下游同收益**：segmentStdoutContent 被 redirectWriteContent（重定向写面内容重建）+ bash-safety-guard stdinShellFeederVeto（管道喂入 shell 载荷判定）共用——一处修复两面收益。

**被否路径**：精确解码 \xHH/\0nnn（军备化反面）；只拦 -e 不修丢词（假重建面 2/3 留洞）；echo 归 null 全 fail-closed（误伤字面 echo 常态命令）。

机制识别检查点逐项全否（判定函数语义内修，无新配置/状态/定时任务/信号/持久化/跨模块调用）→ 修法决策树①。

## 影响范围

- echo 静态重建语义变更：-e 解码、实参保真；字面 echo 行为不变（精确重建同旧 join）；printf 分支零改动
- 重定向写面/管道喂入两处判定同步收紧（\xHH 载荷从放行转 fail-closed 拦）
- 拦截面收严 = 修逃逸（非收严误伤）；放行面（字面/旗标/中后部 - 词）经 11 用例钉不误伤

## 验证

- **拦截侧**（5 用例）：\xHH 主诉、\0nnn 八进制、管道喂入、\c 截断、白名单内转义载荷（\n 拼接）——全 BLOCK/拦
- **放行侧**（11 用例）：纯字面、-n、中后部 -e、无 -e 字面转义、-E 字面、--、-x 归实参、多空格、空参、printf 回归 2——全 ALLOW
- **拼写变体矩阵**（派工纪律 fact 84708931）：-ne/-en 组合、-e -E（E 赢字面放行）、-E -e（e 赢解码拦）、双引号同语义、printf S2 回归——全覆盖钉死
- write-target-evaluator 171/171 绿；全量 410 files 6575 passed + 6 skipped 零失败（首跑 cursor-zero-guard 1 例 5s 超时红系 M-d39f3327 flake 族——隔离复跑 9/9 绿 + 二次全量零失败交叉实证）
- 全等语义对齐探针（bash 3.2 实测）：\x41→A、\0101→A、foo -e 保参、-- 保参、e/E 覆盖序、-en 组合、\uHHHH 字面——文档「问题」节表格

## 活体旁证（开发途中实录）

开发期间守卫把 echo 语义探针命令（`bash -c "echo -e 'a\ub041c'"`）按「写命令落点解析到主仓」误拦——echo 形态是守卫敏感面的同族旁证（误拦侧，非本 PR 修面，归误拦台账）。

## 残余记档

- echo 旗标还有 POSIX xpg_echo 环境差异（SHELLOPTS xpg_echo 下无 -e 也解码）——判定按 bash 默认口径（bash -c 单测实测基线），xpg_echo 场景罕见不入本单
- printf 分支的「选项位歧义 → null」口径与 echo 的「前导旗标解析」不同（bash printf 支持 -- 终止符而 echo 不支持）——两族语义差异属实测事实，各自忠实实现，非口径漂移
