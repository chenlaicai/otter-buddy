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
- **历史文档不可变核查（F20260831dgim）**：PR 中对 `docs/features/`、`docs/research/` 已在 main 出现过的文档的 M/D 修改，直接标严重发现（结构性迁移除外：PR 描述或特性文档中记录了 BYPASS 理由）——正确姿势是新建文档记录变更，frontmatter from/supersedes 关联前文

**判断标准（硬规则，不可降级）**：
- 特性文档存在 → read 文档，检查与实现一致性
- 特性文档缺失 → **严重发现（B2）**，无论变更类型（代码/prompt/skill/doc），不可降级为「可接受」或「完整」
- **历史文档被修改 → 严重发现（B2，F20260831dgim）**：`git diff origin/main...HEAD --name-status -- docs/features/ docs/research/` 出现非 A 状态的历史文件（已在 main 出现过），除非 PR 明确声明结构性迁移（BYPASS 留痕）——正确姿势是新文档记录变更
- 检查步骤：`list_artifacts` 查找特性文档 → 不存在则直接标记严重发现 → 存在则 read 核对一致性

### B3. End-to-End Verification

Is the feature functional end-to-end, not just unit tests passing?

Verification depends on PR type:
- **Prompt changes**: Run the workflow with the new prompt to verify it works
- **Code changes**: Execute key paths in the actual environment
- **Config changes**: Verify the config takes effect
- **Documentation changes**: Verify docs match implementation

End-to-end verification failure must be reported as a 严重发现 in the review report.

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
- **F-claim audit (issue #379 ②)**：Cross-check each claim in the feature doc against the code — for every "implemented X" statement in the doc, verify the corresponding symbol/logic exists in code. List claims that run ahead of the code (doc says done, code not wired yet).（F 承诺对账：逐条核对特性文档声称的功能点 vs 代码实现，承诺面跑在代码前面时逐条列出）

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
