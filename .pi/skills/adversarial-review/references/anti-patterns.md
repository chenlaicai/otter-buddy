# Review Anti-Patterns

## Rubber Stamp Review

**Symptom**: "LGTM", "Looks good", "可以合入" with no specific findings.

**Problem**: No actual review happened. Issues pass through undetected.

**Fix**: Every dimension must be explicitly addressed in the report — findings, or an explicit "无发现". "无发现" must be stated, not implied. But a finding manufactured just to fill a dimension is not a finding — see Scattergun Review.
  - **审查者不能输出"可以合入"**：审查者的结论只有"需要修改"或"存在以下问题（决策者判断）"。"可以合入"是决策者的判断，不是审查者的。

## Scattergun Review

**Symptom**: All 6 dimensions checked at equal depth regardless of what the change is; a 3-line config fix gets the same sweep as an architecture rewrite. Finding list is long but has no center of gravity.

**Problem**: Attention is a finite resource. Uniform coverage means the highest-risk area got the same shallow pass as everything else, and the report doesn't converge — author can't tell what actually matters.

**Fix**: Declare 1–3 focus dimensions before checking (what breaks worst if this is wrong?), go deep there, sweep the rest. Classify findings: 严重 vs 建议. Focus-outside findings default to 建议发现 unless they clear the severity bar.

## Moving Target

**Symptom**: Every review round surfaces brand-new blocking issues unrelated to previous rounds' fixes. The author fixes round N's list only to receive round N+1's fresh list.

**Problem**: Review never converges — escalation to the decision-maker becomes the only exit, burning their attention on arbitration. (This symptom itself is the 移动靶 escalation signal in the convergence criteria — if you notice it happening, stop and escalate.)

**Fix**: Round 1 is the full fresh-eyes review. Round 2+ is delta review: verify previous rounds' fixes and check them for regressions. New issues outside the delta must be flagged as "此前轮次漏报" and default to 建议发现 unless they alone would block the delivery.

## Blind Compliance / Empty Rebuttal

**Symptom** (author side, two directions): applying every review finding verbatim without evaluation — including wrong ones; or dismissing findings with "我觉得没问题" / "过度设计" and no evidence.

**Problem**: Blind compliance wastes the adversarial structure — the reviewer has fresh eyes but shallow context; uncritical acceptance imports the reviewer's misreadings. Empty rebuttals are Let It Slide in disguise.

**Fix**: Every finding gets a classified response: 接受并修复 / 反驳（必须附 file:line、测试或文档原文证据）/ 部分接受 / 呈搭档裁决. No-evidence rebuttal = no disposition at all. **未走决策树（无更好/更差判断）= 未处置**——任何响应都必须先回答"改了让系统变好还是变更差"。See `author-response-protocol.md`.

## Nitpicking

**Symptom**: 20+ comments on formatting, naming preferences, comment style — zero on logic or correctness.

**Problem**: Focus on cosmetic issues while real problems pass through.

**Fix**: Prioritize dimensions by impact: Correctness > Security > Edge Cases > Architecture > Tests > Maintainability.

## Impression-Based Review

**Symptom**: "This looks complex, might have issues" or "Seems fine to me".

**Problem**: No evidence. Cannot be verified or disputed.

**Fix**: Every claim must reference a specific file and line. "Complex" → "The nested conditionals in `auth.ts:45-72` create 8 possible paths, of which 3 are untested."

## Let It Slide

**Symptom**: "Not blocking", "Non-blocking", "Can optimize later", "Low risk", "Low priority", "已记录"（无 issue 链接）, **"非阻断"、"建议"作为可忽略暗示**（如"只是建议，可以忽略"、"建议性问题"——把分级标签当作降级许可证）.

**Problem**: Issues accumulate. "Later" never comes. "已记录" without an issue link is the same as "later" — the issue goes into a black hole. 任何暗示"可延后"的标签（非阻断、建议等）都会被 LLM 解读为"可忽略"——这是分级框架的天然缺陷，必须靠机制（强制决策树）托底。

**Fix**: Every finding needs a verifiable disposition produced by the decision tree (详见 `author-response-protocol.md`)：
  - 严重 → 本 PR 修复（diff 可见）；仅事实错误/看错/误解可反驳
  - 建议 → 更好：本 PR 修复 / 建 issue #N（链接可见）；更差：反驳被检视者认可（含事实错误）
  - **「建议」不是降级许可证**：建议发现 = 必须走决策树处置的真实问题，不是可忽略项
  - **处置的真实性**：如果你说"建 issue"，你应该真的执行 `gh issue create` 并贴出链接。没有 issue 链接的"已记录"等于静默丢失——这就是本反模式的变体。

## Inaction / 不作为

**Symptom**: 发现无任何处置；或处置无理由（仅写"已修复"但不给更好/更差判断；仅写"已记录"但无 issue 链接；仅写"建议不重要"但不附证据）.

**Problem**: 这是最根本的反模式——比 Let It Slide 更深层。Let It Slide 是用"延后"丢问题，Inaction 是连理由都不给，直接静默跳过。任何分级框架（阻断/非阻断、严重/建议）都防不住 Inaction——分级只是标签，处置才是产物。

**Fix**: 每条发现强制走决策树——作者必须显式回答"改了让系统变好还是变更差"，并给出对应处置（更好→修复/issue，更差→反驳+证据）. 不允许跳过判断、不允许无理由不改. 检视者在 delta 审视核对每条发现的决策树产物是否齐备（见 `review-loop.md`）.

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

**Fix**: If you found an issue, fix it. Do not ask permission. Do not categorize severity to justify deferral. The only valid reason to not fix is if the issue is outside the plan scope — in which case, create a GitHub issue (with link) or fix it in the current PR, and communicate back, not ask whether to fix.

边界注明：本反模式针对**作者侧**（自己发现的问题想拖着不修）。检视者不适用——检视者只报告不动手（"Do not modify code"）；且检视者必须给发现分级（严重/建议），那是强制报告要求，此处禁止的是"用分级来论证拖延"，不是分级本身。
