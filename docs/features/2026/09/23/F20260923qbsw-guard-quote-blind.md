---
id: F20260923qbsw
title: bash 守卫引号盲误拦修复（#984 循环拦截事故）
doc_type: feature
change_type: fix
created: 2026-09-23
created_in_conversation: ce40cd37-9b62-4b7c-9fe1-35fc6f8a0a2f
modules:
  - src/frameworks/agent/bash-safety-guard.ts
  - src/frameworks/agent/quoted-text-sanitizer.ts
  - tests/frameworks/agent/bash-safety-guard.test.ts
summary: "F20260922scwd 主仓写拦截的 REDIRECT_PATTERN 与 hasRealCdSegment 复合切断检查是文本级引号盲全文扫描：gh issue comment --body 内含 -->/|/& 合法文本被误判重定向写主仓或假 cd，#984 连拦 3 次中断獭回合。修复：quoted-text-sanitizer 新增 stripQuotedTextSpans（引号段整段剥离，供 shell 语法形态判定；危险通道 bash -c/heredoc/反引号不剥离），checkMainCheckoutWrite 判定基准改剥离文本。9/23 早《压缩交接紧急修复》排查对话追加 9 个回归用例固化 sqlite3/grep 管道/awk/ls/tail/gh comment 等高频只读命令放行面。修法决策树①（既有机制语义内修复），Modification-Class: narrow-fix。"
tags: [bash-safety-guard, quote-blind, false-positive, reliability]
capability_test: "n/a: narrow-fix 收窄既有守卫判定语义，回归用例固化于 tests/frameworks/agent/bash-safety-guard.test.ts（F20260923qbsw 两个 describe 块）"
causal_links:
  from:
    - F20260922scwd
---

# F20260923qbsw：bash 守卫引号盲误拦修复（#984 循环拦截事故）

## Summary

F20260922scwd 主仓写拦截的 `REDIRECT_PATTERN` 与 `hasRealCdSegment` 复合切断检查是**文本级引号盲**全文扫描：`gh issue comment --body` 内含 `-->`（HTML 注释）、`>` 引用、`|`（markdown 表格）、`&` 的合法文本被误判为「重定向写主仓」或「假 cd」，拦截引导文案对不写本地文件的 gh 命令给出无效出路（cd / 绝对路径都救不了），獭连拦 3 次被系统强制中断回合（healing 4d692fb6 / e671f577，9/23 00:11-00:15 两獭连环中招）。

## Root Cause

两个误拦面，同根因（引号盲全文扫描）：

1. **重定向误判**：`REDIRECT_PATTERN` 右支 `(?<!["'\w])\d*>>?\s*[^|&;\n'"]+` 在引号内文本的 `-->` 第二个 `>` 处命中（实测 `a --> b` 匹配出 `"> b"`）；`extractRedirectTarget` 提出的「目标」非绝对路径 → 无 cd 前缀时判落点主仓拦截。`shouldSanitizeForScan` 要求引号内含敏感词元才介入，普通认领/评论 body 不脱敏，原文本直接被吃。
2. **复合切断误判**：`hasRealCdSegment` 的「无 & / |」检查全文扫描——body 含一个 `|` 或 `&`，即使首段是真 cd 也判「假 cd」不豁免，再被误拦面 1 命中。

## Fix

修法决策树 ①（既有机制语义内修复，narrow-fix）：不新增配置/状态/存储/信号/跨模块调用。

- `quoted-text-sanitizer.ts` 新增 `stripQuotedTextSpans`：引号段整段剥离为等长空格，供 shell 语法形态判定使用。与 `sanitizeQuotedText` 分工：脱敏只替换敏感词元（服务词元判定），剥离整段抹除（服务语法判定）。危险通道（bash -c / heredoc / 反引号）不剥离——载荷内重定向是真实语法。剥离用专用跨行正则 `SYNTAX_SINGLE_QUOTED`（shell 引号可跨行，多行 body 是高频形态；sanitize 的单行 QUOTED_TEXT 是词元脱敏的保守选择，不复用）。
- `bash-safety-guard.ts` `checkMainCheckoutWrite`：重定向判定与 `hasRealCdSegment` 复合切断检查改在剥离基准上进行。

## 影响范围

- 放行面（修复目标）：`gh issue/pr comment`、`gh pr review --body`、`gh api -F body` 等 body 含 `>`/`-->`/`|`/`&` 的命令；`cd wt && gh comment` body 含 `|`/`&` 组合
- 拦截面回归保护（测试固化）：真重定向 `echo x > file.txt`、`echo 'a --> b' > file.txt`（引号外真重定向）、`bash -c 'echo x > file.txt'`（危险通道不剥离）、`cd /wt | git commit`（引号外真管道）仍拦

## 验证

- 新增 9 个失败用例先固化（修复前 1 红确认误判，其余形态实测），修复后 230 全绿（bash-safety-guard + quoted-text-sanitizer）
- agent 框架全量 607 tests 全绿；eslint 干净
- 事故现场命令（healing 台账记录的前缀形态）逐一回归 PASS

## 补充回归（9/23 早《压缩交接紧急修复》对话现场，同特性追加）

9/23 08:26-08:48 排查对话中，大獭在旧守卫（未部署本修复）下连续 5+ 次被拦中断回合（invoke aborted）。追加 9 个回归用例固化排查期高频只读命令形态，验证本修复对它们的覆盖：

- sqlite3 只读查询（SQL 比较符 `>` + 项目 db 路径参数值）
- node 执行工作区脚本（绝对路径含项目 data/workspaces）
- grep/awk/ls/tail 管道链读主仓日志
- gh issue comment body 含 `>` `|` `&` 混合
- 安全面回归：sqlite3 查询结果引号外真重定向落主仓仍拦

补充后 221 tests 全绿。注：这些场景在修复后代码上本已放行（引号剥离路径覆盖），追加用例目的是防未来重构回退。

## 遗留

- 拦截引导文案对「不写本地文件的命令」（gh comment 等）仍只给 cd/绝对路径两条无效出路——本轮只修误判本身；引导文案对误判场景的兜底提示（如「若命令不写本地文件却被拦，请报告 healing」）值得后续迭代，未在本特性范围。
