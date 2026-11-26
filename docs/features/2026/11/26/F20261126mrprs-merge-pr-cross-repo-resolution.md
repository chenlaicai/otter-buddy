---
id: F20261126mrprs
title: "merge_pr 跨仓解析：repo 入参 + gh 调用显式 --repo"
summary: "#2037：merge_pr 的 gh 调用不带 --repo，用进程 cwd 所属仓解析 PR 号，被管理项目上 100% 失效且授权审计随之断链。现在新增 repo 入参（owner/name 或整条 PR URL），状态门/检视闭环闸/诊断/merge 全链显式 --repo，审计与日志加 repo 字段。"
change_type: fix
capability_test: "n/a: 工具层跨仓行为由 merge-pr-tool.test.ts 判别用例（修复前 4 红→修复后绿）与真实 gh 双向命令验证；检视闭环闸 --repo 由 check-pr-review-closure.test.ts 覆盖"
intent:
  problem: "merge_pr 内部 gh pr view/merge 不带 --repo 也不传 cwd，gh 用进程工作目录所属仓（otter-buddy 主仓）解析 PR 号——在 CoLink 等被管理项目上调用必然 404，合入无法执行；搭档授权后只能手工点 merge，授权闸与审计双通道随之失效，且唯一替代路径（gh api 直打 merge 端点）恰好绕过原话核验闸。"
  solution: "execute 新增可选 repo 参数（resolveTargetRepo：owner/name 或 GitHub PR URL，URL 捎带 PR 号时与 prNumber 核对防错配）；checkPrMergeable / queryMergeFailureDiagnostics / performMerge 的 gh 调用与 checkReviewClosureOnPr 传给闭环脚本的调用全部显式 --repo；check-pr-review-closure.mjs 加 --repo 参数；writeMergeAudit/buildMergeAuditRecord 与 warn 日志加 repo 字段（同号 PR 跨仓不混淆）。"
  expected_effect: "跨仓合入（如 colink-group/CoLink#4052）带 repo 即可全链执行，授权闸与审计完整保留；本仓调用不带 repo 时行为零变化（gh args 不含 --repo，回退进程 cwd 归属仓）。"
  verify_by:
    type: behavior_check
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
causal_links:
  - {type: "fixes", id: "issue#2037", note: "跨仓合入失效：gh 用进程 cwd 解析 PR 号"}
  - {type: "relates-to", id: "F20260922pmgd", note: "授权闸本体（本修复不改授权/审计判定语义，只补目标仓库解析与透传)"}
tags: [merge_pr, cross-repo, github-cli, authorization-audit]
modules: [src/interface-adapters/agent-runtime/tools/tool-factory.ts, scripts/check-pr-review-closure.mjs]
---

# merge_pr 跨仓解析：repo 入参 + gh 调用显式 --repo

## 预注册

- 预期根因：`tool-factory.ts` 的 `checkPrMergeable`（gh pr view）与 `performMerge`（gh pr merge）均不带 `--repo`、不传 cwd；gh 按进程工作目录所属仓解析 PR 号，服务进程 cwd 是 otter-buddy 主仓，被管理项目 PR 号必然查不到。
- 成立标准：带 repo 入参时 gh view/merge/闭环脚本三类调用全部含 `--repo <owner/name>`；不带 repo 时三类调用均不含 `--repo`（本仓零变化）；repo 为 PR URL 时提取 owner/name 且 URL 号与 prNumber 不一致拒绝。

## 修法

- 修法类别：**narrow-fix**（机制识别七项：修复既有工具「合并指定 PR」声明下的参数缺口与解析缺陷，不新增防线/决策点/信息面——授权闸、时间闸、短话术闸、检视闭环闸、审计双通道语义零改动，仅透传目标仓库）。
- 改动点：
  1. `resolveTargetRepo`（新纯函数）：owner/name 或 PR URL → `{repo, urlPrNumber?}`；非法格式结构化报错。
  2. `checkPrMergeable` / `queryMergeFailureDiagnostics` / `performMerge`：gh args 条件插 `--repo`；无 repo 的查询失败文案补「跨仓请传 repo 参数」引导。
  3. `checkReviewClosureOnPr` → `check-pr-review-closure.mjs --repo`（脚本同步加参数，缺省行为不变）。
  4. `writeMergeAudit` / `buildMergeAuditRecord`：审计 title/content 与 warn 日志加 repo（同号 PR 跨仓混淆防御——#2037 影响第 2 条「审计链路断」的姊妹面）。
  5. 工具 parameters schema + description 加 repo 参数（跨仓必带）。
