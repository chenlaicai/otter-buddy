# Review Dimensions

Baseline dimensions are checked for every PR — they are the floor, not the ceiling. Focus dimensions are chosen based on the PR's risk profile and get deeper scrutiny.

## Baseline Dimensions (Always Checked)

These dimensions are checked for every PR, regardless of size or complexity. They do not count toward the 1-3 focus dimensions.

### B1. CI Status

Is the PR's CI passing?

- Check CI status: `gh run list --limit 1` or review CI status in PR
- If CI fails, identify which tests/jobs failed
- CI failure must be reported as a 严重发现 in the review report (cannot proceed until fixed). 严重发现不可延后——见 `author-response-protocol.md`

### B2. Documentation Completeness

Does relevant feature documentation exist and match the implementation?

- Check if feature documentation exists for the changes
- Verify documentation matches actual implementation
- Missing or inconsistent documentation must be reported as a 严重发现 in the review report
- **历史文档不可变核查**：PR 中对 `docs/features/`、`docs/research/` 已在 main 出现过的文档的 M/D 修改，直接标严重发现（结构性迁移除外：PR 描述或特性文档中记录了 BYPASS 理由）——正确姿势是新建文档记录变更，frontmatter from/supersedes 关联前文

**判断标准（硬规则，不可降级）**：
- 特性文档存在 → read 文档，检查与实现一致性
- 特性文档缺失 → **严重发现（B2）**，无论变更类型（代码/prompt/skill/doc），不可降级为「可接受」或「完整」
- **历史文档被修改 → 严重发现（B2）**：`git diff origin/main...HEAD --name-status -- docs/features/ docs/research/` 出现非 A 状态的历史文件（已在 main 出现过），除非 PR 明确声明结构性迁移（BYPASS 留痕）——正确姿势是新文档记录变更
- 检查步骤：`list_artifacts` 查找特性文档 → 不存在则直接标记严重发现 → 存在则 read 核对一致性

### B3. End-to-End Verification

Is the feature functional end-to-end, not just unit tests passing?

Verification depends on PR type:
- **Prompt changes**: Run the workflow with the new prompt to verify it works
- **Code changes**: Execute key paths in the actual environment
- **DB migration changes**（migration.ts 新增/修改迁移函数、或 schema.ts 表结构变更）: **真启动验证**——在生产 DB 副本上执行完整启动路径（迁移 → bootstrap → 服务监听成功、日志无 SqliteError），仅跑迁移函数 + SQL 行数校验不算 B3 通过（事故教训：崩溃点在启动链路 enqueueRetry 的 ON CONFLICT，SQL 校验触达不到；同类事故已踩两次（出处见 git 历史））
- **Config changes**: Verify the config takes effect
- **Documentation changes**: Verify docs match implementation

End-to-end verification failure must be reported as a 严重发现 in the review report.

**pre-existing 声明核验**：作者自检报告中的「pre-existing / 与本次变更无关」失败声明，若未附 `git stash -u` 复跑或 `origin/main` 基线对照证据，直接打回——无证据 = 未验证（历史现场：5 个自引入失败被误报为与己无关）。检视者可自行抽查：`git stash -u` 或 checkout 基线单跑，验证声明是否成立。

**教训段三要素核查（含教训段的 PR 必查）**：PR 新增/修订了「#xxx 教训/现场」类段落（skill/prompt/SYSTEM.md/特性文档）时，逐段核对「不这么做的现场」三要素——①当时的错误现象 ②导致的后果 ③定位过程；缺任一要素 = 建议发现打回（半成品教训是 3.8% 形态，EPD 对照）。判定示例与模糊地带（流水账/多行分布）见 writing-skills SKILL.md 5b 节。存量教训段不回改，只管本 PR 新增/修订。

### B4. Change Identity Consistency

特性编号在 commit message、PR title、PR 描述、特性文档间一致？

- 从 commit message 或 PR title 提取特性编号（格式 `F<YYYYMMDD><id>`）
- 确认同一个编号出现在：特性文档 frontmatter / PR 描述 / `list_artifacts` 的 groupId
- 缺失或不一致必须报为严重发现（标明 B4 来源）

> 特性编号是变更追溯的锚点——编号不一致会导致特性文档无法被 `search_memory` 按 ID 召回，也会让 `get_related` 的关系链断裂。

> **基础维度失败 → 严重发现**：任一基础维度失败（B1 CI 失败 / B2 文档缺失或不一致 / B3 端到端验证失败 / B4 特性编号缺失或不一致）必须在审视报告的"严重发现"节建立对应条目（标明 B1/B2/B3/B4 来源），不可仅在基础维度检查表中标记"失败"就跳过处置队列。严重发现不可延后——见 `SKILL.md` 严重发现模板和 `author-response-protocol.md` 决策树。

> **基础维度必须附验证证据**：每项基础维度的结论必须附实际验证证据（命令输出 / 工具返回 / 文件路径）。你有 bash、read 等编码工具——必须实际运行检查，不可凭印象填"通过"。
>
> - B1 CI 状态：实际运行 `gh run list --limit 3`，贴关键输出（通过/失败 + 哪些 job）
> - B2 文档完整性：实际运行 `list_artifacts` 查找特性文档，贴结果；read 特性文档核对实现一致性
> - B3 全链路验证：实际运行测试或构建命令，贴关键输出
> - B4 变更标识一致性：从 commit/PR 提取编号，与 `list_artifacts` groupId / 特性文档 frontmatter 对照
>
> **无证据填"通过" = 虚假签收，等同漏报。** 报告合规门禁（见 `review-loop.md`）有权打回。

