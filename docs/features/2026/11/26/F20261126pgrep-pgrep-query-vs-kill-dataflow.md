---
id: F20261126pgrep
title: pgrep 被 self_kill_byname 误判为 pkill（纯查询 vs pgrep→kill 数据流分离）
summary: 从 PKILL_COMMANDS 移除 pgrep（纯查询放行），并在 psgrep 通道模板机加 pgrep 子串签名识别（对齐 pkill 子串口径），保住 kill $(pgrep 主进程) 及其 flag 变体的数据流拦截，等价 pkill 改写不被绕过。
change_type: bugfix
tags: [guard, self_kill, kill, pgrep, fail-open, replay]
modules: [src/frameworks/agent/kill-segment-finder.ts, src/frameworks/agent/psgrep-token-scan.ts]
created_at: 2026-11-26
intent:
  problem: "PKILL_COMMANDS 误含 pgrep，把纯查询 `pgrep -f \"connector/main.js\" | head` 当 pkill 按名匹配误拦（healing 49a9b0c7）。"
  expected_effect: "pgrep 纯查询（无 kill 主体）放行；`kill $(pgrep -f 主签名)` 及其 -fl/--full/sudo 变体的 pgrep→kill 数据流仍拦，对齐 pkill 子串口径（等价改写不绕过）。"
  verify_by:
    type: static_only
    evidence:
      - "npx vitest run tests/guard/replay/replay.test.ts：261 全绿（49a9b0c7 转绿 + pgrep/xargs 回归钉含带参短旗标、带参长选项独立 --xxx V 与粘连 --xxx=X 形态，探针实测）。"
capability_test: "n/a: 纯命令判定器静态回放，无 LLM 场景"
---

# pgrep 被 self_kill_byname 误判为 pkill（纯查询 vs pgrep→kill 数据流分离）

## 问题与范围

回放样本 `tests/guard/replay/cases-2026-10-29.ts` 的 `healing 49a9b0c7`（2026-11-25 日报实录）：`pgrep -f "connector/main.js" | head -5` 被 `self_kill_byname` 误拦（expect allow / 实际 block）。

pgrep 是「查询进程 PID」非「杀进程」；把它当 pkill 按名匹配判定，纯查询被误拦，诱导改用 ps 等绕行写法。

## 根因

`src/frameworks/agent/kill-segment-finder.ts:15` 的 `PKILL_COMMANDS` 正则 `(?:pkill|pgrep|killall|killall5)` 误含 `pgrep`。`findKillSegments` → `matchKillAtPosition` 先查 PKILL_COMMANDS，命中 pgrep 即标记 `isPkill=true`，随后 `checkOneKillSegment` 走 `k.isPkill` 分支 → `pkillTargetsOtter` 按名匹配 → 拦。

## 修复

1. `kill-segment-finder.ts`：`PKILL_COMMANDS` 移除 `pgrep`——纯 pgrep 查询不再进 kill 判定。
2. `psgrep-token-scan.ts`：模板机加 `pgrepMatchesMain`（pgrep argv 文字含 `PKILL_OTTER_PATTERNS` 子串族即命中，对齐 pkill 子串口径）+ `templateStep` 的 pgrep 首命令分支（含 sudo 前缀）。`kill $(pgrep -f "dist/src/main.js")` 走 `directExpansionFeedsKill` → `wordExpansionScansMain($(pgrep…))` → 模板机识别 pgrep 子串签名 → 仍拦。
3. 链尾 xargs 带参 flag 跳参（delta 发现 5 收口）：`isChainTerminator` 与 `stripCommandPrefixes` 按 xargs 语义跳过带参短旗标（`-d`/`-E`/`-I`/`-n`/`-a`/`-L`/`-P`/`-s`/`-e`）与带参长选项（`--arg-file`/`--delimiter`/`--eof`/`--replace`/`--max-lines`/`--max-args`/`--max-procs`/`--max-chars`）及其参数——`pgrep -f X | xargs -d '\n' kill`、`xargs --delimiter '\n' kill` 由漏拦转拦。无参 flag（`-r`/`--no-run-if-empty`）与粘连（`-d'\n'`/`-n1`/`-I{}`）维持原跳。两处带参 flag 口径一致（psgrep-token-scan 的 `XARGS_FLAGS_WITH_ARG`/`XARGS_LONG_WITH_ARG` Set 与 kill-segment-finder 的 `XARGS_FLAG_WITH_ARG`/`XARGS_LONG_WITH_ARG` 正则同族，注释互引）。
4. 链尾 xargs 长选项粘连形态（delta 发现 5 最终收口）：`--delimiter=X` 整 token 形态的 kill 段定位——`KILL_COMMANDS` 正则的赋值前缀组 `[A-Za-z_]\w*=\S+` 会从 `--delimiter` 内部 'd' 位起贪婪匹配 `delimiter="\n" `，把命令位 kill 消费进单个数据位 match（isKillAtCommandPosition 判 prev=`-` 非白名单 → continue → kill 已消费无从定位）。赋值前缀组加负向后顾 `(?<!-)` 锚定 token 边界（不从 flag 名中间起匹配）后，`xargs --delimiter="\n" kill` 的 kill 段恢复定位——粘连（`--xxx=X`）、独立（`--xxx V`）、组合（`-r --delimiter=X`）三形态均拦，参数值恰为 kill（`--delimiter=kill echo`）不误拦。

