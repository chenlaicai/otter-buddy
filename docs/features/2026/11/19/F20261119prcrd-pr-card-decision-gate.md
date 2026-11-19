---
id: F20261119prcrd
title: "PR 呈递拍板机械闸：决策卡作为 yield 前置校验（#1952/#1907 合并处置）"
summary: "2026-11-19 08:43-09:05 大獭呈递 #1941 请拍板只给一段 md 文本，搭档 20 分钟内三次索取「pr卡片」——卡片作为决策载体整体缺位（#1907 的裸链回退是同一族的下位形态）。根因：纯提示词自律零成本回退，yield 只校验「先 speak 再 yield」不校验汇报内容形态。修法四件套：①机械闸双闸点（speak 落库前辅闸 + yield to user 前主闸，判定核心=PR 引用×请求措辞×决策卡在场的三信号共现，守卫总则「明确拦不明确放通」）②PR 决策卡模板固化进 get_html_card_contract 契约③「PR 卡片」术语入库④worktree-isolation skill 呈递四件套纪律。同时吸收孤儿分支 F20261119prcrn（#1907 prompt 层回退案例沉淀，原会话归档未交付，三 commit 已过两轮检视修正）。"
change_type: feature
capability_test: "n/a: 机械闸为纯代码逻辑非 LLM 行为采样面——判定矩阵与工具层拦截由 19+8 例单测/集成测试覆盖（tests/usecases/conversation/pr-card-gate.test.ts + tests/interface-adapters/agent-runtime/tools/pr-card-gate-speak-yield.test.ts，详见正文验证节）；能力维度的验证载体是后续真实 PR 呈递的闸拦截留痕与搭档侧「同一 PR 无二次索取」观察项"
intent:
  problem: "PR 呈递回退的机制性根因是约束错位：卡片呈递是「搭档决策体验」层的约束，住在 prompt/skill 文本里靠注意力自律——违反零成本、回退零摩擦（#1907 已实证：规则在场仍回退；#1952 再实证：20 分钟三次索取）。与认领协议（F20261119claim）同构：跨回合的行为约束必须有机械执行点，否则必然回退。"
  solution: "双闸设计，收益层级与执行位置匹配：辅闸在 speak 落库前（单条命中 [PR 引用+纯请求措辞] 且无任何卡片围栏→拒落库指导补卡），主闸在 yield to user 前（回合累计 speak + reason 命中 [PR 引用+宽表请求措辞] 且无含 otterCard.submit 的决策卡→拒交棒）。两闸词表分离是防误拦关键：窄表不含「可以合入」等评价措辞（独立检视獭的检视报告常态无卡，speak 侧收进来会误拦非呈递方），宽表只在 yield-to-user 结构信号上下文收评价措辞（「可以合入了」正是 08:43 事故形态）。否定/过去式先剔除再匹配（「已合入」「不建议合入」不触发；同回合多 PR 混排天然支持）。授权按钮判定只认「围栏内含 otterCard.submit」——submit 是提交唯一通道，summary 措辞（固定「<PR号>合入」为 merge_pr 授权源）是模板纪律留给 prompt 层。"
  expected_effect: "请求拍板的 PR 呈递缺决策卡时物理阻断（speak/yield 双点），补卡即放行；检视回呈、已合入通报、非 PR 讨论零影响。issue 验收「同一 PR 不再出现第二次 pr卡片 索取」由闸兜底——第一次就出卡。"
  verify_by:
    type: static_only
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [pr-card, decision-gate, speak-gate, yield-gate, presentation-discipline, partner-decision]
modules:
  - conversation
  - agent-runtime
causal_links:
  - {type: "fixes", id: "issue#1952", note: "PR 卡片决策载体缺位——机械闸+模板+术语+口径四件套"}
  - {type: "fixes", id: "issue#1907", note: "裸链回退下位形态——吸收 prcrn 孤儿分支 prompt 层处置，合成一件特性"}
  - {type: "incorporates", id: "F20261119prcrn", note: "孤儿分支三 commit（原会话 a23f0f4a 归档未交付）cherry-pick 吸收"}
  - {type: "same-family", id: "F20261119claim", note: "同构问题：跨回合行为约束必须有机械执行点，纯 prompt 层必回退"}
