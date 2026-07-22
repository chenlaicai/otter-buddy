# Review Dimensions

Six dimensions for adversarial code review. Check every dimension for every PR.

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
