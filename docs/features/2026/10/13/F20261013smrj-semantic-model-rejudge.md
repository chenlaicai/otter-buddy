---
id: F20261013smrj
title: bash 求值器语义模型落地——撤四条拟合规则 + 补裁簇重裁（棘轮 177→148 shrink_only=PASS）
summary: 派工单「方案 A：语义模型落地 + 补裁簇重裁」执行记录。语义模型三条腿（可求值按落点判 / 不可证回落 / 只读正面放行）取代拟合型假写证据：撤 C'''（X.append→cwd）、C4（print→cwd）、D'（gh pr 变更→cwd）、A'（主仓字面量闸）四条「隐式写→落点=cwd」规则（zdebug 实证 12 条误伤全是 {path:"/repo"} 凭空捏造）；open() mode 三分类修正（python 默认读=非写嫌疑 / 写 mode 字面量=写证据 / 非字面量=不可证 fail-closed，含 mode= kwarg 与 perl 模式）；push 远端目标=非写（本地路径例外按落点判）；pull 补进写族词表（双签终版驳回「pull 非写」）。补裁簇 12 条逐条按 §3.2.1 重批（【重裁前裁决（已废）】留痕可回溯），含派工单点名 4 条同构对与 8 条同族批改笔误。棘轮 177→148（added=0，shrink_only=PASS），全仓 5433/5433 绿。
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
date: 2026-10-13
status: development
modification_class: deletion
---

# bash 求值器语义模型落地（撤拟合规则 + 补裁簇重裁）

## 背景 / 意图锚

- 派工单（大獭 2026-10-13 21:11）：「考题库里有几道题本身批错了答案——不是裁判笨，是题错了。实证：两道一模一样的命令（同一次 PR 操作），一道标「放行」一道标「拦截」；还有「读文件被当成写文件」「打印字符串被当成写路径」这种批改笔误。……之前几轮长出的「迁就错答案的补丁规则」全部撤掉」→ 方案 A：语义模型 + 补裁簇重裁（B 保守回退 / C 豁免 2 键均否决）
- 裁决纪律（派工单原文）：「只许按 §3.2.1 证明演算重批，不许『为过考而豁免』」；「每条留痕【重裁前裁决（已废）】前缀+重裁依据」；「拦截试金石 52 条与负门不许动（重裁只涉放行/条件池的错题，安全侧一道不松）」
- 试金石方法论（搭档原话）：「咱们运行的实际数据作为验证用例……这些数据就是试金石」
- 语义模型（§3.2.1 证明演算，write-word-face.ts 头注释为真相源）：求值器只认真实写调用——可求值按落点判 / 不可证回落 / 只读正面放行

## 预注册（动手前预期）vs 实际对照

- 预期根因方向：12 条 zdebug 误伤与语料自相矛盾对均源于「隐式写→落点=cwd」类拟合规则的假写证据（print/append/gh pr/字面量→凭空捏造 {path:"/repo"}）
- 验证标准：撤除后 EXAM_REGEN 棘轮 shrink_only=PASS（added=0）且命名 4 条重裁后双态全过
- 若证据指向「语料期望正确而求值器欠覆盖」则放弃重裁、改走能力补全
- **预期 vs 实际**：命中为主——12 条重裁（预估 10±2 ✓）+ 棘轮 177→148。**两处偏离**：① TS-15689c88 的 #wt 回归根因是我的 open 三分类把 perl `open(F,"<",…)` 判 unknown（修：perl 模式字面量入分类）；② 53ae7e3f#main 放水暴露 `pull` 根本不在 isWrite 词表（旧判定靠 push 写落点蒙对）——偏离方向均为「求值器欠覆盖」，按预注册分支补能力（pull 补词表），未改语料期望

## 机制判定前置（修法决策树，动手前逐项打勾）

**机制识别检查点**——本次修复是否涉及：

- ☐ 新增配置字段/枚举/开关 —— 否（isWrite 词表加 `pull` 属既有判定表的语义补全，非新配置面）
- ☐ 新增状态生命周期 —— 否
- ☐ 新增定时任务/后台进程 —— 否
- ☐ 新增信号类型/消息格式 —— 否
- ☐ 新增持久化存储（表/字段/文件） —— 否（语料三库为既有 fixture 的内容修正与移池，schema 零新字段）
- ☐ 新增决策分支（结果被记住并影响后续） —— 否（openModeKind 三分类为纯运行时判定分支，无状态记忆）
- ☐ 新增跨模块调用路径 —— 否（write-word-face ⇄ write-target-evaluator 既有依赖关系不变）

**全部未命中 → 默认走修法决策树 ①②③，不涉 ④ 新增机制（无需机制预算四问/重对抗门）。**

**修法决策树判定**（主体 + 附带分别归属）：

- **主体 = ③ 删除机制**（`Modification-Class: deletion`）：撤 C'''/C4/D'/A' 四条拟合规则。按决策树③须「接受其当初解决的原始问题回归」——本例**不存在需接受的回归**：四条规则各自「解决」的考题（TS-fa07af97/TS-f35c7144/TS-508d0cc8/TS-66da667b）经重裁证实其裁决本身是批改笔误（假写证据/能力 7 漏网），删除后这些考题由语义模型正道全部通过（shrink_only PASS、added=0 实证）
- 附带 = ① 在既有机制语义内修（缺啥补啥）：open mode 三分类、push 远端口径对齐双签、pull 补 isWrite 词表
- 语料重裁 12 条 = 数据修正（考题答案批改），非机制变更，不占决策树席位

