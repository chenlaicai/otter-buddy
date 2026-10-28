---
id: F20261027fivec
title: bash 守卫历史基线洞复核与精确回归锁（#1350）
summary: 在 main@7f575a81 重测 issue #1350 的 B2/B5 及 F20261008h304 记载的 B4 文档形态，当前均已 BLOCK；不伪造修复前后对照、不改生产机制，新增生产入口与求值器双层精确回归测试，锁危险写、fail-closed 契约及 worktree/只读/纯数据/路径边界保留面。原 baseline-b4.mjs / baseline2.mjs 未找回，历史边界如实披露。
change_type: fix
capability_test: "n/a: 纯 A 类确定代码行为回归测试，无 LLM 参与行为"
intent:
  problem: "#1350 将 PR #1343 时期三条 stash 对照线索拆出独立评估，但 issue 标题把 B4/B5 笼统归入 git 写族且原脚本已不在所述工作区；直接按标题重写会造出已被后续守卫演进修掉的机制或误拦有意保留面"
  expected_effect: "以当前生产入口实测收敛历史线索；危险主仓写与 fail-closed 展开形态持续 BLOCK，合法 worktree、git 只读、quoted heredoc 纯数据和主仓仿名 sibling 不被误拦；提供可据证据关闭 #1350 的验收链"
  verify_by:
    type: behavior_check
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: 2026-10-27
from:
  - F20261008h304
  - F20261019gses
tags: [guard, regression, baseline, fail-closed, investigation]
modules: [guard]
---

# bash 守卫历史基线洞复核与精确回归锁（#1350）

编号溯源：原 `F2026102759c4`；按 `F20261027fidrx` 固定 5 字母新写契约改为 `F20261027fivec`。

## 结论先行

**当前无待修放行洞，本 PR 不含生产代码修复。** B2/B5 与 B4 文档形态在最新基线均已 BLOCK；本次只新增调查文档和精确回归锁。没有把修前已通过的断言包装成「失败→通过」，也没有为了交付 PR 把有意放行改成误拦。

## 排查预注册（实测前冻结）

冻结于对话工作区 `preregistration-1350.md`（2026-10-27）：

- **预期方向 X**：经 `cd <主仓> && …` 改落点后，既有写族判定仍未覆盖 B2/B4/B5 中具体危险写形态。
- **验证标准 Y**：在最新基线以同一生产守卫入口逐项重跑，至少一项真实命令 ALLOW，并可定位既有判定链的具体缺口；修前失败探针先失败，修复后不改断言转绿。
- **反例 Z（立即放弃 X）**：原始命令已 BLOCK，或 cwd/仓库归属/沙箱执行语义证明它属于有意保留面。此时只记录已收敛或有意放行，不强造修复。
- **溯源纪律**：B4/B5 不能只凭 issue 标题编造；找不到脚本就明确未找回，同族探针不得冒充历史现场。

本轮命中反例 Z，因此没有进入生产代码修复分支。

## 原始 B2/B4/B5 溯源与不可知边界

| 项 | 可核实的历史记载 | 当前溯源边界 |
|---|---|---|
| B2 | issue #1350 body：`cd 主仓 && git stash push` 曾放行 | 命令明确，可逐项重测 |
| B4 | F20261008h304「既有基线洞」：裸定界体含 `$(rm …)`，剥体豁免下体展开执行体不被逐条判 | 只有语义描述，无完整原命令；本 PR 用 `cat > /tmp/b4-output.txt <<EOF` + `$(rm -f /repo/b4-target.txt)` 作为**文档形态复现**，不称原脚本逐字找回 |
| B5 | F20261008h304 同段：`cd <主仓> && node -e writeFile` 直接脚本写不覆盖 | 原文明确 writeFile；依大獭裁决补同方法族 writeFileSync，测试分别命名 |

原脚本查找范围：PR #1343 issue comments、review comments 与 reviews；对话 `3241317b-99d6-4d78-9248-ff208a7461bc` 工作区递归查找；全 `data/workspaces` 与 `data` 文件名查找；`/tmp`、`/var/folders` 文件名查找；Spotlight `mdfind -name`。均未找到 `baseline-b4.mjs` 或 `baseline2.mjs`。全 `/Users/orca` 的 `find` 90 秒超时，不记为完整无命中证据。

