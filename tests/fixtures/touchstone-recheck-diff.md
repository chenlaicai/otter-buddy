# 试金石语料库 · 复裁差异终版（76 条清零记录，双签后收口）

- 双签依据：`review-one-shot-plan-delta` 双签结论（检视獭1360 2026-10-12 18:34 + 大獭签）+ git pull 修正口径（检视獭驳回「pull 非写」，大獭认）
- 终态：**差异清单 76 条全部收口**（0 条遗留），按下列口径归入三库或剔除清单

## 一、git 族终版口径（已呈搭档默认通过 + 检视獭修正）

| 形态 | 口径 | 收敛 |
|---|---|---|
| `git push`（远端目标）/ `git fetch` | **非写放行**（fetch 记档：.git 镜像写残余） | push 族远端项 → ALLOW |
| `git push`（本地路径 / `.` 目标） | 按落点判（例外条款） | 条目内例外注记 |
| `git pull` | **写按落点判**（pull=fetch+merge/rebase，merge 写工作树——检视獭驳回项，已修正） | 无 cd → 条件期望 |
| `git add/commit/merge/rebase/branch -D/checkout/switch/worktree remove` | 写按落点判（与 BC-1 一致） | add 族 28 条无 cd → 条件期望 |
| `git worktree add` | **立豁免**（排除区创建+记账写，不豁免则 R1 强制的 worktree 创建流被系统性拦） | 豁免注记 |

## 二、8 条台账复裁差异（逐条双签处置）

| 条目 | 旧裁决 | 终态 | 依据 |
|---|---|---|---|
| TS-c061 | BLOCK | **条件期望**（wt→ALLOW / main→BLOCK） | 检视獭驳平 ALLOW 放水口（`cat > docs/features/…` 相对路径） |
| TS-c062 | BLOCK | **条件期望** | 检视獭驳平 ALLOW 放水口（`--outDir dist-probe` 相对路径） |
| TS-c071 | ALLOW | **BLOCK** | 条件签核销：「主仓树内」提取来源=git add/git commit 真写段（非 heredoc 正文误提取，提取器无旧病复发） |
| TS-c095 | BLOCK | **ALLOW** | 签：cmdsub 按「载荷递归求值」注记入档（`$()` 内层只读可证） |
| TS-c097 | ALLOW | **BLOCK** | 签维持：依据=git checkout 段；git worktree add 豁免段不计 |
| TS-c098 | BLOCK | **ALLOW** | 签：cmdsub 载荷递归求值注记 |
| TS-c104 | BLOCK | **ALLOW** | 签：cmdsub（`$(grep .env)`）递归可证；写点全落 /tmp/colink 树外 |
| TS-c119 | ALLOW | **ALLOW** | 条件签核销：提取来源核查=误提取（全文零写特征，playwright 纯布局诊断）→ 修法翻正 |

## 三、重刷前后期望变化数（构建记录锚，CI 断言同步钉）

| 变化类型 | 条数 | 说明 |
|---|---|---|
| git 口径翻转（push/fetch 非写 → ALLOW） | **68** | push 族 40 + add 族中翻转项 |
| 新增条件期望（两目录各测） | **108** | 无 cd cwd 不可反查 + 真写/隐式写形态 |
| O-2 归池（脚本内容复裁，hash 钉） | **26** | alpha.sh / smoke-boot.sh / colink service.sh / worktree 调用 otter-buddy.sh / heredoc 生成脚本（三修#3） |
| O-2 剔除（不可得/语义边界待裁） | **20** | 剔除清单 B/C 节 |
| 台账复裁处置 | **8** | 上表 |

- 守恒：allow 780 + block 48 + conditional 108 + excl 30 + appendix 40 = **1006**（unique 全量去向可数）
- 残余面 7 条在拦截池以 `kind=residual_face` 如实钉 BLOCK（名单见剔除清单 A 节，PR body 显式列名）
