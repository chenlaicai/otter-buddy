---
id: F20261027hpex
title: "沙箱链 heredoc 载荷写主仓判定接防 + 拷贝族目标落主仓窄规则（#1542）"
summary: "sandboxGuarded=true 写面退役时 heredoc 负门一并被跳过，Y1/Y2/Y3/Y6 heredoc 载荷写主仓端到端放行（贯穿性，65c252d2 起存在）；负门移出门控双链同跑接防，另补拷贝族（cp/mv/install/ln）字面目标落主仓窄规则（E1e）。"
change_type: fix
capability_test: "n/a: 确定性守卫判定行为，无 prompt/LLM 行为改动"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: 2026-10-27T14:30:00+08:00
causal_links:
  from: [F20261016gsbx, F20261019gses, F20261027bgkw, F20261019wvcp, F20261009cphr]
tags: [bash-guard, sandbox, heredoc, main-checkout-write, copy-family, security]
modules: [src/frameworks/agent/bash-safety-guard.ts, src/frameworks/agent/guard-model-judge.ts, tests/frameworks/agent/bash-guard-heredoc-sandbox-mainwrite.test.ts]
---

# 沙箱链 heredoc 载荷写主仓判定接防 + 拷贝族目标落主仓窄规则（#1542）

## 背景：案卷与现状大面积不符

#1542 立案（求值器载荷/动态解析缺口：heredoc 载荷漏拦 Y 类 + cp 动态源误拦 E1 类）后 5 天里，#1636/#1643/#1648 连续改写了这个域。大獭 2026-10-27 06:22 修前实证（本 worktree @e8e353a2 复现确认）结论：

1. **E1 cp 动态源误拦已被后续 PR 顺带修复**——E1a-e 全 ALLOW，案卷的误拦现场不复存在（`cp $F /tmp/bak` 双链放行）。
2. **真缺口比案卷宽**：沙箱链下 heredoc 载荷写主仓判定是**整体豁免**，不止案卷描述的 wrapper/管道两形态。
3. 案卷声称「Y3 直挂 runner 已覆盖」**经实证不成立**——直挂形态同样放行。

## 修前矩阵（sg=true 真实沙箱形态 / sg=false 对照）

| 形态 | 命令骨架 | sg=true 修前 | sg=false | 判定 |
|---|---|---|---|---|
| Y1 wrapper | `cd /tmp && env python3 - <<'PY'` 体含 `os.remove(<主仓>/…)` | **ALLOW** ❌ | BLOCK | 漏拦确认（wrapper 段 argv0=env） |
| Y2 管道+wrapper | `cd /tmp && cat <<'PY' \| env python3 -` | **ALLOW** ❌ | BLOCK | 漏拦确认（heredoc 挂 cat、runner 在管道右段） |
| Y3 直挂 runner | `cd /tmp && python3 - <<'PY'` | **ALLOW** ❌ | BLOCK | 漏拦确认——**案卷「直挂已覆盖」系过时描述** |
| Y6 无 cd 管道 | `cat <<'PY' \| python3 -` | **ALLOW** ❌ | BLOCK | 漏拦确认，**二分 65c252d2（10-22）即存在，贯穿性** |
| Y4/Y5 无 cd、cwd=工作区 | `python3 - <<'PY'` 写主仓绝对路径 | BLOCK | BLOCK | 修前拦得住（此形态非沙箱退役面）——修后仍拦（防翻断言） |
| E1a cp 动态源 | `F=/tmp/a; cp $F /tmp/bak` | ALLOW | ALLOW | 已被后续 PR 顺带修复，保持放行 |
| E1e cp 目标主仓 | `F=/tmp/a; cp $F <主仓>/x` | **ALLOW** ❌ | BLOCK | 应拦——修前缺口，随本次收紧 |

## 根因

F20261016gsbx 二期 2b「沙箱接防写面条件退役」把 `writeChannelSkip="file-write"` 门控设在 `checkMainCheckoutWrite` 的**求值器段整体**上（bash-safety-guard.ts `checkMainCheckoutWrite`）：该门控内不仅有 `evaluateWriteVerdict`（文件写落点语义——沙箱 deny file-write* 物理接防，退役合理），还包含着 **#1523 后置负门 `heredocWriteVeto`**（heredoc 体绝对路径/动态源写主仓兜底）。沙箱链下负门随求值器一并被跳过 → heredoc 载荷写主仓判定整体豁免。

这与 F20261027bgkw（#1544）发现的形态同族但缺口不同：#1544 是保留面尾闸 `SUBSHELL_GIT_WRITE_GATE` 壳字符类不认反引号（字符类缺口）；本次是**负门被门控整体吞掉**（挂点缺口）——沙箱 deny file-write 只覆盖直接写，载荷内脚本在沙箱内执行时 `os.remove(<主仓>/…)` 同样被 OS 拒写，但判定层「载荷写主仓意图」的可见性归零，护栏文档口径（体写主仓应 BLOCK）失效。

## 修法

