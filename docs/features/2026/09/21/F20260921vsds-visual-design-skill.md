---
id: F20260921vsds
title: visual-design skill：跨媒介展示类设计方法论（总纲+媒介插件架构，MVP=web）
summary: 把「结构化约束 > 端到端生成」的设计方法论沉淀为可安装的 skill——四层抽象（结构/风格/质检/交互）为媒介无关本体，references/ 按媒介分目录实例化（web/poster/slides）。MVP 交付总纲 + web 媒介（结构库/风格词典/反模式清单/工具链约定，含 html-card 目标格式）。roadmap 机制化防烂尾：Phase 2/3 开 issue 登记由未闭环扫描盯梢。方法论溯源：AI 海报方法论（HN 1784分）+ hallmark 等 12 万星量级设计 skill 生态洞察（2026-09-21 外部洞察对话，搭档显式发起结合落地）。
doc_type: feature
change_type: prompt
capability_test: "n/a: 纯 prompt 资产（skill 文件），无代码路径；行为验证走路由触发 + build/audit 产出人评"
created_in_conversation: 98bd9fdd-8e28-4de8-b782-b59f46e733dd
tags: [skill, design-methodology, anti-slop, prompt, roadmap]
modules:
  - .pi/skills/visual-design/SKILL.md
  - .pi/skills/visual-design/references/methodology.md
  - .pi/skills/visual-design/references/web/structure.md
  - .pi/skills/visual-design/references/web/styles.md
  - .pi/skills/visual-design/references/web/anti-patterns.md
  - .pi/skills/visual-design/references/web/toolchain.md
causal_links:
  - F20260713u9v4
created_at: 2026-09-21
---

# F20260921vsds visual-design skill：跨媒介展示类设计方法论

## 背景

### 意图锚（搭档原话）

> 「jev先放一边吧……咱们来看下这条画图方法论。你再去洞察下，看看画图/UX设计上，有没有流行的skill这种（我理解，如果要方法论，那业界应该就有沉淀下来一些好用的skill」

> 「ok，继续推进，咱们能搞一套skill出来吗，但我野心更大一点，这个方法论，是否不止是ux，其实图片/海报/ppt等涉及到展示类的设计，是否都能用这一套方法论」

> 「都ok；但我补充一点，搞mvp可以，但你必须做好后续其他的规划，不能做了Mvp然后没有后续了」

### 方法论溯源（外部洞察，2026-09-21 本对话）

- **AI 海报方法论**（HN 1784分/913评论）：结构化分步生成（风格坐标→借模型词典→人择→推到位）vs 一句话端到端直出的对照实证。
- **设计 skill 生态**：ui-ux-pro-max 129K★（192 规则+79 风格）、taste-skill 88.8K★、hallmark 29K★（macrostructure 优先 + 21 themes + 57 slop-test 门 + 四动词）。头部全部单媒介深耕（web UI），无一抽象出媒介无关本体——差异化空间。
- **流程合法性**：本特性为搭档显式发起的结合落地（非雷达/洞察流程自动产出），符合「洞察归洞察、结合归搭档」边界（2026-09-21 定）。

## 目标

- T1: 沉淀「总纲+媒介插件」架构的 visual-design skill——SKILL.md 载四层方法论（结构/风格/质检/交互）与四动词交互模型，媒介实例进 references/<medium>/
- T2: MVP 交付 web 媒介完整四件套（结构库/风格词典/反模式/工具链约定），支持 html-card 目标格式
- T3: roadmap 机制化——Phase 2（poster）/Phase 3（slides）以 GitHub issue 登记，纳入未闭环扫描监控，MVP 合入不等于项目终结
- T4: 反泔水质检门成为产出前硬步骤（不过门不出稿）

## 非目标

- ❌ 图像生成模型的 prompt 工程（MVP 的 web 媒介产出 HTML/CSS；图像生成类媒介留 Phase 2 poster 评估）
- ❌ 复刻 hallmark 的 references 全量知识（30+ 文件；MVP 取方法论骨架 + 本地化内容，广度按需增长）
- ❌ 做成海獭专用 skill——工具链通用化，html-card 仅作为 web 媒介的目标格式之一（边界：海獭给别人用时，别人在做别的项目）
- ❌ 自动评分/CI 集成（质检门是 skill 内流程，不是代码机制）

## 未决问题

- Phase 2 poster 的产出工具链（SVG/HTML vs 图像生成 prompt）——Phase 2 启动时定
- 风格词典的规模与增长机制（v1 手工精选，何时引入程序化搜索）——使用反馈后定

## 方案设计

### 架构：总纲 + 媒介插件

```
.pi/skills/visual-design/
├── SKILL.md               # 四层方法论 + 四动词 + 媒介路由（媒介无关本体）
└── references/
    ├── methodology.md      # 方法论展开：四层抽象的原理与出处
    └── web/                # MVP 媒介
        ├── structure.md    # 结构库：布局节奏/层级骨架（结构先于视觉）
        ├── styles.md       # 风格词典：可搜索风格条目（借词典+人择）
        ├── anti-patterns.md# 反泔水清单 + 质检门流程（不过门不出稿）
        └── toolchain.md    # 工具链约定：通用 HTML/CSS + html-card 目标格式
```

