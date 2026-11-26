# PR #2068 对抗审视报告

## 审查者

检视獭-rclfc

审视提交：`5ba5e2c67ab7e3f209ffa122a232adb5136f1a75`（锚点短写 `5ba5e2c`）。

## 本轮焦点

1. **证据与 PR 的绑定 / fail-closed 正确性**：误放行会把 active fact 写成终态 archived，并从后续对账清单消失。
2. **既有 pr/worktree/branch 行为保持与审计、归属闸**：分支重构可能改变旧路径或绕开既有约束。
3. **日报、工具、特性文档与测试的契约一致性**：拒绝面若只覆盖理想输入，文档中的 fail-closed 承诺会失真。

**作者焦点防锚定披露**：派工中的作者建议在阅读 diff 前已物理先见，无法执行严格的「先独立焦点、后读清单」顺序。恢复方式是直接对判据机制构造清单外的混合证据与否定语境输入，再核对派工清单。派工列出的正则数字边界、旧路径保持、拒绝文案、审计三列、narrow-fix 均已覆盖；额外独立检查了「终态词与 PR 号是否属于同一条证据」及「否定语境」。仍可能存在受作者框架影响的盲区。

## 模型多样性

- 被审查方模型：未具名（派工声明与检视方不同）
- 审查方模型：kimi K3
- 是否异模型：是（依据派工声明；被审查方具体模型名未披露）

## 审查结论

**需要修改**：3 个严重发现、2 个建议发现。

## 上轮处置确认

| 上轮发现 | 处置终态 | 证据 |
|---|---|---|
| 无（首轮审阅） | n/a | n/a |

## 基础维度检查

| 维度 | 结论 | 实际验证证据 |
|---|---|---|
| B1. CI 状态 | **失败** | `gh run view 45827084405`：`check=failure`，失败于 `check-pr-review-closure: status=no_review`；`guard-macos/e2e/golden-selftest=success`。详见严重发现 3。 |
| B2. 文档完整性 | **文档存在，核心承诺失实** | 新文档 `docs/features/2026/11/26/F20261126rclfc-fact-reconciliation.md:1-60 @ 5ba5e2c` 存在且为 A，不是历史文档改写；但其 9-10、26、37、44 行的「非终态/号不匹配拒绝且不写库」被严重发现 1 的真实 sqlite 探针证伪。 |
| B2.5 方案前提 | 方向匹配；实现未满足前提 | issue #2046 与 `prompts/scheduled/daily-health-check.md:28-35 @ 5ba5e2c` 证明工具白名单和日报契约确有冲突；在既有对账入口内对齐契约方向成立。失效在代码白名单而非规则缺失。实施后的证据判据存在误放行，归严重发现 1。 |
| B3. 全链路验证 | **攻击路径失败** | 原有集成测试 6/6；相关全目录 260 文件、3196/3196；`npx tsc --noEmit` 与目标文件 eslint 均退出 0。另以真实 sqlite 跑 3 个对抗探针，3 个非终态/错配证据输入却全部写成 `archived`，详见严重发现 1。 |
| B4. 变更标识一致性 | 一致 | commit、PR title/body、文档 frontmatter 均为 `F20261126rclfc`；`list_artifacts(groupId=F20261126rclfc)` 返回本 worktree 与 PR #2068。`Modification-Class=narrow-fix` 与 diff 相符：未新增配置、状态生命周期、后台任务、信号、持久化字段或跨模块路径；新增的是运行时校验分支，审计字段与状态机复用原路径。 |
| B5. 撞车检查 | 无发现 | `gh pr list --state open --limit 100` 按 #2046 引用及四个代码/测试重叠文件过滤，除本 PR 外结果为 `[]`。 |
| B6. Intent 块 | 通过 | 特性文档 7-12 行含 `intent.problem/solution/expected_effect/verify_by.type=behavior_check`。 |
| B7. Golden Gate | 不适用 | diff 仅实体、usecase、工具 description、集成测试与特性文档，无 prompt/skill/协议层软代码改动。 |
| B8. Prompt 体积预算 | 不适用 | `git diff --name-only origin/main..HEAD -- prompts/scheduled/` 为空。 |
| B9. 证据包核验 | **结构通过，拒绝面判别力失败** | PR body 有 Rollback、机器锚点层、Agent 陈述层；CI `check-pr-evidence` 通过。抽点 issue #2046 的拒绝现场真实存在，本地复跑 6/6 与 3196/3196 属实。文档/PR 对「四类拒绝面均 fail-closed」的证据判别力不足，被严重发现 1 证伪。 |
| B10. 注释编号禁绝 | **失败** | `node scripts/check-pr-anchor-discipline.mjs --base origin/main` 检出 4 处新增注释编号，详见严重发现 2。 |

