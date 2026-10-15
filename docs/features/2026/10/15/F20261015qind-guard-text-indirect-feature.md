---
id: F20261015qind
title: bash 守卫文本提及误拦修复——引号内间接特征脱敏
summary: issue #1494 修复——「脚本名 × 引号内 $VAR」文本形态（如 echo "otter-buddy.sh $S 被拦"）被 checkServiceScriptKill 形态 2 误拦；根因是形态 2 在脱敏后的文本上跑，而 sanitizeQuotedText 只替换敏感词元、保留 $ 间接特征；修复方式：checkServiceScriptKill 改在「词元脱敏 + 引号内 $ 特征一并替换」的文本上判定。
change_type: fix
capability_test: tests/frameworks/agent/bash-safety-guard.test.ts
created_in_conversation: 0d48b657-825d-46d5-bae1-6e13fc0fac7f
intent:
  problem: "issue #1494：bash 守卫对 otter-buddy.sh 一刀切拦截的残留形态——字面只读子命令（status/--help/logs）已放行（现行 SCRIPT_PATH_EXTRACT 只捕获 stop/restart），但「脚本引用 × 引号内变量特征」的纯文本形态（echo/write --body/heredoc 载荷）仍被形态 2 保守拦截。#858（F20260914ectx）引入的 sanitizeQuotedText 只替换引号内敏感词元（kill 等），保留 $ 间接特征，导致 checkServiceScriptKill 形态 2 在脱敏文本上仍命中误拦。"
  expected_effect: "文本形态（引号内提及脚本名 + 引号内变量）放行；真实间接执行形态（引号外变量/命令替换 + 脚本引用）仍拦；字面 stop/restart 拦截面不变；bash <file> 全局规则不变（案发现场第 2 条 shift-repro.sh 被拦是该规则的绕过面防护，不在本特性收窄）。"
  verify_by:
    type: behavior_check
tags: [guard, false-positive, bash-safety]
modules: [src/frameworks/agent/bash-safety-guard.ts, src/frameworks/agent/quoted-text-sanitizer.ts, tests/frameworks/agent/bash-safety-guard.test.ts]
causal_links:
  - https://github.com/chenlaicai/otter-buddy/issues/1494
---

# bash 守卫文本提及误拦修复——引号内间接特征脱敏

## 问题现象

issue #1494（案发现场实录见 issue body）：

- `S=status && echo "otter-buddy.sh $S 被拦"` → 拦（形态 2：脚本引用 × `$` 间接特征）
- heredoc 载荷文本提及脚本名 → 拦（同族）
- 前世（10/14）遭遇的「3 种写法全拦」中，前两种（`bash -x script.sh` / `bash ./repro.sh`）命中的是「bash 从文件读脚本执行一律拦」全局规则（绕过面防护，正确行为），第三种 `./scripts/otter-buddy.sh status` 当时被拦、**现行代码已放行**（SCRIPT_PATH_EXTRACT 只捕获 stop|restart 子命令，见 bash-safety-guard.ts:242 注释「start/status/logs 不拦」）。

## 排查结论（10/15 实证，tsx 探针复现）

| 形态 | 现行行为 | 期望 | 判定 |
|---|---|---|---|
| `./scripts/otter-buddy.sh status` | ALLOW | ALLOW | ✅ 已修复（历史收窄） |
| `./scripts/otter-buddy.sh stop` | BLOCK | BLOCK | ✅ 真实拦截面 |
| `S=stop && scripts/otter-buddy.sh $S` | BLOCK | BLOCK | ✅ 真间接执行，保守拦正确 |
| `S=status && echo "otter-buddy.sh $S 被拦"` | BLOCK | **ALLOW** | ❌ 文本形态误拦（本特性修复） |
| `grep -rn otter-buddy.sh README.md` | ALLOW | ALLOW | ✅ |
| `cat scripts/otter-buddy.sh \| grep x` | ALLOW | ALLOW | ✅ |
| `bash ./shift-repro.sh status` | BLOCK | BLOCK | ✅ bash<file> 绕过面防护（不收窄） |

唯一残留误拦 = **形态 2（SCRIPT_REFERENCE × INDIRECT_CALL_FEATURE）对引号内 `$` 特征无豁免**。

### 根因

