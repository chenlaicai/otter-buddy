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

### B3. End-to-End Verification

Is the feature functional end-to-end, not just unit tests passing?

Verification depends on PR type:
- **Prompt changes**: Run the workflow with the new prompt to verify it works
- **Code changes**: Execute key paths in the actual environment
- **Config changes**: Verify the config takes effect
- **Documentation changes**: Verify docs match implementation

End-to-end verification failure must be reported as a 严重发现 in the review report.

> **基础维度失败 → 严重发现**：任一基础维度失败（B1 CI 失败 / B2 文档缺失或不一致 / B3 端到端验证失败）必须在审视报告的"严重发现"节建立对应条目（标明 B1/B2/B3 来源），不可仅在基础维度检查表中标记"失败"就跳过处置队列。严重发现不可延后——见 `SKILL.md` 严重发现模板和 `author-response-protocol.md` 决策树。

---

## Focus Dimensions (Choose 1-3)

Check every dimension for every PR — but depth follows the declared review focus (see SKILL.md step 2): focus dimensions get the full checklist treatment below, non-focus dimensions get a quick sweep with an explicit "无发现".

## 1. Correctness

Does the implementation match the design intent?

- Read the design document (if available) and compare against the actual code
- Trace the logic flow — are there paths that produce wrong results?
- Check error handling — are failures handled or silently swallowed?
- Verify edge cases in the logic — what happens at boundaries?

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
