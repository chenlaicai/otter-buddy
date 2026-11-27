---
id: F20261127rclfc
title: "对账归档接受合入事实 fact：工具与日报对账段契约统一"
summary: "#2046：archive_artifact_for_reconciliation 白名单拒绝一切 fact，但日报对账段真相源要求「合入事实」（title 含合入 + PR 已合入）可经对账归档——跨对话合入事实长期滞留 active。现在 fact 走 merge-fact 格式硬约束判据（title 含「合入」+ #N 号可解析 + evidence 整体匹配单行模板 gh pr view <N> --json state → MERGED/CLOSED），三类结构缺陷分类拒绝，file/url/game 仍一律拒绝。"
change_type: fix
capability_test: "n/a: 集成测试 manage-key-info-reconciliation.integration.test.ts 20 用例（现场放行 + 四类拒绝面 + 两轮对抗回归 + 全锚定模板 13 形态），真实 sqlite 库验证审计三列落痕"
intent:
  problem: "日报对账段（prompts/scheduled/daily-health-check.md）要求跨对话「合入事实」fact 经 archive_artifact_for_reconciliation 归档，但工具白名单仅 pr/worktree/branch——fact 一律拒绝。已合入事实长期滞留 active，反复制造对账噪声；其他对话无合法替代入口，直接改库绕过审计与归属闸。"
  solution: "实体层 checkMergeFactResource 格式硬约束判据（单一真相源）：resourceType=fact + title 含「合入」+ body #N PR 号可解析 + evidence 整体匹配全锚定模板「gh pr view <对应号> --json state → MERGED/CLOSED」（单倍空格、固定 → 字形、终态词大写、含换行即拒、全行仅一个号）→ 放行并写审计三列；三类结构缺陷（非合入事实/无法解析 PR/证据非严格模板）分类 fail-closed 报错；file/url/game 白名单外仍一律拒绝。工具 description 同步契约。"
  expected_effect: "跨对话合入事实可带机器证据经对账路径归档（issue 现场样本形态：title「AI 雷达持久化入库完成（PR #1378 已合入）」+ evidence「gh pr view 1378 --json state → MERGED」）；非合入事实、无号、证据非严格模板、号不匹配四类仍拒绝且不写库。"
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
  1. 实体层 `checkMergeFactResource`（判据单一真相源，格式校验不含外部命令）：fact + title 含「合入」+ body `#N` 可解析 + evidence 整体匹配全锚定模板「gh pr view <对应号> --json state → MERGED/CLOSED」→ `{ok:true}`；三类缺陷返回结构化 reason。〔搭档裁决 B（格式硬约束）已实施——判据演进见「僵局记录与裁决」节〕
  2. `archiveResourceForReconciliation`：白名单外且非 fact → 原「非机械可判」拒绝；fact → 调判据，按 reason 分类报错（非合入事实 / 无法解析 PR 号 / 非终态证据缺失）。
  3. 工具 description 同步契约（可归档面、拒绝面、GOTCHA 不变）。
- 设计取舍：
  - **信任模型与 pr/worktree/branch 一致**：工具做结构校验，PR 终态真实性由调用方核实（日报流程先 `gh pr view` 再调用），evidence 全文落审计三列事后可查——工具不执行外部命令（usecase 层无 gh 依赖，与既有实现同构）。
  - **「号不匹配」并入 no_terminal_evidence 拒绝面**：evidence 模板捕获的 PR 号与 fact 声明的号无交集 = 终态证据缺失（防「拿别的 PR 的 MERGED 证据归档这个 fact」的错配）。
  - **全锚定模板是硬约束不是风格偏好**：自由文本上的语义判定属不可机械判定域（三轮对抗证伪，见僵局记录）——宽容变体（`\s+`、多箭头、大小写、引号、行内插叙）每一个都是变体绕过面。单一字面形态零宽容后，变体空间趋零；代价是调用方须按模板写 evidence，拒绝消息携带模板教学。
  - **file/url/game 不放松**：白名单外且非 fact 的类型维持原拒绝文案（错误信息不再误导性包含 fact）。

## 验证

- **失败用例证据（bugfix）**：
  - 修复前：issue 现场形态（fact + title 含合入 + #1378 + evidence MERGED）调用 → `非机械可判资源（fact）不能经对账路径归档`（issue 案发现场记录 + 修复前代码路径 `isReconciliationArchivableType` 白名单不含 fact，静态可证）。
  - 修复后：20/20 用例全绿——现场放行（审计三列落痕断言）+ 四类拒绝面 + 对抗回归组（首轮 8 形态拼凑证据不写库 + 合法同行结构放行对照）+ 全锚定模板组（拒绝 10 形态：分号跨引用/MERGED_BUT_NOT 词尾/行内混排/跨行拼合/箭头变体/小写/引号/双空格/号不匹配/非严格参数；放行 3 形态：MERGED/CLOSED/首尾空白 trim）。
- **全量**：tsc --noEmit 0 错误；eslint 0 错误；tests/usecases + architecture + interface-adapters 全目录 3210/3210。

### Delta 1 复核处置（发现 1 未闭环 + 文档漂移 + CI no_review）