## 安全语义（关键，不做简单移除）

若只移除 pgrep 不补数据流识别，`kill $(pgrep -f "dist/src/main.js")` 会漏拦：pgrep 段不再进判定后，kill 段非字面量目标走政策 A「确认不了≠拦」放行。故「查询」与「查询→kill 数据流」必须分离——纯查询放行、数据流拦截。

回收面口径对齐 pkill（`PKILL_OTTER_PATTERNS` 子串族）：pgrep 与 pkill 同为「按名匹配进程命令行」语义，`pkill -f X` 拦 ⇒ 等价 `pgrep -f X | xargs kill` / `kill $(pgrep -f X)` 必拦，否则一句话改写即可绕过 pkill 拦截。pgrep 的 flag 枚举形态（-f / -fl / --full / sudo 前缀）由 argv 文字子串统一覆盖。

## 验证

`npx vitest run tests/guard/replay/replay.test.ts`（261 全绿）：

- `pgrep -f "connector/main.js" | head -5` → allow（49a9b0c7 转绿）。
- `kill $(pgrep -f "dist/src/main.js")` → block（数据流不退化）。
- `pgrep -f "dist/src/main.js"`（纯查询主进程）→ allow。
- `pgrep -f "connector/main.js" | xargs kill` → block（对齐 pkill 子串口径）。
- `kill $(pgrep -fl/--full "dist/src/main.js")` / `kill $(sudo pgrep -f ...)` → block（flag 变体）。
- `pgrep -f "some-unrelated-proc" | xargs kill` → allow（非 otter 特征不误拦）。
- 短旗标带参：`xargs -d "\\n" kill` / `-I {} kill` / `-n 1 kill` → block（delta 发现 5）。
- 长选项独立：`xargs --delimiter "\\n" kill` / `--replace X kill` / `--arg-file X kill` / `--eof END kill` / `--max-lines X kill` → block（delta 发现 5 收口）。
- 长选项粘连：`xargs --delimiter="\\n" kill` / `--replace=X kill` → block；组合 `xargs -r --delimiter=X kill` → block（delta 发现 5 最终收口）。
- 防误伤：`xargs -d "\\n" echo` / `-d kill echo` / `--delimiter "\\n" echo` / `--delimiter kill echo` / `--delimiter=X echo` / `--delimiter=kill echo` → allow（带参 flag 非 kill 目标不误拦，独立与粘连均验证）。
- `pkill -f "dist/src/connector/main.js"` 等 pkill 负门 → block 不退化。
- 全量 `npx vitest run`：7049 全绿（553 文件）。
- 回归钉共 30 条（纯查询放行 ×2 / 数据流拦 ×4 / 非 otter 放行 ×1 / 子串主签名拦 ×1 / xargs 短旗标变体拦 ×7 / 长选项独立拦 ×5 / 长选项粘连拦 ×2 / 组合拦 ×1 / 非 kill 放行 ×7）。

## 覆盖差异披露（收窄前后）

- 旧守卫（pgrep 入 PKILL_COMMANDS）：任何含 `pgrep` 的命令若 argv 命中 `PKILL_OTTER_PATTERNS` 子串即被按 pkill 拦——纯查询与数据流一并拦（歪打正着覆盖数据流，但纯查询误拦）。
- 新守卫（pgrep 出 PKILL_COMMANDS + psgrep 通道回收）：纯 pgrep 查询放行；「pgrep → kill」数据流由 psgrep 通道按同一张 `PKILL_OTTER_PATTERNS` 子串族回收。回收面覆盖 pgrep argv 文字含子串的形态（-f/-fl/--full/sudo 前缀均覆盖）+ 链尾 xargs 带 flag 形态（无参 `-r`/`-n1`/`--no-run-if-empty`、带参短旗标 `-d`/`-n`/`-I`/`-E`/`-a`/`-L`/`-P`/`-s`/`-e`、带参长选项 `--delimiter`/`--replace`/`--arg-file`/`--eof`/`--max-*`，独立 `--xxx V` 与粘连 `--xxx=X` 两种形态均有探针覆盖），带参 flag 的参数不会误当链尾命令名；非 otter 特征（argv 不含任何子串）的 pgrep→kill 数据流放行（政策 A 确认不了域，与 pkill 子串口径一致）。
- 已知边界（链首 wrapper 带参数，本次未扩）：`kill $(timeout 5 pgrep -f 主签名)`、`kill $(env VAR=x pgrep -f 主签名)` 等「wrapper 带参数 + pgrep」链首形态，findPgrepIndex 只跳 wrapper 词本身（sudo/env/timeout/nice/command 直跟 pgrep），不跳 wrapper 参数（时长/赋值），数据流仍放行。属政策 A 确认不了域，与 ps 通道的 `sudo ps` 链首边界同类（大獭裁决本次范围限定链尾 xargs）。

## Rollback

Revert 本切片即恢复 pgrep 入 PKILL_COMMANDS（回到误拦纯查询 + 歪打正着拦数据流的旧态），不影响守卫其它实现。