# Review Anti-Patterns

## Rubber Stamp Review

**Symptom**: "LGTM", "Looks good", "可以合入" with no specific findings.

**Problem**: No actual review happened. Issues pass through undetected.

**Fix**: Every dimension must be explicitly addressed in the report — findings, or an explicit "无发现". "无发现" must be stated, not implied. But a finding manufactured just to fill a dimension is not a finding — see Scattergun Review.

## Scattergun Review

**Symptom**: All 6 dimensions checked at equal depth regardless of what the change is; a 3-line config fix gets the same sweep as an architecture rewrite. Finding list is long but has no center of gravity.

**Problem**: Attention is a finite resource. Uniform coverage means the highest-risk area got the same shallow pass as everything else, and the report doesn't converge — author can't tell what actually matters.

**Fix**: Declare 1–3 focus dimensions before checking (what breaks worst if this is wrong?), go deep there, sweep the rest. Classify findings: 阻断性 vs 次要观察. Focus-outside findings default to 次要观察 unless they clear the blocking bar.

## Moving Target

**Symptom**: Every review round surfaces brand-new blocking issues unrelated to previous rounds' fixes. The author fixes round N's list only to receive round N+1's fresh list.

**Problem**: Review never converges — escalation to the decision-maker becomes the only exit, burning their attention on arbitration. (This symptom itself is the 移动靶 escalation signal in the convergence criteria — if you notice it happening, stop and escalate.)

**Fix**: Round 1 is the full fresh-eyes review. Round 2+ is delta review: verify previous rounds' fixes and check them for regressions. New issues outside the delta must be flagged as "此前轮次漏报" and default to 次要观察 unless they alone would block the delivery.

## Blind Compliance / Empty Rebuttal

**Symptom** (author side, two directions): applying every review finding verbatim without evaluation — including wrong ones; or dismissing findings with "我觉得没问题" / "过度设计" and no evidence.

**Problem**: Blind compliance wastes the adversarial structure — the reviewer has fresh eyes but shallow context; uncritical acceptance imports the reviewer's misreadings. Empty rebuttals are Let It Slide in disguise.

**Fix**: Every finding gets a classified response: 接受并修复 / 反驳（必须附 file:line、测试或文档原文证据）/ 部分接受 / 呈搭档裁决. No-evidence rebuttal = no disposition at all. See `author-response-protocol.md`.

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

**Fix**: Every issue needs a disposition: "在当前 PR 修复" or "开发者回应（审查者认可）". 次要观察允许第三种去向"记录（issue/PR 描述）"——但记录是分流不是拖延，"后续优化"本身仍然禁用。

## Solo Review

**Symptom**: One reviewer approves without cross-check.

**Problem**: Blind spots. Everyone has them.

**Fix**: When multiple reviewers exist, cross-read each other's conclusions. If one says "no issues" and the other found issues, the "no issues" reviewer must re-examine.

## Trust the Developer's Report

**Symptom**: Reviewer checks only the developer's self-verification, not the actual code.

**Problem**: Developer may have missed something. Self-review is not independent review.

**Fix**: Run verification commands independently. Check build, run tests, verify behavior — do not just read the developer's report.

## Ask Whether to Fix

**Symptom**: "发现了一个 Minor 问题，需要我修复吗？" or "剩余的小问题不影响功能，可以后续优化"

**Problem**: Shifts responsibility to the user. Creates decision fatigue. Issues accumulate because "later" never comes.

**Fix**: If you found an issue, fix it. Do not ask permission. Do not categorize severity to justify deferral. The only valid reason to not fix is if the issue is outside the plan scope — in which case, record it and communicate back, not ask whether to fix.

边界注明：本反模式针对**作者侧**（自己发现的问题想拖着不修）。检视者不适用——检视者只报告不动手（"Do not modify code"）；且检视者必须给发现分级（阻断性/次要观察），那是强制报告要求，此处禁止的是"用分级来论证拖延"，不是分级本身。