**因此，本 PR 只声称找回文档可证形态，不声称找回原始 B4/B5 脚本或其完整命令。**

## 修前实测：当前基线证据

环境：worktree `fix-1350-git-write-baseline`，HEAD = `origin/main@7f575a81f4bd4acf9fa45d25962e2bef2ada857a`（2026-10-27，`git fetch origin main` 后一致）。探针与原始输出保留在对话工作区 `probe-1350-before.mjs` / `probe-1350-before.log`；调用真实 `checkBashCommandSafety`，并同时记录 `evaluateWriteVerdict` 与 parse/payload 诊断。

| 探针 | 生产入口 | 求值器当前契约 |
|---|---|---|
| B2 `cd /repo && git stash push` | **BLOCK** | `positive`，主仓 git target `/repo` |
| B5 `cd /repo && node -e "…writeFileSync('b5-target.txt',…)"` | **BLOCK** | `positive`，target `/repo/b5-target.txt` |
| B5 `cd /repo && node -e "…writeFile('b5-target.txt',…)"` | **BLOCK** | `positive`，同一主仓 target |
| B4 文档形态：裸 heredoc `$(rm -f /repo/b4-target.txt)` | **BLOCK** | `fail-closed / script-path-dynamic` |
| B4 同族补充：裸 heredoc 反引号 `rm` | **BLOCK** | `fail-closed / script-path-dynamic` |
| 合法 worktree 内 `git stash push` | ALLOW | 无命中主仓保护面的写 target |
| 主仓 `git stash list && git status --short` | ALLOW | git 只读不产写 target |
| quoted heredoc 中 git/node 写字样 | ALLOW | 纯数据，不当危险执行体 |

session 起点为 `/repo` 与 `/repo/data/workspaces/probe-1350` 时，B2/B5 均得到相同 BLOCK 结论，排除只在外层 cwd 恰为主仓时才成立。

## 根因与历史收敛点

### B2/B5：历史 cd 先行豁免已退场

PR #1523 / commit `4d9e7643`（F20261019gses）的 S1 处置删除「cd 命中合法 cwd 即 return null」的提前豁免，要求 cd 形态继续写落点判定。该提交已用 `cd /repo && touch f` 钉住 cd 主仓写。当前源码 `src/frameworks/agent/bash-safety-guard.ts:2395-2417` 先对 main-owned cwd 执行 `evaluateWriteVerdict` 并消费 BLOCK，之后才进入 `cdExemptionWithVeto`。

#1350 增量是把已存在的通用 S1 机制精确锁到 B2 的 `git stash push` 和 B5 的两种 node 相对写形态，不再复制另一套 git 写判定。

### B4：当前能防危险形态，但不夸大永久根因

当前 B4 文档形态通过 `fail-closed / script-path-dynamic` 被拦：动态脚本路径不能进入词面证豁免（类型语义见 `src/frameworks/agent/write-target-evaluator.ts:76`，动态路径返回该 reason 见同文件 `:2461`；unevaluated 到 fail-closed 三键结果的映射见 `src/frameworks/agent/write-verdict.ts:23`）。本 PR 真实断言这一当前契约，不硬编 `positive` 主仓 target，也不宣称历史缺口已由某一次 B4 专用修复永久解决。

反引号探针是同族补充，只证明当前同一危险展开面；它不是原脚本事实。

## 修法决策树与机制识别

1. **是否仍有可复现的放行？** 否 → 停止生产代码修复，进入回归锁路径。
2. **是否为有意保留面？** worktree 写、主仓 git 只读、quoted heredoc 纯数据与主仓仿名 sibling 均须保留 → 加负向测试，不为消除危险词样而误拦。
3. **文档形态是否等同原脚本？** 否 → 测试名、注释和 PR 均显式标边界。
4. **B4 是否应伪装成 positive target？** 否 → 锁当前 `fail-closed` 契约；未来若有针对性重构，应按新语义显式评估并重定文档，而非悄悄改断言。

