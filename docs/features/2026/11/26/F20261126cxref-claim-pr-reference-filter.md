---
id: F20261126cxref
title: "check-pr-claim 按 GitHub 类型过滤叙述性 PR 引用"
summary: "#2001：认领闸把正文裸 #N 全部当待认领 issue，导致历史 PR 引用误拦。现在先读 GitHub issue API 的 pull_request/state，仅对 OPEN issue 查认领；PR 与 closed 引用跳过，真实未认领 OPEN issue 仍阻断。"
change_type: fix
capability_test: "n/a: CI 认领闸逻辑修正，由 check-pr-claim 单测与真实 GitHub API 正反向 fixture 验证"
intent:
  problem: "check-pr-claim 在无 closes 动词时把所有裸 #N 当 issue，未区分 GitHub PR 和 closed 对象，叙述性引用已合入 PR 会被 claim_missing_or_mismatch 阻断。"
  solution: "在认领判定前查询每个引用的 GitHub issue API 类型和状态，selectOpenIssueNumbers 仅保留 OPEN issue；checkClaim 与 main 共用该过滤，评论查询只作用于这些 issue。"
  expected_effect: "仅引用 #1974（PR）时认领闸放行；同时引用 #1974 与未认领 OPEN #2001 时仅 #2001 被阻断；真实 API 正反向 fixture 与 commit-msg/check-pr-claim 32/32 测试通过。"
  verify_by:
    type: behavior_check
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
causal_links:
  - {type: "fixes", id: "issue#2001", note: "按 GitHub 引用类型和 OPEN 状态收窄认领闸工作对象"}
tags: [check-pr-claim, github-api, issue-claim, false-positive]
modules: [ci, tests]
---

# check-pr-claim 按 GitHub 类型过滤叙述性 PR 引用

## 预注册

- 预期根因：裸 `#N` 提取后直接按 issue 查认领，没有区分 GitHub PR 引用。
- 成立标准：叙述性 PR fixture 被 `claim_missing_or_mismatch` 拦截，类型过滤后 PR 放行且真实未认领 OPEN issue 仍阻断。
- 放弃条件：现有提取已排除 PR，或 GitHub 无法稳定判别类型；此时改判而非硬适配。

实际与预期一致：修复前两个新用例 **2 failed / 18 passed**，PR-only 被误判、PR+OPEN issue 产生两条错误而非仅 OPEN issue 一条。

## 案发现场与根因

healing `e36685b9-f7b2-42fe-876b-a1bd06577ca2`：PR body 的「上一轮 #1974」被当作待认领 issue。`extractIssueNumbers` 的裸井号兜底只负责找候选，原实现随后直接对每个号码执行 `gh issue view ... comments`，缺少引用类型和生命周期过滤。

## 方案与设计取舍

1. main 先对每个候选执行只读 `gh api repos/{owner}/{repo}/issues/<N>`，取得 `pull_request` 与 `state`。
2. `selectOpenIssueNumbers` 仅保留 OPEN issue：有 `pull_request` 的引用和非 OPEN 对象跳过。
3. `checkClaim` 与 main 共用过滤；评论只查询保留的 OPEN issue。类型查询失败仍 exit 2 fail-closed。
4. 无待认领 OPEN issue 时明确回显「无引用或 PR/closed 引用已跳过」。

被否替代：继续靠 closes 动词或改写历史引用——会把机械语义缺口转嫁给作者；按号码段/标题猜 PR——不可靠。GitHub API 的 `pull_request` 是类型真相源。

机制识别七项均未命中：无新增配置、状态生命周期、后台任务、消息格式、持久化、被记住的决策分支或跨模块调用；仅在既有脚本内增加只读 API 查询与过滤，走修法决策树①，`Modification-Class: narrow-fix`。

## 失败证据与验证

### 修复前

`npx vitest run tests/scripts/check-pr-claim.test.ts` → **2 failed / 18 passed**：PR-only fixture 被误判；PR+OPEN fixture 同时错误要求 #1974 与 #2001 认领。

### 修复后

- `npx vitest run tests/scripts/check-pr-claim.test.ts` → **21/21 passed**。
- `npx vitest run tests/scripts/check-pr-claim.test.ts tests/scripts/commit-msg-claim-gate.test.ts` → **2/2 文件、32/32 tests passed**。
- `npm run build`、`npm run lint:intent` 与 `git diff --check` 均通过。
- 真实 GitHub API 正向：`node scripts/check-pr-claim.mjs --json-file /tmp/pr2001-narrative-pr.json`（body 仅「上一轮 #1974」）→ exit 0，明确跳过 PR/closed 引用。
- 真实 GitHub API 负向：同脚本 `--json-file /tmp/pr2001-open-issue.json`（OPEN #2000、无有效认领）→ exit 1，`claim_missing_or_mismatch` 仅指向 #2000。

## 验收标准

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 仅叙述性 PR 引用 | 重放 #1974 fixture | 放行，不查认领、不报 claim_missing |
| PR 引用 + 未认领 OPEN issue | 重放 #1974 + #2001 fixture | 仅 #2001 被阻断 |
| closed issue 引用 | 重放 #1999 closed fixture | 放行 |
| 真实未认领 OPEN issue | 对 #2000 执行脚本 | exit 1 且原因仅 #2000 |
| 查询失败 | GitHub 类型或评论查询异常 | exit 2 fail-closed，不默认放行 |

最简实现检查：复用现有 `gh`、提取函数与 `checkClaim`，只增加一个过滤函数和可选 references 参数；未新增依赖、配置、持久化或新的状态机。

## 影响与回滚

影响面是 CI 的 `check-pr-claim` 及其类型声明。commit-msg 正则提取语义不变，真实 OPEN issue 的认领和 F-ID 匹配不变。无 DB、配置或数据迁移。

revert 本 PR 即恢复旧的裸井号全量认领判定；代价是 #2001 的叙述性 PR 引用误拦重新出现。