| 发现 | 处置 |
| --- | --- |
| 发现 1 未闭环：行内混排/双空格否定/斜杠日期三类变体仍放行 | **根治换型**：放弃自由文本语义近似（行绑定被同类变体证伪），改为结构化格式钉——evidence 须含「gh pr view <对应号> … → MERGED/CLOSED」单行单 PR 终态结构；delta 1 三变体 + 行内混排竖线/斜杠日期两个 delta 2 变体全部回归钉死 |
| 文档/PR body 口径漂移（6/6→7/7、3196→3197、行绑定旧口径） | 本节与残留表已更新至结构化判据口径 |
| CI head_not_covered | delta 2 复核回执覆盖新 head 后解锁 |

### Delta 3 处置（搭档裁决 B：格式硬约束，全锚定模板重实现）

| 项 | 内容 |
| --- | --- |
| 裁决 | 搭档原话「2046选B：格式硬约束，继续实现」（卡片回执 `{pr:2068, choice:"B"}`）——放弃一切自由文本语义判定 |
| 判据重写 | 全锚定模板 `^gh pr view (\d+) --json state → (MERGED|CLOSED)$` 整体匹配 + 模板捕获号 ∈ fact 声明号 + 显式换行拒绝；剔除宽容面（`\s+`/多箭头变体/大小写/引号/`#?` 前缀/行内插叙） |
| 僵局记录两类残余绕过 | 分号跨 gh 引用、MERGED_BUT_NOT 词尾——模板首尾锚定后均不可构造，回归用例钉死 |
| 宽容面收紧项 | 箭头变体 `->`/`-->/==>`、小写终态词、引号包裹、双空格、行内混排多 PR、非严格参数——delta 2 形态下可放行的输入全部转拒，回归用例钉死 |

### Delta 4 处置（delta 3 复核：2 严重 + 2 建议全处置）

| 发现 | 级别 | 处置 |
| --- | --- | --- |
| conversation.ts JSDoc 含特性编号，B10 机械闸非零退出 | 严重 | 注释锚点剥除（改「见特性文档僵局记录与裁决节」泛指） |
| CI check head_not_covered（新 head 无检视覆盖） | 严重 | 流程项：delta 4 复核回执覆盖新 head 后重跑 CI 解锁 |
| F-ID 未按定稿日期顺延（PR 跨 11-27） | 建议 | 采纳：按定稿改名规程改 F20261127rclfc（文档路径+frontmatter id；后缀保持 rclfc；分支历史 commit 保留旧号双向可搜） |
| artifact-tools 主 description 宽松口径与参数描述不一致 | 建议 | 采纳：主 description fact 子句同步硬模板口径 |

## 影响范围

- archive_artifact_for_reconciliation 工具（fact 判据扩展；pr/worktree/branch 路径零变化）；日报对账段与工具契约一致化；审计三列模型原样。

## 残留与后续

| 项 | 需要搭档介入 | 说明 |
| --- | --- | --- |
| 全锚定模板是准入门槛 | 不需要 | evidence 须整体匹配 `gh pr view <对应号> --json state → MERGED/CLOSED`（与日报对账段操作指引同型）；自由文本/宽容变体判据经三轮对抗证伪后按搭档裁决 B 放弃 |
| 跨仓 fact 的 #N 归属仓未区分 | 不需要 | 模板捕获号与 fact 声明号精确绑定（成员判断非集合交集），跨仓同号各查各的证据；审计 evidence 全文留痕可查 |
| 日报对账段 prompt 无需改动 | 不需要 | 真相源本来就是它，本修复是工具侧对齐 |

## 僵局记录与裁决（2026-11-26 宣布僵局，2026-11-27 搭档裁决 B 并实施）

- 判据方向修补循环触发 review-loop 停止条件（连续 2 轮修复验证不通过）：
  - 首轮「词/号全文聚合」→ delta 1「行绑定」→ delta 2「结构化格式钉」，每轮均被新对抗变体证伪（冻结时 head 仍可被「分号跨 gh 引用」「MERGED_BUT_NOT 词尾」两类输入误放行）。
  - 教训：自由文本 evidence 的语义判定属**不可机械判定域**（每轮收紧只会移动变体空间，不收敛）。
- 冻结时的三个候选方向：
  - **A 回退白名单**：撤销 fact 扩展，合入事实归档改人工路径（日报列「待人工」清单）——最保守，消灭噪声源
  - **B 全锚定模板**：evidence 要求整体匹配单一 gh 输出模板（^gh pr view N --json state → MERGED$，锚定首尾）——残余变体空间趋零，代价是 evidence 格式硬约束
  - **C 人工确认闸**：fact 归档提请后须经搭档/日报人工确认才落库——保留自动化但决策权归人
- **裁决：搭档选 B**（原话「2046选B：格式硬约束，继续实现」，2026-11-27）→ 按 B 重实现，见「Delta 3 处置」节。
- delta 2 复核报告：.review/review-2068.md（覆盖 edc1b5962）

## Rollback

单 commit revert 即可（无迁移、无配置、无数据变更）。
