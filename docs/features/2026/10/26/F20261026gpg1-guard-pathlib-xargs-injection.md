---
id: F20261026gpg1
title: 守卫绕过批次：pathlib 写族词面洗白洞收口 + xargs replace-str 注入等价类 + 探针补盲钉（M-a09944aa①②/M-3fc9962b/M-2ad7c58d）
summary: "三 matter 批次处置：基线探针先行（红证，origin/main@57edd41c 严格对照）。两个真活洞收口——①M-a09944aa①机理修正版：Path(lit).mkdir() 族词面证洗白洞（PAYLOAD_WRITE_FACE 缺 pathlib 写族方法名 → proveNoWrite 洗白 ALLOW；matter 字面主张在 #1611 后已半收口，真缺口是方法族）+ 提取通道同族归位 + 裸方法名族对齐（replace 因字符串方法 81 条误伤面排除）；②M-a09944aa② xargs replace-str 注入等价类挂 stdinShellFeederVeto 同尺（静态源拼接重建递归/不透明 fail-closed）。补盲钉死：B+0 实测无害确认、B+1 已被 #1611 收编、B+2 矩阵外形态 4 条进棘轮；M-2ad7c58d 两项实证处置（A 项已不成立/B 项疑点消解）。"
capability_test: "n/a: 判定语义由行为测试钉死——bash-guard-gpg1-fixes 18 例（① pathlib 词面/提取/变量接收者 4 + ② xargs 注入 7 + ③ B+0/B+1 补盲 5 + ④ M-2ad7c58d 核验 2）+ touchstone block 库 +4（87→91，corpus 冻结断言同步呈报）+ 全量 6874 passed 零失败。golden 豁免声明（沿 #1318/#1377 先例）：不涉 golden_replay 断言面"
change_type: fix
intent:
  problem: "M-a09944aa（#1611 delta 记档缺口批次）①python -c 载荷写提取白名单缺 mkdir ②xargs -i bash -c {} 注入上游内容为 -c 载荷漏放；M-3fc9962b 探针补盲（B+0 pypy3 单侧/curl|env python -c/B+1 sudo 长旗标/B+2 矩阵外形态纳棘轮）；M-2ad7c58d 求值器 gap（截断/引号不闭合 evaluated 空集口径、c091 ast.parse 疑似误判）。派工要求基线探针先行、按当前 main 复现不照旧开工、已修项给证据记档不重复造机制"
  expected_effect: "Path(lit).mkdir/rmdir/unlink/touch/rename/replace/symlink_to/hardlink_to 主仓落点全拦（修复前双版本 ALLOW）；变量接收者 p = Path(主仓).mkdir() 同拦（裸方法名族）；xargs -i/-I{}/--replace 注入形态静态有害拦/良性放/不透明 fail-closed（修复前全 ALLOW）；良性对照零回归（echo hi 注入/ls|xargs echo/树内相对路径写）；matter ③ env -P 不做（搭档单独点头边界保持）"
  verify_by:
    type: capability_test
modules:
  - src/frameworks/agent/bash-safety-guard.ts
  - src/frameworks/agent/write-word-face.ts
  - src/frameworks/agent/write-target-evaluator.ts
from:
  - F20261021pdex
  - F20261022vwfg
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
doc_type: feature
tags: ["guard", "pathlib", "xargs-injection", "whitewash-gate", "probe-blind-spot", "touchstone", "bugfix", "security"]
Modification-Class: narrow-fix
created_at: 2026-10-26T13:00:00+08:00
---

## 修法分类自评（Modification-Class）

**Modification-Class: narrow-fix**（修法决策树①：既有语义内修）——两个修复均是既有判定面的覆盖面补齐：①是 PAYLOAD_WRITE_FACE 词表族归位（write_text 先例同位扩词，无新机制）；②是 stdinShellFeederVeto 既有判定链的新形态归位（与 busybox 归位同先例，拼接重建复用 checkMainCheckoutWrite 既有基座）。机制识别七项全未命中：无新配置/生命周期/定时任务/信号/持久化/被记住的决策分支/跨模块调用路径。判定面收窄的唯一行为变化（变量接收者 p.mkdir() 相对路径从洗白 ALLOW 变回落拦）是保守向收窄非机制新增。

# 守卫绕过批次：pathlib 写族 + xargs 注入 + 探针补盲

## 背景与基线复现

三 matter 派工（大獭 2026-10-26），基线 57edd41c（含 #1636 gitdir 机制、#1611 resolveExecHead）。红证全部经 origin/main 严格对照（真 worktree @ 57edd41c 实测，非 stash 推断）。

### 基线矩阵（修复前 origin/main 实测）

