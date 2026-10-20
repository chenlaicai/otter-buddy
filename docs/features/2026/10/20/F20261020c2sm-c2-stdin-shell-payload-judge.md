---
id: F20261020c2sm
title: C2 工作区落点误判族收口——stdin 喂入 shell 载荷判定语义化（空 token 陷阱修复 + 静态载荷递归判 + 不透明源正确定因）
summary: M-49a4909d C2（写工作区被拦）分层复现：#1240 负门面已被 F20261016grdl 区域下沉修复（经典形态防退化钉在位）；现存活跃面=scanShellFlags 空 token 陷阱（空参段幻影 token 被当「旗标位非旗标」FAIL_CLOSED）——arg-less shell 段（裸 bash/X | bash）全形态误拦且错定因（良性/树外/工作区写都报「落点解析到主仓」），bash - 同语义分裂、bash -e 漏放。修法：陷阱修正 + 管道静态可判载荷（segmentStdoutContent 同基座）递归判 + 不透明源 fail-closed 正确定因 + kill 面补 heredoc 体（B3）。双向变好：写主仓照拦、带旗标旧漏洞收口。
change_type: fix
capability_test: tests/frameworks/agent/bash-guard-stdin-shell-feed.test.ts（拦截侧 11 + 放行侧 12 = 23 例，修前 10 红固化）+ bash-guard-heredoc-body-strip B3 回归 + 全量 406 files 6439 passed + 6 skipped 零失败 + tsc/eslint 零报
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
---

## 问题陈述（两层病灶，探针分层实证）

M-49a4909d 症状「写工作区被拦」（10/14-15 夜 conversation 0d48b657 repeatedIntercept 8 次）在当前 main 上分两层：

1. **#1240 负门×落点语义面（已修，防退化钉在位）**：`cd <主仓> && python3 - <<PYEOF`（heredoc 写工作区路径）——F20261016grdl（10/16）把三区豁免（data/workspaces、.otter/worktrees、.otter/workforms）下沉到 `isInsideMainCheckout` 基元后，C2 经典形态（heredoc python 写工作区）已 ALLOW。案发「8 次」在修复前 + 老实例（10-15 案卷 b9026422 附注「合入后必须 build+重启才生效，老实例仍带误拦」）。
2. **现存活跃面（本特性修复对象）**：`scanShellFlags` 空 token 陷阱——`extractShellCPayload` 的 `after.trim().split(/\s+/)` 对空参产生**幻影空 token** `[""]`，空串走到「非旗标 token 出现在旗标位 = 形态异常」分支 → FAIL_CLOSED → arg-less shell 段（裸 `bash`/`X | bash`）全形态误拦。连带三病：①文案错定因（良性载荷/树外/工作区写都报「写命令落点解析到主仓」）；②`bash -` 同语义（同读 stdin）走 token="-"→FILE→放行（判据分裂实证）；③`bash -e`/`-o pipefail` 带旗标形态走 whitelist→FILE→**漏放**（保护碎片化——真正的不透明管道执行面本来就半开）。今日实证：守卫修复獭探针被此面连拦 3 次（healing 89eb2a30 repeatedIntercept 3，ruleId=main_write_resolve）。

求值器层对照（write-verdict）：`printf 'touch <主仓>' | bash` 求值器 ALLOW（管道载荷零牙口，不落盘直执族 = M-38fb45c0 射程）——旧守卫对管道形态的拦截是「歪打正着」（靠陷阱），不是语义判定。

## 根因（file:line）

- `src/frameworks/agent/bash-safety-guard.ts` extractShellCPayload：`after.trim().split(/\s+/)` 空参 → `[""]` → scanShellFlags 尾部 fail-closed 分支（「非旗标 token 出现在旗标位」本为 `bash -C /tmp -c` 形态设计）
- 同文件 judgeShellCSegment：FAIL_CLOSED → true → checkMainCheckoutWrite 统一发 `rewriteMainWriteBlockMsg`（文案错定因）
- `src/frameworks/agent/guard-model-judge.ts` judgePipeToShell：上游 kill 词样检测只扫 words/commentText，**heredoc 体不在 words**（heredocs 独立结构）——`cat <<'EOF' | bash` 体含 kill 的 B3 旧拦截同靠陷阱，陷阱修后须由词样基座接管

## 机制判定（修法决策树，动手前）

