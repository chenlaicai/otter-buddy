---
id: F20261027bgkw
title: "反引号嵌套载荷递归判定补全（#1544）"
summary: "sandboxGuarded=true 链上，SUBSHELL_GIT_WRITE_GATE 壳字符类只认 (/{ 不认反引号，反引号嵌套 git 写载荷绕过保留面兜底；扩壳字符类补全，与 $() 壳同口径 fail-closed。"
change_type: fix
capability_test: "n/a: 确定性守卫判定行为，无 prompt/LLM 行为改动"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: 2026-10-27T11:45:00+08:00
causal_links:
  from: [F20261016gsbx, F20261019gses, F20261027rcwd]
tags: [bash-guard, git-write, command-substitution, backtick, sandbox]
modules: [src/frameworks/agent/bash-safety-guard.ts, tests/frameworks/agent/bash-safety-guard-backtick-nested.test.ts]
---

# 反引号嵌套载荷递归判定补全（#1544）

## 修前实证与根因修正

大獭修前 10 例探针（main `9c1705b5`，含 #1636+#1648）：仅 B3（`echo "\`cd /主仓 && git commit -m x\`"`，sandboxGuarded=true）ALLOW，其余 9 例判定正确（顶层 cd+commit 已被 #1636 收口、$() 嵌套已被 #1648 链路覆盖、worktree/只读对照放行正确）。

**简报根因（collectPayloads 无 backtick case）经实证不成立**：

1. lexer 把反引号词法化为 `cmdsub` part（`command-lexer.ts:309` backtick 分支 push `{type:"cmdsub"}`）——collectPayloads 的 `p.type === "cmdsub"` 天然覆盖反引号，收集层无缺口可补；
2. trace 实证 B3（backtick）/B4（$()）的 `parseOnce` 产出完全一致（payload kind=cmdsub、depth=1、segmentIndex=0、model 含 cd+commit 双段）；
3. `evaluateWriteVerdict` 对 B3 判 **BLOCK positive**（mainHits=主仓）——非沙箱链上反引号嵌套早已拦住。

**真根因**：`sandboxGuarded=true` 时求值器与 heredoc 负门退役（F20261016gsbx 二期 2b G3 枚举表，`writeChannelSkip="file-write"`），保留面 `checkSegmentStructuralWrite` 尾闸 `SUBSHELL_GIT_WRITE_GATE` 壳字符类 `[({]` 只认 `$()` 与命令组——B4 的 BLOCK 恰是 `(` 被该闸兜住，反引号壳不在字符类内，兜底落空 → ALLOW。

## 修法

`SUBSHELL_GIT_WRITE_GATE` 壳字符类扩反引号：`[({]` → `` [`({] ``，字符类排除 `[^)}]` → `[^)`}]`（防反引号壳内首个 `}` 提前终止匹配——与 `(/{` 壳对 `)`/`}` 的既有边界语义对齐）。

单行修复，单定义单消费点（bash-safety-guard.ts:1259 定义、:1786 段序列判定尾闸消费），无分类指纹需同步（BLOCK 文案走 `rewriteMainWriteBlockMsg` 既有 `main_write_resolve` 指纹）。

## 翻判面（修前矩阵实测定案）

修前 10 例翻判矩阵（sandboxGuarded 与否两链、主仓/worktree/纯数据形态）：

| 形态 | 修前 | 修后 | 说明 |
|---|---|---|---|
| 反引号嵌套 cd 主仓 && git commit（sg）| ALLOW | **BLOCK** | #1544 残留缺口，本 PR 修复目标 |
| 反引号嵌套 cd worktree && git commit（sg 与否）| ALLOW | BLOCK | 翻判面：对齐 $() 壳既有口径（见取舍）|
| 裸反引壳 git commit（无 cd，sg）| ALLOW | BLOCK | 同上，对齐 `$()` 既有口径 |
| 反引号纯数据 `echo "\`date\`"`（sg）| ALLOW | ALLOW | 不误拦，纯数据形态无 git 写族字面 |
| 反引号纯数据跨段 `echo "\`date\`" && git commit`（WT-cwd，sg）| ALLOW | **BLOCK** | **反引号独有误拦**（r1 审视发现）：闭反引号可作匹配起点，$() 对照 ALLOW（`echo "$(date)" && git commit` 同形态修前即 ALLOW）——worktree 日常流 `git add && echo `date` && git commit` 会整链 BLOCK。已知限制非缺陷：正则层无法区分（B3 修复目标与该形态共享首个反引号起点），根治需 lexer 级 cmdsub span 提取，挂 #1608 域跟踪 |
| 反引号只读 `echo "\`git status\`"`（sg）| ALLOW | ALLOW | 只读子命令不拦 |
| worktree 顶层 commit（B9 对照）| ALLOW | ALLOW | 合法面不受影响 |
| cd 主仓 && git status（B10 对照）| BLOCK 不变→ALLOW（只读）| 不变 | 只读对照放行保持 |

## 取舍

- **壳内 git 写族不看 cwd（fail-closed）是 $() 壳既有口径**（修前矩阵 M4/M5：`echo "$(cd worktree && git commit)"` 在 sg 与否两链上均 BLOCK）——反引号对齐扩入后，反引号 worktree 合法形态会翻判 BLOCK。这是保守面的一致性对齐而非新误拦：shell 语义上反引号/$() 壳内 cd 影响子进程 cwd，静态判定选择 fail-closed。若搭档/后续要给壳内 worktree 形态开合法通道，应与 $() 壳一起重议（本 PR 不动 cd 豁免语义全局重议——#1544 边界）。「非新误拦」限定于壳内形态域；跨段形态（反引号数据 + 顶层合法 worktree 写）为反引号独有新增误拦面，已在翻判面矩阵如实声明（r1 审视修正）。
- **不动 collectPayloads**：简报假设的收集层缺口不存在（实证见上），无代码可写；强改 collectPayloads 反而引入无依据变更。
- **不修沙箱退役面**：sg=true 时求值器退役是 F20261016gsbx 的架构决策（沙箱物理 deny file-write 接防），git 写族属保留面（沙箱 deny 列表不含 git 网络/对象写），保留面兜底正则补壳字符是当前架构下的正确修法。

## 测试

新回归测试 `tests/frameworks/agent/bash-safety-guard-backtick-nested.test.ts`：B1-B10 固化断言（BLOCK 例断言消息含「写命令落点解析到主仓」）+ 6 例翻判面（纯数据/只读/裸壳/非沙箱链）。

全量测试：441 文件 / 7003 passed / 6 skipped，零回归（含 bash-safety-guard.test.ts、bash-safety-guard-git-dashc.test.ts 等守卫族）。