**① Y 类接防（负门移出门控）**：`heredocWriteVeto` 调用点从 `if (ctx.writeChannelSkip !== "file-write")` 块内移到块外——双链同跑。负门本身只加拦不放行（体含主仓绝对路径/动态源 + 体非只读 → 拦），沙箱链放行的「树外写/豁免区写/只读体/数据体」不受影响（对应测试组全覆盖）。

**② E1e 拷贝族窄规则（新增）**：沙箱链专属 `copyFamilyMainDestHit`——`splitShellSegments` 切段 + `parseSegmentHead` 剥 wrapper 后判 cp/mv/install/ln，目标词（`-t/--target-directory` 值或末位位置词）字面可见且 `isInsideMainCheckout` 判真 → 拦。面窄口径（2c 先例）：

- 只判**字面目标**——`cp a $D` 变量目标不拦（沙箱物理接防兑底，窄规则不重建动态判定链）；
- **源不判**——E1a 正道（`cp $F /tmp/bak` 动态源取证）、`cp <主仓>/package.json /tmp`（主仓只读源取证）都继续放行；
- `isInsideMainCheckout` 基元自带 workspaces/worktrees/workforms 豁免区与 realpath 归一，落点语义与全仓一致；
- sg=false 链不跑此规则（求值器 argv 写面 F20261019wvcp 已覆盖，防重复判定）。

**③ modelCdExemption 死导出清理**：全仓 grep 确认 `modelCdExemption` 零调用点（8 处引用全为注释——定义 + write-target-evaluator 2 处 + bash-safety-guard 3 处 + 测试文件 2 处注释），其私有辅助 `cdSegmentStaticTarget`/`effectiveCommandOfSegment`/`WRAPPER_WORDS_FOR_WRITE` 仅被它消费。整链删除（#1523 路由切换后 cd 链豁免由 `evaluateCdTargets` 承担，函数自 10-19 起即死码）。注意 `effectiveCommandOfSegment` ≠ `effectiveCommand`（后者仍在 kill 族判定使用，保留）。

## 翻判面（修后矩阵）

| 形态 | 修前 sg=true | 修后 sg=true | 说明 |
|---|---|---|---|
| Y1 wrapper env python3 | ALLOW | **BLOCK** | 负门双链同跑 |
| Y2 cat \| env python3 - | ALLOW | **BLOCK** | 同上（#1308 右段识别在负门基座内） |
| Y3 直挂 python3 - | ALLOW | **BLOCK** | 同上 |
| Y6 无 cd cat \| python3 - | ALLOW | **BLOCK** | 同上 |
| Y4 无 cd cwd=工作区 | BLOCK | BLOCK | 非退役面，防翻断言 |
| node 同族 writeFileSync | ALLOW | **BLOCK** | 负门 python/node 双族 |
| 动态源 os.environ 拼路径写 | ALLOW | **BLOCK** | #1309 第二触发条件同门接防 |
| E1e cp $F <主仓>/x | ALLOW | **BLOCK** | 窄规则接防 |
| cp 字面 /tmp → <主仓>/y | ALLOW | **BLOCK** | 同上 |
| cp -t <主仓>/data | ALLOW | **BLOCK** | 同上 |
| 树外 heredoc 写（/tmp） | ALLOW | ALLOW | 放行保持 |
| 工作区（data/workspaces）heredoc 写 | ALLOW | ALLOW | 豁免区保持 |
| 只读体 heredoc（print/open().read） | ALLOW | ALLOW | 负门体只读豁免保持 |
| 数据体 heredoc（cat 落树外/工作区） | ALLOW | ALLOW | 非解释器体不参与负门 |
| E1a cp $F /tmp/bak | ALLOW | ALLOW | 防翻判断言（后续 PR 已修） |
| cp <主仓>/package.json /tmp | ALLOW | ALLOW | 源不判（取证正道） |
| cp 目标落工作区 / mv 工作区→/tmp | ALLOW | ALLOW | 豁免区/树外目标 |
| cp a $D（动态目标） | ALLOW | ALLOW | 窄面只接字面，非 .git 落点沙箱兑底 |
| cp a $G（G 溯源到主仓 .git） | ALLOW | **BLOCK** | r1-3：沙箱白名单放行 .git，物理兑底失实的落点溯源接防 |
| cp <主仓>/pkg $D（主仓源+树外动态目标） | ALLOW | ALLOW | r1-1：头词占位修正后放行（修中版本曾误拦） |
| 数据体 heredoc 含 cp 主仓文本 | ALLOW | ALLOW | r1-2：输入剥体（#1304 语义），体文本非命令 |
| sg=false 对照链（Y1/Y3/Y6/E1e） | BLOCK | BLOCK | 回归防翻 |

## 取舍

