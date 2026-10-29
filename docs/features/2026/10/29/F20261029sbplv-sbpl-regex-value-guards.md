---
id: F20261029sbplv
title: SBPL regex 值语义回归守门与 #1697 根因勘误（顺序覆盖真机实证生效）
summary: 值层钉死 + 根因勘误——grantToProfileRules 的 regex 值形态实测正确（单反斜杠转义点、命中真实写路径、无双反斜杠残留），新增「SBPL regex 值语义」守门测试 4 项防转义回归；真机三实测（git add/worktree add/worktree remove 信封形态）证明 SBPL deny→allow 顺序覆盖语义生效，#1697「顺序覆盖不生效」结论系探针方法学产物（node 子进程/脚本包裹外层非 git 信封 → 无 grant → 默认 profile 的 .git deny 生效，fail-closed 预期行为）。
change_type: fix
capability_test: "n/a: 回归守门测试（git-sandbox-policy.test.ts「SBPL regex 值语义」describe 4 项），非新增能力面"
created_in_conversation: 2deb62bf-1e41-464d-a794-0da4c75a5c03
created_at: 2026-10-29
causal_links:
  - "#1697"
  - "#1688"
  - "#1685"
  - "#1691"
tags:
  - bash-guard
  - sbpl
  - sandbox-profile
  - escape-semantics
  - regression-guard
  - root-cause-correction
modules:
  - src/frameworks/agent/bash-sandbox.ts
  - tests/frameworks/agent/git-sandbox-policy.test.ts
---

# SBPL regex 值语义回归守门与 #1697 根因勘误（顺序覆盖真机实证生效）

## 背景

#1697 现象：外部仓（CoLink）与主仓 linked worktree 内 `git add -A`/`git commit` 写
`.git/worktrees/<name>/index.lock` 恒 EPERM。初判根因（issue 排查段）为「SBPL
regex-allow 对 regex-deny 的顺序覆盖在真机不生效」，并怀疑 `\\.` 转义在
escapeForOuterBash + bash + SBPL 三层链路变形、`(/|$)` 断言 ICU 方言语义不符、
`^` 锚定基数不一致三个方向。

## 根因勘误（本世实证链）

### 1. 值层正确（原假说一「转义层 bug」不成立）

- `grant-rules-verify.cjs` 对 dist 实测：CoLink 真实路径 5 正例全中
  （index.lock/objects/refs/reflog/config.lock）+ 3 负门全拒 + 指针规则
  `$` 锚定正负断言 + 无双反斜杠残留（11 断言全 PASS/exit 0）；
- `git-sandbox-policy.test.ts` 56/56 全绿；规则值层为单反斜杠转义点
  （`^<root>/\.git/...`），JS RegExp 命中真实写路径；
- 逐字节核对 `git-execution-policy.ts:444`（od -c）：模板串 `\\.` → 值 `\.`，形态正确。

### 2. 真机双面三实测：SBPL 顺序覆盖语义生效（原结论的反证）

2026-10-29 18:2x-19:0x，走**生产 spawnHook 全链路**（信封形态命令）实测：

| 操作 | 写面 | 结果 |
|---|---|---|
| `cd <linked wt> && git add -A` | 创建面：`.git/worktrees/<name>/index.lock` | ✅ 成功 |
| `git worktree add --detach <wt>` | 创建面：`.git/worktrees/<new>/` + config.lock | ✅ 成功 |
| `git worktree remove <wt>` | 删除面：.git 指针 unlink + gitdir 移除 | ✅ 成功 |

对照锚点：同日复合形态命令（带管道/分号）因信封不识别 fail-closed 无 grant，
`.git` 写 EPERM——证明沙箱 deny 生效且窄写域 allow **仅在 grant 后生效**，
即「deny → 后置窄 allow 顺序覆盖」机制在真机成立（#1688 判别表的预期行为）。

### 3. #1697 探针方法学缺陷（原结论的来源）

issue「决定性对照实验」的探针由 **node 子进程/脚本包裹**发出（案发现场：
raw-touch-probe.cjs / profile-repro.cjs / spawn-hook-repro.cjs，issue 自述
「探针由沙箱内 node 子进程发起」）。外层命令非 git 信封 → 无 grant → 默认
profile（仅通用 `.git` regex deny，无窄写域 allow）→ `.git` 写 EPERM 是
fail-closed **预期行为**，从未测到 git profile 的窄写域。同理：

- `touch <外部worktree>/subpath-probe` 成功是 `(allow default)` 覆盖
  （CoLink 树不在任何 deny 内），非 subpath allow 证据；
- `touch <colink>/.git/...` EPERM 是默认 deny 未被任何 allow 覆盖（无 grant 时
  本就无窄写域），非「regex allow 在 deny 之后不生效」的证据；
- linked worktree（wt-sbx-test）同样复现同属此形态产物。

### 4. EPERM 症状的真实来源（候选归口）