---

# PR 呈递拍板机械闸（F20261119prcrd）

## 事故现场（#1952 原文摘录）

2026-11-19 08:43-09:05，同一诉求 20 分钟内三次：

| 时间 | 搭档 | 大獭实际输出 |
| --- | --- | --- |
| 08:43 | 「已合入」（#3509 合入） | 一段 md 文本 + 一张「待你一句话」卡——无 PR 号锚点、无可点开的 PR、无授权按钮 |
| 08:45 | 「给我1941的pr卡片」 | 才补出裸 URL + 卡片 |
| 09:05 | 「pr卡片」 | 又重发一次卡片 |

卡片是被要了才给的，不是交付时本来就在的。搭档要的不是好看的 HTML，是一张**不读正文就完成决策的卡**：这是什么 PR、能不能合、证据够不够、按哪个键。

## 根因：约束错位（与 #1907/#1951 同构）

- **没有机械闸**：speak 形态选择全是提示词自律（SYSTEM.md/speak description/skill），yield 只校验「先 speak 再 yield」不校验汇报内容形态——违反零成本，回退零摩擦。
- **没有固定模板**：每次手搓卡片字段随心情浮动，缺最关键的授权按钮（otterCard.submit 能把「拍板」变成一次点击，且直接充当 merge_pr 的合法授权源）。
- **「PR 卡片」高频词未绑定动作**：未进术语库，模型把它理解成「贴个链接/做张图」。
- **汇报视角漂移**：文本主线是操作流水，搭档视角要的是「你现在要不要按、按了会发生什么」。

## 修法四件套

### A. 机械闸（双闸点，本 PR 核心）

判定核心三信号共现：**PR 引用**（`#\d{3,}` 或 pull URL；issue/PR 共号域——呈递语境 #N 泛指待拍板对象，通报 issue 完成同样该出卡）× **请求措辞**（词表见下）× **决策卡不在场**（无含 otterCard.submit 的 html-card 围栏）。

| 闸点 | 判定面 | 词表 | 拒绝点 |
| --- | --- | --- | --- |
| 辅闸（speak 落库前） | 单条 body | 窄表：拍板/授权/一句话纯请求措辞（**不含**「可以合入」等评价措辞） | errorResponse 拒落库，含补卡模板 |
| 主闸（yield to user 前） | 回合累计 speak + yield reason | 宽表：窄表 + 合入请求族（可以合入/待合入/要不要合入/是否合入/能否合入…） | errorResponse 拒交棒，指导补 speak 决策卡 |

两表分离的防误拦论证：
- **窄表不收评价措辞**：独立检视獭的检视报告（「对抗检视通过，可以合入，无阻塞项」）常态无卡——speak 侧收「可以合入」会把检视回呈也拦掉。
- **宽表只在 yield-to-user 上下文收评价措辞**：yield to user 本身是「请搭档行动」的结构信号；检视獭 yield 回大獭（to 不含 user）不触发。「可以合入了」在 yield-to-user 语境正是 08:43 事故形态。
- **主闸判定面用累计而非单条**：防拆条规避——先说「#1960 检视完了」（无请求词过辅闸）再说「可以合入了，等你」（无 PR 引用过辅闸），单条都不共现，累计才拼出呈递形态（集成测试实证）。

**否定/过去式剔除**（先剔除再匹配）：`不建议合入`/`不要合入`（后行断言 `(?<!要)` 排除疑问形态「要不要合入」——测试实证误剔会让主闸漏拦）/`别合入`/`暂不合并`/`无法合入`/`拒绝合入`/`已合入`/`已授权`/`已 merge/squash`。剔除按片段不按整句：同回合「#1954 已合入，#1960 可以合入」→ 前者剔除后后者仍命中（呈递在途）。

**fail-open 边界**：ctx.speakBodiesThisTurn 未注入（旧装配路径）→ 主闸判定面视为空，放行不抛异常（宁漏勿误——闸失效不能反过来阻断发言）；辅闸不依赖注入字段。