1. **负门整体移出 vs 沙箱链重建体判定**：选前者——负门是既有基座（#1240/#1308/#1309 三轮演进），双链同跑口径天然对齐；重建专用体判定会产生第二套语义。代价：沙箱链上求值器 ALLOW 的写主仓形态（非 heredoc）仍由沙箱物理接防兜底——这是 2b 退役的既定设计，本次不动。
2. **拷贝族窄规则只接字面目标**：变量目标（`cp a $D`）不拦——但 r1-3 修正：.git 落点是例外（沙箱白名单放行 .git，物理兑底失实），末位动态目标溯源到赋值链字面且落主仓 .git 子树时接防。其余落点变量目标由 sg=false 链求值器 dynamic fail-closed 兜、sg=true 链沙箱物理拒写兜底——窄规则追求零误拦而非判定完备，与 2c 窄规则「面窄、自带消息」先例一致。
3. **拦截消息双段拼接**（`rewriteMainWriteBlockMsg` + `GUARD_CP_BLOCK_MSG`）：前半段保持 main_write 指纹分类归因兼容（healing 台账指纹不改），后半段说真话（沙箱链窄规则口径）。
4. **Y4/Y5 形态实测修正**：案卷矩阵称 Y4/Y5「BLOCK 是因为工作区在写面内——不是机制正确」；本次实测（@e8e353a2）Y4 在 sg=true 下确为 BLOCK，但归因是**负门从未进过沙箱门控之外的路径**……实测修正：Y4 形态走 V1 文本链（parseOk=false）时 `checkPidIndependentRules` → `checkMainCheckoutWrite` 同样受门控影响，其 BLOCK 来自保留面段结构判定（`checkSegmentStructuralWrite` 未退役）+ 求值器回位路径。修后该形态保持 BLOCK（防翻断言固化），机制归因以测试断言为准。

## 验证

| 验证项 | 结果 |
|---|---|
| 新增测试（bash-guard-heredoc-sandbox-mainwrite.test.ts） | 38/38（Y 类 8 + 放行对照 6 + E1 面 10 + r1 处置 14） |
| 守卫族重点回归（gsbx-phase2 / bash-safety-guard / heredoc-body-strip / stdin-shell-feed / cd-forms-s1 / pipe-direct-exec） | 756/756（含新增 38） |
| 全量 vitest | 446 文件 7093 通过 + 6 skipped，零回归（r1 处置后） |
| tsc --noEmit / eslint（改动文件） | 零错误 |
| modelCdExemption 残留引用 | 全仓 grep 仅剩历史注释（bash-safety-guard/write-target-evaluator/测试文件的叙述性注释，指向历史行为非调用） |

## 对抗审视 r1 处置（检视-1659，2026-10-27）

r1 报告 3 严重 + 1 建议，全部落在拷贝族窄规则上（负门接防/死码清理/性能/文档主体验证通过）：

- **严重 1（头词占位）**：位置词循环从索引 0 起算，头词 cp 计入 positionals，导致 `cp <主仓>/pkg $D`（主仓字面源+树外动态目标的备份正道）误拦，而 E1e 的 BLOCK 依赖 bug 凑数。处置：循环改从索引 1 起算（对齐求值器 copyFamilyArgs words.slice(1) 基准）+ 位置位消耗语义改为「非末位动态词占位（源位消耗）、末位动态词不判 dest」——`cp $F <主仓>/x` 的 $F 占源位使 <主仓>/x 成为末位 dest 照拦，`cp <主仓>/pkg $D` 的 $D 末位动态不判放行。
- **严重 2（数据体泄漏）**：窄规则在原始命令上切段，数据体 heredoc 内的 `cp …主仓…` 文本被当真命令拦（#1304 同类回归）。处置：输入先 `stripHeredocPayloads` 剥体（与 checkPidIndependentRules 同款基座——python/node/shell 解释器体保持可见由体级判定承担）。
- **严重 3（.git 兑底失实）**：「变量目标沙箱物理接防兑底」声明对 .git 落点失实——沙箱 profile 白名单 allow .git（bash-sandbox.ts，worktree git 操作需要），`G=<主仓>/.git/hooks/pre-commit; cp /tmp/a.txt $G` 端到端 ALLOW（可写 git 钩子执行面）。处置选「补判定」路径：末位动态目标若溯源到全命令赋值链字面且落主仓 .git 子树 → 拦（面窄：单变量词形，溯源失败不判）；非 .git 落点变量目标维持沙箱兑底（声明限制到真实面）。
- **建议 4（子壳 pre-existing）**：`(cp … <主仓>/…)` 修前已 ALLOW 非 PR 回归，进日报候选池，不在本 PR 处置。

r1 处置调试期还发现并修复一处处置引入的类型 bug（copySegmentTracedGitHit 返回 boolean，调用点误用 `!== null` 判断恒真，导致全树外拷贝误拦）——已被全树外回归断言拦截在合入前。修复后全量 446 文件 7093 通过零回归；r1 探针面（P1a/P1b/P2a/P2c/P3d/. git 溯源族）全部以 r1-* 标签并入正式测试。

## 后续

- #1542 评论附修前实证差异说明（案卷 E1 已被顺带修复、Y3「已覆盖」描述过时、E1e 收紧）。
- 沙箱链上「求值器退役面」的其余裸奔形态（非 heredoc、非拷贝族的字面写主仓，如 `tee <主仓>/x`）由沙箱 deny file-write* 物理接防兜底——按 2b 既定设计不在本次范围；若后续 healing 台账出现沙箱内逃逸实证再行立案。
