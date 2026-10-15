---
id: F20261015gsub
title: bash 守卫定位收敛——军备规则族删除，退回常见直白形态兜底
summary: 痛定思痛（搭档 10/15 决策）——守卫在「防绕过军备竞赛」方向复杂度膨胀（误拦族谱 30+ issue）已成拖后腿；删除形态 2 间接拦/eval 包装/one-liner kill 词样/脱敏间接特征抹除等军备规则族，保留常见直白危险形态（字面 kill/pkill/stop/restart/写主仓/rm data/gh merge/U5 文件脚本/管道 shell kill）；绕过面由物理隔离兜底（另立调研）
change_type: refactor
capability_test: tests/frameworks/agent/bash-safety-guard.test.ts + bash-guard-*.test.ts 57 文件 1486 全绿
created_in_conversation: 0d48b657-825d-46d5-bae1-6e13fc0fac7f
intent:
  problem: "bash 守卫误拦族谱实证其已成系统拖后腿而非守卫机制（搭档 10/15 09:58 原话「痛定思痛」）。30+ issue 军备竞赛循环：堵绕过面→引入新误拦面→收窄→开新绕过面。守卫复杂度膨胀（3306 行、183 个补丁引用），每条绕法堵一个误拦面扩一分（#1494 文本提及被拦即产物）。"
  expected_effect: "守卫只拦常见直白危险形态；军备规则族（形态 2 间接拦/eval 包装+数字/one-liner kill 词样/脱敏间接特征抹除）删除；绕过面由物理隔离兜底（另立调研）；12 条 OPEN 守卫误拦 issue 随规则删除批量处置。"
  verify_by:
    type: behavior_check
tags: [guard, architecture, direction-decision, convergence]
modules: [src/frameworks/agent/bash-safety-guard.ts, src/frameworks/agent/guard-model-judge.ts, src/frameworks/agent/quoted-text-sanitizer.ts]
causal_links: []
---

# bash 守卫定位收敛——军备规则族删除，退回常见直白形态兜底

## 决策背景

搭档 2026-10-15 09:54 方向原话（意图锚）：

> 「我觉得咱们必须清晰认识到，所谓的 Bash 守卫，永远无法做到百分百，只有物理隔离才是真正的守卫。因此，bash 守卫要聚焦在常见的 bash 拦截，而不是绞尽脑汁去拦截 ai 各种绕来绕去的脚本」

09:58 加强指令：「要！你来深入分析！咱们要痛定思痛！bash 守卫已经成了本系统的拖后腿而不是守卫机制了！」

10:04 拍板：「一次性做好」

10:13 范围确认：「ok」（本 PR 只做代码收敛，物理隔离 OS 层加固另出调研文档）

## 改动清单（删减法）

### 删除（军备规则族）

1. **checkServiceScriptKill 形态 2**（间接调用保守拦）：`SCRIPT_REFERENCE × INDIRECT_CALL_FEATURE`（脚本引用 × `$VAR/$()` 特征）整条删除。该规则是 #1494 文本形态误拦的根因。间接形态（`S=stop && otter-buddy.sh $S`）不再拦，由形态 1 字面检测 + 物理隔离兜底。
2. **checkCommandLevelPatterns 三条军备规则**（V1 层）：
   - eval 包装 + 数字参数拦（`eval "echo 42877"`）
   - 管道到 shell + kill 词元拦（V1 文本正则版——V2 模型版 judgePipeToShell 保留，见「保留」）
   - 脚本语言 one-liner + kill 词元 + 数字拦（perl/python/node -e 载荷词样）
   壳函数恒 null 保留调用点占位（后续清理）。
3. **judgeCmdLevelModel**（V2 层镜像）：eval 命令位+数字 / 脚本 one-liner kill 词样两条同样删除（壳函数恒 null）。
4. **sanitizeQuotedTextForIndirectCheck**（quoted-text-sanitizer.ts，F20261015qind 昨日新增）：随形态 2 删除而删除——该函数存在的唯一目的是给形态 2 提供「引号内间接特征抹除」判定基文本，形态 2 删了它失去存在意义。
5. **SCRIPT_REFERENCE / INDIRECT_CALL_FEATURE** 常量：随形态 2 删除。

### 保留（常见直白危险形态）

