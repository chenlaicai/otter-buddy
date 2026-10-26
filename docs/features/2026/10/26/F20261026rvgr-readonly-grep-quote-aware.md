---
id: F20261026rvgr
title: "主仓只读 grep 检索被 main_write 误拦：引号参数位词元误判命令位修复（#1635）"
change_type: fix
created: 2026-10-26
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
modules:
  - src/frameworks/agent/kill-segment-finder.ts
  - src/frameworks/agent/bash-safety-guard.ts
  - tests/frameworks/agent/guard-v2-real-replay.test.ts
summary: "issue #1635（P2）：只读 grep 检索管道连续两日（10-23/10-24）被 main_write 误拦——引号内危险词（rm / find -delete 出现在 grep 模式参数）被 isKillAtCommandPosition 的前导字符白名单判为命令位：grep alternation 转义竖线 \\| 的 | 在 VALID_CMD_PRECEDERS 白名单里，引号内字面量被当 shell 管道。修复：①引号感知——白名单字符若在引号内（$() 内除外）视为字面量非操作符；$( 边界优先白名单（bash 语义：双引号内 $() 真实展开）。②checkDataDirDestructive 入口剥 heredoc 体（gh issue create 正文含 find -delete 字样的文档数据体误命中，与 checkGitAliasShellInjection X5 同构）。"
tags: [bash-guard, false-positive, main-write, quote-aware, fix]
capability_test: "n/a: 纯守卫词法修复，行为回归由 guard-v2-real-replay 回放块（9 用例）与全量 agent 测试钉住"
from: [F20260922gpqa, F20261016gdfv, F20261014ectx]
---

# 主仓只读 grep 检索被 main_write 误拦：引号参数位词元误判命令位修复（#1635）

issue #1635（P2，tech-debt）。每日健康检查任务连续两日被自己要排查的守卫规则拦截。本单交付：案发现场代码级重判定 + 最小面修复 + 9 条回放测试钉死边界。

## 1. 案发现场重判定（日志 + 代码级，非 issue 原样照单）

issue 描述与实际有三处出入，以实证为准：

| 差异点 | issue 说法 | 实证（healing_events + otter-buddy.log L2238313/L2259621/L2248760） |
|---|---|---|
| 拦截者 | main_write 规则「进程名模式」 | `checkDataDirDestructive` → `segmentDestructive` → `isKillAtCommandPosition`（main_write 文案族） |
| 命中机制 | "find 被进程名模式命中" | 词法级：**引号内 `\|` 的竖线在 VALID_CMD_PRECEDERS 白名单**，前导字符判定把引号内字面量当 shell 管道 |
| 简报路径 | scripts/guard/prompt-guard.py | 该文件在仓库任何 git 历史中不存在；拦截实现是 src/frameworks/agent/bash-safety-guard.ts |

三起现场完整命令（healing 事件 commandHead 截断 120 字符，全文从主日志取）：

- **987a40c3（10-24，issue 主现场）**：`grep -i "write\|rm\|destruct"` —— 引号模式内字符串 `rm` 前导字符是 `\|` 的 `|` → 误判命令位 → `BLOCKED rm targeting main-checkout mainTree`
- **af548d08（10-23）**：`grep -n "\"find\"\|'find'\|find -delete\|..."` —— 引号模式内 `find -delete` 词面 → `BLOCKED find -delete targeting main-checkout mainTree`
- **L2248760（10-23 gh issue create）**：heredoc 正文（文档数据体）含 `find -delete` 字样 → 同规则误命中

**共同点**：三起命令实际副作用为零（纯只读检索 / 写 issue 正文）。

## 2. 根因

### 2.1 引号盲区（主根因）

`isKillAtCommandPosition`（kill-segment-finder.ts）的判定链：词元（rm/mv/find）前跳空白 → 前导字符 ∈ `VALID_CMD_PRECEDERS`（`| ; & \n \r \f ( `` ` ``）→ 判命令位。该白名单**不感知引号**：grep alternation 模式 `"write\|rm\|destruct"` 中 `\|` 的 `|` 是引号内字面量（BRE alternation），却被当作 shell 管道符 → 引号内 `rm` 误判命令位。

注：`checkDataDirDestructive` 的段切分 `split(/&&|\|\||[;&\n]/)` 不含单竖线，整条管道进单段；段内 `isKillAtCommandPosition` 全段扫描任意位置词元——真管道右段 `| rm` 与引号内 `\|rm` 在前导字符层不可区分，白名单曾经同时正确放行前者+错误放行后者。仓库已有引号感知基建（`splitShellSegments`/`sanitizeQuotedText`），但本函数未接入。

### 2.2 heredoc 体未剥（次根因）

