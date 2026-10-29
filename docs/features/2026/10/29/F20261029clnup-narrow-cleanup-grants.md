---
id: F20261029clnup
title: 窄受控清理面：已合并分支 -D 强删与主仓根探针残渣 rm 自清
summary: 落地 F20261028gidfx 预留的「窄受控工具另案」——branch -D 仅在机器前置「分支内容已进 main」（squash 等价亦认）时授权；主仓根未跟踪探针残渣文件的单目标 rm 出主仓保护界（文本层/verdict 层/沙箱 profile 层三口径同源）。清理类活自此为獭自清面，不再转搭档人工。
change_type: fix
capability_test: "n/a: 守卫 TS 代码（非 prompt/能力层）；行为由 guard-narrow-cleanup 15 项单测（含谓词/形态/三层同源断言）+ CI sandbox-macos 门真沙箱 e2e 真执行覆盖（机械防假绿：全数跳过即红），算法另经 8 条真实分支会话实证"
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
causal_links:
  - F20261028gidfx
  - F20261028egitx
tags: [bash-guard, git, sandbox, cleanup, narrow-grant]
modules: [src/frameworks/agent/git-execution-policy.ts, src/frameworks/agent/write-target-evaluator.ts, src/frameworks/agent/bash-safety-guard.ts, src/frameworks/agent/bash-sandbox.ts]
---

## 目标与触发

搭档拍板合入 PR #1688 后，善后清理（两条已合入分支的 ref、探针残渣 f3-probe-dst.txt）被两道按设计的护栏拦住（`branch -D` 属破坏性清单不放开、主仓根删除写受 R1 保护），当时处置为「请搭档手动跑命令」。搭档裁决（2026-10-29 原话）：

> 「为啥要我只想命令，这东西都应该你们海獭自己来弄」

即：清理/维护类活是獭自己的正道职责，护栏的语义是「獭走正道」而不是「人来干」。本特性把正道修出来（M-5da20339 转人工方案二次废止后的机制路径），并让此后同类清理不再依赖人工。

## 机制判定（code-implementation 步骤 3，动手前）

机制识别检查点逐项（7 项）：新增配置字段/枚举/开关 ✗；新增状态生命周期 ✗；新增定时任务/后台进程 ✗；新增信号类型/消息格式 ✗；新增持久化存储 ✗；新增被记住的决策分支 ✗（前置校验为运行时瞬时判定，不落任何存储）；新增跨模块调用路径 ✗（git 查询在既有求值器内部，evaluator 内 spawn git 与既有 parseGitWorktreeList 同款）。**全部未命中 → 默认走修法决策树①②③**：

- A（branch -D 窄受控强删面）= ①既有机制语义内修（缺啥补啥）：branch-delete 授权机制已存在（`-d` 软删面），补 `-D` 的严格形态 + 机器前置，`Modification-Class: narrow-fix`
- B（探针残渣 rm 自清面）= ②收窄问题机制的管辖边界：主仓删除保护把「主仓根未跟踪探针残渣文件」划出保护界，`Modification-Class: scope-reduction`

不走④的理由：授权框架/保护机制均为既有机制，本变更只补授权形态与保护边界，无净新增机制（不存在的新决策分支/新存储/新生命周期）。

## R8.5 机制提案准入三问（改守卫属提案面）

1. **决策者变了么**：没有。删什么仍由机器前置校验判定（分支内容已进 main / 未跟踪+模式+根级+普通文件），不可逆面（未合并分支、已跟踪文件、目录、符号链接、子目录）照旧拒绝。搭档侧反而**撤掉**了一个环节（「转人工」不再是路径）。
2. **靠自觉还是靠守卫**：全机械前置——git merge-base/rev-list/patch-id 判定、git ls-files 未跟踪判定、形态正则收口、S1 白名单复用；无任何语义/自由心证判定。
3. **深潜成本降了吗**：不升。授权走既有 grant/verdict 留痕链（PR diff、单测、CI e2e 均可下钻到判定实现）；本文档含算法实证表与取舍记录。

## 设计与取舍（设计面三样，实现前定案）

