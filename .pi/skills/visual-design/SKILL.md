---
name: visual-design
description: >-
  Use when: 搭档要求做展示类设计——页面/落地页/UI 界面/卡片/海报/PPT 版式/图表美化，或要求审视/重构既有设计、从参考图提取设计风格. Not for: 纯文案写作、代码逻辑实现（设计稿中的交互逻辑另走 code-implementation）、闲聊聊设计想法 → companion. Output: 过反泔水质检门的设计产物（四层方法论：结构→风格→质检，四动词交互），web 媒介输出 HTML/CSS.
co_loads: []
category: technique
---

# Visual Design

展示类设计的反泔水方法论：结构先于视觉、词典+人择、不过门不出稿。

## 触发

**触发条件**：搭档要求设计/重构/审视任何展示类产物，或提供参考要求提取风格。

**排除**：纯文案（→ companion）、代码功能实现（→ code-implementation）。

## 输入

| 输入 | 必选 | 缺失时 |
|------|------|--------|
| 设计 brief（做什么给谁看） | 是 | 停下来问搭档 |
| 目标媒介 | 否 | 从 brief 推断；web 之外明示就绪状态 |
| 风格偏好/参考 | 否 | 走词典人择流程 |

## 工作流

1. **路由动词**（四动词交互模型，边界决策树）：
   - `design`（默认）：新建设计。走步骤 2-5 全流程
   - `audit <目标>`：对既有产物只评分出反泔水清单，**不改稿**
   - `redesign <目标>`：保文案+信息架构+品牌，只换视觉结构层
   - `study <参考>`：从截图/URL 提取设计 DNA（结构/字体配对/色彩锚点），输出可复用诊断
   - **动词边界决策树**：搭档要求新东西 → design；搭档要求看问题/评价 → audit（禁止顺手改）；搭档对现状不满要换样子但内容不变 → redesign；搭档给出欣赏的参考 → study。模糊时问一句，不猜
   - **study 输出格式**：`## 设计 DNA 诊断`（宏观结构描述/字体配对推断/色彩锚点色值/可迁移要点四段）——诊断后搭档可选：用 DNA 建新（转 design）/ 沉淀进 styles.md 词典 / 仅留诊断
2. **定结构**（结构先于视觉）：read `references/web/structure.md`，先选信息骨架与节奏——不同 brief 不同骨架，禁止模板换色。结构未定不动手写视觉
3. **择风格**（词典+人择）：read `references/web/styles.md`，从词典给搭档 2-3 个风格候选（各附一句话特征+适用判断），人择后推到位（push it properly, not superficially）——词典没有的现场借 study 流程提取，不硬凑
4. **工具链**：read `references/web/toolchain.md`——通用场景输出独立 HTML/CSS；海獭对话卡片场景输出 html-card（design token 引用），两者不混用
5. **过质检门**（不过门不出稿）：read `references/web/anti-patterns.md`，出稿前执行反泔水扫描+自我批评——命中反模式项必须修掉或说明豁免理由，把「为什么这不是泔水」写进交付说明

方法论原理与出处见 `references/methodology.md`（首次使用本 skill 时建议通读）。

## 媒介就绪状态

| 媒介 | 状态 | 载体 |
|---|---|---|
| web（页面/卡片/界面） | ✅ MVP | references/web/ |
| poster（海报/单帧） | Phase 2（issue 登记） | 未建——需求来了明示状态，禁止用 web 冒充 |
| slides（PPT/叙事流） | Phase 3（issue 登记） | 未建——同上 |

## 产出

| 产出 | 下一步 | 执行者 |
|------|--------|--------|
| 设计产物（HTML/CSS 或 html-card）+ 质检门通过说明 | 搭档人评验收 | 搭档 |
| audit 评分清单 | 搭档决定是否转 redesign | 搭档 |
| study 风格 DNA 诊断 | 沉淀进 styles.md 词典或直接使用 | 当前獭 |

## 参考（索引）

- `references/methodology.md` — 四层方法论本体（结构/风格/质检/交互的原理与业界溯源）
- `references/web/structure.md` — web 结构库
- `references/web/styles.md` — web 风格词典
- `references/web/anti-patterns.md` — 反泔水清单与质检门
- `references/web/toolchain.md` — 工具链约定（含 html-card 格式）