- 设计取舍：
  - **「工作区 remote 回退」层不存在**：issue 期望「缺省回退工作区 remote 解析」，但 ToolContext 无工作区/工作目录数据源（工具层拿不到对话工作区路径），该层不可实现——缺省保持 gh 进程 cwd 行为（本仓调用零变化），跨仓由入参显式声明，description 引导。这是对 issue 期望的三层结构（入参→工作区→cwd）收敛为两层（入参→cwd），属事实边界不属功能缺失。
  - **URL 号与 prNumber 核对**：URL 形态捎带 PR 号时与显式 prNumber 比对，不一致拒绝——防「看错链接传错号」的静默错配合入（合入不可逆，宁可多一次往返）。
  - **prNumber 仍 required**：存量调用兼容 + 与 required 声明一致；URL 自含号也不豁免（一处语义一处声明）。

## 验证

- **失败用例证据（bugfix）**：
  - 单元判别：修复前 `merge-pr-tool.test.ts` 跨仓组 4 failed（stub gh 收到无 --repo 的 args）/ 修复后 46/46 全绿（19:12 失败现场 → 19:14 转绿，vitest 本地复跑可复现）。
  - 真实命令双向（2026-11-26 19:16，主仓 cwd=/Users/orca/ai/otter-buddy）：
    - 失败形态（= 修复前行为，gh 缺省用 cwd 仓）：`gh pr view 4052 --json state` → `GraphQL: Could not resolve to a PullRequest with the number of 4052. (repository.pullRequest)`
    - 通过形态（= 修复后行为，显式 --repo）：`gh pr view 4052 --repo colink-group/CoLink --json state,headRefName` → `{"headRefName":"refactor/dm-send-persist-layer","state":"OPEN"}`
  - 复现步骤：在 otter-buddy 仓 cwd 下执行上述两条命令即可复现失败/通过对比（#2037 issue 正文「复现」节同型）。
- **全量**：tsc --noEmit 0 错误；tests/interface-adapters/ 全目录 + check-pr-review-closure.test.ts = 886/886 通过；merge-pr-tool.test.ts 46/46。
- **环境既有失败排除**：tests/scripts/memory-vec-hygiene.test.ts 4 失败为 sqlite 环境依赖，main 基线（主仓直接跑）同样失败，与本修复无关（改动面不含 memory_vec）。

## Delta（检视发现处置，PR #2065 第一轮审视 2 严重 + 3 建议）

| 发现 | 处置 |
| --- | --- |
| 1（B1 CI）PR body 测试改动声明缺「方向」字段被闸拦 | 补声明段（方向：收紧——闭环脚本加 --repo 缺参 fail-closed 校验，防线增强） |
| 2（B2/B3 声明不符）body/文档声称 title 带 repo 实际只有 content | **补 title**（选修复不选订正声明：审计 title 是列表视图唯一可见行，同号跨仓区分正是本修复目标位），新增用例钉住 |
| 3（建议）URL 号不可解析形态静默丢号 | 正则收紧：pull/pulls 路径形态号不可解析（pull/abc、pull//123）显式拒绝；pulls/123 复数形态顺手支持（号可解析即走核对），新增 3 形态判别用例 |
| 4（建议）跨仓 docs-only 豁免恒失效 | 记录为已知边界（残留表新增行，fail-closed 方向不修） |
| 5（建议）裸仓库主页 URL（无尾斜杠）被拒 | 正则放宽：github.com/o/n 合法（解析 repo-only），新增用例 |

## 影响范围

- merge_pr 工具（新增可选入参，存量调用零破坏）；check-pr-review-closure.mjs（新增可选 --repo）；授权闸/时间闸/短话术闸/审计判定语义零改动。

## 残留与后续

| 项 | 需要搭档介入 | 说明 |
| --- | --- | --- |
| 「工作区 remote 回退」层未实现 | 不需要 | ToolContext 无数据源，事实边界（见设计取舍）；跨仓显式传 repo 已覆盖全部现网场景 |
| 跨仓 docs-only 豁免恒失效 | 不需要 | 闭环脚本豁免判定用本地 git diff，跨仓 headRefOid 不在本地仓必败 → 跳过豁免（fail-closed 方向，非绕过面）；跨仓 docs-only PR 将被要求检视回执，与本仓行为不对称（检视发现 4，PR #2065 delta 记录） |
| #2037 提到的「诱使绕闸」历史案例审计缺失 | 不需要 | 属既有事故（11-25 已手工合入），本修复防止复发，不追溯 |

## Rollback

单 commit revert 即可（无迁移、无配置、无数据变更）。