机制识别检查点：新增配置/状态/定时任务/信号/持久化/记住结果的决策分支——全否；**「跨模块调用路径」字面命中**（stdinShellFeederVeto 调用 write-target-evaluator 的 segmentStdoutContent）——论证不涉净新增机制：该导出是既有重建语义（redirectWriteContent/printfFormatContent 单一真相源）的复用暴露，调用方向与 bash-safety-guard 既有 `evaluateWriteVerdict` 引用同向，无新契约/新机制，恰是「一条语义一个接口」原则的执行。→ **修法①既有语义内修（narrow-fix）**：stdin 喂入 shell 的载荷判定对齐 bash -c 载荷的既有语义（可判内容递归判、不可判 fail-closed、kill 面词样口径），非新机制。

## 设计取舍

1. **静态载荷递归走同一 checkMainCheckoutWrite（与 bash -c 载荷同基座）**——而不是新开「管道载荷专用判定」：载荷是被执行的真实命令文本，判定语义与命令文本完全同构（写主仓拦/树外放/工作区豁免一次继承）。检视獭历来把「两条通道两套解析」定为病灶（#1554 发现 3 同款），本修法不制造第二套。
2. **不透明源保持 fail-closed 但文案正确定因**（U5 族「脚本内容未经逐条判定」+ 引导改写为 `bash -c` 形态/拆独立命令）——不放宽不落盘直执面（该族独立立案 M-38fb45c0）；只修错定因（「落点解析到主仓」误导排查方向）。
3. **裸 bash（stdin=EOF）放行**——与 `bash -` 既有口径一致（同语义同判）；heredoc stdin 形态（`bash <<EOF`）的 `<<` 标记交体判通道（scanShellFlags 同 `-` 标记处理），体在场可判不走「旗标位非旗标」误拦。
4. **kill 面基座补 heredoc 体**（judgePipeToShell 上游词样 + 载荷递归 kill 词样兜底）——B3 测试（体经管道真执行含 kill 仍拦）的旧拦截是陷阱副作用，陷阱修正必须由语义基座接管（否则=修复引入真漏洞）。载荷递归的 kill 检查额外兜嵌套上下文（bash -c 嵌套管道——模型层不递归跑 judgePipeToShell 的既有边界）。
5. **裸 cat 定界 heredoc 体|bash**：体即 stdout（静态可判）→ 纳入静态载荷递归（`cat <<'EOF' | bash` 写工作区放行/写主仓拦）；非定界体（含 `$`/反引号）→ 不可判 → fail-closed。
6. **已排除路径**：「只修文案不修判定」（Q 系误拦实证当夜连拦 3 次，只改文案不减误拦）；「arg-less shell 一律放行」（把 `cat f | bash` 不透明面从当前半开状态彻底放开=扩开放面，违保守侧）；「管道载荷另写专用判定器」（双基座分裂）。

## 影响范围

- 行为变化仅限 arg-less shell 段（裸 bash/sh/纯旗标无 -c）与其管道上游：可判载荷（echo/printf 静态词、裸 cat 定界 heredoc 体）从「一律拦」变「按内容判」；不透明源拦截不变（文案变）；`bash -e` 等带旗标形态从「漏放」变「同判」（保护增强）。
- heredoc python/node 体判、bash -c 载荷递归、U5 文件形态、kill 命令位判定均不动。
- 全量 406 files 6439 passed + 6 skipped 零失败（含 guard-touchstone exam/corpus 守恒、B3 回归、wv 62 钉）。

## 验证

- **固化失败（修前）**：23 钉对 stash 源码复跑 **10 failed**（放行侧 9 形态全被旧陷阱拦 + 带旗标拦截钉反向红=旧漏洞）——失败证据即修前行为
- **修后**：同文件 **23/23 绿**；探针语义矩阵 20/20（拦截 10：不透明源×2/静态载荷写主仓/data 破坏/bash -c 递归/wrapper sudo/带旗标收口/cat heredoc|bash 写主仓/bash heredoc 体写主仓；放行 10：良性载荷/树外/工作区(C2)/裸 bash/sh/bash -/heredoc 树外/echo|sh/cat heredoc|bash 写工作区(C2)/C2 经典回归）
- **B3 反向洞防护回归**：`cat <<'EOF' | bash` 体含 kill → 照拦（bash-guard-heredoc-body-strip.test.ts 原钉不动，全量绿）
- **对照组（不能误伤的反面）**：heredoc python 写主仓照拦、重定向写主仓照拦
- 全量 406 files 6439 passed + 6 skipped 零失败；tsc / eslint 零报；最简检查：复用既有重建基座与判定链，无新依赖/新文件（测试除外）