### SKILL.md 核心设计

- description 三段式：Use when 涉及展示类设计（页面/卡片/海报/PPT 版式/图表美化）→ Not for 纯文案、代码逻辑 → Output 按媒介产出 + 过质检门的设计稿
- 四动词（对齐 hallmark 交互模型，业界验证过）：`design`（新建，默认）/ `audit <目标>`（评分清单不改稿）/ `redesign <目标>`（保文案信息架构换视觉层）/ `study <参考>`（提取设计 DNA）
- 媒介路由表：web → references/web/；poster/slides → 未就绪时明示「Phase N 待建」，禁止降级用 web 冒充（诚实边界）

### web 媒介四件套要点

- **structure.md**：宏观结构优先——先定信息骨架（叙事节奏/密度分布），后谈视觉；结构多样性原则（不同 brief 不同骨架，不做模板换色）
- **styles.md**：v1 精选 ~20 风格条目（每条：名称/一句话特征/字体配对/色彩锚点/适用场景），来源=业界共识本地化；人择后推到位（不 superficially）
- **anti-patterns.md**：泔水特征清单（紫色渐变 hero/居中三卡片/模板感 bullet 堆砌等）+ 出稿前质检流程：反模式扫描 → 自我批评 → 不过门不出稿
- **toolchain.md**：通用 HTML/CSS 约定；html-card 目标格式段（design token 引用 var(--otter-*) 等，对齐卡片契约；此段仅在海獭对话场景使用，通用场景输出独立 HTML）

### roadmap 机制化（T3，防烂尾——搭档硬要求）

| Phase | 交付物 | 状态 | 监控机制 |
|---|---|---|---|
| 1 | 总纲 + web 四件套（本 PR） | 交付中 | PR 流程本身 |
| 2 | poster/ 媒介目录（构图库/风格词典/反模式/工具链评估） | issue 登记 `visual-design Phase 2` | 未闭环扫描定时任务盯 issue |
| 3 | slides/ 媒介目录（叙事模板/版式规则） | issue 登记 `visual-design Phase 3` | 同上 |
| 4（远期可选） | study 动词深化 + design.md 便携格式跨工具交接 | 不开 issue，特性文档记一笔 | 使用驱动 |

启动条件：Phase 2/3 的 issue 在 MVP 合入即创建（本 PR 合入后大獭执行），不在 MVP PR 内创建（避免 PR 膨胀）。

## 影响范围

- 新增 skill 进入路由候选——涉及「展示类设计」请求会被路由到本 skill（此前落 companion 或无 skill 匹配）；无代码变更，无既有功能影响
- F20260713（海獭 web UI 设计）的后续页面迭代可成为本 skill 的第一批真实使用场景（因果关联，非依赖）

## 风险与约束

- skill 内容质量依赖 v1 手工精选，冷启动期风格词典覆盖不足 → 用「词典没有时明示 + 借助 study 动词现场提取」兜底
- 方法论文本过长稀释路由注意力 → SKILL.md 控制在骨架级（<150 行），展开内容全进 references（对齐项目 skill 体积预算纪律）

## 不兼容更新

无（纯新增）。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 架构 | 总纲+媒介插件（单 skill） | 分媒介多 skill | 方法论 DRY，路由描述不互踩；新增媒介=加目录 |
| 架构 | 自建（借鉴 hallmark 框架） | fork hallmark | hallmark 与 web 工具链强耦合，跨媒介改造≈重写；且保持内容主权 |
| MVP 媒介 | web | poster | 日常最高频 + HTML/CSS 约束最可控 + 业界参照最全 |
| roadmap | issue 化+未闭环扫描 | 只写文档 | 搭档硬要求「不能做了 MVP 没后续」；issue 被既有扫描机制盯住，机制化而非口头承诺 |
| 机制识别检查点 | 全部未命中 → 不涉及净新增机制 | — | 无 schema/状态/定时任务/信号/持久化/决策分支/跨模块调用；skill 与 issue 均为既有机制的存量使用 |
| 未答四问 | 不适用（未命中检查点） | — | 见上行判定 |

## 验证

- 路由验证：对话提「做个落地页/设计这张卡片」类请求，skill 被正确路由（description 触发词命中）
- build 验证：给一个真实 brief（如对话卡式汇报页），产出过质检门的 HTML，人评「made, not generated」
- audit 验证：对一张既有泔水页面跑 audit，输出有依据的反模式评分清单
- 边界验证：提 poster 需求时明示 Phase 2 未建，不用 web 冒充

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| .pi/skills/visual-design/SKILL.md | 新增 | 总纲：四层方法论+四动词+媒介路由 |
| .pi/skills/visual-design/references/methodology.md | 新增 | 方法论本体展开 |
| .pi/skills/visual-design/references/web/structure.md | 新增 | web 结构库 |
| .pi/skills/visual-design/references/web/styles.md | 新增 | web 风格词典 v1 |
| .pi/skills/visual-design/references/web/anti-patterns.md | 新增 | 反泔水清单+质检门 |
| .pi/skills/visual-design/references/web/toolchain.md | 新增 | 工具链约定（含 html-card 格式） |
| docs/features/2026/09/21/F20260921vsds-*.md | 新增 | 本特性文档 |