**授权按钮判定**只认「围栏内容含 otterCard.submit」（remark 收集，与体积测量同源）——submit 是提交唯一通道；summary 固定格式「<PR号>合入」（merge_pr 合法授权源，F20260922pmgd）是模板纪律留给 prompt 层，机械层不管措辞。

### B. 模板固化（get_html_card_contract 契约）

写卡前必调的契约工具加「PR 呈递决策卡模板」节：七字段 checklist（title=PR号+一句话结论/状态/改动要点/验证证据带来源/检视结论覆盖 commit/合入后动作/授权按钮 summary 固定格式）+ 双闸点说明。

### C. 术语入库

`data/terminology/seed-terminology.json` 加「PR 卡片」（seed-012，别名 pr卡片/PR卡/决策卡）：定义=决策载体卡七字段+otterCard.submit 授权源，context=四件套固定动作。

### D. skill 纪律（worktree-isolation 步骤 5）

推送并创建 PR 段加呈递四件套：①正文 1-2 句结论 ②PR URL 裸写独占一段（unfurl）③create_linked_resource 登记 ④带授权按钮的决策卡——机械闸校验，缺卡被拒；汇报视角自检「搭档不读正文只看卡能决策吗」。

另：speak 工具 description 加一句决策卡纪律（行为触发类引导必须在工具 description——每请求随 tools 参数注入；speak description 原注释明示勿移出）。

## 吸收孤儿分支（#1907 prompt 层处置）

`fix/F20261119prcd-pr-card-regression-note`（F20261119prcrn，原会话 a23f0f4a 归档未交付）三 commit cherry-pick 吸收：BIG_OTTER.md 六形态段加 #1907 回退案例标注（三件套固定动作+交付自查）+ 特性文档（过两轮检视修正）。与机械闸正交互补：prompt 层管「记得」，机械层管「逃不掉」。#1907/#1952 按 issue 原文「合成一件特性做」一并闭环。

## 已知边界与兜底

- **请求措辞词表是白名单制**：表外措辞（如「看着办」「你定」）不拦——守卫总则「明确拦不明确放通」，宁漏勿误；漏拦由 prompt 层四件套纪律兜底（skill/契约/术语三层在场）。
- **「可以合入」的检视报告依赖主闸的 to-user 判定**：检视獭 yield 回大獭不触发主闸；若检视獭被误派直接 yield to user 且说了「可以合入」，会被要求补卡——补一张状态通报卡成本低，属可接受误拦（宁漏勿误的反向边界：结构信号+请求措辞共现时，出卡总是合理的）。
- **辅闸不校验决策卡质量**（有无 submit 由主闸管）：单条带任意卡片的呈递措辞过辅闸——卡片有没有授权按钮在 yield 时才判。中间态（speak 完未 yield）无闸覆盖，设计如此（yield 是最终闸点，speak 可连续多次）。
- **PR 引用与 issue 共号域**：#N 不区分 PR/issue——「issue #1952 处理完了，等你拍板」也会被要求出卡（issue 完成的拍板呈递同样该有决策卡，泛化是收益不是误拦）。

## 验证

- `tests/usecases/conversation/pr-card-gate.test.ts`：19 例判定矩阵（词表命中/否定剔除/多 PR 混排/嵌套围栏/宽窄表分离）。
- `tests/interface-adapters/agent-runtime/tools/pr-card-gate-speak-yield.test.ts`：8 例工具层集成（辅闸拒/放、拆条规避主闸兜住、检视獭不触发、已合入通报放行、fail-open、补卡后放行）。
- 全量 6468 测试绿；`npm run check` 绿（build/lint/schema/smoke）。
- 狗食验证第一现场：本 PR 自身呈递执行四件套（正文结论 + 裸链独占段 + 登记 + 决策卡）。

## Rollback

`git revert <merge-commit>` 即可——闸是独立校验层（speak/yield execute 内各一个函数调用），无数据迁移；术语 seed 下次启动不重复导入（id 幂等）。