---

## Focus Dimensions (Choose 1-3)

Check every dimension for every PR — but depth follows the declared review focus (see SKILL.md step 2): focus dimensions get the full checklist treatment below, non-focus dimensions get a quick sweep with an explicit "无发现".

## 1. Correctness

Does the implementation match the design intent?

- Read the design document (if available) and compare against the actual code
- Trace the logic flow — are there paths that produce wrong results?
- Check error handling — are failures handled or silently swallowed?
- Verify edge cases in the logic — what happens at boundaries?
- **F-claim audit（承诺对账）**：Cross-check each claim in the feature doc against the code — for every "implemented X" statement in the doc, verify the corresponding symbol/logic exists in code. List claims that run ahead of the code (doc says done, code not wired yet).（F 承诺对账：逐条核对特性文档声称的功能点 vs 代码实现，承诺面跑在代码前面时逐条列出）
- **迁移结构保持核查（事故教训，迁移类 PR 必查）**：变更涉及 DB 表重建/复制时，逐表核对结构保持方式——`CREATE TABLE AS SELECT`（CTAS）只拷数据不拷结构（丢 PK/UNIQUE/FK、FTS5/vec0 虚拟表退化为普通表），**任何 CTAS 用法直接标严重发现**；正确姿势是 sqlite_master 提取 DDL 重建或原地 DELETE+INSERT 换键。同一迁移函数内主表与卫星表使用不同严谨度的重建方式（现场：主表从 sqlite_master 提 DDL 防漂移，四张卫星表 CTAS）是**强信号**——必须逐表核实，不接受「卫星表简单所以 CTAS 够了」的隐含假设。
- **捷径审查（事故教训，刹车三）**：对 PR 中「替代既有路径的新捷径」专门核验两问——原路径存在的原因是什么？新捷径是否满足了同样的约束？（现场：「vec 复制现成数据替代 retry worker」绕过了既有暗化兑底，若检视维度有此条，CTAS 雷大概率在这层被拦）捷径本身不是罪，答不出「原路径的约束是什么」才是严重发现。

## 2. Edge Cases

Are boundary scenarios handled?

- Null / undefined / empty string inputs
- Empty collections (arrays, maps)
- Concurrent access (if applicable)
- Large data volumes — will it OOM or timeout?
- Race conditions in async code
- Integer overflow, floating point precision

## 3. Security

Are there security risks?

- SQL injection / command injection / XSS
- Privilege escalation — can a user access what they shouldn't?
- Sensitive data exposure — passwords, tokens, PII in logs or responses
- SSRF — does user input control outbound URLs?
- Path traversal — does user input control file paths?

## 4. Architecture Compliance

Does the code follow project conventions?

- Layer constraints respected (e.g., Clean Architecture)
- Dependency direction correct (outer → inner, not reverse)
- No circular dependencies introduced
- Naming matches project terminology
- File organization follows project structure

## 5. Test Coverage

Are core behaviors tested?

- Tests exist for new/modified functionality
- Tests verify external behavior, not internal implementation
- Edge cases from dimension 2 are covered
- Tests are deterministic (no flaky tests from timing or order dependencies)
- Test names describe the behavior being verified

## 6. Maintainability

Can the next developer understand this?

- Naming is clear and consistent
- Complex logic has comments explaining WHY, not WHAT
- No unnecessary duplication
- No dead code left behind
- Error messages are actionable

## 7. Mechanism Budget

> 范围（软维度，非必查）：变更净新增机制（新机制/子机制/对外承诺）时可选用此维度作焦点。纯修 bug、纯删除、纯重构豁免。复盘记录破例（搭档裁决豁免 + 特性文档引用裁决）亦豁免。

Does the addition carry its full future cost explicitly? (加法自带全部未来)

- Check the feature doc's「设计取舍」section for the four answers:
  ① 谁需要它（具体角色，不是「应该有」）② 失败后果（用户可感知，还是仅内部指标异常）③ 后续机制（它创造的新状态里哪些可能出错、会被怎么修）④ 退役条件（什么信号出现时该删它）
- **Net-new mechanism with no four answers → 建议发现**（软维度，走决策树处置；先软后硬，跑熟后再评估升级为 B 维度）
- ①② 答非所问（如「应该有」「提升健壮性」这类无角色无后果的答案）同视为缺失
- Context: 病根五条（生成回路/局部有效/前提不死/路径不对称/度是全局属性）见特性文档 mechanism-budget（按标题 grep docs/features/ 定位）

## 8. Prompt Size Budget (B8, 2026-09-17)

> 基础维度（diff 触及 prompts/scheduled/*.md 时必查，不占焦点名额）。防线前移：PR 合入前拦截，取代「DB 写入时静默降级」的末端哑防线。

Does the diff grow scheduled-task prompt templates unchecked?

- Run `npm run lint:prompt-size` — exit 1 (over budget) = severe finding
- Net growth >500B without PR-description declaration (等量出清 or 净增理由) = severe finding
- Check frontmatter `budget_bytes` overrides are justified in the feature doc
- Context: 体积失控事故（2026-09-17 定性重大事故）——daily-health-check.md 23 天 4.6 倍（18 PR +185/-24 纯加法），超 DB CHECK 后同步失败静默降级，DB 跑三周旧版。根因不是文件大，是系统没有控制自己变大的能力。