`checkDataDirDestructive` 在原始命令上跑词元扫描，heredoc 体（写入 issue/PR 正文的数据文本）中的 `find -delete` 字样被误命中。同文件 `checkGitAliasShellInjection` 已有剥体先例（X5），本入口漏接。

## 3. 修法（最小面，两处）

### 3.1 isKillAtCommandPosition 引号感知（kill-segment-finder.ts）

```ts
// $( 命令替换边界优先白名单（防双引号内 $() 被吞成数据位）
if (prev === "(" && i > 0 && text[i - 1] === "$") return true;
// 白名单字符若在引号内 → 字面量非操作符 → 数据位 continue
if (VALID_CMD_PRECEDERS.has(prev)) {
  if (!operatorCharIsQuoted(text, i)) return true;
  continue;
}
```

`quoteStateBefore` 状态机：扫词元前文本的引号开合；`$()` 嵌套深度计数——**进入 $() 后引号世界重置**（bash 语义：`echo "$(rm x)"` 的 rm 是真实执行位），depth>0 时操作符不算引号内字面量。

### 3.2 checkDataDirDestructive 剥 heredoc 体（bash-safety-guard.ts）

入口 `stripHeredocPayloads(command)` 后再切段扫描——与 `checkGitAliasShellInjection` X5 同构。heredoc 体真实危险面由专职层覆盖（`checkHeredocScriptBodies` 递归 V1 全量链 / `heredocWriteVeto` 体感知负门），剥体不产生真洞；`stripHeredocPayloads` 对展开特征/未闭合体保守不剥（fail-closed）。

## 4. 边界钉死（guard-v2-real-replay.test.ts #1635 块，9 用例）

放行面（现场形态）：
- 1635-A1：10-24 现场命令原样回放（引号内 `rm`）→ ALLOW
- 1635-A2：10-23 现场命令原样回放（引号内 `find -delete`）→ ALLOW
- 1635-A3：gh issue create heredoc 正文含 `find -delete` 字样 → ALLOW
- 1635-A4：issue 关闭标准形态 `grep -n "find" src/...` → ALLOW

拦截面（安全红线不动）：
- 1635-B1：命令位真 `rm` 主仓文件 → BLOCK
- 1635-B2：命令位真 `find src -delete` → BLOCK
- 1635-B3：双引号内 `$()` 展开的真命令位写（`echo "$(rm -f src/x.txt)"`）→ BLOCK
- 1635-B4：引号内真执行体（`bash -c "rm -f src/x.txt"` 载荷）→ BLOCK
- 1635-B5：heredoc shell 体执行真 rm（`bash <<'SH'` 体）→ BLOCK

另跑 15 项生产形态对照矩阵（worktree 代码直接调用）：现场 2 条 ALLOW + 真 rm/-rf/find -delete/data 破坏/`$()`/bash -c/反引号/sudo/timeout/kill 族 12 条 BLOCK + worktree 内 rm 放行对照。

## 5. 已知局限（不在本单范围）

- `ls src | xargs rm -f`（管道喂 xargs 无路径参数）ALLOW——**存量既有行为**（stash 基线对照证实修复前同 ALLOW）：`pathArgsOf(xargs rm -f)` 无路径参数 → zone=null。xargs 间接来源判定属 kill 族 `source:"pipe"` 语义，data 破坏族未接同款管道标记，记档不动。
- `quoteStateBefore` 是线性扫描（O(n²) 最坏）——命令长度有 8192 上限保护（checkBashCommandSafety 入口长度门），实测无感。
- 转义引号 `\"` 在单引号内不特殊处理（POSIX 单引号内无转义语义，已正确）；双引号内 `\"` 配对跳过已处理。

## 6. 验证记录

- 修复前失败证据：`npx vitest run tests/frameworks/agent/guard-v2-real-replay.test.ts -t '#1635'` → 3 failed（A1/A2/A3）+ 6 passed（B1-B5+A4）
- 修复后：同命令 9 passed
- 全量：`npx vitest run` → 429 files / 6851 passed / 6 skipped；`npm run lint` 0 error；`tsc --noEmit` 通过；`npm run test:capability:only`（build 后）16 files passed
- 生产形态矩阵：见 §4

## 7. 影响范围

- 放行面扩大：仅「引号内字面量操作符 + 数据位词元」与「heredoc 文档体」两族——全部为已实证误拦面
- 拦截面收窄：零（VALID_CMD_PRECEDERS 白名单字符在引号外语义不变；$() 优先白名单是新增放行修正，此前 `echo "$(rm x)"` 靠 quoteState 旧路径本就 BLOCK——新代码 depth 重置语义同样 BLOCK，B3 钉死）
- 回放基线：guard-touchstone 三库（allow 791/block/cond）全绿不漂移；9/28 真实拦截回放（V9+）不漂移
