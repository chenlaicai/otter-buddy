---
id: F20261019f714
title: 三项次发现根因修复：healing create() 归口两列入列、lint:docs 警告本体清零改名链、守卫写落点 $VAR 溯源与进程名回显收窄
summary: M-f7148deb 三件套一个 PR 根因修复（搭档红线：不打补丁/不改阈值/逐条来）。① create() INSERT 缺 bound_issue/bound_at——归口字段在写入点被静默丢成 NULL：两列入列+接口契约注释+round-trip 测试锁死。② lint:docs 3 warnings 顶满上限 3（本体=三个缺 slug 旧文件名）：补 slug 改名+全链引用同步（grep 零悬空）+历史 lint 开链接订正第二开口（.doc-fix 声明+成对纯路径替换，4 负例锁死）——warnings 归零、阈值一字不动。③ 守卫误拦两面：拦截面=词表命令落点 $VAR 动态源 fail-closed→resolveTargetArgWord 同命令赋值溯源（案发放行、落主仓仍正拦）；归因面=进程名回显把路径 token 误标「进程名模式」→收窄排除（kill/pkill 裸进程名回显保持）。实勘纠正：healing f34409ce 真根因是载荷 execFileSync 命中 exec 类负门（拍板语义），非路径误拦，本 PR 不放宽。
change_type: fix
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
from:
  - F20261019haof（healing age-out 三缺陷修复——本任务三条次发现的报告来源，同对话交接）
  - F20261001lrbk（历史文档改名曾因引用链同步无通道而搁置、改走 lint:docs 豁免上限——本次补机械开口根治）
  - F20260924gfpn（「进程名模式吞路径」第五缺陷排查期误判的实测证伪——本 PR 收窄的是回显层标签，非判定层）
  - F20261009gwte（bash 写落点静态求值器出生文档——本 PR 的 $VAR 溯源是其「落点看事实」第一性原理的补全）
  - F20261019gses（守卫单求值器与载荷负门语义——f34409ce 判定语义出处，本次不改动）
tags: [guard, healing, docs-lint, root-cause, bugfix]
modules:
  - src/frameworks/db/healing/sqlite-healing-event-repository.ts
  - src/usecases/healing/healing-event-repository.ts
  - scripts/lint-historical-docs.mjs
  - scripts/intent-exempt-list.txt
  - src/frameworks/agent/write-target-evaluator.ts
  - src/frameworks/agent/command-model.ts
  - src/frameworks/agent/bash-safety-guard.ts
capability_test: tests/frameworks/agent/bash-guard-processname-diagnostic.test.ts（关联三套：create-bound 3 例、lint-historical-docs-linkfix 5 例、target-arg-var-source 9 例，修复前均红）
---

# 三项次发现根因修复（M-f7148deb）

## 背景与红线

三条「次发现」来自 healing age-out 修复（F20261019haof）交付时的顺手报告，入 M-f7148deb 待办后由搭档拍板一次做完整。搭档红线（原话）：「不允许你打补丁」「警告这个要处理好，不允许去修改阈值」「其余你先别管，一件一件来」——三条全部按根因修，无 ignore/suppress/豁免掩码，阈值数字零变更。

## ① healing create() 缺归口两列（隐性契约雷）

**根因**：`sqlite-healing-event-repository.ts` 的 `create()` INSERT 列清单只有 14 列，不含 `bound_issue/bound_at`——`eventToRow` 映射出来的归口字段在写入点被丢弃，库内恒 NULL。读侧（rowToHealingEvent）本来就支持两列，缺陷只在写侧；既有测试用裸 SQL 直插绕过，契约从未被锁。

**修法**：两列入 INSERT（`row.bound_issue ?? null`）+ 接口 `create()` 注释把「全字段 round-trip、任何字段不得静默丢弃」写成显式契约。

**修复前失败**：基线源码下新测试 `expected null to be 1361`（round-trip 红）——修复后 3/3 绿。

## ② lint:docs 警告本体清零（阈值不动）

**事实基线（三处实测一致）**：本分支基线、origin/main、主仓 checkout 均为 **3 warnings（上限 3，差 1 即爆闸）**，本体全部是三个缺 slug 旧文件名（F20260716i5n2 / F20260826mwrd / F20260826sgpa）。待办台账记载的「第 4 个」在上述三处当前态均不可复现——如实记录，不虚构第四条修复对象。

