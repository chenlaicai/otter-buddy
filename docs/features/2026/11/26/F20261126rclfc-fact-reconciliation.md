---
id: F20261126rclfc
title: "对账归档接受合入事实 fact：工具与日报对账段契约统一"
summary: "#2046：archive_artifact_for_reconciliation 白名单拒绝一切 fact，但日报对账段真相源要求「合入事实」（title 含合入 + PR 已合入）可经对账归档——跨对话合入事实长期滞留 active。现在 fact 走 merge-fact 结构判据（title 含「合入」+ #N 号可解析 + evidence 含 MERGED/CLOSED 终态词与对应号），三类结构缺陷分类拒绝，file/url/game 仍一律拒绝。"
change_type: fix
capability_test: "n/a: 集成测试 manage-key-info-reconciliation.integration.test.ts 新增 3 用例（现场放行 + 四类拒绝面 fail-closed），真实 sqlite 库验证审计三列落痕"
intent:
  problem: "日报对账段（prompts/scheduled/daily-health-check.md）要求跨对话「合入事实」fact 经 archive_artifact_for_reconciliation 归档，但工具白名单仅 pr/worktree/branch——fact 一律拒绝。已合入事实长期滞留 active，反复制造对账噪声；其他对话无合法替代入口，直接改库绕过审计与归属闸。"
  solution: "实体层新增 checkMergeFactResource 结构判据（单一真相源）：resourceType=fact + title 含「合入」+ body #N PR 号可解析 + evidence 含 MERGED/CLOSED 终态词且提及对应号 → 放行并写审计三列；三类结构缺陷（非合入事实/无法解析 PR/非终态证据缺失）分类 fail-closed 报错；file/url/game 白名单外仍一律拒绝。工具 description 同步契约。"
  expected_effect: "跨对话合入事实可带机器证据经对账路径归档（issue 现场样本形态：title「AI 雷达持久化入库完成（PR #1378 已合入）」+ evidence「gh pr view 1378 --json state → MERGED」）；非合入事实、无号、无终态证据、号不匹配四类仍拒绝且不写库。"
  verify_by:
    type: behavior_check
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
causal_links:
  - {type: "fixes", id: "issue#2046", note: "工具白名单与日报对账段契约冲突"}
  - {type: "relates-to", id: "F20261113recon", note: "受控对账归档路径本体（本修复扩展其 fact 判据，pr/worktree/branch 行为零变化）"}
tags: [artifact-reconciliation, contract-alignment, fail-closed, daily-health-check]
modules: [src/entities/conversation/conversation.ts, src/usecases/conversation/manage-key-info.ts, src/interface-adapters/agent-runtime/tools/artifact-tools.ts]
---

# 对账归档接受合入事实 fact：工具与日报对账段契约统一

## 预注册

- 预期根因：#1835 引入对账归档时白名单只收 pr/worktree/branch（「fact 判定依赖人工判断」的设计假设），与日报对账段真相源（「合入事实」类 fact 应可归档）契约冲突——两侧口径从未对齐。
- 成立标准：issue 现场样本形态（跨对话 fact、title 含「合入（PR #N 已合入）」、evidence 含 gh MERGED）放行并写审计三列；非合入事实/无号/无终态证据/号不匹配四类拒绝且状态保持 active。

## 修法

- 修法类别：**narrow-fix**（机制识别：修复工具与日报真相源的既有契约不一致——日报段早已定义「合入事实可归档」的行为，工具白名单未跟上；不新增防线/决策点，审计三列模型原样复用）。
- 改动点：
  1. 实体层 `checkMergeFactResource`（判据单一真相源，结构校验不含外部命令）：fact + title 含「合入」+ body `#N` 可解析 + evidence 含 `\b(MERGED|CLOSED)\b` 终态词且词边界数字含对应号 → `{ok:true}`；三类缺陷返回结构化 reason。
  2. `archiveResourceForReconciliation`：白名单外且非 fact → 原「非机械可判」拒绝；fact → 调判据，按 reason 分类报错（非合入事实 / 无法解析 PR 号 / 非终态证据缺失）。
  3. 工具 description 同步契约（可归档面、拒绝面、GOTCHA 不变）。
- 设计取舍：
  - **信任模型与 pr/worktree/branch 一致**：工具做结构校验，PR 终态真实性由调用方核实（日报流程先 `gh pr view` 再调用），evidence 全文落审计三列事后可查——工具不执行外部命令（usecase 层无 gh 依赖，与既有实现同构）。
  - **「号不匹配」并入 no_terminal_evidence 拒绝面**：evidence 提及的 PR 号与 fact 声明的号无交集 = 终态证据缺失（防「拿别的 PR 的 MERGED 证据归档这个 fact」的错配）。
  - **file/url/game 不放松**：白名单外且非 fact 的类型维持原拒绝文案（错误信息不再误导性包含 fact）。

## 验证

- **失败用例证据（bugfix）**：
  - 修复前：issue 现场形态（fact + title 含合入 + #1378 + evidence MERGED）调用 → `非机械可判资源（fact）不能经对账路径归档`（issue 案发现场记录 + 修复前代码路径 `isReconciliationArchivableType` 白名单不含 fact，静态可证）。
  - 修复后：新增 3 用例全绿——现场放行（审计三列落痕断言）+ 四类拒绝面（非合入/无号/无终态词/号不匹配，全部不写库）。
- **全量**：tsc --noEmit 0 错误；eslint 0 错误（第一稿判据内联触发 max-lines/max-statements/unused-import 三错，重构为实体层单一真相源后归零——判据收敛顺带修设计冗余）；tests/usecases + architecture + interface-adapters 全目录 3196/3196。

## 影响范围

- archive_artifact_for_reconciliation 工具（fact 判据扩展；pr/worktree/branch 路径零变化）；日报对账段与工具契约一致化；审计三列模型原样。

## 残留与后续

| 项 | 需要搭档介入 | 说明 |
| --- | --- | --- |
| 跨仓 fact 的 #N 归属仓未区分 | 不需要 | evidence 号匹配只做数字交集，跨仓同号概率极低且审计 evidence 全文留痕可查；如现网出现误配再收紧 |
| 日报对账段 prompt 无需改动 | 不需要 | 真相源本来就是它，本修复是工具侧对齐 |

## Rollback

单 commit revert 即可（无迁移、无配置、无数据变更）。