信封判定 fail-closed 的已知触发面（症状 issue 归口 #1699，10-29 15:06 后
主仓/外部仓 worktree commit 全拒的探针记录在其案发现场）：
复合命令形态（管道/分号/多段 git）、引号参数形态（#1691 残余记录实测
`--author="大獭 <otter-buddy>"` 破信封解析）、`git -c` 的**非白名单 config 键**
（信封仅放行 user.name/user.email，git-execution-policy.ts safeConfig 白名单）
与 URL 参数 push 形态（healing 台账 6h 内多起）。这些形态无 grant → 默认
profile deny → index.lock EPERM，与 SBPL 形态无关。

## 本 PR 交付

1. 「SBPL regex 值语义」守门 describe 4 项：值层提取后作为 JS RegExp 必须命中
   真实写路径（含 #1697 主现场 index.lock/objects/refs 与外部仓路径）、
   值层不得出现双反斜杠（转义形态回归闸）、worktree .git 指针删除面命中
   且 `$` 锚定不放宽（负断言：指针规则不得命中 `.git` 子树）——
   防「源码层多写一层转义 → 规则永不匹配 → deny 独存」与「指针规则锚定放宽」
   两类未来回归；
2. `bash-sandbox.ts` deny/grant 两处转义形态注释钉死（值层语义一文讲清，
   实证核验口径——值层自 #1688 起即正确，非本 PR 修复）；
3. 根因勘误记录（本文档）。

**不改行为面**：修法决策树判定为无机制变更（守门测试+文档），Modification-Class: docs-config。

## #1697 issue 处置去向

- **勘误结论回写**：#1697 issue 的初判结论（「顺序覆盖在真机不生效」+三个转义
  方向怀疑）已被本勘误推翻——issue 关闭前须附勘误评论，指向本文档与检视独立
  复现记录，避免双结论悬空；
- **关闭口径**：按 #1697 关闭标准，其验证断言（信封形态 commit 落库）已由
  真机三实测+检视独立复现满足——本 PR 合入后可按「根因勘误+实测验证」关闭，
  关闭评论引用本文档；
- **残余症状移交**：非信封形态（复合命令/引号参数/-c 非白名单键）误拦的
  EPERM 症状归 #1699（沙箱 git 写面全局失效，OPEN，含主仓+外部仓探针
  记录）；external worktree push/fetch 管理写面归 #1694（OPEN；#1696 已
  合入关闭其首修）。后续排查者搜到 #1697 时应循此去向找到活线。

## 与 #1691 的协同

mac 真机集成 CI 门（`sandbox-macos`，macos-latest 真 sandbox-exec 跑
git-sandbox-integration.test.ts 含 #1682 外部仓场景）由 #1691 携带——本 PR
不重复加 job（防 ci.yml 冲突，搭档定调「你们俩不要冲突」）。守门测试随
#1691 的门每 PR 真跑获得运行时回归覆盖。

## 验证

- 机器锚点：`git-sandbox-policy.test.ts` 全量 PASS（含守门 describe 4 项，
  复跑命令与 exit code 见 PR body 机器锚点节）；`tsc --noEmit` 0 error；
  `grant-rules-verify.cjs` 5 正例+3 负门+指针 `$` 锚定+无双反斜杠共 11 断言
  全 PASS/exit 0（修正初版 lazy 正则抓错指针规则后才真实全绿——初版实际
  9 PASS/1 FAIL/exit 1，检视发现 S2 已拆自反锚点）；真机三实测
  （上表，18:2x-19:0x，生产 spawnHook 链路）。
- git 考古（检视独立复核）：`git log --all -p -- src/frameworks/agent/git-execution-policy.ts`
  ——gitDir 行仅 escapePath 版与 `\\.git` 版两种形态，#1688（3454e952:444）起
  值层即正确，双反斜杠 buggy 形态从未存在于任何 commit。
- agent 陈述（未复验）：外部仓形状的 SBPL 运行时写面（CoLink .git 真实写）未直接
  复验——本机建 fixture 被守卫拦（git init 仅限登记 worktree），以 #1691
  sandbox-macos 门 #1682 用例与 CoLink 现场复验为最终锚点。

## 已知边界

- 信封 fail-closed 形态面（复合命令/引号参数/`git -c` 非白名单键）的误拦修复
  症状归 #1699（见 §4），策略层 push/fetch 归 #1694，均不在本 PR 范围；
- CoLink 撤回功能交付（feat/shared-recall-reedit）恢复路径：以信封形态直接执行
  `cd <wt> && git commit`/`git -c user.name=… -c user.email=… commit -F <msg>`
  绕开引号参数形态（#1691 同款规避）——注意 `git -c` 仅 user.name/user.email
  白名单键受信封支持（safeConfig），其余 config 键仍 fail-closed。

## 回滚

纯测试+注释+文档，revert 即回，无行为面变更。
