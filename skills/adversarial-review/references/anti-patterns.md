# Review Anti-Patterns

## Rubber Stamp Review

**Symptom**: "LGTM", "Looks good", "可以合入" with no specific findings.

**Problem**: No actual review happened. Issues pass through undetected.

**Fix**: Every review must produce at least one specific finding per dimension checked. "无发现" must be explicitly stated, not implied.

## Nitpicking

**Symptom**: 20+ comments on formatting, naming preferences, comment style — zero on logic or correctness.

**Problem**: Focus on cosmetic issues while real problems pass through.

**Fix**: Prioritize dimensions by impact: Correctness > Security > Edge Cases > Architecture > Tests > Maintainability.

## Impression-Based Review

**Symptom**: "This looks complex, might have issues" or "Seems fine to me".

**Problem**: No evidence. Cannot be verified or disputed.

**Fix**: Every claim must reference a specific file and line. "Complex" → "The nested conditionals in `auth.ts:45-72` create 8 possible paths, of which 3 are untested."

## Let It Slide

**Symptom**: "Not blocking", "Can optimize later", "Low risk".

**Problem**: Issues accumulate. "Later" never comes.

**Fix**: Every issue needs a disposition: "在当前 PR 修复" or "开发者回应（审查者认可）". No third option.

## Solo Review

**Symptom**: One reviewer approves without cross-check.

**Problem**: Blind spots. Everyone has them.

**Fix**: When multiple reviewers exist, cross-read each other's conclusions. If one says "no issues" and the other found issues, the "no issues" reviewer must re-examine.

## Trust the Developer's Report

**Symptom**: Reviewer checks only the developer's self-verification, not the actual code.

**Problem**: Developer may have missed something. Self-review is not independent review.

**Fix**: Run verification commands independently. Check build, run tests, verify behavior — do not just read the developer's report.