**修法（警告本体，非阈值）**：
- 三个历史文档补 slug 改名（R100 纯改名 ×2、R096 改名+链接同步 ×1）；
- 全链引用同步：5 个引用方历史文档的链接路径、`scripts/intent-exempt-list.txt` 豁免表条目、signal 两侧代码注释、SignalBadge 测试断言、`src/entities/signal/signal-event.ts` 设计依据指针——改后 `git grep` 三个旧文件名零命中（悬空引用为 0）；
- 历史文档 lint 开「链接订正」第二开口：改名必然要动引用方正文的链接字节，而历史文档 lint 此前只开 frontmatter 通道（F20261001lrbk 因此搁置根治、改走上限豁免——本条就是那个豁免的由来）。新通道要求 `.doc-fix` 声明 + **全部**变更行是成对纯链接路径/反引号 `.md` 文件名替换（行内其余字节逐字节相同、删增一一配对），任何观点/正文/非成对变更仍拦；
- `scripts/lint-docs.mjs` **零改动**，MAX_WARNINGS=3 原样。

**效果**：lint:docs 从 3 warnings → **0 warnings**（837 docs OK）。

## ③ 守卫误拦：实际拦截面 + 归因误导面

**面 A——实际拦截根因（f3d5ebe5 案发，03:10）**：worktree 内 `git reset HEAD; OLD=…; mv "$OLD" "$NEW"` 被 `main_write_resolve` 拦——词表命令（mv/cp/重定向）落点参数是 `$VAR` 时直接 dynamic-path fail-closed，不做同命令赋值溯源。修法：`resolveTargetArgWord` 读 `acc.priorAssignments` 同命令赋值（与 cd 溯源同口径，结果含 `..` 一律不可求值的爬升红线保持），溯源成功后照常走落点判定。双向：落点全树外/运行区 → 放行；落主仓 → **正面正拦**（语义从 fail-closed 升级为落点事实判定，拦截不减）。连带关闭 5 条 dynamic-path 考题 gap（TS-80b0e7bc 迁 allow 等，逐条核过落点：全在 worktree/data-workspaces，无放水）。

**面 B——归因误导根因**：`locateTriggerContext` 的「进程名模式」只做诊断回显（代码注释明写不参与拦截判定），但匹配面把路径里的 `otter-buddy`/`dist/src/main.js` 片段也标成「进程名模式」——该误标连续两次把根因归因带偏（F20260924gfpn 排查期误判史 + 本次次发现报告）。修法：正则加路径紧邻排除（`(?<!\/)…(?!\/)`），路径型 token 不参与进程名判定；kill/pkill 判定通道（kill-segment）一字未动，裸进程名（`pkill -f otter-buddy`）回显保持。

**实勘纠正（对台账叙述）**：healing f34409ce（07:46 high，node -e 案发）**不是**路径误伤也不是进程名误拦——逐行二分实测：无 exec 面的 node -e 载荷（含路径字面量）求值放行，该载荷命中的是 `execFileSync(` 的 exec 类负门（拍板的不可证 fail-closed）。本 PR 不放宽该负门；该事件归口时应记「exec 负门真阳性，设计语义保持」。

## 测试与证据

- **修复前失败（三连，基线源码换入实测）**：① round-trip `expected null to be 1361` 红；② 链接订正通道正例在基线 lint 全拦红；③ 基线换入 9 例红（案发 mv 放行/求值器溯源/E1 债偿还/重定向溯源/拼接/主仓正拦 + 3 例进程名回显误标）。
- **修复后**：针对性 4 套 25 例全绿 + 全量 vitest 全绿 + `tsc --noEmit` 0 error + pre-commit 全闸（check/lint:docs/historical/prompt-anchors 等）通过。

## 影响范围与负向验收

- **阈值零变更**：`MAX_WARNINGS=3` 原样；fixture 计数断言 796/104/82 是语料迁移守恒（考题库完整性锁，非安全阈值）。
- **保护零削弱清单**：kill/pkill 字面 PID 与按名终止仍拦（双向断言 4 例）；exec 负门持续拦截（f34409ce 同形态断言）；落主仓写正拦；历史文档正文观点修改仍拦（4 负例：观点混改/夹带私货/无声明/纯正文）。
- 无新依赖、无 schema 变更、不触 healing 事件数据。

## 下一步

PR 交大獭编排异体对抗审视，搭档终审；f34409ce 等误拦事件的台账归口收尾由大獭处置（结论见「实勘纠正」段）。