## 设计取舍

### 1. 撤 C'''/C4（append→cwd / print→cwd 假写证据）

zdebug 实证 12 条误伤的写目标全是 `{path:"/repo", via:"cmd-arg"}` 凭空捏造（纯计算/只读载荷被捏出 cwd 写）。语义模型下 print/append 是数据操作不是文件写调用，不构成写证据。配套重裁 TS-f35c7144/TS-fa07af97（其「隐式写→落点=cwd」裁决随规则一起作废）。

### 2. 撤 D'（gh pr edit/merge/close/reopen/create→cwd）——同构对按内容判到一致 = 双 ALLOW

- 双签既有口径明文：「gh issue comment（**外部写不落本地树**）」（TS-6a5cc1b2 裁决原文）；语料压倒性一致：gh pr edit（TS-c084/c085/TS-324eaad4/TS-3b2fd2b2/TS-05537e52）、gh pr create（TS-a4c2ffa4）、gh issue create/comment（TS-fea396ea/TS-c092）、gh pr review --comment（TS-9e996401/TS-7715da07）全 ALLOW
- TS-508d0cc8 的「主仓树内×1/4」证据自身错误（`__HEREDOC_DATA__(/tmp/pr1269-body-update(重定向)` 被标主仓树内——/tmp 不在主仓树内）；与 TS-a6dfe989（同 pr1269-body 操作族，ALLOW）判到一致 = 双 ALLOW
- ⚠️ **派工单条款张力旗标（呈大獭知悉）**：TS-508d0cc8 是拦截池条目，派工单 point 2 将其列为重裁目标（「同构对按内容判到一致」）vs point 5「拦截试金石 52 条与负门不许动（重裁只涉放行/条件池的错题）」——两条款字面冲突。按 point 2 **具名授权**执行（重裁点名 = 例外授权），「安全侧一道不松」理解为不得把真写放行（本案写证据全落 /tmp 全树外，无真主仓写）。若裁决方向应为双 BLOCK（D' 保留），回滚成本 = 一条脚本 + 恢复 D' 块，随时可翻案

### 3. 撤 A'（c062 主仓字面量闸）+ 形态B 字面量闸限定只读载荷