## 严重发现

### 发现 1：终态词和 PR 号未绑定到同一条 PR 证据，非终态或错配证据会真实归档

- **维度**：正确性 / 边界条件 / 安全性 / B2 / B3 / B9
- **位置**：`src/entities/conversation/conversation.ts:179-184 @ 5ba5e2c`；写入路径 `src/usecases/conversation/manage-key-info.ts:224-250 @ 5ba5e2c`
- **事实与影响**：
  - 终态词用独立 `/\b(MERGED|CLOSED)\b/i` 检查，数字用独立 `/\b(\d+)\b/g` 收集，随后只判断两个全集是否有交集；二者不要求来自同一个 PR、同一条命令或同一个终态结果。
  - 日期和时间戳也进入数字全集，`NOT MERGED` 也命中终态词。以下三种非目标证据均被 `checkMergeFactResource` 返回 `{ok:true}`，并经真实 usecase + sqlite 写成 `archived`：

| 对抗输入 | 实际结果 |
|---|---|
| title 声明 `#2026`；evidence=`2026-11-26T13:00:00Z gh pr view 9999 --json state → MERGED` | 日期年份 `2026` 误配目标号；`ok:true`，DB=`archived` |
| title 声明 `#1378`；evidence 第一行 `9999 ... MERGED`、第二行 `1378 ... OPEN` | 一个 PR 的 MERGED 与另一个 PR 的号拼成「证据」；`ok:true`，DB=`archived` |
| title 声明 `#1378`；evidence=`gh pr view 1378 --json state → OPEN; NOT MERGED` | `NOT MERGED` 中的独立词 `MERGED` 命中；`ok:true`，DB=`archived` |

  这直接违反 issue #2046 的「PR 非终态仍 fail-closed」关闭标准，也使特性文档 9-10、26、37、44 行的对应承诺失实。归档为领域终态，误归档 fact 会从 active 对账面消失，审计列反而留下看似有证据的记录。
- **证据**：
  - 临时集成探针 `tests/usecases/conversation/manage-key-info-reconciliation.review-probe.test.ts`：`npx vitest run <该探针>` → **3/3 passed**，三个用例均断言并观察到误写的 `archived`；探针结束后已删除，`git status --short` 当时为空。
  - 独立纯函数复核 `npx tsx -e` 对以上三组输入调用 `checkMergeFactResource`，三组输出均为 `{"ok":true}`。
  - 现有拒绝测试 `tests/usecases/conversation/manage-key-info-reconciliation.integration.test.ts:159-190 @ 5ba5e2c` 只覆盖单一 `9999 ... MERGED` 的干净错配，因此 6/6 与 3196/3196 均未触达上述输入形态。
- **处置**：本 PR 修复。

### 发现 2：新增测试注释含 4 处编号，B10 机械闸失败

- **维度**：B10 / 架构合规
- **位置**：`tests/usecases/conversation/manage-key-info-reconciliation.integration.test.ts:109,171,177,183 @ 5ba5e2c`
- **事实与影响**：新增注释分别含 `#2046`、`#N`、`#N`、`#1378`，违反非特性文档注释编号禁绝规则；本地机械闸以非零状态退出。
- **证据**：`node scripts/check-pr-anchor-discipline.mjs --base origin/main` 输出 `新增注释行夹带编号 4 处`，逐项列出上述四行。
- **处置**：本 PR 修复。

### 发现 3：当前 PR CI `check` 失败

- **维度**：B1
- **位置**：CI run 45827084405 / job 139933913821（https://github.com/chenlaicai/otter-buddy/actions/runs/45827084405）
- **事实与影响**：当前 head `5ba5e2c` 的 `check` job 为 failure；失败日志为 `检视断环（status=no_review）：PR 无任何 review 记录`。本报告提交 review 后，该历史 run 的结果不会自动变成成功，需要以新的 CI 结果核验。
- **证据**：`gh run view 45827084405 --job 139933913821 --log-failed`；同 run 的 `guard-macos/e2e/golden-selftest` 均为 success。
- **处置**：本 PR 修复。

## 建议发现

### 建议 1：两处当前契约注释仍描述旧行为或引用不存在的符号

