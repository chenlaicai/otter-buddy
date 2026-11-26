---
id: F20261126cwred
title: CRED_WRITE_RE 重定向分支收窄，SSH config 只读链 stderr 重定向不再误判写凭证
summary: 修复 bash-safety-guard 守卫 CRED_WRITE_RE 重定向分支把 stderr 重定向误判为写凭证的根因（原裸 >），收窄为边界 + 凭证目标判据并补齐写凭证操作符族（> / >> / >| / >& / <>）与 fd 前缀判据，SSH config 公开只读链不再被 cred_dir_access 拦。
change_type: bugfix
tags: [guard, bash-safety, regression]
modules: [src/frameworks/agent/bash-safety-guard.ts]
created_at: 2026-11-26
created_in_conversation: 6af46649-f93f-4c5b-a6d2-245a4ed33e9f
intent:
  problem: "bash-safety-guard.ts 的 CRED_WRITE_RE 末尾 |>>|>/ 的 / 是正则字面量定界符提前截断，最后一个分支实为裸 >，任何含 > 的凭证上下文命令（2>/dev/null、2>&1、非凭证重定向目标）旧版全误拦为「写凭证」，导致部署公开配置 grep SSH config 只读链被 cred_dir_access 拦（healing d536ca28 等）。"
  expected_effect: "收窄重定向分支为「写凭证操作符族在命令边界（fd 前缀数字算进命令 token）+ 目标确为凭证路径才拦」；非凭证目标的 fd 重定向（2>/dev/null、2>&1）、复制 fd（>&2）、尖括号占位放行；fd 前缀写凭证、>|/>&/<> 写凭证仍拦。SSH 公开只读样本转绿，私钥负门不退化。"
  verify_by:
    type: static_only
    evidence:
      - "npx vitest run tests/guard/replay/replay.test.ts：226 全绿，含 3 条 SSH 公开只读红转绿 + 13 条回归钉（含 4 条 fd 前缀负门 + 4 条操作符族负门）。"
capability_test: "n/a: 纯命令判定器静态回放，无 LLM 场景"
---

# CRED_WRITE_RE 重定向分支收窄，SSH config 只读链 stderr 重定向不再误判写凭证

## 问题与范围

2026-11-23/24 真实发生的误拦：部署公开配置读取链在末段 `grep` SSH config 时被 `cred_dir_access` 拦住（healing d536ca28 等三条样本）。既有 #1892 回放已明确此类公开只读应放行。本修复只处理守卫判定器 `CRED_WRITE_RE` 的重定向分支根因，回放资产的固化档案见 F20261124gcfgr（11-24 回放固化），本文件只归属守卫修复本身。

## 根因

`src/frameworks/agent/bash-safety-guard.ts` 的 `CRED_WRITE_RE` 末尾为 `|>>|>/`——末尾 `/` 是正则字面量定界符，被提前截断，最后一个分支实为裸 `>`。因此任何含 `>` 的凭证上下文命令（`2>/dev/null`、`2>&1`、非凭证重定向目标）旧版全误拦为「写凭证」。SSH config 公开只读链普遍携带 `2>/dev/null`，即被此裸 `>` 误拦。

## 修复

收窄重定向分支为 `(?:^|[\s;&|])\d*(?:>>|>\||>&|<>|>)\s*[^\s;&|]*\.(?:ssh|gnupg|aws)\b`——写凭证操作符族（覆盖 `>`、追加 `>>`、noclobber 覆盖 `>|`、双流写 `>&`、读写打开 `<>`）须在命令边界（行首/空白/; & | 后，紧邻的 fd 前缀数字 `\d*` 算进命令 token），且目标确为凭证路径（.ssh/.gnupg/.aws）才拦。非凭证目标的 fd 重定向（`2>/dev/null`、`2>&1`）、复制 fd（`>&2`）、尖括号占位（`<pattern> ~/.ssh`）放行；fd 前缀写凭证、`>|`/`>&`/`<>` 写凭证仍拦（两轮审视分别发现的 fd 前缀退化与操作符族逃逸，已补负门回放）。

## 样本政策对齐

`0dea2289`（2026-11-12 固化的负门：`grep -R ~/.ssh/config 2>/dev/null`）本是「含 .ssh 即拦」旧政策（#1892 前）遗留，其 block 判定依赖裸 `>` 误拦 stderr 重定向。修复后按「政策 A 改向」惯例 expect block→allow（样本留在 mustBlockCases，测试自动按 allow 断言）。

## 范围外披露（不修，交大獭裁决 / 已建 issue 承接）

1. `49a9b0c7`（pgrep 红）是 `0f9874302` 追加的第 4 个缺陷，根因 `kill-segment-finder.ts` 的 `PKILL_COMMANDS` 误含 `pgrep`（查询误当杀）。与 #2000（SSH config cred_dir_access）无关，另立 issue #2059 独立修（pgrep→kill 数据流分离），不并入本 PR。
2. 词尾粘连残余（含数字与非数字：`head -c2> <凭证路径>` / `echo x2> <凭证路径>` / `echo secret> <凭证路径>`）：bash 词法上是 stdout 写凭证（该拦），`(?:^|[\s;&|])\d*` 判据因操作符紧贴词尾（数字或非数字）无命令边界而放行。非本次补丁引入（收窄方案词法歧义固有残余）、罕见形态，已建 issue #2063 承接（口径含数字与非数字粘连），排期守卫线 pgrep（#2059）之后。
3. 间接目标（`f=<凭证路径>; echo x > $f`、`> $(...)`）：静态正则无法确认变量/命令替换的目标是凭证路径，属政策 A「明确才拦、不明确一律放通」的确认不了域，放通是本判据的固有边界（非退化）。

## Rollback

Revert 本 commit（守卫修复）即还原 CRED_WRITE_RE 为收窄前裸 `>` 分支，回放样本与断言保留。

## 测试改动声明

方向：收紧。守卫修复附带 13 条回归钉（含 4 条 fd 前缀写凭证负门 + 4 条操作符族负门，防止审出的退化/逃逸复发）；`0dea2289` expect block→allow 是旧政策负门的政策 A 改向（真实先例，非删改断言）。