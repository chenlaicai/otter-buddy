---
id: F20261008h304
title: bash 守卫 cat 型 heredoc 体剥除基座：数据体对 git 写族/one-liner 通道不可见（#1304）
summary: checkMainCheckoutWrite 内两套基座不一致——重定向通道在剥体基座判定而 git 写族/one-liner 通道吃原始 command，cat > file <<'EOF' 的体内容（纯文件数据）中 git stash push / node -e \"…\" 字样被当真写操作拦；修复为新增 blankDataHeredocBodies：非解释器头、closed、开行无管道无 $()、quoted 定界或体无 $/反引号、体无 kill 词元——全判据保守满足才等长隐去，落点仅 git 写族/one-liner 通道。
change_type: feature
capability_test: "tests/frameworks/agent/bash-guard-heredoc-body-strip.test.ts"
modules:
  - src/frameworks/agent/bash-safety-guard.ts
tags:
  - guard
  - false-positive
  - bugfix
created_at: "2026-10-08"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
intent:
  problem: "#1304：cat 型 heredoc 体是纯文件数据（无 shell 执行语义），但 git 写族/one-liner 通道扫描原始 command——体内 `git stash push` 字样被当真 git 写拦、`node -e \\\"…\\\"`（转义引号）使 one-liner 载荷提取失败保守拦。10/8 实拦：healing 47c443e7/f80f7559（当日 09:38/09:42 两连拦）+ 凌晨 01:00-01:13Z 4 条同族（cd worktree 后 gh 只读查询族）。"
  expected_effect: "cat 型 heredoc 体含写操作字样不再误拦（当日实拦回放 PASS）；反向洞防护——cat 落主仓、体经管道真执行（cat<<EOF|bash）、解释器体、python 负门、EOF 后真写搭车绕过全部仍拦；cd worktree git/gh 只读等原放行面零回归。"
  verify_by:
    type: behavior_check
---

## 背景与需求

### 问题描述

issue #1304：main_write 守卫误拦复活。10/5 起 8+ 起「cd worktree 后 git/node 命令被拦（hasWorktreePath=true 仍触发）」，是 #1207/#1239 修复家族的回归信号。

### 排查过程（当日现场实拦 + 逐字节回放）

排查者本人（大獭）当日 09:38/09:42 被连拦两次，成为活体样本：

1. **09:38**：`cat > /tmp/guard-repro.mjs <<'EOF' … EOF; npx tsx`（heredoc 写 /tmp + 执行）
2. **09:42**：`cat > data/workspaces/<conv>/x.mjs <<'EOF' … EOF; cd worktree && npx tsx`（heredoc 写对话工作区——非 git 追踪 sandbox，R1 明文排除——+ worktree 内执行）

**分层排查**：
- 复现脚本 mainPid 传 null → 触发降级路径全 PASS（排除「守卫代码自身误判」）
- dist 本体（运行时同款）+ mainPid 正确传入 + 逐字节原命令回放 → 09:42 BLOCKED 复现成功
- 最小化矩阵定位分叉：heredoc 体内 `git stash push` 字样 BLOCKED / `node -e \"…\"`（转义引号）BLOCKED / `node -e "…"`（普通引号）PASS / 体内重定向字样 PASS

### 根因

`checkMainCheckoutWrite` 内**两套扫描基座不一致**：

- 重定向通道（REDIRECT_PATTERN 判定）吃 `stripQuotedTextSpans(blankVerifiedScriptBodies(command))`——剥体基座
- git 写族 / one-liner 正则通道（`checkWriteChannels`）吃**原始 command**——heredoc 体对它可见

cat 型 heredoc 的体是纯文件内容（写入目标文件的数据），无 shell 执行语义；体内出现 `git stash push`、`node -e \"…\"` 字样是数据不是操作。重定向通道的剥体基座（#1207 delta r1 引入）只覆盖 python/node 解释器体（`blankVerifiedScriptBodies` 过滤 `isPythonHeader/isNodeHeader`），cat 型数据体从未被剥除。

次要因素：one-liner 载荷提取对引号形态敏感——体内 `node -e \"…\"`（JSON 层转义的双引号）使 `extractOneLinerPayloads` 提取失败 → fail-closed 保守拦。

