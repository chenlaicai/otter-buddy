---
id: F20261024dwtg
title: 词面证洗白通用机制根治（dynamic-path 整体入 UNPROVABLE_TEETH）+ git 写面 .git 爬升锚定（M-05415afd / M-dd668952）
summary: "#1619/#1625 逐族收编后词面 regex 与词表差集动词仍漏收（实证 find 族 e2e 放水）——dynamic-path 整体入 UNPROVABLE_TEETH 通用根治，不再逐族追；配套 git 旗标区动态值缓判保只读面；git 写面落点=cwd 落运行时区时 fs 爬升锚定真实 gitdir（data/workspaces 的 stash drop/pop 实际写主仓 .git 被豁免洗白收口）"
change_type: fix
capability_test: "n/a: 纯 A 类求值器行为修复，无 LLM 参与行为"
intent:
  problem: "①#1619/#1625 收编的是具体族（argv-write-uncovered / tar-unzip-rsync / curl-wget-dd），词面 regex（WRITE_FACE_WORDS/ARG_TARGET_FACE）与词表（TARGET_ARG_COMMANDS）的差集动词漏收同门未来仍会开——基线探针实证 find 在 TARGET_ARG_COMMANDS 不在 WRITE_FACE_WORDS，`find \"$D\" -delete` 落 dynamic-path 被 proveNoWrite 洗成 e2e 正面 ALLOW（含 bash -c 载荷通道）。②evalGitWrite 落点=cwd，cwd 落运行时区（data/workspaces）被豁免洗白——但 git 真实语义向上爬升发现 .git（本仓 workspaces 非独立 git 树，爬升命中主仓 .git）：cwd=工作区时 git stash drop/pop/apply/clear 实际写主仓元数据，wv ALLOW 漏拦（prod 全链靠 V1 文本面兜住，终局判据层自洽缺口）"
  expected_effect: "dynamic-path 整体不进能力 4 豁免（通用门，不逐族追）；git 只读面（-C\"$P\" status/log）旗标动态值缓判不误拦；git 写面在运行时区 cwd 按真实 gitdir 锚定判主仓写；worktree（.git 文件）写自身元数据维持豁免；已清理 worktree 路径不推定（E3/E4 回放面宁放不误拦）"
  verify_by:
    type: behavior_check
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
created_at: 2026-10-24
from:
  tasks:
    - "M-05415afd"
    - "M-dd668952"
---

# 词面证洗白通用机制根治 + git 写面 .git 爬升锚定（M-05415afd / M-dd668952）

## 背景与病灶

### 单 A（M-05415afd）：词面证洗白门逐族收编的尽头

#1619（F20261022mxwv）收 argv-write-uncovered 族、#1625（F20261023wshd）收 curl/wget/dd 族，
口径都是「目标槽不可静态钉 → 不进能力 4 词面证豁免（UNPROVABLE_TEETH）」。但两单收编靠的是
**逐族枚举**——词面 regex（WRITE_FACE_WORDS / ARG_TARGET_FACE）与词表（TARGET_ARG_COMMANDS /
EXTENDED_TARGET_COMMANDS）是两套独立维护的集合，差集动词同门漏收：

**基线复现（探针 /tmp/probe-red.ts + /tmp/probe-e2e.mts，先基线后修法）**：

| # | 形态 | 基线行为 | 机制 |
|---|---|---|---|
| A1 | `find "$D" -delete`（cwd=worktree） | **e2e ALLOW（放水）** | find 在 TARGET_ARG_COMMANDS（词表）不在 WRITE_FACE_WORDS（词面 regex）→ proveNoWrite 成立 → dynamic-path 被主入口洗白口洗成正面 ALLOW |
| A2 | `bash -c 'find "$D" -delete'` | **e2e ALLOW（放水）** | 载荷通道同洗白（subPayloadWashable） |
| A3 | `find -delete`（无路径参） | e2e ALLOW | 落点=cwd=worktree → worktree 自治豁免（**语义正确非洞**，主仓 cwd 变体会拦） |

对照面：词表内动词（cp/mv/tee/touch/mkdir/rm）全在 WRITE_FACE_WORDS → proveNoWrite 恒
false → 修前就 BLOCK（不靠洗白口把关）；`find "$D" -exec rm {}` 因 rm 词面同判 BLOCK。
即**洗白口的实际敞开面=词表与词面 regex 的差集**（find 是实证命中，shred/rmdir 反向差集
是静默断言面属另一 gap 记档不追）。

### 单 B（M-dd668952）：git 写面落点的工作区豁免洗白

