# Testing Rules: Behavioral Contract Testing

Tests verify what the system DOES, not how it does it internally.

## Core Principle

Assert observable behavior (outputs, side effects, state changes). Do not assert internal implementation details (which functions were called, in what order, with what arguments).

## What to Assert

| Assert This | Not This |
|-------------|----------|
| Return value | Which internal function was called |
| Database state change | Number of times a method was invoked |
| HTTP response status/body | Call order between services |
| Error message content | Whether a specific private method ran |
| Observable side effect | Mock verification of internal calls |

## Forbidden Assertions

- `toHaveBeenCalledWith` — asserts internal call details
- `toBeCalledTimes` — asserts call count, not behavior
- `toHaveBeenCalledTimes` — same as above

These assertions tie tests to implementation, making refactoring break tests even when behavior is unchanged.

## Test Structure

```
describe('feature name', () => {
  it('should [observable behavior] when [condition]', () => {
    // Arrange: set up the scenario
    // Act: trigger the behavior
    // Assert: verify observable outcome
  });
});
```

## When Tests Fail

A test failure means one of two things:

1. **The test is wrong** — it doesn't match the new design. Fix the test.
2. **The implementation is wrong** — it deviates from the plan. Fix the code.

Diagnose which before acting. Do not automatically revert business code to make tests pass.

## Anti-Patterns

| Anti-Pattern | Problem | Fix |
|-------------|---------|-----|
| Mock everything | Tests pass but integration fails | Mock only external boundaries |
| Test private methods | Brittle, blocks refactoring | Test through public interface |
| Snapshot testing for logic | Encodes implementation, not behavior | Assert specific values |
| Testing framework internals | Coupled to library version | Test your code's behavior |
