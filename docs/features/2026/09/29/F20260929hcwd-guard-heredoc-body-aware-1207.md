---
fid: F20260929hcwd
id: F20260929hcwd
title: bash 守卫 #1207 误拦集群修复——heredoc 体感知判定 + V2 wrapper 剥除对齐 + 引导文案命令感知
summary: >
  #1207 一周 17+ 条误拦的三处根因修复：①只读 python heredoc 被主仓写通道正则
  整体拦——新增体感知判定（体含写/杀/执行签名才拦，纯只读体放行），重定向判定
  先等长隐去 python 体；②「cd wt 后写命令被误判主仓写」在 main 已由 F20260928grv2
  的 modelCdExemption 修复，本 PR 以 6 个误拦形态回归固化；③修复过程中探针实证
  两个 V2 安全回归并同 PR 封堵——wrapper 参数连剥不全（xargs -n1 -I{} 致 #760
  A4 攻击形态漏拦）与 bash/node heredoc 体直接执行 kill 主 PID 无任何判定
  （体级真杀主 PID 放行）。dev-server 引导文案改命令感知（只在进程操作形态附加）。
  全仓 4357/4357 绿，攻击 PoC 17/17 保持 BLOCK。
created: 2026-09-29
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
change_type: fix
status: implemented
related_issues: ["#1207", "#760"]
related:
  - F20260928grv2          # V2 结构模型（cd 豁免/管道右段判定的宿主）
  - F20260922scwd          # 主仓写检测（误拦规则的宿主）
  - F20260924gfpn          # git 只读白名单 + 写族正则
  - F20260914dsrv          # dev-server 引导附加层
  - F20260914ectx          # #858 内嵌文本脱敏
capability_test: tests/frameworks/agent/bash-safety-guard.test.ts
intent:
  problem: >
    #1207 记录了守卫「主仓写判定」的持续误拦集群（9/25×14 + 9/29×3）：命令已
    cd 到 worktree 仍被拦、只读 python heredoc 探查被拦且引导文案答非所问
    （报 dev-server 重启引导）。误拦无逃生通道（#1069 白名单未落地），獭被迫
    反复绕路，6h 内 ≥3 次升 high 的告警噪音持续累积。
  goal: >
    只放行误拦形态、不放松任何真实攻击面（#760 血训）：误拦复现用例转 PASS，
    全部既有 BLOCK 用例保持 BLOCK；顺带封堵修复过程中实证的 V2 漏拦回归。