evalGitWrite 落点=cwd（无 -C 时）。cwd 落运行时区（data/workspaces/）时被豁免——但 git 的
真实语义是**从 cwd 向上爬升发现 .git（discover git dir）**：data/workspaces 不是独立 git 树，
爬升必然命中主仓 .git。真机验证（/tmp/probe-anchor.ts）：`repo/data/workspaces/conv1` 下
无 .git，git 实际操作的是 `repo/.git`。stash 写族（drop/pop/apply/clear/store/branch，
STASH_WRITE_SUBS）写 refs/stash 栈=主仓元数据，wv 判 ALLOW（终局判据层漏拦；prod 全链由
V1 结构通道「段文本含 git stash 写字样」兜住 BLOCK——双产线一致性 M-3f8d8a0d 面上的分叉）。

## 修法

### 单 A：dynamic-path 整体入 UNPROVABLE_TEETH（通用门，不逐族追）

`UNPROVABLE_TEETH` 增加 `"dynamic-path"`。语义：**落点不可静态溯源与目标槽不可静态钉
（argv-write-uncovered）同属「求值器证明不了」的词面证盲区**——proveNoWrite 词面证对两者
同样全盲，一律不进能力 4 豁免。三处洗白口（subPayloadWashable / heredoc / 主入口）同源生效
（都查 UNPROVABLE_TEETH 集合），不再逐族收编。

**配套（防误伤，A2 缓判）**：dynamic-path 入集后，git 只读面（`git -C"$P" status`/
`log -p`）的旗标区动态值会连带 fail-closed——旗标值求不出对**只读子命令**无写面意义。
evalGitWrite/evalGitAdd 两处同构旗标循环改为**缓判**（pendingDyn）：旗标区动态值先挂起，
子命令分类后落地——写族子命令（GIT_WRITE_SUBS/add）→ 返 dynamic-path（与旧行为同判）；
只读/无静态子命令 → 返 null（原语义，词面证豁免面保住）。bash-guard-git-flag-wording
三条红线用例（`git -C"$P" status` 放行族）守恒验证。

### 单 B：git 写面落点 .git 爬升锚定（gitCrawlAnchor）

evalGitWrite base（-C 目标或 cwd）落运行时区时，fs 只读爬升锚定真实 gitdir：

- `.git` **目录**（本体仓）→ base 锚定为 .git 所在树 → 主仓树判定生效（豁免不再洗白）
- `.git` **文件**（linked worktree，指回主仓 .git/worktrees/<n>）→ 不锚定——写的是
  worktree 专属元数据区，语义=写 worktree，维持豁免
- 爬升到根未发现 / **base 路径不存在** → 不锚定（不推定）——已清理的 worktree 路径
  （guard-v2-real-replay E3/E4 回放面）爬升必命中主仓 .git，但 git 在不存在的 cwd 无法
  运行，推定无意义，宁放不误拦

信任口径：与 fsAbsentPlan/fsContentPlan 同一「只读 fs 查询」口径（机制识别检查点已记档）；
TOCTOU 窗口与牙3 同记档。求值器语义注：爬升锚定只改「运行时区豁免的 git 写面落点」——
通用落点判定（pathWithinMain）不接爬升（非 git 写无爬升语义，dynamic-path 求不出本就
fail-closed）。

## 行为翻转面（有意，逐条对照）

| 命令形态 | 修前 | 修后 | 依据 |
|---|---|---|---|
| `find "$D" -delete` @worktree | ALLOW | **BLOCK**（dynamic-path fail-closed） | M-05415afd 病灶本体 |
| `bash -c 'find "$D" -delete'` | ALLOW | **BLOCK** | 载荷通道同门 |
| 词表动词 `cp/mv/tee… "$D"` | BLOCK | BLOCK（不变） | 修前靠词面 regex 挡，非洗白口 |
| `git -C"$P" status`/`log` | ALLOW | ALLOW（不变，靠 A2 缓判保住） | 红线用例 |
| `git -C"$P" commit` | BLOCK | BLOCK（不变） | 写族缓判落地同判 |
| `git stash drop/pop/apply/clear` @workspaces cwd | wv ALLOW | **wv BLOCK** | M-dd668952 病灶本体（prod 全链修前已由 V1 文本面兜住，修后终局判据层自洽） |
| `cd WT & git commit -m x` @workspaces cwd | prod ALLOW | **prod BLOCK** | grdl-g1 用例翻转：& 右段 cwd=startCwd=workspaces，爬升锚定主仓——git 真实写主仓元数据，旧「沙箱无 .git 空写面」注释前提不再成立 |
| `git stash drop` @worktree cwd | ALLOW | ALLOW（不变） | worktree 元数据区维持豁免 |
| `git push -u origin x`（全静态远端） | ALLOW | ALLOW（不变） | corpus 96a21f3c 面 |
| E3/E4 回放（cd 已清理 worktree && stash/commit） | 放行 | 放行（不变） | base 不存在不推定，宁放不误拦 |

## 红绿链

- **红（修前基线）**：`tests/frameworks/agent/write-target-evaluator-dynwash-door.test.ts`
  A1 三用例（find 族直判+载荷）+ B2 真爬升用例（临时目录构造 repo/workspaces）修前 4 败
  （vitest 实跑钉红）；A2/B1 守恒用例修前即绿（证明修前不靠洗白口把关的面不翻）
