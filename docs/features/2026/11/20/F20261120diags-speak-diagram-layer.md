---
id: F20261120diags
title: "说话图形层：图形态正名（内联 SVG 图卡）+ diagram skill + 注入面补图 + 卡片体积 256KB"
summary: "六形态中「图」是唯一没有獭侧通道的形态：speak 描述明写「图类暂无我方发图通道」、契约场景映射表无图行、绘制规范零沉淀——技术方案梳理被路由到卡类，图解退化成卡片里的一堆文字。但技术上通道已通：html-card 自包含 HTML 不禁内联 SVG，渲染层零改动即可出图。本特性做正名而非工具开发：①契约新增「图类卡」节（html-card 内联 SVG + importance=high 默认展开，图的感知动词是「看」）+ 映射表补图行；②新建 diagram skill（图型选择/网格对齐/单流向/密度克制/token 配色 + 质检门）——「像人画的」靠规范不靠库；③speak 描述与 BIG/SMALL_OTTER 补图意识；④卡片体积 64KB→256KB（搭档拍板：上限定位是失控保险丝不是内容约束，正常图卡 <20KB），超限文案引导转文类产物/内联 SVG。"
change_type: prompt
capability_test: "n/a: 注入面 prompt 特性（speak 描述/契约/身份 prompt/skill），LLM 行为验证走真实发言吃狗粮——首例分层架构 SVG 图卡已在驱动对话产出（2026-11-20「说话治理全景」）；机械面由 lint:skills + tool-helpers/html-card 体积边界测试覆盖"
intent:
  problem: "搭档多次提汇报可读性优化（描述方式/角度/完整性/生动形象），本轮指向图形表达：claude code 的架构图/流程图像人画的，海獭说话缺这层。诊断：内容组织（F20261030rdpov）、文风（F20261030lvgov）、形态路由（F20261009fpeq）三层已治，图形层是六形态中唯一断腿的形态——通道被 speak 描述明写封死、映射表无图行、无绘制规范，三断点都是系统级而非獭懒。"
  solution: "正名 + 规范 + 意识，不做渲染层开发：①契约正名图类卡 = html-card 内联 SVG（CSP 只禁外网请求，SVG 合法），importance=high 默认展开（与活类「玩」同理，折叠态的图等于没发）；②diagram skill 沉淀绘制规范（单图单主题/网格对齐/单一主流向/密度克制/token 配色/质检门），明确不塞 mermaid/echarts（体积放不下也无必要，未来若要库走预注入渲染层 srcdoc 而非放体积）；③speak 描述改「图类暂无通道」为图类卡指引，身份 prompt 补「技术图解别把图写成一堆文字」；④体积 64KB→256KB（4 倍余量，保险丝保留），超限文案从「请精简」改为「精简或转文类产物，图形需求用内联 SVG」。"
  expected_effect: "技术方案梳理/排查结论场景獭自主出 SVG 图卡而非文字堆砌；图质量有规范可检（对齐/流向/密度/配色四轴）；正常内容永远碰不到体积上限，失控输出仍有保险丝。"
  verify_by:
    type: static_only
created_in_conversation: 8a076a50-19b5-49fc-91a1-dcdc1cd5d38b
tags: [prompt, injection-surface, diagram, svg, html-card, product-form, skill]
modules:
  - interface-adapters
  - api-contract
  - prompts
  - .pi/skills
causal_links:
  - {type: "complements", id: "F20261009fpeq", note: "六形态注入面落地时图类仍无通道（映射表无图行），本特性把图正名为内联 SVG 图卡并补绘制规范——同一平权路线的补完"}
  - {type: "extends", id: "F20260916hcel", note: "体积弹性化续作：64KB→256KB，上限定位明确为失控保险丝；塞库需求正路是预注入渲染层而非放体积"}
---

# 说话图形层（F20261120diags）

## 背景

搭档 2026-11-20 提出：claude code 梳理技术方案时画的架构图/流程图「很像人画的，质量也高、不混乱」，
希望海獭说话也能用图/表这种天然高效的展示形式。

历史治理脉络：L1 内容组织（F20261030rdpov 三问 + 首屏自足）、L2 文风（F20261030lvgov 反泔水）、
L3 形态路由（F20261009fpeq 六形态进注入面）都已闭环。**L4 图形层是六形态中唯一断腿的形态**，三个断点：

1. speak 工具描述明写「图类暂无我方发图通道」——本意是不能发图片文件，獭读到的结论是「图与我无关」
2. 契约场景映射表言语/卡/活/链/文各有行，唯独图无行——架构/流程场景被路由到卡类，图解退化成文字
3. 绘制规范零沉淀——「像人画的」靠规范（网格对齐/分层/流向一致/密度克制），系统里没有

关键事实：**技术上通道已通**——html-card 自包含 HTML 只禁外网请求，内联 SVG 完全合法，
首例图卡（四层治理全景图）已在驱动对话产出验证。缺的不是工具开发，是正名 + 规范 + 意识。

## 改动清单

| # | 改动 | 锚点 |
| --- | --- | --- |
| 1 | 契约新增「图类卡（内联 SVG）」节 + 场景映射表补图行（架构/流程/时序/关系 → 图类卡默认展开） | `src/interface-adapters/agent-runtime/tools/html-card-contract-tool.ts` |
| 2 | 新建 diagram skill：图型选择决策树、骨架先行、SVG 技术规范（token 配色/viewBox/marker）、质检门五条 | `.pi/skills/diagram/SKILL.md` |
| 3 | speak 描述图类句改写；BIG/SMALL_OTTER 六形态段补图意识 | `tool-factory.ts`、`prompts/identity/` |
| 4 | CARD_MAX_BYTES 65536→262144（注释写明保险丝定位）；超限文案引导转文类产物/内联 SVG | `api-contract/api/html-card.ts`、`tool-helpers.ts` |
| 5 | 测试随常量更新（256KB 边界/超限/嵌套围栏）；gameover-report 注释口径改 CARD_MAX_BYTES | `tests/`、`web/src/lib/html-card.test.ts` |

## 设计决策

- **为什么不引入 mermaid**：库 2.8MB，任何合理体积上限都放不下；且手写 SVG 强制走设计 token，
  风格统一、更像人画的。未来若确需图形库，正路是预注入渲染层 srcdoc（学预设类库 CSS），
  卡内只写图源码——不是放开体积让每卡塞库。
- **为什么保留体积上限而不是取消**（搭档 10:28 问「是否不需要限制」，讨论后拍板放宽而非取消）：
  正常内容卡（含复杂 SVG）<20KB，撞限信号 = 塞库/base64/失控输出，全是「效果差」来源；
  卡片原文进消息历史每轮注入，大卡是持续 token 税；无上限时一次失控生成即爆上下文与渲染。
  上限是保险丝，256KB = 正常内容 4 倍以上余量。
- **图类卡复用 importance=high 而非新围栏**：图的感知动词是「看」（与活类「玩」同理），
  折叠态没意义；不新增围栏类型 = 渲染层零改动，不豁免卡数预算。

## 验证

- `pnpm lint:skills`（新 skill 合规）
- tool-helpers / html-card / gameover-report 相关单测
- 行为验证：首例狗粮图卡已在驱动对话产出；后续真实汇报场景持续观察 + 搭档反馈回流 diagram skill
