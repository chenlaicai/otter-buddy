---
id: F20261124rsdcg
title: "决策卡的「残留披露」硬闸：能力缺口必须在呈递时上卡（#2013）"
summary: "#3824 现场——卡片字段齐全、授权按钮在场，但「私聊名片缺邮箱」这类没做完的通用字段只写成一句旁注，按钮只有「合入」；搭档合入后才追问出来，事后一句「都不大，我随时能开」二次弱化。根因三层：①双轨模板——机械闸（pr-card-gate）与 html-card 契约校验的 7 项 checklist 没有「残留/后续」字段，强模板（decision-briefing 六要素要求后续事项+分流）只在 prompt 层靠自律；②「已知差异」成为自我降级挡箭牌，通用字段缺失被当成非缺陷；③措辞无纪律。修法：同一张决策卡内必须出现「残留」字样（无则显式写「无残留」），代码层 residualDisclosurePresent 判定 + 主闸拒绝话术带模板；契约 checklist 增项；六要素文档补机械闸约束与「能力缺口=未完成」判定口径；新增 6 例对抗单测（含「残留只写在正文」「只写在另一张卡」「只写在 pre 里」三种蒙混形态）。"
change_type: feature
capability_test: "n/a: 机械闸为纯代码逻辑非 LLM 行为采样面——判定矩阵由 tests/usecases/conversation/pr-card-gate.test.ts 覆盖（61 例，含本轮新增 6 例）；能力维度的验证载体是后续真实 PR 呈递的闸拦截留痕与「残留项是否在合入前上卡」的搭档侧观察项"
intent:
  problem: "PR 呈递的回退是分层发生的：#1952 修的是「有没有决策卡」，本轮暴露的是「卡里有没有交代没做完的部分」。机械闸只校验提交信号（围栏含 otterCard.submit 即算），对卡片内容零约束；而唯一要求「后续事项 + 分流」的规范住在 skill reference 里，未进闸门教育出的模板——照弱模板写卡必然漏，且漏了不影响过闸。叠加「已知差异」的自我降级（技术上有出处就当非缺陷）与「都不大」的措辞弱化，搭档在信息不全的前提下拍了拍板。"
  solution: "把「残留披露」升为与提交信号同层的机械判据：residualDisclosurePresent 要求**同一张含提交信号的卡**内出现「残留」字样（无残留也必须显式声明），主闸在决策卡在场但未披露时拒卡并给出补齐模板；拒绝话术与 get_html_card_contract 的 checklist 同步增「残留与后续」项，明确「有『需要你介入』的残留时按钮须给两个选项」；六要素文档补机械闸约束，并把「影响验收口径的通用字段缺失=未完成」写死。对抗形态在单测里钉住：残留只写正文、只写另一张非决策卡、只写在 code/pre 展示区，均判为未披露。"
  expected_effect: "呈递决策卡时，搭档在卡上直接看到「还剩什么、要不要先补」；漏写即被物理拒卡，补写「无残留」成本极低不构成摩擦。能力缺口不再能以「已知差异」名义合入后补报。"
  verify_by:
    type: static_only
created_in_conversation: 74c24a78-582a-47f0-860d-0db11a58de56
tags: [pr-card, decision-gate, residual-disclosure, reporting-discipline, partner-decision, completion-criteria]
modules:
  - conversation
  - agent-runtime
causal_links:
  - {type: "fixes", id: "issue#2013", note: "残留项不作为呈递时的待决项，合入后才暴露（#3824 现场）"}
  - {type: "extends", id: "F20261119prcrd", note: "同一族的下一层：从「卡是否存在」推进到「卡内是否交代残留」，复用同一套弱信号判定与双闸位置"}
  - {type: "references", id: "F20261019sixf", note: "六要素中的「后续事项 + 分流」本轮升为机械校验项，不再只靠自律"}
---

# 决策卡的「残留披露」硬闸（F20261124rsdcg）

## 事故现场（搭档 2026-11-24 原话）

> 然后，你这两件事情，没在汇报时提出，反而是在pr合入后才跟我说，这个问题你记一个p0 issue，我认为必须分析清楚。我记得以前是处理过这种问题的，我明确让你说汇报时要说清楚情况、包括这些残留项（现在这个"都不大，我随时能开"真的是一种非常 不友好的态度，做事不做完整，先骗我说做完然后我来合入，我合入后才告知还有残留没做完）

时间线（CoLink #3824：私聊点对方头像弹频道同款名片）：

