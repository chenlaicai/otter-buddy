---
id: F20261021dqbx
title: bash 双引号反斜杠语义对齐——parseOnce 词法层根修（M-f89f1ff3）
summary: "command-lexer 双引号扫描对任意 \\X 一律走 evalEscape 丢反斜杠（\\' → '），与 bash 引用语义（双引号内反斜杠仅 $ ` \" \\ 换行五者前特殊，其余反斜杠字面保留两字符）错配——词法层丢字符即词义谎报，#1597 严重 2 单反斜杠假重建逃逸（attack/control 差分端到端 ALLOW）的真根因。修法=非特殊对归位 lit part（文本保原文两字符，evaluated=bash 真值），escape part 只留五符真转义（evalEscape 语义不动）；净 +3 代码行。治标闸 wordDivergesFromBash 随 part 归位自动降级纵深冗余（#1597 F20261021eche 记档承诺兑现）。全变体矩阵 11 用例（含尾反斜杠残留触发面回归钉）+ #1597 测试 4 处诚实翻转。"
capability_test: "n/a: 判定语义变更由单测钉死——command-lexer-dq-backslash 矩阵 11 例 + write-target-evaluator 186 例 + 全量 6606 passed（1 例 pre-existing 超时 flake 有基线铁证，M-d39f3327 台账）。golden 豁免声明（沿 #1318/#1377 先例，F20261014gvbx 对账口径）：本 PR 不涉 golden_replay 断言面，golden-results.jsonl 无本 PR 记录系按设计不落账而非漏跑，不计缺记录"
change_type: fix
intent:
  problem: "M-f89f1ff3：parseOnce 双引号内 \\X 丢反斜杠致词义与 bash 真值分歧——词法层丢字符是 #1597 严重 2 假重建逃逸（单反斜杠 \\' 吞命令结构端到端 ALLOW）的真根因，治标闸兜住 echo 内容面但 evalPath 落点词/路径词等非内容面仍错位"
  expected_effect: "双引号非特殊对（\\' \\n \\x \\0 \\; \\/ …）evaluated=原文两字符 bash 真值（修复前丢反斜杠）；五符特殊对（\\$ \\` \\\" \\\\ \\换行）与未引/单引上下文语义不变（反证矩阵钉死）；#1597 attack 形态端到端仍 fail-closed BLOCK 不回退"
  verify_by:
    type: capability_test
modules:
  - src/frameworks/agent/command-lexer.ts
from:
  - F20261021eche
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
doc_type: feature
tags: ["guard", "lexer", "bash-semantics", "backslash", "double-quote", "bugfix", "security"]
created_at: 2026-10-21T15:20:00+08:00
---

## 问题

**现象（#1597 严重 2，检视獭1597 attack/control 差分实锤）**：bash 双引号内反斜杠仅 `$` `` ` `` `"` `\` 换行五者前有特殊作用（POSIX/bash 引用语义），其余（`\'` `\a` `\x` `\n` `\;` …）反斜杠**字面保留两字符**。command-lexer 双引号扫描却把任意 `\X` 归 escape part，`evalEscape` 按「任意 \X → X」丢反斜杠——词法层丢字符，evaluated 词义与 bash 真值分歧：

```
源码  echo "a\'b"     bash 真值词 a\'b（4 字符 a \ ' b）    parseOnce 修复前 a'b（丢 \）
源码  echo -e "a\nb"  bash：词 a\nb → echo -e 解码 → a<LF>b  修复前：anb（谎报）
```

**危害链**（不止「词面微差」）：假重建把 `\'` 换成 `'` 制造假引号串吞命令结构 → 载荷递归判读读到无害内容 → 谎报 ALLOW，而 bash 实际落盘 `\'` 活命令结构（`;` 真分隔、touch 主仓真执行）——一条 `\'` 翻转守卫（#1597 attack 形态端到端 ALLOW 实证）。#1597 的治标闸（wordDivergesFromBash）兜住内容重建面，但 **evalPath 落点词/脚本路径词等非内容面仍错位**（如 `> "d\'ir/f.txt"` 落点错位 `d'ir/f.txt`）——根因在词法层，必须根修。

## 目标与非目标

- **目标**：command-lexer 双引号内反斜杠语义与 bash 对齐——非特殊对反斜杠字面保留，evaluated 恒等于 bash 真值；治标闸兑现「根修后自动降级纵深冗余」承诺（F20261021eche 记档）
- **非目标**：ANSI-C `$'...'` 转义族（检视獭1597 探针 5 实证 unknown part → fail-closed，另族）；echo decode 白名单语义（#1513 不军备化之尺不动）；未引/单引上下文 `\X` 语义（bash 正确，反证钉死不动）；词法层结构重构（max-lines 预算随缘，不动大手术）