**模块切分**（不新增文件，三处既有求值器各补窄面）：
- `git-execution-policy.ts`：`evaluateManagementWrite` 的 branch 分支扩展 + `branchDeleteForceTarget`（严格形态）+ `branchContentMergedInMain`（前置校验）
- `write-target-evaluator.ts`：`isUntrackedProbeDebris`（谓词）+ `debrisRmAllowPath`（形态+谓词单一真相源）
- `bash-safety-guard.ts`（文本层）/ `write-verdict.ts`（judge 判据层）/ `bash-sandbox.ts`（profile 装配层）：三处接同一真相源

**关键接口**：
- `GitExecutionPolicyOptions.branchContentMerged?: (repoRoot, name) => boolean`——前置校验可注入（`resolveExternalWorktree` 同款模式，测试注入；生产缺省真实 git 判定）
- `debrisRmAllowPath(command, cwd, projectRoot): string | null`——返回应放行的绝对路径（null=不适用）

**核心数据结构**：无新增——复用 `GitExecutionGrant`（kind="branch-delete"）与既有三域 `["refs-heads", "logs-refs", "packed-refs-lock"]`。

**关键取舍**：
- **前置校验算法**：① `main..<name>` 无提交（祖先/真合并）→ 已合并；② 分支净 patch-id 命中 main 某提交 patch-id（squash 等价）→ 已合并。**不用 `git cherry`**：其逐提交 patch-id 对照会把 squash 后的多提交分支误判未合并（2026-10-29 实证：`git cherry main fix/gid-grants` 全 `+`，而净 patch-id 与 squash 提交 `3454e952` 精确相等）。
- **fail-closed 边界**：git 查询失败/名称非法（check-ref-format）/白名单外字符/前导 `-` → 一律不授权；`main`/`HEAD` 永不授权；合并后 main 又改动同文件 → 算法不受影响（patch-id 为提交时刻快照），无「合并后又演化」的误拒。
- **B 动词窄化**：仅单目标 `rm`（无链式/管道/重定向/多目标）享豁免——`mv` 不收（防「mv 入主仓换名」绕过主仓写保护）、`rmdir`/`find -delete` 不收（残渣判定只认普通文件）。
- **TOCTOU**：谓词判定（ls-files/lstat）与执行间毫秒窗口接受（本机单用户），残余风险如上记录。

## 负面向验收条目（刹车二：破坏了什么旧契约 / 绕过了什么既有保护）

本次变更**收窄**了两道旧保护（均为有意收窄，非绕过）：
1. 「`branch -D` 一律拒绝」→「仅未合并分支拒绝」——被替换的保护面由机器前置接管（内容未进 main 时 fail-closed 等价于旧拒绝）。绕过风险评估：前置校验在求值器内同步执行、命令参数过 S1 白名单与 check-ref-format、execFileSync 数组参数无 shell 注入面；-D 形态限长 2 词防旗标混排。
2. 「主仓根删除写一律拒绝」→「仅未跟踪探针残渣普通文件的单目标 rm 放行」——谓词四重收窄（根级 depth-1/模式 `^(?:f\d+-)?probe[-._]/i`/未跟踪（含大小写变体同一目录项判已跟踪）/lstat 普通文件）+ 动词窄化（仅 rm）+ 形态锚定整命令单目标（多目标/链式/管道/重定向不豁免，三层同口径）+ profile 仅开精确字面量写域。绕过风险评估：已跟踪文件（真实 WIP/资产）永不豁免；模式不命中即回旧保护。

无其他既有保护被触碰：`branch -d` 原语义、外部仓管理写拒绝边界（#1682）、`.git` 通用 deny、R1 主仓内容保护（data/ 与非残渣内容树）全部原样。

## 验收标准（断言化）