### 排查期间的护栏事件

排查中两次被守卫拦（诊断块「进程名模式：…/bash-safety-guard.ts」——文件名含 node 词元），换 workspace_write 写脚本 + worktree 内执行绕过。此为守卫按设计工作（诊断回显参与展示不参与判定），非新 bug。

## 方案设计

### 修复：blankDataHeredocBodies

```text
非解释器头（!isPythonHeader && !isNodeHeader && !isShellHeader）
  && closed（未闭合永不剥，fail-closed）
  && 开行无管道 |（cat <<EOF | bash 体经下游真执行）
  && 开行无命令替换 $(
  && (quoted 定界 || 体无 $ `)（裸定界体经 shell 展开可被解释）
  && 体无 kill 词元（保守）
→ 体区域等长替换为空格，仅用于 git 写族/one-liner 通道判定
```

落点约束：cd 豁免 / 重定向 / git 白名单仍用原始文本（cd 段与重定向落点是真实 shell 语义，重定向通道已有自己的剥体基座）。

### 反向洞自查（回归 B 面，全部 BLOCKED 验证通过）

| 用例 | 结果 | 判据 |
|---|---|---|
| B1 cat 落主仓（无 cd） | 拦 | 落点判定不受体剥除影响 |
| B3 cat<<EOF\|bash 体含 kill | 拦 | 判据③开行管道 |
| B6 python heredoc 体真写主仓 | 拦 | 判据②解释器头不剥，负门保留 |
| 体剥除搭车绕过（EOF 后真 git 写） | 拦 | EOF 后命令在体区域外，可见 |
| python 体 subprocess | 拦 | 同 B6 |

### 既有基线洞（修复前即存在，非本次范围，另开 issue）

| 洞 | 复现 | 说明 |
|---|---|---|
| `cd <主仓> && git stash push` 真写放行 | B2 基线 PASS 实测 | cd 豁免吃「cd 到主仓」也算豁免段——模型可 cd 主仓跑只读的历史设计放行面 |
| 裸定界体含 `$(rm …)` 放行 | B4 基线 PASS 实测 | 裸定界体经 shell 展开执行——判据④挡住本次不剥，但基线本就漏 |
| `cd <主仓> && node -e writeFile` 放行 | B5 基线 PASS 实测 | 同 B2 族 |

## 验证

### 回归矩阵（tests/frameworks/agent/bash-guard-heredoc-body-strip.test.ts，14 用例全绿）

- **A 面误拦修复**（5 用例 PASS）：09:38/09:42 实拦回放、体内 git stash/commit 字样、体内转义引号 node -e、嵌套 EOF 文本
- **B 面反向洞**（5 用例 BLOCKED）：B1/B3/B6 + 搭车绕过 + 解释器体
- **C 面原放行面**（4 用例 PASS）：cd worktree git/gh 只读、python heredoc 只读、cat heredoc 写 worktree 内文件

### 全域测试

`tests/frameworks/agent/` 1254 用例：1252 绿 + 2 失败（tool-description-overrides 域，stash 对照验证为 #1338 遗留基线失败，与本次无关）。

## 影响范围

- 只影响 `checkMainCheckoutWrite` 的 git 写族/one-liner 通道扫描基座
- 解释器 heredoc（python/node/bash）体级判定链不变
- cd 豁免、重定向判定、git 只读白名单、data 破坏、kill 族判定不变

## 取舍

- **等长空格替换 vs 删除**：等长保 span 偏移稳定（与 blankVerifiedScriptBodies 同构），避免正则回溯性能退化
- **判据⑤ kill 词元**：对裸定界体已有判据④兜底，quoted 体 kill 字样理论无执行面；但 kill 是最高危目标，多一层保守换审计安心
- **凌晨 4 条 gh 族实拦未逐字节回放**：healing commandHead 截断 120 字符，无法全量回放——同族判定（cd worktree + gh 只读 + heredoc 上下文），修复后观察

## 后续动作

- [x] 修复 PR（本 PR）
- [ ] 基线洞 3 处另开 issue（cd 主仓豁免放行真写 / 裸定界体 $() / B5 族）
- [ ] 观察凌晨 gh 族实拦是否随本修复消失
