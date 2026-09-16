---
id: F20260916rptl
title: 议题汇报规范层：决策简报三层结构 + L2 触发条件 + 模板库 + 黑话翻译表
summary: "纯 prompt/文档改动——decision-briefing.md 重写为三层结构（3 秒执行摘要/30 秒关键信息/完整版），BIG_OTTER/SMALL_OTTER 加议题汇报触发条件（L2 必出 html-card，结构真相源留 decision-briefing 不重复枚举），黑话翻译表入 BIG_OTTER 附录，新增 3 个 html-card 模板（决策通报/方案对比/复盘报告）"
change_type: prompt
capability_test: "n/a: 纯 prompt/文档改动（references 模板 + identity prompt），无代码变更——三层结构行为验证由 PR 终审简报首个示范实例承担；prompt 层 lint 走 lint:intent"
created: 2026-09-16
created_in_conversation: ee07dc1b-b195-4595-9b53-d927ec020f97
modules:
  - .pi/skills/review-protocol/references/decision-briefing.md
  - .pi/skills/review-protocol/references/templates/
  - .pi/skills/review-protocol/SKILL.md
  - prompts/identity/BIG_OTTER.md
  - prompts/identity/SMALL_OTTER.md
from:
  - F20260916hcel
  - F20260912brdd
intent:
  problem: "「说人话」反复失效（搭档 7 次求救）的根因是面向搭档的信息无分层契约、无形式硬约定——decision-briefing 六要素平铺、决策点埋末位、纯文本为主、黑话靠即兴比喻；搭档 9/15-9/16 明确要「问题/根因/分析/方案/让我选择」+「三秒/三十秒/完整版三层结构」+「有图有表」，否定前置色块和每问一小卡"
  expected_effect: "L2 决策呈拍板时必出 html-card 议题汇报卡（一个议题一份卡）；简报按三层结构组织（3 秒层结论入 title 折叠态可见/30 秒层表格为主体/完整版 details 折叠）；黑话有固定翻译口径；海獭套模板出卡质量稳定"
  verify_by:
    type: behavior_check
---

# 议题汇报规范层

## 背景

2026-09-15 搭档两次反馈「说人话版本」失效：「我很多时候还是感觉看不懂」。全库 19 条「说人话」命中里搭档发 7 条全是求救——该词在 prompt 规范零命中，是大獭临场补丁，质量忽高忽低。根因分析（`analysis/2026-09-15-shuorenhua-failure-analysis.md`）：决策点埋末位、「说人话」当语言风格不是信息架构、形式纯文本为主、无分层契约。

搭档 9/15-9/16 原话定规格：

> 「我更想看到 问题是什么（描述清楚、简单易懂）、根因、分析、解决方案，然后让我选择，而不要过于为了简略文字而简略」
> 「内容可能比较多，但有图有表，有三层结构，三秒看什么、三十秒看什么、完整版这种」
> 前置色块「很低级也很难看」
> 「难道每个问题就做一张卡片吗」
> 「默认合起来」（所有卡默认折叠，9/16 纠正大獭误执行的「默认展开」）

基建层（PR1，F20260916hcel / PR #958）已合入 main：单一 html-card 围栏、体积 MAX=64KB、所有卡默认折叠、高度 clamp [100,4000] 海獭自控、单消息最多 2 张。本特性是规范层（PR2）：把三层结构落到 prompt 规范文件。

## 方案设计

### 1. decision-briefing.md 三层结构重写

六要素平铺 → 三层结构，信息零丢失：

| 旧（六要素平铺） | 新（三层结构） |
|---|---|
| 1. 一句话结论（放最前） | **3 秒层**：一句话结论 + 风险 + 置信度 |
| 2. 背景 ≤3 行 | **30 秒层**：背景 ≤3 行 |
| 3. 选项对比（含被否方案+否决理由） | **30 秒层**：选项对比（≥3 选项用表格，推荐行高亮） |
| 4. 獭间分歧如实呈现 | **30 秒层**：獭间分歧 |
| 5. 推荐+理由+置信度+最大风险 | **3 秒层**置信度 + **30 秒层**推荐+理由+最大风险 |
| 6. 锚点 | **完整版**：案发现场 / 锚点 / 引用（`<details>` 折叠） |

新增「卡片化规范」节：L2 决策必出 html-card、一个议题一份卡、title 承载 3 秒层结论、选项按钮 otterCard.submit、不要前置色块、不为简略而简略。

保留原样：默认通过模式（L2 中低风险）整节、适用范围、分级边界——这些与分层结构正交。

### 2. BIG_OTTER/SMALL_OTTER 触发条件节

