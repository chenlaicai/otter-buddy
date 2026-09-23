---
id: F20260922gpqa
title: bash 守卫引号感知修复（#852）：bash/sh -c 引号载荷内第二位起词元检测
change_type: fix
status: implemented
created: 2026-09-22
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules:
  - src/frameworks/agent/bash-safety-guard.ts
  - src/frameworks/agent/kill-segment-finder.ts
  - tests/frameworks/agent/bash-safety-guard.test.ts
intent:
  problem: '纵深防御的 kill 检测层对引号包裹的 bash/sh -c 载荷内第二位起的词元整层失效——KILL_COMMANDS 右支要求词元紧邻 -c，innerPkill 的 [^|;&]* 被引号内 shell 操作符（;）截断，bash -c "sleep 1; <词元> …" 形态只剩分段层兜底（分段按 ; 切开后该层恰好能兜住，但单层失效违背纵深防御各层独立正确的原则）'
  expected_effect: '引号载荷被提取并按子命令递归检测：词元在引号内任意位置均可识别（含嵌套 bash -c）；无词元载荷不误伤；存量 197 用例零回归'
  verify_by:
    type: capability_test
    note: tests/frameworks/agent/bash-safety-guard.test.ts 新增 6 用例锁定（含修复前正则层回退 MISS 证据），vitest 自动断言
summary: '#852（PR #850 检视发现 4 延后项）：findKillSegments 对引号包裹的 bash/sh -c 载荷新增 extractDashCPayloads 提取 + 递归子命令检测——修复前 KILL_COMMANDS 右支与 innerPkill 对引号内第二位起的词元双双失效（正则层探针实证 MISS×3），修复后词元在引号内任意位置（含嵌套）均可识别。'
tags: [bash-guard, security, defense-in-depth]
capability_test: tests/frameworks/agent/bash-safety-guard.test.ts
from: [F20260903gh698]
---

# F20260922gpqa bash 守卫引号感知修复（#852）

## 问题

#852（PR #850 检视建议发现 4）：`findKillSegments` 的 kill 检测对引号包裹的 `bash -c` 参数存在整层失效：

- `KILL_COMMANDS` 右支（:44）要求词元紧邻 `-c`——词元在引号内第二位起（`bash -c 'sleep 1; <词元>'`）不匹配
- `innerPkill` 正则（:258）的 `[^|;&]*` 被引号内 `;` 截断——同样只覆盖首位词元
- 修复前正则层探针实证：`bash -c 'sleep 1; pkill -f x'`、`bash -c "cd /tmp; killall node"`、`bash -c 'cd /tmp; kill <pid>'` 三形态全 MISS（对照首位形态 HIT）

**不构成现网安全漏洞**（issue 原文已判）：分段层按 `;` 切开后第二位词元落在新段段首，主支路径能兜住——本 issue 修的是纵深防御的层独立性（每层应独立正确，不能依赖恰好存在的下游兜底）。

## 修复

`findKillSegments` 新增第三分支：段不匹配 PKILL/KILL 主支时，用 `extractDashCPayloads` 提取 bash/sh -c 的引号包裹载荷（单/双引号各一），递归按子命令跑 `findKillSegments`——词元在载荷内任意位置（含嵌套 bash -c）均识别。段文本保留外层段（拦截日志/语义判定单位不变）。

## 设计取舍

机制识别检查点逐项核对：无新增数据结构（局部函数）、无新触发链（在既有检测函数内分支）、无绕过既有保护（反向：补回失效层）、无并行机制——既有语义内修（narrow-fix），不涉净新增机制。

取舍：选「载荷提取+递归」而非「放宽正则」——正则内嵌引号配对（`(?:'[^']*'|"[^"]*")` 内再允许操作符）会让 KILL_COMMANDS 主支复杂度失控，且嵌套形态仍需递归；提取函数 12 行、语义直白、测试直接驱动真实守卫函数。

取舍 2（实现中发现）：bash-safety-guard.ts 基线恰满 eslint max-lines 450 上限，修复净增必超——将 KILL/PKILL 词元目录 + 命令位置判定链（isKillAtCommandPosition/stripCommandPrefixes）+ findKillSegments 整组迁至 kill-segment-finder.ts（语义零变更纯搬迁 + 本修复的新分支），主文件 658 行回落至上限内。选整组迁出而非只迁 findKillSegments：后者对私有依赖（常量+位置判定）有循环依赖，整组自包含无环。

已知边界：引号不匹配/转义引号（`\'`）的畸形输入按不提取处理（保守放行给下游分段层）——畸形 shell 本身不可执行，非攻击面。

## 验证

- 新增 6 用例全绿，存量 197 用例零回归（203/203）
- 修复前回退证据：正则层探针实证三攻击形态 MISS（probe 文件跑后即删，证据见本记录与 PR 描述）
- 修复后探针驱动真实 `checkBashCommandSafety` 10/10 符合预期（含嵌套 bash -c、sh -c、非主 PID 字面量放行、无词元载荷放行）
- 已过最简检查：extractDashCPayloads 12 行 + 递归调用 6 行，无更简形态（正则单表达式方案复杂度倒挂）
- 负面向：本次变更无旧契约破坏——放行面不变（无词元载荷仍放行），只新增拦截面（此前漏拦的攻击形态）
- Golden Gate: n/a（verify_by=capability_test 已由 vitest 用例自动断言，无 LLM 场景）

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 大獭