- A' 是建立在 TS-66da667b「主仓树内×1/1」裁决上的拟合闸，而该裁决已按能力 7 拍板翻正（目标 data/workspaces/…=沙箱非主仓树，同构 TS-67845f56/TS-ad11a060 翻正先例）
- 语义模型下字面量出现在字符串里不构成写证据（TS-ee23c745 双签：「写形态仅存在于字符串字面量（cmd 数据），非调用点——按 §3.2.1 调用点语义不构成写证据」）；写调用参数不可求值→回落的 fail-closed 已覆盖变量间接面（resolveScriptArg null→回落）
- 形态B 路径字面量闸（c100 语义）限定 `!hasWriteCall`：只读载荷的主仓字面量仍回落（防线不破）；写载荷落点已由形态A正面判定，字面量不重复当闸（否则 `open('/repo/x','w')` 这类写主仓正向拦截被自家闸误回落）
- 已知残余面（记档）：提取词面外写形态（`Path.write_text` 等）×主仓字面量间接——随词表收编收敛

### 4. open() mode 三分类（open 未知 mode 修正，病理按 §3.2.1 规则 1）

- **read**：1 参 open（python 默认读模式=**非写嫌疑**）/纯读字面量（r/rb/rt/perl `<`）
- **write**：写 mode 字面量（w/a/x/+ 族、r+、perl `>`/`>>`/`+<`/`+>`/`+>>`）
- **unknown**：mode 非字面量（变量/调用/空字面量）→ **不可证 fail-closed 回落**——修复旧 fail-open：`open(p, mode='w')` kwarg 形态曾被当「无 mode」误判读；`open(p, m)` 变量 mode 曾被当读
- word-face 侧（openCallUnknownMode/openCallWriteHits）与提取通道（openModeKind）双侧同语义

### 5. git 语义对齐双签终版

- **push（远端目标）= 外部写不落本地树→非写放行**（10 条 allow 考题「双签口径：git push（远端目标）归非写放行」）；push 目标为本地路径/`.`（罕见）例外按落点判
- **pull 归写按落点判**（双签终版：检视獭驳回「pull 非写」——pull=fetch+merge/rebase）——求值层 isWrite 词表补 `pull`（53ae7e3f 语料期望正确，属求值器欠覆盖，未动语料）
- 旧链对齐锚已记档分叉：GIT_WRITE_SUBCOMMAND（旧链正则）仍按写族拦 push——旧链退役时自然收敛，本 PR 不动生产判定

### 6. 测试期望变更（2 条，附依据）

- 「git push origin HEAD → 拦」→「远端目标→非写放行」+ 新增本地路径 push 负门（`git push /repo/x` 仍拦）——依据=双签口径「git push（远端目标）归非写放行」（语料 10 条同判）
- 「git push 主仓 cwd 带 2>&1 管道 → 仍拦」→ 命令体换真写写族（git commit）继续钉「fd 复制不放行真写」——原载体 push 远端不再构成真写，负门语义由 commit 写族保真

## 补裁簇重裁清单（12 条，逐条【重裁前裁决（已废）】留痕）

| 条目 | 移池 | 重裁依据（摘要） |
|---|---|---|
| TS-508d0cc8 | block→allow | gh pr edit=外部写不落本地树（TS-6a5cc1b2 明文）；原证据 /tmp 被标主仓树内自相矛盾；与 TS-a6dfe989 同构对判一致 |
| TS-66da667b | block→allow | 能力 7 拍板：data/workspaces=沙箱（同构 TS-67845f56 先例）；原「主仓树内×1/1」漏网批改笔误 |
| TS-f35c7144 | cond→allow | 纯计算无写（lunardate 日期运算+print）；原「隐式写」= C4 假写证据 |
| TS-fa07af97 | cond→allow | json.load/glob/open(f).read 只读族（派工单点名「读文件被当成写文件」翻正） |
| TS-15689c88 | cond→allow | perl `open(F,"<",…)` 只读读文件被当成写文件 |
| TS-da5c5ca3 | cond→allow | gh pr review=外部写 + `$(cat <<EOF)` 只读 |
| TS-14bd05b6 | allow→cond | cwd 不可反查（证据明示真 cwd=非主仓）→ 两目录各测（双签既有口径） |
| TS-d79005bb | allow→cond | 同上（git add/commit 族同形态） |
| TS-affb0ba6 | allow→cond | git cherry-pick=仓库状态写按落点判（原「只读/纯计算」与写词面表及双签口径矛盾）→ 双态各测 |
| TS-c139 | cond→block | argv[2]→/repo/b 绝对主仓路径两态皆写（机械双态模板误用，#wt=ALLOW 是放水口） |
| TS-c141 | cond→block | 同上（argv[1]→/repo/data/x） |
| b1c9e7ec | cond→block | 绝对路径写 /repo/.otter/local-stash-backup（非排除区）两态皆 BLOCK（机械双态模板误用） |

