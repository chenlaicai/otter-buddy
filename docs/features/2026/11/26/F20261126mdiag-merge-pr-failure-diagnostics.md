---
id: F20261126mdiag
title: "merge_pr 合入拒绝回执补合并状态与失败检查定位"
summary: "#1998：分支保护拒绝合入时，工具原先只透传 GitHub 通用 policy 错误。失败后只读查询当前 mergeStateStatus 与 statusCheckRollup，把状态和失败检查名称/链接同时写入人可读文本与机器可读 details；原始错误保留，授权与检视闸不变。"
change_type: fix
capability_test: "n/a: 工具错误回执诊断增强，由 merge-pr-tool 集成单测覆盖外部 gh 调用序列"
intent:
  problem: "merge_pr 在分支保护拒绝时只返回 base branch policy prohibits，调用方无法从回执判断当前 mergeStateStatus 或定位失败检查，需要额外手工 gh 排查。"
  solution: "合入异常后只读查询 PR 的 mergeStateStatus 和 statusCheckRollup，筛出失败/超时/取消等终态检查，将名称、结论与链接写入 details 和错误文本；诊断查询失败不覆盖原始合入错误。"
  expected_effect: "分支保护拒绝 fixture 下，回执 details.mergeStateStatus=BLOCKED，details.failedChecks 含 check 名称与 CI 链接，文本仍含原始 policy 错误；诊断查询异常不覆盖原始错误，完整 merge-pr-tool 套件 41/41 通过。"
  verify_by:
    type: behavior_check
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
causal_links:
  - {type: "fixes", id: "issue#1998", note: "补合入拒绝后的只读诊断与机器可读失败检查定位"}
tags: [merge-pr, diagnostics, github-checks, error-response]
modules: [agent-tools, tests]
---

# merge_pr 合入拒绝回执补合并状态与失败检查定位

## 预注册

- 预期根因：`performMerge` 的 catch 只透传 GitHub 异常，没有查询并附带 `mergeStateStatus` 与失败 checks。
- 成立标准：错误处理代码无诊断查询，新增分支保护拒绝测试因缺 `details.mergeStateStatus` 失败。
- 放弃条件：现状已有等价增强，或拒绝发生后无法可靠执行只读查询；此时改判而非硬适配。

实际与预期一致：修复前 `tool-factory.ts` 的 merge catch 仅返回原始异常文本；新增用例首轮 **1 failed / 39 passed**，失败值为 `mergeStateStatus=undefined`。

## 案发现场与根因

healing `18401348-1d73-49b2-b5bd-8d799cf8ee00`：同 HEAD 因 PR body 编辑触发新 CI 后，已授权合入被分支保护拒绝。工具只回 `base branch policy prohibits`，没有指出新检查失败。

根因是失败回执只有异常透传，缺少失败后的只读状态采集；授权原话闸和独立检视闸均已通过，问题不在闸门判定。

## 方案与设计取舍

合入失败后追加一次 `gh pr view <N> --json mergeStateStatus,statusCheckRollup`：

- `details.mergeStateStatus` 提供机器可读合并状态。
- `details.failedChecks[]` 提供失败检查 `{name, url, conclusion}`；文本同步列出，保留原始错误。
- 兼容 CheckRun 的 `detailsUrl` 与 StatusContext 的 `targetUrl`，覆盖 FAILURE/TIMED_OUT/CANCELLED/ACTION_REQUIRED/ERROR/STARTUP_FAILURE/STALE；后两个值由独立检视按 GraphQL CheckConclusionState 全集补齐。
- 诊断查询失败时返回 `UNKNOWN` 与 `diagnosticError`，绝不覆盖原始合入错误。

被否替代：只匹配 GitHub 错误文案猜原因——同型 policy 错误可能来自落后分支、pending 或失败检查，关键词分类不可靠；只返回原始 `statusCheckRollup` 全量——噪音大，违背定位目的。

机制识别七项均未命中：无新增配置、状态生命周期、后台任务、消息格式、持久化、被记住的决策分支或跨模块调用；仅在既有工具内追加只读 `gh` 查询，走修法决策树①，`Modification-Class: narrow-fix`。

## 失败证据与验证

### 修复前

`npx vitest run tests/interface-adapters/agent-runtime/tools/merge-pr-tool.test.ts` → **1 failed / 39 passed**：新增分支保护拒绝用例的 `result.details.mergeStateStatus` 为 `undefined`，其余既有用例通过。

### 修复后

同一命令 → **41/41 passed**；`npx vitest run tests/interface-adapters/agent-runtime/tools/` → **32/32 文件、295/295 tests passed**；`npm run build`、`npm run lint:intent` 与 `git diff --check` 均通过。失败 fixture 断言：

- `details.mergeStateStatus === "BLOCKED"`。
- `details.failedChecks` 含 CheckRun 的 FAILURE/STARTUP_FAILURE 与 StatusContext 的 STALE，分别验证 `detailsUrl`、`targetUrl` 和 `context` 回退；不含成功的 e2e。
- 错误文本同时含 `mergeStateStatus=BLOCKED`、失败检查 URL 和原始 `base branch policy prohibits merging`。
- 诊断查询超时 fixture 返回 `mergeStateStatus=UNKNOWN` 与 `diagnosticError`，且原始合入错误仍保留。

## 验收标准

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 分支保护因失败检查拒绝 | 重放 merge-pr-tool 的 #1998 fixture | details 含 BLOCKED 与至少一个失败检查名称/URL，原始错误保留 |
| 既有授权与检视路径 | 运行完整 merge-pr-tool 测试文件 | 全部通过，合入与拒绝行为不变 |
| 负向保护 | 检查 merge 调用与诊断调用顺序/类型 | 诊断只在 merge 异常后执行，且为只读 `gh pr view`；不绕过任何授权闸 |

最简实现检查：复用现有 `execFileAsync`、`errorResponse` 与 `ToolResponse.details`，未新增依赖、配置或持久化；仅两个工具内辅助函数和两个回归用例，已达同等语义下的较小实现。

## 影响与回滚

影响面仅 `merge_pr` 失败回执；成功路径、授权原话校验、时间闸、短话术闸、检视闭环闸和审计顺序均不变。无 DB、配置或数据迁移。

revert 本 PR 即恢复旧的纯异常文本回执；代价是 #1998 的诊断缺口重新出现。