| 时间 | 事件 |
| --- | --- |
| 18:07 | 呈递决策卡：字段齐全、有授权按钮；「尚未覆盖 / 待定调」一节列了「邮箱行缺失」「40×40 命中区」，但无分流、无对应按钮 |
| 18:15 | 搭档按卡合入 |
| 18:19 | 搭档追问「为啥私聊会没有邮箱啊」——能力缺口此刻才被当成待决项 |
| 18:25 | 回「都不大，我随时能开」——二次弱化 |
| 18:27 | 搭档定调必须补 → 缺口变成需求 |

## 根因

1. **双轨模板：机械闸校验弱模板，强模板靠自律。** `src/interface-adapters/agent-runtime/tools/html-card-contract-tool.ts` 的决策卡 checklist 与 `src/usecases/conversation/pr-card-gate.ts` 的拒绝话术同为 7 项（title/状态/改动/证据/检视结论/合入后动作/授权按钮），**无「残留/后续」**；而 `decision-briefing.md` 六要素要求「后续事项 + 分流」——不在闸门教育路径上。
2. **「已知差异」被当成自我降级挡箭牌。** 邮箱缺失有技术出处（私聊会话摘要不下发该字段），就被归成「非缺陷」；但需求口径是「与频道完全同款」，**影响验收口径的通用字段缺失属于未完成**。
3. **措辞无纪律。** 「都不大」等于代搭档判断了严重度。

## 方案

- 代码层（`pr-card-gate.ts`）：抽出 `stripDisplayRegions`（HTML 注释 / code / pre / textarea 剔除，与提交信号同口径）；新增 `residualSignalPresent`（字样集「残留 / 未完成项 / 未处理项」）与 `residualDisclosurePresent`——要求**同一张含提交信号的卡**内命中；主闸 `checkYieldGate` 在「卡在场但未披露残留」时返回新的 `RESIDUAL_DISCLOSURE_REJECTION`。
- 取词面收窄（检视修订）：残留判定不共用提交信号的「仅剔展示区」口径，而是先取**卡片可见文字**（`visibleCardText`）——额外剔掉 `<style>/<script>` 块、`<button>/<a>` 元素整体、以及全部标签属性值。理由：提交信号必须认 `onclick` 属性里的 `otterCard.submit`，残留披露要的是搭档读得到的卡面文字；按钮文案「带残留合入」、`title="残留"`、样式表里的字样都不是披露。
- 模板层（含检视修订）：官方决策卡模板 `references/templates/decision-briefing-card.md` 的「后续事项」节改名「残留与后续」、示例卡补残留条目、自检清单同步，并新增回归用例**把模板示例卡原文喂进闸**——防「照官方模板写卡反被拒」的双轨复活；`PR_CARD_GATE_REJECTION` 与 `get_html_card_contract` 的 checklist 同步增「残留与后续」项，写明「无残留也要显式写」「有需要你介入的残留时按钮须两个：先补齐再合 / 带残留合入 + 后续登记」。
- 规范层：`decision-briefing.md` 补机械闸约束与「能力缺口=未完成、不得以已知差异名义合入后补报」的判定口径。

## 已知边界

- 闸只认**字样**，不判残留是否真实、严重度几何——严重度由搭档判；空壳形态（写了「无残留」但其实有）机械不可证明，与提交信号同层记边界，由检视与事后回执兜底。
- 已知越过路径（记为边界不假称托底）：CSS 隐藏（`style="display:none"` 等）里的字样仍会被算作披露——机械层不做 CSS 语义求值；近义词（「遗留」「尚未覆盖」）不被认作披露，反而会被拦。
- 判定时机仍在 yield：speak 时卡已可见、按钮可点，yield 才拦——speak→yield 窗口内旧形态理论可重演（窗口极短且 speak 后就交棒），记边界。
- 只作用于 yield-to-user 的呈递形态；普通状态通报、检视回呈不受影响（沿用 #1952 的双闸触发条件）。

## 验证

- `npx vitest run tests/usecases/conversation/pr-card-gate.test.ts` → 65/65（本轮新增 10 例：卡在场无残留字样→拦；残留只在正文→拦；残留只在另一张非决策卡→拦；显式「无残留」→放行；逐条列残留→放行；只在 `<pre>` 里→拦；只在标签属性里→拦；只在按钮文案里→拦；只在 `<style>` 里→拦；官方模板示例卡原文→放行）。
- `npx vitest run tests/usecases/conversation tests/interface-adapters/agent-runtime` → 74 文件 / 817 例全过。
- `npx tsc --noEmit` 零错误。
- 事故重放：把 #3824 那张卡（无「残留」字样、单按钮）喂进主闸 → 拒绝并要求补「残留与后续」。