守恒：三库总数 921 不变（allow 767→770 / block 49→50 / cond 105→101），跨库唯一性断言过，字面量计数锚同步（767/49/105→770/50/101）。

## 影响范围

- `src/frameworks/agent/write-target-evaluator.ts`：撤 C'''/C4/D'/A'；open 提取通道三分类（openModeKind）；isWrite 补 pull；push 远端非写+本地例外；形态B 字面量闸限定只读载荷
- `src/frameworks/agent/write-word-face.ts`：openModeOf/classifyModeLiteral 三分类（默认读=非写嫌疑、mode= kwarg、perl 模式、未知→不可证）；openCallUnknownMode 修正；payloadWriteFaceHit 并入未知 mode 闸
- `tests/fixtures/guard-touchstone-{allow,block,conditional}.json`：12 条重裁移池 + meta 计数
- `tests/frameworks/agent/write-target-evaluator.test.ts`：2 条期望变更 + 1 条本地 push 负门新增
- `tests/frameworks/agent/guard-touchstone-{corpus,exam}.test.ts`：字面量计数锚同步

## 验证

- **棘轮**：177→148，`shrink_only=PASS`（added=0，逐池 allow removed 群/block 1/cond 7 全为删除键）
- **全仓**：`npx vitest run` 5433/5433 绿（360 文件）；evaluator 78 例绿
- **正反双侧**：放行面（zdebug 12 误伤全清、push 远端 10 条、沙箱写、纯计算）+ 拦截面（本地 push 负门、argv 绝对路径双态 BLOCK、fd 复制不救真写、$W 爬升回落族保持）均钉测试
- 命名 4 条（TS-f35c7144/fa07af97/a6dfe989/508d0cc8）+ 全部 12 条重裁后双态过考，无一靠「回落恰好放行」

## 残余面与立档

1. **4 条拦截池疑似同族批改笔误（未动，呈大獭拍板）**：TS-2ddd1c90 / TS-c60ababd / TS-d1c92c6e / TS-e94be41a（`cat >> /repo/.otter/worktrees/wt/… <<EOF`）——裁决证据 `__HEREDOC_DATA__(/repo/.otter/worktrees/…` 被标「主仓树内」（.otter/worktrees/ 是排除区，证据自相矛盾，与 TS-508d0cc8 同族）。按「拦截池冻结+未点名不擅动」纪律立档不动——**要不要一并翻正，一句话可决（脚本一分钟）**
2. 提取词面外写形态（Path.write_text 等）×主仓字面量间接 = A' 撤除后的已知残余（随词表收编收敛）
3. 旧链 GIT_WRITE_SUBCOMMAND 与求值层 isWrite 的 push 分叉已记档（旧链退役收敛）
4. 检视獭1360 补签欠账（TS-080c6544 / TS-f6fe2325）待 PR 审视时双签收口

## 后续

- 能力 3 收尾清棘轮（148→0）为下一棒（fail-closed(heredoc-script-payload) 88 条大头）
- 对抗审视（检视獭1360，模型错开）→ delta 复核 → 大獭/搭档终审
