---
id: F20261008cphr
title: "bash 守卫 cat 管道 heredoc 逃逸收口：负门/通道双基座扩管道右段解释器识别（#1308）"
summary: "cat <<'PY' | python3 - 形态下守卫负门（cd 豁免 veto）与通道正则（无 cd 形态）均不识别——管道右段解释器在 `<<` 定界符之后，两套判定基座都只看 `<<` 之前。修复：heredocHeaderIsInterpreter 扩「管道右段解释器识别」（负门/体只读判定双消费同基座）+ MAIN_WRITE_PATTERNS 新增 cat 管道通道 2 条（无 cd 形态，豁免同 pattern[0] 吃 heredocReadOnly）。"
change_type: fix
capability_test: "tests/capability/ n/a: bash 守卫判定的纯代码逻辑单测（532+15 用例覆盖），非 prompt 行为面"
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
causal_links:
  - "#1308（issue）"
  - "#1240 / F20261006c1240（负门引入——本单扩其识别形态）"
  - "#1304 / F20261008h304（数据体剥除基座——cat 体语义归属的姊妹判定）"
  - "docs/designs/bash-guard-constitution.md（守卫宪法——本单挂 L3 主仓写层）"
tags: [bash-guard, heredoc, cd-exemption, security, pipe]
modules:
  - src/frameworks/agent/bash-safety-guard.ts
  - tests/frameworks/agent/bash-safety-guard.test.ts
intent:
  problem: "cat 管道 heredoc（cat <<'PY' | python3 -）体写主仓绝对路径端到端放行——负门与通道正则均不识别管道右段解释器"
  expected_effect: "cd+cat 管道与无 cd 裸 cat 管道两形态下体写主仓 → 拦截；纯读探查/写非主仓/tee 数据体不误拦；python 直连负门不回归"
  verify_by:
    type: behavior_check
---

# F20261008cphr cat 管道 heredoc 逃逸收口（#1308）

## 背景

issue #1308（P2，PR #1301 检视 r1 发现 2）：`cd /tmp && cat <<'PY' | python3 -` + 体内 `open('<repo>/data/x','w')` 形态端到端放行。根因：负门 `scriptHeredocAbsPathsInsideMain` 的段语义 `heredocHeaderIsInterpreter` 取 `<<` **之前**的最后一段——cat 管道形态下是 `cat`（非解释器）→ 负门不触发 → cd 豁免放行。

排查另发现 **issue 未描述的第二逃逸面**：无 cd 裸跑 `cat <<'PY' | python3 -` 时，通道正则 MAIN_WRITE_PATTERNS[1]（python heredoc patch 通道）要求 python 在 `<<` **之前**（`python[\d.]*\s+-\s*<<`），右段 python 不命中 → 无 cd 形态下整族漏。

探针实证（修复前，projectRoot=主仓根模拟生产）：

| 场景 | 修复前 |
|---|---|
| A：cd /tmp + cat 管道 + abs 写主仓 | ALLOW（洞） |
| B：无 cd 裸 cat 管道 + abs 写主仓 | ALLOW（洞，issue 未提） |
| C：cd + cat 管道 + 纯读主仓 | ALLOW（正道，须保持） |
| D：cd + python 直连 heredoc + abs 写主仓 | BLOCK（#1240 负门对照，完好） |
| E：cat 管道 + 写 /tmp | ALLOW（正道，须保持） |

## 根因

两套判定基座同源缺陷：
1. **负门基座**（`heredocHeaderIsInterpreter`，bash-safety-guard.ts:1558）：只判 `<<` 前最后一段。cat 管道形态解释器在 `<<` 后的右段 → 不识别 → 负门 false → `cdExemptionWithVeto` 直接放行
2. **通道基座**（MAIN_WRITE_PATTERNS[1]）：正则要求 `python - <<` 邻接形态。`cat <<PY | python3 -` 的 python 在定界符后 → 不命中 → 无 cd 形态下无任何防线

机制注意：V2 模型判定（modelCdExemption）里管道在第二段内部（cd 段下游 joiner=&&），不杀豁免——与 V1 hasRealCdSegment 的「管道杀豁免」语义不同，这正是 A 场景的放行机制链。

## 修复设计

**Modification-Class：narrow-fix**（既有负门/通道语义不变，扩识别形态）。

1. **负门/体判定基座扩管道右段识别**（`heredocHeaderIsInterpreter`）：`<<` 后同头行剩余部分按真管道（`\|\|` 非管道）切分，跳过定界符域（段 0），任一右段段首（跳 wrapper 词，复用 heredocInterpreter）是 python/node → 按解释器体判定。多级管道（`cat | grep | python3 -`）循环判定每个右段。单函数扩展，负门（拦截）与体只读判定（豁免）双消费同基座——对齐 #1285/#1310 确立的「拦截与豁免同一基座」原则。
2. **通道正则新增 2 条**（MAIN_WRITE_PATTERNS[5]/[6]）：`<<DELIM | (wrapper)* python -` / node 同型。仅认紧邻单管道（lookaround 排除 `||`）；左段词表不限（右段解释器才是执行面锚）；豁免同 pattern[0] 吃 heredocReadOnly（纯读体放行，与 python 直连同口径）。

### 机制判定四问（步骤 3 前置判定）

- 命中机制识别清单？**否**——不新增独立机制，是既有负门（#1240）与通道（#1038）的形态识别扩展。声明值 narrow-fix。
- ①谁需要：守卫判定面（负门/通道）需要看见管道右段解释器，与 python 直连形态同权。
- ②失败后果：cat 管道形态写主仓端到端放行（A/B 探针实证）。
- ③后续机制：无后续依赖。tee/grep 等数据通道右段不命中（体不执行，语义归 #1304 数据体剥除）——两判定正交，不互相依赖。
- ④退役条件：负门/通道基座若统一重构（宪法「退役条件」），管道右段识别随基座退役。

## 验证

- **失败证据链**：修复前探针 A/B ALLOW（本文档「背景」节表格，探针脚本 /tmp/probe2-1308.mjs，projectRoot=主仓根）。
- **修复后**：同探针 A/B → BLOCK；C/E 放行面保持；D 对照不回归。15 条 #1308 用例全绿（拦截 8 + 放行 4 + 回归 1 + 反转声明面 1 + 相对路径拦截 1）。
- **全量**：5049/5049 绿（335 文件），lint 0 error，tsc exit 0。
- **声明面反转**：#1240-r1 的「cat 管道当前放行」声明面用例（tests/...test.ts:2681）反转为拦截——洞已修，声明面随之更新（新用例注明反转来源）。
- 已过最简实现检查：单函数扩展 + 2 条正则，无新文件/新依赖/新机制。

## Known Limitations

- 多级管道中段带数据变换词（如 `grep -v | python3 -`）：负门路径已覆盖（右段循环判定），通道路径的正则只认紧邻单管道——多级形态的拦截由负门（cd 形态）承担，无 cd 多级形态不在通道覆盖内（负门不适用无 cd）。探针 B 变体（无 cd + grep 中段）未覆盖——保守记录，攻击面极窄（多级管道+无 cd+恰好绕过负门形态组合）。
- 动态路径拼接（os.environ 组合）不触发负门（无绝对路径字面量）——#1309 范围，本单不修。