## 方案设计（修法）

`command-lexer.ts` 双引号扫描分支（净 +3 代码行）：

| 项 | 内容 |
|---|---|
| 判据常量 | `DQ_BACKSLASH_SPECIAL = {$, `, ", \, 换行}`（bash 双引号反斜杠特殊对后随字符集） |
| 非特殊对 | `\X`（X 非五符且非尾部截断）→ **lit part**，文本=原文两字符 `\X`——反斜杠是字面量不是转义符，evaluated 自然得 bash 真值 |
| 五符特殊对 | `\X` → escape part **原样保留**，evalEscape 语义不动（`\$`→`$`、`\\`→`\`、`\`+换行→续行删除） |
| 尾部截断 `\` | nx 缺失仍走 escape 保守路径（evalEscape→空 + 治标闸兜住 fail-closed）——病态输入不放飞 |
| 两 case 合流 | slice 表达式同形 `text.slice(i, Math.min(i + 2, n))`，kind 只是 part 类型分派 |

**下游传导（全部自动跟随，零改动）**：evalWord 拼接 → bash 真值；evalPath 落点词 → 真值路径；guard-model-judge 词面尾部映射（:715 escape→去反斜杠、lit→原文）→ 真值；segmentStdoutContent 重建基座 → 真值；`wordDivergesFromBash` 治标闸（#1597）→ **判据恒不触发**（非特殊对不再产生双引号态 escape part）= 兑现「根修后降级纵深冗余」承诺，保留作纵深防御（尾部截断残余面）。

## 设计取舍

**设计面确认（模块切分/关键接口/核心数据结构）**：模块切分=仅双引号扫描分支；关键接口=WordPart/evaluated 契约不变（lit part 文本=原文片段，既有语义）；核心数据结构=PartType 枚举**不扩**——非特殊对从 escape **归位**为既有 lit 类型，非新增类型。路线唯一性由 M-f89f1ff3 派工「根修后治标闸自动降级纵深冗余」预期锁定（escape part 保留 + evalEscape 分派路线会让闸恒触发、降级承诺落空）。

**为什么 part 归位（lit）而不是 evalEscape 变 quoted-aware 分派**：
1. 语义诚实——bash 双引号内非特殊 `\` 就是字面量，lit 是它的真类型；escape 语义=「反斜杠有转义作用」，非特殊对根本不该是 escape
2. 降级承诺兑现——#1597 治标闸判据（escape part × 双引号态）随 part 归位自动恒不触发；分派路线闸恒触发，良性双引号转义造-执对永久保守拦
3. 全消费面统一受益——4 处 raw 视图（command-model:324 等）本就保真不受影响，evaluated 视图与 guard-model-judge:715 词面视图一起转真值，无需逐处修

**机制识别检查点（逐项机械判断）**：新增配置字段/枚举/开关——否（DQ_BACKSLASH_SPECIAL 是词法语义常量集非配置）；新增状态生命周期——否；新增定时任务/后台进程——否；新增信号类型/消息格式——否（PartType 枚举不扩）；新增持久化存储——否；新增决策分支（结果被记住并在后续影响行为）——否（纯解析分支即时消费）；新增跨模块调用路径——否（lex 内部，接口签名不变）。全否 → 修法决策树① narrow-fix（既有语义内修：实现对齐 bash 引用语义）。

## 影响范围

- **源码**：`src/frameworks/agent/command-lexer.ts` 双引号扫描分支（净 +3 代码行）；`write-target-evaluator.ts` 仅注释校准（治标闸降级说明）
- **语义变化面**：双引号非特殊 `\X` 的 evaluated 从 X 变 `\X`（修复本体）——下游 evalWord/evalPath/词面/重建基座全变真值；**#1597 测试 4 处诚实翻转**（3 个「分歧闸 → null」→ 精确重建 bash 真值；printf 造-执对 fail-closed → positive——重建转真值后递归判读直读到 `;` 真分隔 + touch 主仓写，比 fail-closed 更强）+ `\xHH` 变体标题校准（词求值后同字面已为真，兜住它的是 decode 白名单）
- **不回退面**（反证钉死）：未引 `\X`→X、单引纯字面、五符特殊对转义、#1597 attack 形态 fail-closed BLOCK、#1240/#1513 负门
- **测试**：新增 `command-lexer-dq-backslash.test.ts` 矩阵 11 例（含残留触发面回归钉）；全量 6606 passed + 6 skipped（1 例 pre-existing 超时 flake 见验证节基线铁证）

## 验证

**失败证据（bugfix Verification 硬规则）**——修复前实测输出（本 session 探针 + 修复轮首跑断言红）：

```
探针（修复前）: parseOnce(String.raw`echo "a\'b"`).words[1].evaluated = "a'b"     ← 丢反斜杠
                bash 真值（od 字节级）: "a\\'b"（a \ ' b 四字符）