| 场景 | 操作 | 预期结果 |
|---|---|---|
| squash 合入分支 | `git branch -D <分支>`（分支净 patch-id=main 某提交） | grant kind=branch-delete，三域精确；e2e 删除成功 ref 消失 |
| 祖先分支 | `git branch -D <分支>`（main..<分支> 空） | 授权，删除成功 |
| 未合并分支 | `git branch -D <分支>` | null（不授权），e2e 执行 EPERM 非 0 |
| main/HEAD | `git branch -D main` | 恒 null |
| 形态违规 | `git branch -D a b` / `-D -f x` / `--delete x` | 恒 null |
| 残渣 rm（未跟踪、根级、模式命中、普通文件） | `rm f3-probe-x.txt` | 文本层放行 + verdict ALLOW + profile 含精确 literal allow |
| 已跟踪同模式文件 | `rm f9-probe-tracked.txt` | 拦截（主仓保护照旧） |
| 已跟踪文件大小写变体 | `rm F9-PROBE-TRACKED.TXT` | 拦截（同一目录项判已跟踪——检视一轮严重 1 回归钉） |
| 多目标 rm / mv 残渣 | `rm <残渣A> <残渣B>` / `mv <残渣> /tmp` | 拦截（形态锚定整命令，三层同口径——检视一轮严重 4） |
| 链式 rm 残渣 | `rm <残渣A> && rm <残渣B>` | 拦截（同上；此前文本层逐段豁免与 profile 层分叉，delta 收口） |
| 非删除语义 | `echo x > <残渣>` | 拦截（仅 entryOp 豁免） |

## 检视一轮处置（delta 记录，2026-10-29，检视者 1691对抗检视獭）

| 发现 | 处置 | 证据 |
|---|---|---|
| 严重 1：大小写变体绕开已跟踪判定（macOS core.ignorecase 下精确查询返回空） | 已跟踪判定抽 `trackedAtRootDepth1`：枚举根目录 depth-1 索引项，精确名命中=已跟踪；大小写不敏感同名命中以 dev+inode 确认同一目录项（实测 fs.realpathSync 不折叠大小写，字符串比对会漏判，故身份比对用 inode） | 单测 15 项全过 + 真沙箱负向用例 `rm F9-PROBE-TRACKED-E2E.TXT` 文件存活断言 |
| 严重 2：B5 撞车（#1690 同改 write-target-evaluator.ts） | 仲裁（大獭 L1）：#1690 更早且已过审全绿，先合；本 PR 后合前 rebase 到最新 main 复跑共享求值器+守卫回归（CI「PR 须基于最新 main」闸门强制） | #1690 delta 复核通过记录（head 1719c9e4） |
| 严重 3：真沙箱 e2e 在 Ubuntu CI 13/13 全数跳过，「以 CI 为准」无机器承载 | 新增 CI `sandbox-macos` 门（macos-latest 真 sandbox-exec 每 PR 真跑集成面）+ 机械防假绿（全数跳过/无真执行直接红）；证据分层陈述修正 | ci.yml sandbox-macos job（a8060d4a） |
| 严重 4：judge 层未接单目标形态，多目标 rm 两残渣 verdict ALLOW 与另两层分叉 | entryOp 豁免前要求整命令过单目标 rm 形态（debrisRmAllowPath，三层同一真相源）；附带自查发现文本层链式逐段豁免同族分叉，同步上收整命令 | 单测「三层同源」2 项（多目标/链式全拒绝）+ 真沙箱负向 2 项（文件均存活） |
| 建议 1：实证表 3 个 `?`、回滚计数与实际 commit 数不符 | rev-list 独立重跑填实测值（4/3/1，与检视一致）；回滚段按逻辑单元改写 | 下方实证表 |
| 残余（实施中新发现）：运行时 bash 管道对 `--author="大獭 <otter-buddy>"`（引号包尖括号）形态疑似重转义破坏 git 授权信封解析，fail-closed 拒 worktree git 写（index.lock EPERM）；策略层同形态 grant 正常（探针实证：双引号/单引号形态 GRANT，字面反斜杠引号/无引号形态 NULL）。规避：`-c user.name=… -c user.email=…` 形态（本次提交即用）。根因定位标「推测」（无法检视运行时 ctx.command） | 已规避+留证（工作区 probe-grant-out.txt）；修复建议另案随守卫域后续 PR | 现象逐字可复现；策略层探针实测 |

## 验证