| 形态 | 基线判 | 定性 |
|---|---|---|
| `python3 -c 'import os; os.mkdir("/repo/pwned")'` | BLOCK | matter ① 字面主张**已半收口**（#1611 SCRIPT_WRITE_TOKENS 含 os.mkdir——「提取白名单缺 mkdir」不成立于当前 main） |
| `python3 -c 'Path("/repo/pwned").mkdir()'` | **ALLOW** | **真活洞**（①机理修正版）：PAYLOAD_WRITE_FACE 只有 `Path(lit).write_text/write_bytes`，mkdir/rmdir/unlink/touch/rename 族缺 → proveNoWrite 洗白 |
| `python3 -c 'p = Path("/repo/pwned"); p.mkdir()'`（变量接收者） | **ALLOW** | **真活洞**：裸方法名族只有 writelines/truncate/unlink，mkdir/write_text/rmdir/touch/rename 缺 |
| `echo "mkdir -p /repo/x" \| xargs -i bash -c {}` | **ALLOW** | **真活洞**（②）：三处盲——stdinShellKind 判 other（{} 非 stdin 中继）/ 求值器把 {} 当无写字面量 / proveNoWrite 洗白 |
| `echo "/repo/x" \| xargs -i bash -c 'mkdir -p {}'`（模板） | **ALLOW** | **真活洞**（②第二形态）：占位符在模板内，上游路径注入 |
| `curl \| xargs -i bash -c {}`（不透明源） | **ALLOW** | **真活洞**（②+不透明复合） |
| `pypy3 -c 主仓写` / `sudo --user=root python3 -c 主仓写` / `sudo -u root python3 -c` | BLOCK | B+0/B+1 **已被 #1611 收编**（resolveExecHead 版本归一 + skipWrapperArgs 长旗标吞食）——记档不重复修 |
| `curl \| env python -c "print(1)"` | ALLOW | B+0 交叉形态**实测=无害确认**：-c 在场 python 不读 stdin，curl 内容不被执行（非漏放） |
| `curl \| env python`（无 -c） | BLOCK | feed 通道已有矩阵钉（对照） |
| 截断载荷 `python3 -c 'ast.parse(open("x").read()); open("/repo/pwn","w")` | BLOCK | M-2ad7c58d A 项**已不成立**：heredoc-script-payload 回落 → V1 fail-closed 拦（#1544 链已有） |
| c091 `ast.parse(open().read())` 只读链 | evaluated（读披露） | M-2ad7c58d B 项**疑点消解**：guard-write-eval-corpus c091 note 明载「truncated-payload 源数据上限，非求值器缺口」，shadow 口径已剔除 |
| GA-3 良性截断只读 `python3 -c 'ast.parse(open("x").read()` | BLOCK | **pre-existing FPOS**（origin/main 同拦）——保守向误拦非本批引入，记档不动（#1513 尺度） |

### 与记忆的对照修正

- matter ① 的字面主张「python -c 载荷写提取白名单缺 mkdir」→ 实际当前 main 的缺口不在提取通道白名单（os.mkdir 词面在表、提取通道可用），在 **PAYLOAD_WRITE_FACE 词面证的 pathlib 方法族缺失**（write_text 有、同族写方法无）+ 裸方法名族缺失。修法从「加白名单词」修正为「词面+提取通道同族归位」。
- matter ② 的「xargs -i bash -c {} 注入上游内容为 -c 载荷漏放」→ 字面属实，三处盲因定位如上。

## 方案设计

### 修法①：pathlib 写族同族归位（write_text 先例）

**词面证层**（write-word-face.ts PAYLOAD_WRITE_FACE）：
- `Path(lit).<method>` 双约束族扩：write_text/write_bytes → +mkdir/rmdir/unlink/touch/rename/replace/symlink_to/hardlink_to
- 裸方法名族 `.(writelines|truncate|unlink)(` 对齐扩 +mkdir/rmdir/touch/rename/write_text/write_bytes/symlink_to/hardlink_to——**replace 刻意排除**：全语料扫描 `.replace(` 81 条全是 JS/Python 字符串方法良性用法（词面证据：allow 库 77 条），裸名收 replace = 大面积误伤；pathlib replace 语义由 `Path(lit).replace(` 双约束形态覆盖
- 变量接收者主仓路径（`p = Path("/repo/x"); p.mkdir()`）：裸方法名族命中 → 不洗白 → 落点求值不出回落拦

**提取通道**（write-target-evaluator.ts evalScriptWriteTargets）：
- Path(lit) 单参写方法族（mkdir/rmdir/unlink/touch/symlink_to/hardlink_to）→ 落点=接收器构造
- Path(lit).rename/replace 双参 → src/dst 双落点（任一主仓即拦）