solution: |
  根因一：python heredoc 误拦（E5，9/29 09:06 实时案例）。
  MAIN_WRITE_PATTERNS[1]（python3 - << 通道）按通道形态整体拦，不解析体内容——
  只读探查（open().read/print）与写补丁（open('w').write）共用同一通道形态被
  无差别拦截。探针实证：引号定界 heredoc parseOk=true 走 V2 模型路径，模型层判
  体为数据放行后，文本层补跑的 checkMainCheckoutWrite(原始命令) 在未剥体的原文
  上命中通道正则——误拦发生在 V2 路径而非 V1 兑底链。
  修复：体感知判定三件套——
  a) PY_BODY_WRITE_SIG 体签名（open 写模式含 lookahead 精确匹配 'r'/'rb' 不命中、
     os.O_* 位旗标、.write*/.dump(/.to_csv(、pathlib 写族、os.remove/kill/exec 族、
     裸 kill(/killpg(（from os import kill 形态）、subprocess/ctypes/eval/exec）；
  b) pythonHeredocBodiesReadOnly(command)：全部体均为 python 解释器 + 无签名 →
     豁免通道拦截；任一体含签名或非 python → 保守拦；
  c) blankPythonHeredocBodies：重定向判定前把 python 体等长隐去（体里 > 是
     python 语法非 shell 重定向；bash/sh 体永不隐去——可执行内容）。
  V1 兑底链输入已是剥体文本（体不可知）→ 不传豁免参数 → 保守拦（fail-closed 不变）。

  根因二：cd worktree 后写命令误判（issue 主根因，E1-E4/F1/F2）。
  main 的 F20260928grv2 modelCdExemption（段级 cd 链 + 静态求值）已修复主形态——
  本 PR 以 6 个 issue 原文形态固化为回归测试，防未来回退。

  修复过程中探针实证的两个 V2 安全回归（同 PR 封堵，拦截面收紧）：
  ③ wrapper 参数连剥不全：V1 stripCommandPrefixes 是 while 循环连剥全部旗标/
     数字/赋值参数，V2 effectiveCommand 只剥一个——xargs -n1 -I{} kill {} 的
     argv0 落在 -I{} 上，kill 段失认；且管道右段「字面参数」判定把 {} 占位符
     当字面参数。两处都对齐 V1：连剥改循环；字面参数收窄为纯数字 PID（#777
     剥括号口径）。#760 A4 攻击 PoC 恢复拦截。
  ④ bash/node heredoc 体直接执行无判定：bash - <<EOF 内 kill <mainPid>、
     node - <<EOF 内 process.kill(<mainPid>) 在现状全放行（V2 判体为数据 +
     文本层无规则）——比 python 误拦更严重的体级真杀。checkHeredocScriptBodies：
     shell 体（bash/sh/zsh/dash/ksh 头）递归 V1 全量链（语义精确，echo kill N
     数据位不误拦）；node 体签名扫描（process.kill/child_process/fs 写族）；
     python 体跳过（写/杀面由体感知豁免的签名承担，os.kill 在 PY_BODY_WRITE_SIG）。
     挂点三处：V2 modelOk 路径（原始命令）、V1 OnText 链（未闭合 fail-closed
     保留原文时生效）、PID 缺失路径（node 签名不依赖 PID）。

  附带：appendDevServerGuidance 改命令感知——只在命令真实命中进程操作形态
  （kill 族/lsof/pkill/killall/restart-service 词元）时附加 dev-server 引导，
  只读 heredoc 被拦时不再出现答非所问的重启建议（PROCESS_OPS_SHAPE）。
trade_offs:
  - 豁免面只收不扩：体签名识别不了的写 API（mmap 写、fileinput inplace、未来新 API）
    保守拦——豁免是例外，拦截是默认；Known Limitations 与 1038 号特性（DATA_DESTRUCTIVE）
    同先例留痕。
  - bash/sh 体递归 V1 全量链而非词元扫描：体里嵌套 heredoc 不再递归（单层判定），
    嵌套攻击面极窄且闭合体已剥的主基线仍在——换取语义精确（不按词元误拦数据位）。
  - dev-server 引导命令感知而非删除：#844 的受控路径引导对真实进程操作场景仍有
    价值，只裁掉「无差别附加」的噪音面。
  - #1069 受控脚本白名单不在本 PR 范围（issue 明示，勿顺手做）。
verification:
  - npx tsc --noEmit → 0 error
  - npx eslint（改动 6 文件）→ 0 error
  - npm test 全仓 → 306 files / 4357 tests 全绿
  - issue 误拦形态复现：E1 cd wt && git add / E2 git add -A && commit --author / E3
    git rebase / E4 echo && node /tmp / E5 只读 python heredoc / F1 cd wt && git commit /
    F2 cd wt && git merge → 全 PASS（放行）
  - 攻击 PoC 17 形态：裸 kill / env kill / bash -c 内嵌 / xargs -n1 -I{}（本次恢复）/
    ~/bin/kill / FOO=1 kill / cd wt 伪装真杀 / kill $VAR / rm -rf data/metrics /
    体级 os.kill / from os import kill 裸调 / open r+b / os.open O_WRONLY /
    subprocess 调 kill / json.dump 落盘 / shutil.rmtree data / bash 体真 kill → 全 BLOCK
  - 放行面不回归：json.dumps/print、pathlib read_text、'rb' 纯读、node readFileSync
    分析、bash 体 echo kill 字样（数据位）→ 全放行
capability_test_plan:
  - tests/frameworks/agent/bash-safety-guard.test.ts（#1207 主形态 + 加固签名攻防两面 + 跨解释器安全）
  - tests/frameworks/agent/guard-v2-behavior.test.ts（A4 wrapper 连剥 + node 体对称面）
production_assertion:
  assertion: cd <worktree> && git commit/add/rebase 形态命令的 guard_intercept「主仓写」类拦截，未来 30 天 ≤2 条
  baseline: 一周 17+ 条（issue #1207，9/25×14 + 9/29×3）
  check: sqlite healing_events 按 error_type=guard_intercept + description LIKE '%主仓%' 计数
  due: 2026-10-29
known_limitations:
  - python 体签名静态识别不全（mmap 写/fileinput inplace/未知新 API）→ 保守拦
  - heredoc 体嵌套 heredoc 不递归（单层判定）
  - issue 1069 受控脚本白名单未落地，误拦无正道逃生通道（独立 issue 排期）
---

# F20260929hcwd：bash 守卫 #1207 误拦集群修复

## 问题

#1207 记录守卫「主仓写判定」持续误拦（一周 17+ 条），两类形态：

1. `cd <worktree> && git commit/add/rebase` 仍被判「未 cd 到 worktree」拦截
2. 只读 python heredoc 探查被拦，且引导文案是「重启 dev server 请用受控脚本」——答非所问

## 根因（探针实证，非推断）

### 根因一：python heredoc 误拦

`MAIN_WRITE_PATTERNS[1]`（`python3 - <<` 通道正则）按通道形态整体拦，不解析体。
探针实证关键事实：**引号定界 heredoc parseOk=true，走 V2 模型路径**——模型层判体
为数据放行后，文本层补跑的 `checkMainCheckoutWrite(原始命令)` 在未剥体的原文上命中
通道正则。误拦发生在 V2 路径，不是 V1 兑底链。

### 根因二：cd worktree 后写命令

main 的 grv2 架构（modelCdExemption 段级 cd 链）已修复——issue 主根因在开工时已是
绿灯形态。本 PR 固化 6 个 issue 原文形态为回归测试。

### 修复中实证的 V2 安全回归（同 PR 封堵）

3. **wrapper 参数连剥不全**：V2 `effectiveCommand` 对 wrapper 词只剥 1 个参数
   （V1 是 while 连剥全部）——`xargs -n1 -I{} kill {}` 的 argv0 落在 `-I{}`，
   kill 段失认 → #760 A4 攻击 PoC 形态放行。管道右段「字面参数」判定还把 `{}`
   占位符当字面参数（第二漏拦半）。
4. **bash/node heredoc 体直接执行无判定**：`bash - <<EOF` 内 `kill <mainPid>`、
   `node - <<EOF` 内 `process.kill(<mainPid>)` 现状全放行——体级真杀主 PID。

## 方案

| 改动 | 文件 | 内容 |
|---|---|---|
| 体感知豁免 | bash-safety-guard.ts | `PY_BODY_WRITE_SIG` + `pythonHeredocBodiesReadOnly` + 通道 pattern[0] 豁免分支 |
| 重定向判定体隐去 | bash-safety-guard.ts | `blankPythonHeredocBodies`（仅 python 体等长替换空格） |
| heredoc 体级判定 | bash-safety-guard.ts | `checkHeredocScriptBodies`：shell 体递归 V1 全量链 / node 体签名扫描 / python 体跳过 |
| wrapper 连剥对齐 | guard-model-judge.ts | `effectiveCommand` + `effectiveCommandOfSegment` 改 while 连剥；管道右段字面参数收窄为纯数字 PID |
| span 提取基础设施 | quoted-text-sanitizer.ts | `extractHeredocSpans`（header/body/位置，与 blankHeredocBody 同闭合边界） |
| 引导命令感知 | circuit-breaker-helpers.ts | `PROCESS_OPS_SHAPE` 命中才附加 dev-server 引导 |

## 验证

- 全仓 4357/4357 绿 + tsc 0 error + eslint 0 error
- 误拦复现 7 形态全放行；攻击 PoC 17 形态全 BLOCK（含本次恢复的 A4 与 bash/node 体级真杀）
- 放行面：dumps/read_text/'rb'/readFileSync/echo kill 数据位 → 全放行

## 生产断言

`cd <worktree> && git commit/add/rebase` 的「主仓写」类 guard_intercept 未来 30 天
≤2 条（基线一周 17+）。检查：healing_events sqlite，到期 2026-10-29。

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 开发獭-1207