`checkBashCommandSafety` 主入口（bash-safety-guard.ts:2075）先走 `checkSanitizedPath`——`sanitizeQuotedText`（quoted-text-sanitizer.ts:251）只把引号内**敏感词元**（kill/pkill 等）替换为等长 X，`$` 与变量名保留。脱敏文本经 `checkServiceScriptKill` 时 `SCRIPT_REFERENCE` 不命中（词元已抹）→ 但 `INDIRECT_CALL_FEATURE = /\$[{({A-Za-z_]|`/`（bash-safety-guard.ts:246）仍命中引号内残留的 `$S`——sanitized 路径不返回 null，落回原文本路径，形态 2 在原文本命中「脚本名 × `$`」拦截。

实测证据：`sanitizeQuotedText('S=status && echo "otter-buddy.sh $S 被拦"')` → `S=status && echo "XXXXXXXXXXXXXX $S 被拦"`——词元已抹、间接特征残留。

## 方案设计

在 quoted-text-sanitizer.ts 新增「脱敏+间接特征抹除」变体，checkServiceScriptKill 改在该变体文本上判定：

1. **新增 `sanitizeQuotedTextWithIndirectFeatures(command)`**：在 sanitizeQuotedText 结果基础上，把**引号段内**的 `$VAR` / `${VAR}` / `$(...)` / 反引号替换为等长 X。引号外特征零触碰。
   - 实现路径：复用 SINGLE_QUOTED_TEXT / DOUBLE_QUOTED_TEXT 分段逻辑，段内先 sanitizeSegment 再抹间接特征。
   - 危险通道哲学对齐 sanitizeQuotedText：SHELL_PAYLOAD_CHANNEL（bash -c / heredoc / 反引号通道）命中时不处理——载荷内引号是代码不是数据。

2. **checkServiceScriptKill 判定基文本替换**：
   - 形态 1（SCRIPT_PATH_EXTRACT，stop/restart 字面）保持原文本判定——字面 stop/restart 无引号包裹歧义问题（引号内 "stop" 字样不触发，因正则要求命令位前导）。
   - 形态 2 改在新变体文本上跑：`SCRIPT_REFERENCE.test(sanitized) && INDIRECT_CALL_FEATURE.test(sanitized)`。
   - 调用点同步：checkBashCommandSafety 主路径、checkBashCommandSafetyOnText、checkWhenMainPidMissing 三处统一。

### 安全性论证

- **逃逸面核查**：`otter-buddy.sh "$S"`（引号外脚本名 + 引号内变量）——sanitizeQuotedText 只处理引号段，脚本名在引号外仍被 SCRIPT_REFERENCE 命中；`"$S"` 在引号内被抹。此形态是否放行？——**是**。论证：`otter-buddy.sh "$S"` 中 `$S` 是真实执行的子命令参数，抹除后放行了真风险！**否决此形态放行**：必须只抹「脚本名也在引号内」的形态。
  
  修正：**分段抹除的豁免条件**——若脚本名（SCRIPT_REFERENCE 命中点）在引号外，则该命令不脱敏（引号内 $ 特征保留，形态 2 仍拦）。即：仅当**脚本名本身位于引号段内**时，同段/其他段的 `$` 特征才抹除；脚本名在引号外（真实执行意图）时保持原文本判定。这样：
  - `echo "otter-buddy.sh $S"` → 脚本名在引号内 → 抹 $ → 放行 ✅
  - `otter-buddy.sh "$S"` → 脚本名在引号外 → 不抹 → 拦 ✅
  - `otter-buddy.sh $S` → 不抹 → 拦 ✅

- **绕过面核查**：攻击者能否把真危险命令伪装成「脚本名在引号内」？`echo "otter-buddy.sh" && otter-buddy.sh $S` ——第二段脚本名在引号外 → 不抹 → 拦 ✅。分段逐段判定，不按整条命令一票放行。

### 非目标

- bash <file> 全局规则收窄（issue 修复方向④的 tests/scripts 豁免边界）——绕过面防护，需独立特性评估（若有需求另立 issue）。
- 形态 1（字面 stop/restart）行为变更——保持现状。
- heredoc 载荷提及：现行 stripHeredocPayloads 已剥闭合 heredoc 体（F20260924gfpn），实证 heredoc 文本提及在绝对路径写下放行；相对路径写主仓被拦是主仓写规则（正确）。本特性不改 heredoc 处理。

## 影响范围

- src/frameworks/agent/quoted-text-sanitizer.ts：新增导出函数（纯增量）
- src/frameworks/agent/bash-safety-guard.ts：checkServiceScriptKill 判定基文本 + 注释
- tests/frameworks/agent/bash-safety-guard.test.ts：新增放行/拦截断言组

## 验证

1. `npx vitest run tests/frameworks/agent/bash-safety-guard.test.ts` 全绿（含新增用例）
2. 新增用例覆盖：引号内脚本名+引号内变量放行、引号外脚本名+引号内变量拦、纯文本 echo 放行、真间接执行拦、字面 stop/restart 拦
3. 相关守卫测试文件回归（bash-guard-false-positive-fix / heredoc-body-strip / layered-detect）
