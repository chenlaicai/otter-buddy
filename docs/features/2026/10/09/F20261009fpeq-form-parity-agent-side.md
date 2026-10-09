---
id: F20261009fpeq
title: "形态平权的獭侧落地：六形态选择指引进注入面——speak 工具描述 + 身份 prompt + 契约场景映射 + 小獭简报模板"
summary: "宪法六形态（言语/卡/图/活/链/文）渲染层已全部落地（F20261008csfw→csf1→csp2→csf3），但獭侧注入面零知识：speak 工具描述只讲 html-card 写法、0 处提活类/链类，身份 prompt grep 六形态零命中——獭默认退化成「文本+卡」。本特性把世界观传导到行为层：① speak 描述补六形态选择映射（什么场景选什么形态）；② BIG/SMALL_OTTER 补最小形态意识段；③ 场景映射表进 get_html_card_contract 契约（写卡前必调的天然触达点，不挤 SYSTEM.md）；④ otter-summon 任务简报模板补形态预期一行。"
change_type: prompt
capability_test: "n/a: 能力验证面 = lint-prompt-anchors 全树扫描零违规 + lint-intent 通过 + 既有套件回归绿（工具描述字符串改动有 tests/interface-adapters 兜底）。golden 豁免声明（沿 #1318/#1377 先例）：注入面指引变更属 LLM 行为面，golden 场景集无「汇报形态选择」场景可跑——由锚点重放评审（本 PR Verification 节）替代"
created_in_conversation: 325ef7b7-8e42-4edc-9abf-eae8f332a2c4
causal_links:
  - "F20261008csfw"
  - "F20261008csf1"
  - "F20261009csp2"
  - "F20261009csf3"
modules:
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/interface-adapters/agent-runtime/tools/html-card-contract-tool.ts
  - prompts/identity/BIG_OTTER.md
  - prompts/identity/SMALL_OTTER.md
  - .pi/skills/otter-summon/SKILL.md
tags:
  - conversation-view
  - product-form
  - prompt
  - injection-surface
created_at: "2026-10-09T16:10:00+08:00"
intent:
  problem: "六形态渲染层全齐但獭侧注入面零知识（speak 描述 0 处提活类/链类，身份 prompt 六形态零命中），獭默认退化成「发言+html 卡」——搭档实证：「你们海獭还大多数还是在发 发言+html，并没有按照预期的用对各种格式，比如刚才这个 PR」。与「记忆无感知」（R7 立规前）同型：世界观合入了前端，没传导到獭的行为层。"
  expected_effect: "獭在产出节点用对形态：PR 呈递 = 链类裸链（自动 unfurl 预览卡）+ 产物登记（自动摘要卡混排）而非只贴文本；可交互演示 = 活类卡；结构化对比 = 卡类；一句话问答 = 言语。选择映射随 speak 工具每轮注入，行为触发点（F20260825hcpg 判断标准归位原则：行为触发类引导必须在工具 description）。"
  verify_by:
    type: static_only
---

# 形态平权的獭侧落地：六形态选择指引进注入面

## 问题（现状调查结论，gen6 glm 世完成）

1. **渲染层全齐**：宪法（F20261008csfw）定义六形态平权 → P1（F20261008csf1 图类 lightbox/链类 unfurl/文类摘要卡混排）→ P2（F20261009csp2 活类卡 + 自动产物登记）→ 右栏清单退役（F20261009csf3）
2. **注入面零知识**：speak 工具描述（tool-factory.ts:42）只讲 html-card 卡片写法，0 处提 html-card-play/链类/文类；BIG_OTTER.md / SMALL_OTTER.md grep 六形态零命中
3. **根因定性**：与「记忆无感知」同型——世界观合入了前端，没传导到獭的行为层，獭默认退化成「文本+卡」

## 獭侧能力边界（本特性实施前核实，防指引写成空头支票）

| 形态 | 獭侧动作 | 渲染机制（锚点） |
|---|---|---|
| 💬 言语 | speak 正文 md | 气泡（现有） |
| 🗂 卡类 | ```html-card 围栏 | HtmlCard 沙盒，默认折叠 |
| 🎮 活类 | ```html-card-play 围栏 | 默认展开运行 + 自动登记产物（tool-factory.ts:85 autoRegisterPlayableCards） |
| 🔗 链类 | URL 裸写**独占一段**（勿 [label](url)、勿句中） | remark-bare-link 插件 mdast 层判定 → unfurl 预览卡（web UnfurlCard.tsx:57-69） |
| 📄 文类 | create_linked_resource 登记产物 | 摘要卡按 createdAt 混排进时间轴（ArtifactCard） |
| 🖼 图类 | **獭侧暂无发图通道**——lightbox 只作用消息 attachments，speak 无附件写入源（agent-invoker.ts:779 注释「speak 工具暂无附件写入源」）。本特性不补此能力，只在指引中诚实标注边界 | — |

## 设计取舍

**机制识别检查点判定（动手前完成）**：本特性为纯注入面指引（prompt/description 字符串），不新增运行时机制、不改数据流——四问全部不命中，判定结论：非机制类变更。

**关键取舍**：
- **选择映射放 speak 描述正文而非 references**：F20260825hcpg 注释明示「行为触发类引导必须在工具 description（每请求随 tools 参数注入），references 指针对『要不要用』的决策无效」——形态选择正是「要不要用」的决策
- **场景映射表放契约工具不挤 SYSTEM.md**：get_html_card_contract 是写卡前必调的天然触达点（speak 描述已引导必调），场景级映射（PR 流程/审视报告/终审简报各节点出什么形态）放这里；SYSTEM.md 只保留 R 层规则不扩
- **身份 prompt 只加一段最小意识**：体积纪律——BIG_OTTER.md 现 11.4KB，本特性净增 <500B，只写「形态平权意识 + 一句最常见纠偏（PR 呈递）」，详细映射指向工具描述与契约
- **链类写法纠正常见误用**：`[label](url)` 与句中链接不出 unfurl 卡（判定规则实测），指引必须写明「独占一段」这个反直觉动作

**省事声明论证**：本特性被描述为「最小增量」——依据是增量纪律（注入面体积预算 #1030 立的闸），每处注入都过了「删掉会改变行为吗」三问；替代方案（SYSTEM.md 新增 R 条）被否：R 层管规则不管场景映射，且体积纪律禁止 SYSTEM.md 继续膨胀。

## 验证

- lint-prompt-anchors（全树）：零违规（改动文本不含 F 编号/issue 号）
- lint-intent：通过（intent 块完整，verify_by.type=static_only 合法枚举）
- 既有测试套件回归（工具描述字符串有 tests/interface-adapters 断言兜底）
- Golden Gate：n/a——豁免声明：verify_by=static_only，golden 场景集无「汇报形态选择」场景可跑（沿 #1318/#1377 先例，写进 PR Verification 节）
- 锚点重放评审：本特性改动 speak 工具描述的行为触发语义（什么场景选什么形态）→ 必跑，结果在 PR Verification 节
- 已过最简实现检查：改动为纯文本增量，零新代码/零依赖/零新文件（特性文档除外）——仓库已有注入面（speak 描述 + 契约工具）即最简载体