### 修法②：xargs replace-str 注入等价类

挂接 `stdinShellFeederVeto`（与 curl|bash 同基座判定）：
- `xargsReplaceInjection(seg)` 识别：xargs 段旗标区含 replace 旗标（`-i` / `-I<str>` / `-I <str>` / `--replace[=<str>]`，缺省 {}）且命令区为 `shell -c <含 replace-str 的模板>`（两种注入位：整模板恰为 replace-str / 模板内含占位符）。动态词不猜（→ null 走既有保守面）
- 静态上游（echo/printf 经 segmentStdoutContent）→ **拼接重建**（模板 split/join 上游内容，xargs 实参替换语义）→ 重建载荷递归 checkMainCheckoutWrite（与 bash -c 载荷同基座）
- 不透明上游 → fail-closed（STDIN_SHELL_OPAQUE_MSG，feed 归因）
- 良性静态源（echo hi）→ 递归判无写面 → 放行
- kill 词面在重建载荷中 → INDIRECT_KILL_BLOCK_MSG 归因

### 不修与记档项（按派工边界）

- **matter ③ env -P 扩面**：明确不做——搭档单独点头边界（M-3fe59a8e 先例）保持
- **xargs 默认追加形态**（`echo path | xargs touch` 词级注入）：F20261020c2sm R2 已记档归 wrapper 基座治理域（M-c36b9847），与 `touch $(cmd)` 命令替换面同级——不越界收（#1513 不军备化：xargs 常规用法海量，追加形态全收进上游词级递归 = 巨大误伤面）。独立测试钉现状 ALLOW
- **GA-3 pre-existing FPOS**（良性截断只读误拦）：保守向，origin/main 同判，非本批引入——记档待 wrapper 基座治理单统一裁

## 测试

- `tests/frameworks/agent/bash-guard-gpg1-fixes.test.ts`（新，18 例）：① pathlib 词面/提取/双参 rename/变量接收者 ② xargs 注入 7 形态（整占位/模板/不透明/良性/树内/追加现状/kill）③ B+0/B+1 补盲钉 5 ④ M-2ad7c58d 核验 2
- touchstone block 库 +4（TS-gpg1x01/02/04/06：pathlib 直写三形态 + rename 双参）——xargs 注入形态**不进库**：exam 棘轮以 evaluateWriteVerdict（求值器单链）为考官，xargs 结构判定在 guard 侧，进库必挂 exam 棘轮语义（独立测试钉，呈报理由记 corpus 注释）
- corpus 冻结断言更新：block 87→91（+4 呈报件）、真实语料守恒式含 TS-gpg1 前缀排除
- 全量：431 files 6874 passed + 6 skipped 零失败；tsc/eslint 零错误

## 红绿证据

红（origin/main @ 57edd41c 严格对照）：
```
LEAK | python3 -c 'from pathlib import Path; Path("/repo/pwned").mkdir()'
LEAK | echo "mkdir -p /repo/pwntree" | xargs -i bash -c {}
LEAK | echo "/repo/pwntree" | xargs -i bash -c 'mkdir -p {}'
（对照）PASS | python3 -c 'Path("/repo/pwned").write_text("x")'  ← 既有通道正例
```
绿（本 PR）：以上全 BLOCK；良性对照（echo hi 注入/ls|xargs echo/树内相对写/write_text 良性面）全 ALLOW。

## 影响范围

- 修改面：bash-safety-guard.ts（xargsReplaceInjection + feederVeto 分支 +57 行）、write-word-face.ts（词面族 2 行）、write-target-evaluator.ts（提取通道 +17 行）
- 良性面收窄：变量接收者 `p.mkdir()` 相对路径（无主仓字面量）从洗白 ALLOW 变为词面命中→回落拦——保守向收窄，与 write_text 先例同尺（TS-19e22576 真实良性面经 varEnv 通道不受影响，exam 全绿实证）
- 不动面：stdinShellKind/stdinShellFeederVeto 主链语义、feed 通道矩阵、#1308 契约、UNPROVABLE_TEETH、gitdir 机制（#1636）

## 残余记档

- xargs 默认追加形态（词级注入）现状 ALLOW——归 M-c36b9847 wrapper 基座治理域（F20261020c2sm R2 同判）
- GA-3 良性截断只读 FPOS（pre-existing）——保守向误拦，待统一裁
- xargs 注入形态未进 touchstone 三库（exam 棘轮考官域所限）——独立测试 bash-guard-gpg1-fixes 长期钉
- env -P 扩面未做（搭档单独点头边界）