熵增纪律（F20260912brdd 去重决策）：完整规格真相源留 decision-briefing.md，identity 文件只放触发条件 + 指针，不重复枚举结构。

- BIG_OTTER：「议题汇报触发条件」节——L2 决策必出 html-card + 触发要点（一议题一卡/title 承载 3 秒层/submit 按钮/不要前置色块/写卡前调契约工具）
- SMALL_OTTER：yield 回大獭的汇报含 L2 内容时 speak body 按三层结构组织；卡片化由大獭呈终审时完成

### 3. 黑话翻译表入 BIG_OTTER 附录

静态写入（搭档 9/15 未明确反对静态方案，且术语稳定低频变化、动态查 terminology 增加每轮检索开销）：invoke/yield/speak/entry/turn/session 池/ToolContext/worktree/发言石/F 文档/决策简报/检视獭/信号/healing 台账/回执 等 17 条，一条一行，固定口径不即兴造比喻。

### 4. 模板库（3 个模板）

`templates/decision-briefing-card.md` / `option-comparison-card.md` / `retrospective-card.md`，每个含：何时用、怎么填、完整 html-card 示例、发出前自检清单。模板用设计 token（var(--otter-\*) 等）不写死色值；data-height 显式声明高度；完整版用 `<details>` 折叠。

## 关键决策

### D1：模板存放位置——工作区 → repo references/templates/

**原始表述**（v2 分析文档）：模板存对话工作区。
**调整为**：repo 内 `.pi/skills/review-protocol/references/templates/`，与真相源 decision-briefing.md 同目录。
**理由**：工作区随对话归档删除，模板需跨对话稳定引用；review-protocol 是所有审视/终审流程的入口 skill，模板放其 references 下天然被所有走流程的獭看到。工作区只存原型和分析文档。
**风险**：repo 内模板改动要走 PR 流程（比工作区重）——可接受：模板迭代频率低，且规范层本就该走审视。

### D2：黑话翻译表静态入 BIG_OTTER，非动态 terminology 库

静态表 17 条固定口径。理由：术语稳定、使用场景是「写作时参考」而非「运行时查询」、动态检索增加每轮工具调用开销。若未来术语漂移频繁再迁 terminology 库。

### D3：SMALL_OTTER 侧不强制出卡

小獭 yield 回大獭的 L2 汇报只要求 speak body 三层结构，卡片化由大獭呈终审时完成。理由：避免每獭重复出卡消耗体积预算（单消息 2 张上限），且终审是大獭的职责（异体原则——小獭不应直接呈搭档拍板）。

### D4：默认折叠与 title 承载结论的绑定

PR1 已定「所有卡默认折叠」（搭档 9/16「合起来」）。推论：卡片的 3 秒层结论必须放进 title——折叠态 title 是唯一可见信息。本规范把这个推论写成硬要求。

## 影响范围

- 改：`.pi/skills/review-protocol/references/decision-briefing.md`（重写）、`prompts/identity/BIG_OTTER.md`（+触发条件节+附录）、`prompts/identity/SMALL_OTTER.md`（+触发条件节）、`.pi/skills/review-protocol/SKILL.md`（参考节+模板库指针）
- 新增：`.pi/skills/review-protocol/references/templates/` 3 个模板文件
- 不改：任何代码（src/web 零改动）；SYSTEM.md 主体不动（R8 指针语义不变——真相源仍是 decision-briefing.md）

## 一致性检查

- **SYSTEM.md R8**：「终审简报…模板真相源在 review-protocol/references/decision-briefing.md」——本 PR 后真相源不变，三层结构是内容重组非路径变更，R8 语义成立 ✅
- **BIG_OTTER.md「呈搭档拍板的硬规则」节**：原有指针保留，新增触发条件节紧随其后，两处互补不重复 ✅
- **SYSTEM.md 注入内容与 BIG_OTTER.md 同步关系**：SYSTEM.md 含 R8 决策分级（规范层），BIG_OTTER.md 含身份+硬规则（身份层）——本 PR 只动 BIG_OTTER 身份层，SYSTEM.md 无需同步改动 ✅
- **review-protocol SKILL.md 引用**：终审步骤 5 指针「模板见 references/decision-briefing.md」语义不变；参考节新增模板库指针 ✅

## 验证

- 改前/改后对照：见 PR 描述「自检报告」节（拿 PR #958 终审简报真实场景演示三层结构）
- `npm run lint:intent`：通过
- 模板示例自检：3 个模板均过自检清单（title 独立支撑决策/结论最前/表格+高亮/被否方案/无前置色块/无写死色值/data-height）
- 首个示范实例：本 PR 的终审简报将直接用新三层结构 html-card 发出——规范自我验证
