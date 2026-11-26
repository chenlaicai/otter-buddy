# PR #2068 Delta 2 对抗复核报告

## 审查者

检视獭-rclfc

复核提交：`edc1b5962384111910fc09b24eaa69300b880e46`（锚点短写 `edc1b59`）。

## 本轮焦点

1. 结构化终态证据是否真正绑定目标 PR，且只接受完整 MERGED/CLOSED token。
2. 上轮文档/PR 证据漂移是否完整消除，而非只追加 delta 段。
3. B10 是否保持通过，当前 head CI 是否形成闭环。

## 模型多样性

- 被审查方模型：未具名（派工声明与检视方不同）
- 审查方模型：kimi K3
- 是否异模型：是（依据派工声明；被审查方具体模型名未披露）

## 审查结论

**僵局**：同一批问题连续两轮修复验证未通过，触发 review-loop 的「僵尸循环」停止条件。停止当前修补循环，后续方向呈搭档裁决。

- Delta 1（`6d048af`）：三类同根因变体仍误归档。
- Delta 2（`edc1b59`）：原五类攻击已被拒绝、合法结构仍放行，但另外两类结构变体仍真实误归档；B10 同时从已通过回归为 7 处违规，文档与 PR body 仍保留旧算法和旧测试数。

## 上轮处置确认

| 上轮发现 | 处置终态 | 证据 |
|---|---|---|
| 严重 1：非终态/错配证据误归档 | **连续第二轮未闭环** | 原五类攻击独立复核均 `ok:false`；新两类输入均 `ok:true` 且真实 sqlite DB=`archived`，见严重发现 1。 |
| 严重 2：文档/PR body 漂移 | **未完整处置** | intent 与新增 delta 段已写结构钉，但 `修法` 32、37 行仍为全文词/号交集，45 行和 PR body 多处仍为 3196，见严重发现 3。 |
| 严重 3：CI head_not_covered | **等待新 CI 结果** | 当前 head run 45835135093 的 `check` 仍失败于 `head_not_covered`；本报告覆盖 `edc1b59`，见严重发现 4。 |
| 首轮 B10 注释编号（delta 1 已关闭） | **修复回归，重新打开** | 机械闸本轮检出 5 行共 7 处新增编号，见严重发现 2。 |
| 首轮建议 1：错误符号/旧契约注释 | 修复 + delta 确认 | `conversation.ts:153-154`、`manage-key-info.ts:194-202 @ edc1b59` 保持订正。 |
| 首轮建议 2：`archived_at` 断言 | 修复 + delta 确认 | 集成测试 228-234 行保持三列断言。 |

## 基础维度检查

| 维度 | 结论 | 实际验证证据 |
|---|---|---|
| B1. CI 状态 | **当前 head 未通过** | run 45835135093 `check=failure`，job 日志为 `当前 head edc1b59 无检视覆盖——最近一条 review 覆盖停在 6d048af`；e2e/golden-selftest 通过，guard-macos 核验时仍 queued。 |
| B2. 文档完整性 | **失败** | 特性文档新增 Delta 1 段，但原修法、验证段未同步，形成同文档内新旧算法与数字并存；PR body 也仍有多处 3196。 |
| B2.5 方案前提 | 方向不再续审，触发停止条件 | 本轮不重开契约对齐方向；结构化格式钉是原严重发现 1 的第二轮处置，连续未通过后按协议停止循环。 |
| B3. 全链路验证 | **对抗路径失败** | 现有集成 7/7、相关全目录 260 文件 3197/3197、tsc/eslint 通过；2 个 delta 2 真实 sqlite 探针全部误写 `archived`。 |
| B4. 变更标识一致性 | 一致 | ID 保持 `F20261126rclfc`；delta 仍只改运行时判据、文档、测试与报告，无净新增机制面，narrow-fix 不变。 |
| B5. 撞车检查 | 无发现 | 当前 open PR 按 #2046 与重叠文件过滤，除本 PR 外为 `[]`。 |
| B6. Intent 块 | 通过 | intent 块存在且 solution 已更新结构钉；其他文档段不一致归 B2。 |
| B7. Golden Gate | 不适用 | 无 prompt/skill/协议层软代码改动。 |
| B8. Prompt 体积预算 | 不适用 | 未触及 `prompts/scheduled/`。 |
| B9. 证据包核验 | **内容失实** | CI evidence 结构闸通过；PR body 的机器锚点和 Verification 仍写 3196/3196，本地独立复跑为 3197/3197。 |
| B10. 注释编号禁绝 | **失败，修复回归** | `node scripts/check-pr-anchor-discipline.mjs --base origin/main` 检出 7 处新增编号。 |

## 严重发现

### 发现 1：结构化格式钉仍允许跨 PR 拼接和非终态前缀 token，原严重发现连续第二轮未闭环

- **维度**：原严重发现 1 / 正确性 / 边界条件 / B3
- **位置**：`src/entities/conversation/conversation.ts:191-197 @ edc1b59`
- **事实与影响**：
  - `[^\\n]*?` 只排除换行，不排除另一个 `gh pr view` 引用。目标号在前、另一个 PR 的箭头与 MERGED 在后时，正则会跨命令吞入中间文本。
  - `(MERGED|CLOSED)` 后没有 token 边界，`MERGED_BUT_NOT` 会被当成合法 MERGED。

| Delta 2 对抗输入（title 均声明 `#1378`） | 实际结果 |
|---|---|
| `gh pr view 1378 --json state; gh pr view 9999 --json state → MERGED` | `ok:true`，真实 sqlite DB=`archived` |
| `gh pr view 1378 --json state → MERGED_BUT_NOT` | `ok:true`，真实 sqlite DB=`archived` |

  第一项并不含「gh pr view 1378 … → MERGED」这一完整目标结构，第二项的终态 token 也不是 MERGED/CLOSED 枚举值，因此二者不属于文档已披露的「完全伪造合法目标结构」边界。它们直接违反「中间插入其他 PR 引用即断开」与「箭头后紧跟终态词」的格式承诺。