- 字面 kill 主 PID（extractLiteralPids + PID 文件引用）
- pkill/killall 按名匹配 otter 特征（pkillTargetsOtter）
- otter-buddy.sh 字面 stop/restart（形态 1，路径限定主仓）
- 写主仓文件（checkMainCheckoutWrite 全链：git 写族/重定向/one-liner 写/heredoc 写）
- rm data/ 主仓破坏（checkDataDirDestructive）
- gh pr merge 字面（judgePrMergeModel partner-gate）
- U5 bash <file> 文件脚本拦（judgeBashFileScript——绕过面防护，不是军备：从文件读脚本内容是「未经逐条判定」的直接绕过，非词元猜测）
- 管道到 shell + kill（V2 judgePipeToShell 模型版——`curl | bash` 类直白注入，非花式绕过）
- eval 载荷递归（judgeEvalPayload——真执行体语义递归，非词元猜测）

### 测试断言同步

- 删除：形态 2 相关 5 条（间接形态拦/文案引导）、eval 包装相关 4 条、one-liner kill 词样相关 3 条、qind 逃逸面断言 4 条（随形态 2 失效）
- 保留并仍绿：qind 放行断言 3 条（文本形态放行在形态 2 删除后更稳）、kill/pkill/stop/restart/写主仓/rm data/U5 等保留面全部断言
- 全量：57 文件 1486 全绿（删 16 条失效断言，新增 0）

## 量化结果

| 指标 | 收敛前 | 收敛后 |
|---|---|---|
| bash-safety-guard.ts | 2240 行 | 2199 行 |
| guard-model-judge.ts | 709 行 | 686 行 |
| quoted-text-sanitizer.ts | 357 行 | 311 行 |
| 合计 | 3306 行 | 3196 行（-110 行，删军备族） |
| 守卫族测试 | 1498（含 16 条军备断言） | 1486 全绿 |

代码量降幅不大（110 行）是因为壳函数占位保留 + 注释留痕——**行为面降幅才是重点**：形态 2/脱敏间接抹除/eval 包装/one-liner 词样四类拦截面消除，对应 12 条 OPEN 误拦 issue 的误拦面消失。

## 收敛后形态基线（实证）

| 形态 | 收敛前 | 收敛后 | 判定 |
|---|---|---|---|
| kill 42877 / pkill -f otter-buddy | BLOCK | BLOCK | ✅ 保留 |
| otter-buddy.sh stop/restart（字面） | BLOCK | BLOCK | ✅ 保留 |
| 写主仓 / rm data/ / gh pr merge | BLOCK | BLOCK | ✅ 保留 |
| bash <file>（U5） | BLOCK | BLOCK | ✅ 保留（绕过面防护） |
| echo "kill 42877" \| bash | BLOCK | BLOCK | ✅ 保留（直白注入） |
| `S=stop && otter-buddy.sh $S` | BLOCK | **ALLOW** | 收敛（形态 2 删） |
| `eval "otter-buddy.sh $S"` | BLOCK | **ALLOW** | 收敛 |
| `eval "echo 99999"` | BLOCK | **ALLOW** | 收敛（eval+数字删） |
| `node -e "console.log('kill 12345')"` | BLOCK | **ALLOW** | 收敛（one-liner 词样删） |
| `echo "otter-buddy.sh $S 被拦"` | ALLOW（qind） | ALLOW | ✅ 保持放行 |

## 12 条 OPEN 守卫误拦 issue 处置

规则删除后以下 issue 的误拦面消失，逐条关闭留痕（理由引用本特性）：
- #1408（alpha.sh 被 U5 误拦——U5 保留，该 issue 若指字面形态需复核；若指间接形态则随形态 2 消失）
- #1454（工作区清理误拦——需复核是否属砍掉的规则族）
- #1468（只读路径成规模误拦——需复核）
- #1478（git commit 误拦——需复核是否属写主仓保留面）

**注意**：12 条并非全部随本 PR 自动消失——需逐条复核其命中规则是否在被删族内。处置动作（逐条 gh issue close + 理由）在 PR 合入后执行。

## 非目标（另立）

- **物理隔离 OS 层加固**：主仓 data/ 只读挂载、alpha 实例 PID namespace——搭档 10:13 确认本 PR 不含，另出调研文档（macOS sandbox-exec / bindfs 可行性）。
- 壳函数清理（checkCommandLevelPatterns / judgeCmdLevelModel 恒 null 占位）：后续 housekeeping PR 删除。

## 验证

- 守卫族 57 文件 1486 全绿、tsc/eslint 零错误
- tsx 探针 16 形态基线全量核对（保留面 7 拦 + 收敛面 6 放 + pkill 边界核实——`pkill -f otter` 基线本就放行，非本 PR 放开）