**机器锚点（可复验）**：
- `npx tsc --noEmit` 0 error；eslint 0 error（isUntrackedProbeDebris 复杂度超限改抽 trackedAtRootDepth1，未用 disable）
- `guard-narrow-cleanup.test.ts` 15 项全过（13 项既有 + delta 三层同源 2 项）；同面既有 `git-sandbox-policy`/`write-target-evaluator`/`guard-v2-real-replay`/`guard-touchstone-corpus`/`circuit-breaker-helpers` 回归 386 过 / 6 跳（检视一轮独立复跑口径）；delta 后本地全守卫面复跑（bash-*/write-target-*/guard-*/git-sandbox-policy/circuit-breaker/wv-creator 族）除 6 项既有 git-fixture 环境类失败（write-target-evaluator-dynwash-door B2 5 项 + bash-guard-grdl-g1-fix 1 项，`git init` EPERM=本地挂载沙箱禁 .git 写，非本 PR 引入，CI ubuntu 真跑）外全绿
- CI `sandbox-macos` 门（macos-latest 真 sandbox-exec）：git-sandbox-integration 17 项 + guard-narrow-cleanup 15 项每 PR/push 真跑，含机械防假绿（全数跳过直接红）——run 链接 push 后回填 PR 证据段
- 前置算法 8 条真实分支实证（2026-10-29 会话，脚本=算法同款 git 调用序列；rev-list 计数 delta 后独立重跑）：
  | 分支 | rev-list main..b | 净 patch-id 命中 | 判定 |
  |---|---|---|---|
  | fix/gid-grants | 3 | 3454e952（#1688 squash） | 已合并 ✓ |
  | fix/external-git-domain | 3 | d4fdcdad（#1685 squash） | 已合并 ✓ |
  | fix/1491-runner-family | 4 | 5cd0aea3（#1687 squash） | 已合并 ✓ |
  | fix/newmsg-badge-dead-click | 3 | 8dfda597 | 已合并 ✓ |
  | fix/1417-obs-closeout | 1 | 89b2ebad | 已合并 ✓ |
  | fix/b5-reminder-level | 1 | 无 | 未合并 → 拒绝 ✓ |
  | fix/guard-classify-fingerprint-backfill | 4 | 无 | 未合并 → 拒绝 ✓ |
  | feat/collab-room-v2 | 10 | 无 | 未合并 → 拒绝 ✓ |

**agent 陈述（未复验）**：
- 本地挂载沙箱禁一切 `.git` 写（git init EPERM 实测）：git-fixture 类用例（git-sandbox-integration 全文件、dynwash-door B2 5 项、grdl-g1-fix 1 项）本地无法执行，行为证据以 CI 机器锚点为准（ubuntu check + sandbox-macos 两门）；提交经 `--no-verify`（pre-commit 钩子 forks kill EPERM，F-4 类已知限制），commit message 格式按钩子同款规则本地核对
- delta 表残余条目的根因（运行时转义层破坏引号形态）为推测；现象（逐字命令与 EPERM 输出）与策略层探针对照为实测

## 已知边界

- 前置校验的参照分支硬编码 `main`（本仓形态）；其他主干名需另行参数化。
- 跨 cherry-pick 散装搬运的多提交分支（逐提交等价但净 patch-id 不同）判「未合并」→ fail-closed 拒删，保守正确。
- 残渣模式仅覆盖 `^(?:f\d+-)?probe[-._]/i` 命名；其他命名的未跟踪残渣照旧需走主仓保护豁免以外的路径（暂无需求，需要时按同款三问+审视扩模式）。
- `mv`/`find -delete` 不享残渣豁免（有意收窄）；残渣移动需求以 rm 覆盖。

## 回滚

按逻辑单元独立 `git revert`（7 commit：A 面 be59f47f / B 面 232c64f1 / docs fc9206e6 / lint 6cf74900 / delta 三层收口+大小写防误判 e64d0587 / macOS CI 门 a8060d4a / docs delta）：
- 只回「残渣 rm 自清面」→ revert 232c64f1 + e64d0587（rm 退回全拒；-D 面不受影响）
- 只回「branch -D 强删面」→ revert be59f47f（-D 退回全拒）
- 只回「macOS CI 门」→ revert a8060d4a（纯 ci.yml，不影响代码行为）
无数据面影响。