- **绿（修后）**：新测试 11/11 绿；agent 目录 79 文件全绿；**全量 425 文件 / 6812 测试全绿**
  （含 guard-touchstone-exam 三库棘轮、guard-v2-real-replay 回放、bash-guard-git-flag-wording
  红线）；e2e 探针 14 形态 13 过 1 探针期望笔误（`find -delete` @worktree 为 worktree 自治
  正确 ALLOW，非洞）
- lint + tsc --noEmit 干净

## delta1 处置（检视猭1636 初轮 request-changes，2026-10-24）

**严重 1（--work-tree 覆盖丢爬升锚定）已修**：探针复现比报告更广——不仅
`--work-tree <ws>`，`--work-tree /tmp/x stash drop`@ws 也 ALLOW（override 落非豁免区同样把
主仓 refs 写面丢出账）。修法=检视建议的双入账：anchored（gitdir 侧）无条件入账 +
workTreeOverride 求值成功时追加第二条（work-tree 侧）；override 求不出维持回落语义。
B2 新增 delta1 用例（分离值/attached/override 落 repo 外三形态均 BLOCK）锁死。

**严重 2（CI lint:pr-tests 闸）已修**：PR body 补「## 测试改动声明」段（见 PR）。

**建议 1（pendingDyn 丢弃族）记档**：子命令位动态（`git "$OP" drop`）返 null 走词面证豁免
——与改前同判（改前旗标循环 w===null 处直接返回同判），非本单引入；#1513「间接构造不追」
口径记档不收。源码 :572 注释补边界说明。

**建议 2（gitCrawlAnchor 双调用 + as string）已修**：改单次调用 const anchor 模式（顺手收）。

**建议 3（.git 文件注释不实）已修**：论证改「政策豁免：worktree 是 R1 认可的正道写区；
元数据物理上仍写共享 gitdir 的 worktrees/<n> 子区，stash/commit 亦写共享 refs/index」——
行为不变（豁免），论证如实。

**--git-dir= 跳过组合（检视报告 H2c）**：大獭裁决「记档不追」——`--git-dir=` 旗标当前
直接 continue 跳过不入账，与 --work-tree 组合可把 gitdir 侧指到任意处；独立面不在本单
病灶谱系（M-dd668952 的 wv(session) 洗白已由爬升锄定收口），记档待后续独立单。

## 非目标（记档不追）

- 词表外命令 evaluated 空集静默断言（`7z a "$D"`/`zip -r`/`pip download -d`）：提取层
  静默断言面，与洗白门不同族（uncovered-cmd 归宿在提取层入账），按 #1513 口径记档
- shred/rmdir（词面有/词表无的反向差集）：静默断言面同上
- 载荷内 git 只读动态 -C（`bash -c 'git -C"$P" status'`）：A2 缓判在载荷递归内同源生效
- gitSegSelfWriteEvidence 未动（写族段自身证据判据保持，缓判只改 evalGitWrite/Add 的
  reason 产生时机）

## 取舍记录

- **一单一 PR**：两件修复面都在 write-target-evaluator.ts 求值器语义层（洗白口集合 +
  git 落点锚定），A2 缓判与单 B 的 .git 爬升在 evalGitWrite 同函数交汇，拆两 PR 会互相
  rebased 冲突；L1 自治判定合并交付
- **缓判 vs 立即返回**：立即返回 dynamic-path 会让只读 git 面误拦（红线用例败）；把只读
  面豁免写进洗白口又弱化通用门——缓判把「动态值」的语义决定权交回子命令分类，两全
- **不存在的 base 不推定**：E3/E4 回放的 worktree 已清理，爬升必中主仓 .git——但命令
  实际跑不了，推定拦截是纯误拦，宁放
- **M-05415afd 原立案为 L2（语义池变更需独立评审）**：搭档 24/10 00:07「按你推荐来」+
  大獭 08:15 重派工落地本批次，本 PR 即该评审的实施载体——语义池变更内容=dynamic-path
  入 UNPROVABLE_TEETH 一行 + 上述翻转面全表，供对抗审视聚焦

## 遗留风险

- dynamic-path 入通用门后，**任何**落点求不出的命令不再被词面证兜底放行——若语料外
  存在「落点动态但确无写」的良性高频形态（如 `mkdir "$BUILD"` 类 CI 脚本），会从 ALLOW
  翻为 BLOCK（fail-closed 语义正确但可能误拦体验）——touchstone 三库全绿证明当前语料
  无此形态，真实使用中若浮出按误拦台账归档（M-2edf95d5 同域）
- .git 爬升锚定引入 fs 只读查询进 evalGitWrite（原纯判定函数）——性能（单次命令多次
  statSync，≤40 跳/段）与 TOCTOU（判定与执行之间 .git 可能变化）已记档，与牙3 同口径