修复轮首跑 4 断言红（根修前的真值语义断言）:
  expected 'it\\'s' to be null（echo "it\'s" 分歧闸 null 期望）
  expected 'a\nb' to be null（echo -e "a\nb"）
  expected 'a\\'b' to be null（printf %s "a\'b"）
  expected 'positive' to be 'fail-closed'（printf 造-执对）
```

**修复后输出**：矩阵 11/11 ✓；write-target-evaluator 186/186 ✓（4 断言翻转为真值语义）；command-model + stdin-feed 全绿；全量 411 files 6606 passed + 6 skipped。

**验收标准（机械断言）**：

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 非特殊对词义 | `npx vitest run tests/frameworks/agent/command-lexer-dq-backslash.test.ts` | 11 passed |
| 五符特殊对不变形 | 同上（「特殊对」用例） | `\$`→`$`、`\\`→`\`、`\`+LF→删，全过 |
| 反证（未引/单引不动） | 同上（「反证」2 用例） | 全过 |
| #1597 attack 不回退 | 同上（attack 用例）+ write-target-evaluator.test.ts | fail-closed BLOCK |
| 治标闸降级 | 同上（「治标闸降级」用例） | `echo "it\'s"` 精确重建非 null |
| 全量回归 | `npx vitest run` | 6606+ passed（flake 1 例见下，隔离复跑绿） |

**pre-existing 声明（硬门禁证据链）**：全量首跑 2 例 5s 超时类红（build-app 6873ms、cursor-zero-guard 5981ms）、二跑 1 例（cursor-zero-guard 5331ms）、隔离复跑 16/16 绿、**stash -u 干净基线（origin/main 状态）全量复跑同一例同款红（cursor-zero-guard ③ 6886ms）**——基线铁证 = pre-existing 并行负载超时 flake，M-d39f3327 台账族（该 matter 已等 2 天，正是此病）。

**最简实现检查**：已过最简阶梯——无新依赖/新函数/新类型（复用 lit/escape 既有类型 + 一个语义常量集），分支内条件表达式收编两类 part，净 +3 代码行；测试独立矩阵文件 10 例为收编族「全变体矩阵审视」交付面。确认已最简。

**负面向验收（刹车二：本次变更破坏了什么旧契约/绕过了什么既有保护）**：①旧契约变化=双引号非特殊 `\X` 的 evaluated 词义从 X 变 `\X`——这正是修复本体，但属公共词法层输出变化，下游全部跟随（影响面节已列）；②#1597 治标闸 3 个「分歧闸 → null」测试断言被翻转为精确重建——诚实翻转（闸降级为纵深冗余而非删除）；③未绕过任何既有保护：fail-closed 路径全保留（尾部截断、unknown part、decode 白名单外、#1240 heredoc 负门均不动）。

## 残余记档

- **ANSI-C `$'...'` 转义族**：lexer unknown part → fail-closed（检视獭1597 探针 5 双对照实证），转义语义另族治理，非本 PR
- **尾部截断 `\` 残余**：病态输入（未闭合引号+尾反斜杠）仍走 escape 保守路径，治标闸兜住 fail-closed——保留纵深，并已补直接回归钉（检视獭1600 建议 1：escape 单字符 part 断言 + segmentStdoutContent null 双断言）
- **echo decode 白名单外 fail-closed**：`\xHH` 等 bash echo -e 可解码的转义仍不重建（#1513 不军备化之尺，收窄口径 F20261021eche delta2 S2）——非本 PR
- **M-d39f3327 并行负载超时预算**：cursor-zero-guard ③ 在 411-worker 全量下贴线 5s 随机红（基线复现）——独立台账排期，本 PR 只记不修

## 本次变更对旧特性的说明

- **F20261021eche（#1597，已合入）**：其「残余记档」的解析层错配（`\'` 丢反斜杠）由本 PR 根修收口；「根修合入后本闸自动降级纵深冗余（判据恒不触发）」承诺兑现（非特殊对不再产生双引号态 escape part）；其 4 处测试断言随语义修复诚实翻转（本文档影响范围节列明）。F20261021eche 历史文档不回改，以本文档追加说明为准。