机制四问均不触发：无新配置、无新状态/存储、无生命周期变化、无跨模块调用路径或新机制。改动文件只有本测试与本文档；`Modification-Class: narrow-fix`（历史行为调查后的窄范围回归锁，不声称生产代码修复）。

## 负向保留面与路径边界

`tests/frameworks/agent/bash-guard-issue-1350-baseline.test.ts` 共 10 条：

- B2 一条；B5 writeFileSync/writeFile 两条；B4 文档形态一条；B4 反引号同族补充一条。
- 合法 worktree 内 git stash 与 node 相对写均 ALLOW。
- 主仓 git 只读 ALLOW。
- quoted heredoc 同时含 git/node/rm 写字样仍 ALLOW，证明不是按危险字样粗暴拦截。
- `/repo-sibling` git stash ALLOW，钉住 `/repo` 与仿名 sibling 的路径边界。

这些测试调真实生产入口，不 mock 守卫；同时断言求值器结果，区分「有主仓 target 的 positive BLOCK」与「求值不出 fail-closed BLOCK」。

## 取舍与影响面

- **不做全局守卫重构**：本单没有现存 ALLOW 根因可修，扩大生产面只会制造无关风险。
- **不改历史特性文档**：F20261008h304 作为历史现场保持原样，本次以 `from` 建立因果链。
- **不宣称原脚本完整恢复**：不可知部分保持不可知；可复现形态才进自动测试。
- **生产行为零变化**：只新增测试与文档；依赖安装产物未纳入 git。
- **issue 处置建议**：PR 合入且 CI 全绿后，可据回归证据关闭 #1350；合入前不自行关闭。

## 机械验收断言

```text
1. npx vitest run tests/frameworks/agent/bash-guard-issue-1350-baseline.test.ts
   => 1 file / 10 tests passed。
2. git diff --exit-code origin/main -- src/
   => 无差异；本 PR 无生产行为改动。
3. npm run check && npm test && npm run lint:docs && npm run lint:intent
   => 全量构建/静态检查/测试/文档校验通过。
4. PR 三项 CI（check / e2e / golden-selftest）均成功。
5. 特性文档与 PR 明示「当前无待修放行洞」「原脚本未找回」「无修前失败→修后通过链」。
```

最简检查：运行第 1 条并核对 B2/B5 `positive`、B4 `fail-closed` 与负向 ALLOW 分层，不只数绿色用例数。

## 自检 / TDD / 异体声明

- 预注册先于修前探针冻结，探针推翻预期后没有暗改预期。
- 本 PR 无生产代码缺口，故不存在修复前红、修复后绿；新增测试在改动生产代码为零的基线上 10/10 通过，是防未来回归的锁，不是已修漏洞的证明。
- 不含 prompt/skill/tool manifest 改动，无新系统能力，无需 capability test。
- 实现者不自审、不组织最终异体审视；PR 与证据交回大獭编排异模型对抗审视。

## 审视处置

### r1（2026-10-27，检视-1664；0 严重、2 建议）

| 发现 | 更好/更差判断 | 处置与证据 |
|---|---|---|
| 文档 B4 段两处源码指针不符语义 | **接受并修复，改了更好**：证据链指针必须直达对应语义；检视指出的 `write-target-evaluator.ts:674-676` 实为 git 双入账注释，`write-verdict.ts:25-28` 实为 positive 返回 | 重读当前 head 后改为 evaluator `:76`（类型语义）与 `:2461`（动态路径返回 reason）、verdict `:23`（fail-closed 映射）；不机械照抄单一替代位置 |
| 相邻 heredoc 测试仍只写「另开 issue 跟踪」的历史指向 | **接受并修复，改了更好**：历史原文可保留，但补当前证据可避免把已锁形态误读成未处理放行洞 | `tests/frameworks/agent/bash-guard-heredoc-body-strip.test.ts` 保留 10/8 历史原文，追加 2026-10-27 / `F20261027fivec` 对 B2 与 B4 文档形态的 BLOCK 回归证据及 #1350 指向 |

两条均为文档/注释精度修正，不改变守卫行为与既有测试断言；无新增 issue、无裁决分歧。修复提交后交原检视獭做 delta 复核，本段不在 delta 确认前预写「通过」。