- **维度**：可维护性 / 文档一致性
- **位置**：`src/entities/conversation/conversation.ts:153-154 @ 5ba5e2c`；`src/usecases/conversation/manage-key-info.ts:194-201 @ 5ba5e2c`
- **事实与影响**：实体注释称 merge-fact 判据为 `isMergeFactResource`，实际导出符号是 `checkMergeFactResource`；usecase JSDoc 仍写「pr/worktree/branch……fact/file/url/game 一律拒绝」，与本方法新增的 fact 放行分支直接矛盾。读者从当前方法文档得到的契约与运行行为不同。
- **证据**：上述原文与 `conversation.ts:171-185`、`manage-key-info.ts:224-234` 的实际实现对照。
- **更好/更差判断**：作者须回答——使当前契约注释与实现一致，会让系统变好还是变更差。
- **处置**（作者按决策树选定）：更好 → 本 PR 修复 / 建 issue（须论证本 PR 无法承载并登记）；更差 → 附证据反驳。

### 建议 2：fact 放行用例的 DB 断言未观测 `archived_at`

- **维度**：测试覆盖
- **位置**：`tests/usecases/conversation/manage-key-info-reconciliation.integration.test.ts:135-153 @ 5ba5e2c`
- **事实与影响**：fact 用例名称与特性文档声称「审计三列留痕」，但其 SQL 只读取 `status, archived_by_otter_id, archive_evidence`，断言未覆盖 `archived_at`。实现确实在 `manage-key-info.ts:245-250` 写入三列，因此这是测试观测缺口，不是当前实现缺列；若第三列未来在 fact 路径回归，该用例不会检出。
- **证据**：对照测试 148-153 行与 PR 用例 83-89 行的三列断言；仓储 SQL `src/frameworks/db/conversation/conversation-repository-mixins.ts:82-96 @ 5ba5e2c` 同时更新三列。
- **更好/更差判断**：作者须回答——让 fact 用例的观测面与「审计三列」承诺一致，会让系统变好还是变更差。
- **处置**（作者按决策树选定）：更好 → 本 PR 修复 / 建 issue（须论证本 PR 无法承载并登记）；更差 → 附证据反驳。

## 维度扫视结论

| 维度 | 类型 | 结论 |
|---|---|---|
| 正确性 | 焦点 | 严重发现 1 |
| 边界条件 | 焦点 | 严重发现 1：日期、混合命令、否定语境 |
| 安全性 | 焦点 | 严重发现 1：fail-closed 可被矛盾证据绕过；未发现 SQL/命令注入新面，外部命令仍未执行 |
| 架构合规 | 扫视 | 判据位于实体层、usecase 调用方向合理；B10 严重发现 2 |
| 测试覆盖 | 扫视 | 原测试与全目录均真跑通过；对抗输入未覆盖，另有建议发现 2 |
| 可维护性 | 扫视 | 建议发现 1 |
| 机制预算 | 扫视 | 非净新增机制，narrow-fix 分类成立；未发现归属闸或状态机改动 |

## 旧路径与审计核对

- `pr/worktree/branch` 在类型闸后仍进入原有 `canTransitionArtifactStatus`、evidence 长度校验、状态更新与审计更新序列；相关全目录 3196/3196 通过，未发现旧路径行为变化。
- `file/url/game` 仍由 `manage-key-info.ts:218-223` 拒绝；原 fact 拒绝用例改为 file 后仍验证该拒绝面。
- fact 与旧类型共用审计写入；`conversation-repository-mixins.ts:82-96` 的 SQL 同时写 `archived_by_otter_id/archived_at/archive_evidence`。
- 普通跨对话 `update_artifact_status` 的 404 反击用例通过；本 PR 未改普通路径归属闸。

## 审查者自省

- 未把误放行归入作者已披露的「跨仓同号」残留；本报告复现的是同仓、同文本内的非终态与错配证据。
- 未替搭档作交付决策，结论仅列事实、影响与处置队列。
- 未使用淡化或暗示可忽略发现的措辞；两个建议发现均须作者走更好/更差决策树。
- 未提供修复路线、代码草稿或预指派建议级处置。
- 临时对抗测试已撤除，未改动被审代码。

## 变更完整性

- [x] issue 现场样本可归档，审计写入路径存在。
- [ ] 非合入事实、无号、非终态证据、号不匹配全部 fail-closed。
- [x] file/url/game 保持拒绝，pr/worktree/branch 相关回归测试通过。
- [x] tsc、目标 eslint、相关 3196 测试通过。
- [ ] B10 注释编号机械闸通过。
- [ ] 当前 head CI 全部通过。

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 检视獭-rclfc
