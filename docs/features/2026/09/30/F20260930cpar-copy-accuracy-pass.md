---
doc_type: feature
id: F20260930cpar
title: 文案准确性订正：restart_otter 悬空指针修复 + skill 索引 Precondition 归位正文
summary: 注入面文案准确性审视（搭档 9/30 定调：不搞灵活机制，聚焦 skill/tool 文案准确性）的两处订正——①restart_otter TIP 指针从「按标题 grep 定位」改为可操作锚点（文档 ID F20260909sentr + 具体路径，原指引模型按标题 grep 文件名大概率扑空）；②adversarial-review/otter-summon 的 Precondition 段（执行期约束）从 description 触发门归位正文执行约束节，触发门只留触发信号。
change_type: prompt
capability_test: "n/a——纯文案变更（verify_by=static_only：工具 description 断言含于全量 4340 用例，skill frontmatter 由 lint-skills 守护，无 LLM 行为变化）"
intent:
  problem: "restart_otter TIP 让模型「按标题 grep 定位」交接模板，但文档文件名是 F20260909sentr- 前缀 slug，按标题 grep 文件名大概率扑空——指引不可操作；adversarial-review/otter-summon 的 Precondition 段（执行期约束）混在 description 触发门里，对「该不该触发」无贡献且让索引偏长。"
  why_now: "搭档 2026-09-30 定调注入面议题收敛：「不搞灵活机制（cache 方面变弱），聚焦逐个 skill/tool 文案的准确性审视」「ok，你开工」。"
  expected_effect: "restart_otter 的交接模板指引可操作（ID/路径/记忆检索三锚点）；两个 skill 的触发门只留触发信号，索引从 431/409 字符降到与其余 skill 同量级，执行约束在正文原位保留。"
  verify_by:
    type: static_only
    reason: "纯文案变更，无运行时行为面；description 断言含于全量 4340 用例，frontmatter 结构由 lint-skills 校验。"
created_in_conversation: 1d3437f9-ae46-488f-824b-d67936791165
causal_links:
  issues: [1230]
  from: [F20260929tdrv]
tags: [tool-description, skill-index, copy-accuracy, entropy-reduction]
modules:
  - src/interface-adapters/agent-runtime/tools/
  - .pi/skills/
---

## 背景

搭档 9/30 定调（注入面优化议题收敛）：
> 「这些'灵活机制'都不太好（cache方面变弱）。聚焦在逐个 skill/tool 当前文案的准确性审视上，看是否存在优化的点；不需要落 R 文档，本次只是一次特性优化方案的讨论」

前置：F20260929tdrv（39 条 description 合理性审视）已处理「描述与机制矛盾」类问题；本次是第二轮，聚焦**文案可操作性 + 触发门纯度**。

## 目标

T1: restart_otter TIP 悬空指针修复——「按标题 grep 定位」不可操作（文档文件名是 F20260909sentr- 前缀 slug，按标题 grep 文件名大概率扑空）
T2: skill 索引触发门纯度——adversarial-review / otter-summon 的 Precondition 段是执行期约束（模型读到时已决定使用该 skill），归位正文

## 非目标

- 不动任何「灵活机制」（按需激活/毕业式瘦身/白名单/预算闸——全部已否决，cache 账算不过来）
- 不重开 39 条 description 的全面审视（tdrv 刚完成一周，通读未发现更多站得住的准确性问题）
- 不动 triage_signal batch_bind 参数分层（搭档可选项，本次未做——收益 ~300 字符 vs 首次调错成本，留档）

## 设计取舍

① **指针改法**：「按标题 grep」→「按文档标题 grep 内容定位 + 记忆检索关键词」双锚点。首版曾用文档 ID（F20260909sentr）——被 lint-prompt-anchors 拦截（判据：编号锚点是出处/决策史，不进每轮注入的 prompt），且 ID 有重生成风险；「按标题 grep 内容」命中 frontmatter title 字段（唯一且稳定），与修复前文案的区别是明确「grep 内容」而非 grep 文件名。
② **Precondition 归位而非删除**：两段约束（异体执行原则/召唤前 MUST search_memory）本身正确且重要，只是位置不对——挪进正文「执行约束」节，内容一字不改。adversarial-review 的 Not for 补「实现者自审 → 违反异体执行原则」保持触发门对该排除项的覆盖。
③ **全量测试 + lint-skills 双守护**：description 断言含于 4340 用例，frontmatter 结构由 lint-skills 校验（13 warnings 均为存量，无新增）。

## 验证

- 全量测试 308 文件 / 4340 用例通过
- `node scripts/lint-skills.mjs` OK（14 skills，13 warnings 存量）

## 留档（未做项）

- `triage_signal` batch_bind 参数分层：收益 ~300 字符，代价首次调错成本——搭档拍板「可做可不做」，本次不做；若后续该工具调错率高再回来
- 其余 37 条 description：tdrv 审视新鲜（一周），通读无新发现