- **证据**：临时集成探针 `manage-key-info-reconciliation.delta2-probe.test.ts` 经 `npx vitest run` 为 **2/2 passed**，两项均断言并观察到误写的 `archived`；纯函数 `npx tsx -e` 对两项也均返回 `{"ok":true}`。探针已删除，随后相关全目录复跑为 **3197/3197**。
- **已核验的部分修复**：hyphen 日期、跨行拼合、双空格 NOT、另一个 PR 在前、slash 日期五项均 `ok:false`；合法基本结构与 `state: "MERGED"` 前缀均 `ok:true`。
- **处置**：停止当前循环，呈搭档裁决。

### 发现 2：B10 注释编号闸从已通过回归为 7 处违规

- **维度**：B10 / 修复回归
- **位置**：`src/entities/conversation/conversation.ts:186 @ edc1b59`；`tests/usecases/conversation/manage-key-info-reconciliation.integration.test.ts:66,72,78,84,90 @ edc1b59`
- **事实与影响**：新增注释含 `delta 1`、`delta 2` 和 `#2026`；机械闸按轮次编号与 issue 编号合计检出 7 处。派工所称「anchor 本地全绿」与实际命令结果相反。
- **证据**：`node scripts/check-pr-anchor-discipline.mjs --base origin/main` 非零退出，逐项列出 entity 186 的 `delta 2`、测试 66/72/78/84 的轮次编号，以及测试 90 的 `delta 2` 与 `#2026`。
- **处置**：停止当前循环，呈搭档裁决。

### 发现 3：文档与 PR body 只追加新段，旧算法和旧测试数仍保留

- **维度**：B2 / B9 / 上轮严重发现 2 未完整处置
- **位置**：`docs/features/2026/11/26/F20261126rclfc-fact-reconciliation.md:32,37,45,47-53 @ edc1b59`；PR body「验收结果 / 证据分层声明 / Verification」
- **事实与影响**：
  - 文档 32、37 行仍写 `\b(MERGED|CLOSED)\b` 与全文数字交集；47-53 行新增结构钉段落后，同一文档同时存在两套互相矛盾的判据。
  - 文档 45 行仍写 3196/3196；PR body 验收结果、机器锚点和 Verification 也仍写 3196/3196。独立复跑实际为 3197/3197。
  - 文档 52 行声称「本节与残留表已更新至结构化判据口径」，但原修法与验证段未更新。
- **证据**：上述原文、`gh pr view 2068 --json body`、本地 7/7 与 3197/3197 输出。
- **处置**：停止当前循环，呈搭档裁决。

### 发现 4：当前 head CI `check` 失败于 head_not_covered

- **维度**：B1 / 上轮严重发现 3
- **位置**：CI run 45835135093 / job 139961874807（https://github.com/chenlaicai/otter-buddy/actions/runs/45835135093）
- **事实与影响**：当前 head `edc1b59` 尚无成功 CI；失败原因是最近 review 停在 `6d048af`。本报告覆盖当前 head，但历史 run 仍需以新运行接替。
- **证据**：`gh api /repos/chenlaicai/otter-buddy/actions/jobs/139961874807/logs` 返回 `status=head_not_covered`；e2e 与 golden-selftest 已通过。
- **处置**：停止当前循环，呈搭档裁决。

## 建议发现

无新增建议发现。

## 升级简报

### 3 秒层

**同一修复连续两轮对抗验证未通过，且 B10、文档证据同步反复回归；推荐停止当前修补循环并退回方向裁决。置信度高：误归档均由真实 sqlite 复现。**

### 30 秒层

- **背景**：首轮发现自由文本证据可误归档；两轮 delta 分别更换行绑定与结构钉，均仍有实际放行非终态/错配证据的输入。
- **选项 A：继续当前修补循环**。不推荐——已触发 review-loop「连续 2 轮修复验证不通过」停止条件，且每轮同时出现工程闸或证据漂移。
- **选项 B：停止循环，退回方向裁决**。推荐——遵守既定收敛协议，把后续方向交回搭档，而不是让检视者与实现者继续逐变体往返。
- **最大代价**：#2046 的修复交付暂停，active fact 对账噪声继续存在至搭档确定方向。

### 完整版

案发现场、逐轮处置、全部锚点与复现数据见上文及 PR review。此处不提出新的实现路线。

## 维度扫视结论

| 维度 | 类型 | 结论 |
|---|---|---|
| 正确性 / 边界条件 | 焦点 | 严重发现 1，连续第二轮未闭环 |
| 文档与证据一致性 | 焦点 | 严重发现 3 |
| 架构合规 | 焦点 | B10 严重发现 2，修复回归 |
| 测试覆盖 | 扫视 | 现有 7/7 与 3197/3197 真跑通过；新两类输入未覆盖 |
| 安全性 | 扫视 | 无新增外部命令、SQL、归属闸变化；fail-closed 归严重发现 1 |
| 可维护性 | 扫视 | 同文档并存两套判据归严重发现 3；首轮两条建议保持修复 |

## 审查者自省

- 未把「根治」自述当作证据，直接对新正则构造并执行了边界输入。
- 新严重项均属于原发现或其修复回归，不是 delta 之外另开政策、设计或风格要求。
- 未提供下一条修复路线或正则草稿；连续两轮失败后按协议停止，而非继续主导实现设计。
- 临时探针已撤除；除本报告外未改被审代码。

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 检视獭-rclfc
