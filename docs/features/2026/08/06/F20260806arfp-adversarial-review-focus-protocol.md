---
id: F20260806arfp
title: adversarial-review-focus-protocol
doc_type: feature

summary: |
  优化对抗审视的协作协议：检视者侧从"6 维度均摊覆盖"改为"焦点声明 + 发现分级"，第 2 轮起从全量重审改为 delta 审视；作者侧新增批判性处置协议（四分类 + 证据要求）。
  核心动机：均摊覆盖导致注意力分散、每轮 fresh-eyes 重审导致审视不收敛；作者侧只有服从导向规则（"立即修复、不许问"），盲目遵从使对抗结构退化为单人审阅。
  主机制：焦点声明（1–3 维度深挖、其余扫过）+ 阻断性/次要观察分级 + 复审 delta 化 + 作者四分类处置（接受/带证据反驳/部分接受/呈搭档）。

status: development
change_type: prompt
tags: [adversarial-review, collaboration-protocol, skills]
modules:
  - .pi/skills/adversarial-review/SKILL.md
  - .pi/skills/adversarial-review/references/report-template.md
  - .pi/skills/adversarial-review/references/anti-patterns.md
  - .pi/skills/adversarial-review/references/author-response-protocol.md
  - .pi/skills/code-implementation/SKILL.md
  - .pi/skills/requirement-analysis/SKILL.md
  - .pi/skills/otter-summon/references/collaboration-patterns.md
---

# F20260806arfp: 对抗审视焦点协议与作者处置协议

## 根因分析

### 检视者注意力分散，结构上不保证收敛

1. **覆盖导向而非风险导向**：原 SKILL.md 要求 6 维度全查不许跳过，anti-patterns 甚至写"每个维度至少一个发现"（与同行允许"无发现"自相矛盾）。3 行配置修复与架构重写吃同样的全量扫射，注意力被制度性均摊。
2. **发现不分级、处置二元化**：typo 与数据丢失同权、全部阻断结论，检视者没有排优先级的动力，报告本身不收敛。
3. **每轮全量 fresh-eyes 重审**（原 code-implementation step 8 "第 1 轮发现不附"）：每轮都可能冒出新阻断问题，收敛只靠"2 轮硬上限→呈搭档"兜底，消耗搭档注意力。

### 作者侧没有批判性接纳的合法通道

1. **规则不对称**：检视者被要求对抗（not a rubber stamp），作者侧全是服从导向（"Fix all discovered issues immediately"——本意防自发现问题拖延，但在检视语境里读起来是照单全收）。
2. **反驳通道只存在于检视者一侧**（"开发者给出合理解释→可认可"），作者从未被授予反驳权；BIG_OTTER.md 有"纯技术取舍你拍板"的种子但未操作化。
3. 盲目遵从浪费对峙结构：检视者 fresh eyes 但上下文浅，作者上下文全但有立场，碰撞本该产生信息；照单全收等于单人审阅。

### 必须避开的对称坑

- 作者反驳权不能变成换皮 let-it-slide → 反驳必须带证据（file:line/测试/文档原文），空驳回等同未处置。
- "次要观察"分级不能复活已被禁用的"后续优化"逃逸口 → 次要观察必须有强制去处（修复或记录 issue），是分流不是拖延。

## 方案（三条机制）

### A. 检视者：焦点声明（review thesis）

- 理解改动范围后、动手前声明本轮焦点：基于改动性质与 blast radius 选 1–3 个维度 + 一句话理由。焦点深挖（读周边代码、追执行路径），其余扫过（仍需显式"无发现"，不求同等深度）。
- 发现分两级：**阻断性**（单凭这条就否决交付，门槛问题"仅凭这一条我会否决吗"）/ **次要观察**（不阻断，但必须有着落：修复或记录）。焦点外发现默认次要观察，除非过阻断门槛。

### B. 收敛机制：第 2 轮起 delta 审视

- 第 1 轮保持全量 fresh eyes；第 2 轮起职责变为：① 逐条验证第 1 轮修复 ② 检查修复引入的回归。为此第 2 轮**附上**第 1 轮发现清单 + 作者逐条处置 + 修复 diff——有意反转原"不附第 1 轮发现"规则：fresh-eyes 的代价是不收敛，防放水改由证据要求与作者处置协议承担。
- delta 之外的新发现必须标注"第 1 轮漏报"，默认次要观察，除非过阻断门槛。每轮冒新阻断问题 = 移动靶反模式。

### C. 作者：批判性处置协议（四分类）

每条发现逐条回应：① 接受并修复 ② 反驳（必须附证据；空驳回 = 无效处置）③ 部分接受（划清边界）④ 呈搭档裁决（产品方向/资源/对外承诺，或一轮证据交换后仍对立）。检视者评估反驳只看证据不靠权威；一轮交换仍对立即呈搭档，不拉扯。裁决留痕。

## 决策史

- 2026-08-06 搭档提出两个观察（检视要聚焦、作者批判性接纳），Claude 给出根因分析 + 三机制方案，搭档拍板"全部实施"（检视者侧 A+B、作者侧 C 一次落地，单 PR 单 F 档）。

## 改动清单

| 文件 | 改动 |
|------|------|
| adversarial-review/SKILL.md | 新增 step 2 焦点声明；发现分级（阻断性/次要观察）；新增"复审：delta 审视"节；反驳评估规则；引用 author-response-protocol |
| references/report-template.md | 模板加"本轮焦点"段、发现分区（阻断性/次要观察）、作者回应栏、维度扫视结论表；复审轮报告结构 |
| references/anti-patterns.md | 修正 Rubber Stamp 自相矛盾；新增 Scattergun Review / Moving Target / Blind Compliance & Empty Rebuttal 三个反模式；Let It Slide 兼容次要观察的"记录"去向 |
| references/author-response-protocol.md | 新增：四分类处置、证据交换规则、与"立即修复"规则的适用范围划分、次要观察处置 |
| code-implementation/SKILL.md step 8 | 新增作者处置协议步骤；第 2 轮改 delta 审视（附第 1 轮发现 + 处置 + 修复 diff）；"立即修复"规则明确限定自发现问题 |
| requirement-analysis/SKILL.md step 6 | 审视处置改引作者处置协议；复审 delta 化 |
| otter-summon/references/collaboration-patterns.md | 开发↔检视循环注意事项补焦点声明、delta 审视与作者处置协议指向 |

## 验证

- 纯 prompt/文档改动，不改运行时代码，无测试影响
- 一致性自查：三处作者侧引用同一 protocol 文件（避免漂移）；anti-patterns 的 Let It Slide 与次要观察分级已对齐；report-template 与 SKILL.md 行为规则一致

## 对抗审视记录

### 第 1 轮（2026-08-06，独立 agent，焦点：提示词优化是否真的能让 AI 表现更好）

**结论**：可以合入（无阻断性问题，6 条次要观察）。焦点问题正面核验：焦点声明时序正确且元认知可执行；四个 reference 均在使用点内联引用、无完全死信；指令增量未稀释信噪比；全仓无残留旧规则的活跃 prompt；三处作者侧引用同一 protocol 文件属实。

**逐条处置**（按本文档自立的作者处置协议执行，即本机制的首次 dogfooding）：

| # | 观察 | 处置 | 理由 |
|---|------|------|------|
| 1 | anti-patterns "Ask Whether to Fix" 与新分级规则字面相悖 | 接受并修复 | 亲验属实，补作者侧边界注明 |
| 2 | 报告模板次要观察无作者回应槽位 | 部分接受 | 补槽位；但注明次要观察回应允许极简（一行），防止对 typo 级条目套全套流程引入噪音 |
| 3 | "无焦点报告无效"无执行方 | 接受并修复 | 报告消费者是作者，step 8.2 加合规性检查、不合规打回 |
| 4 | 纯反驳路径与轮次记账未定义 | 接受并修复 | 裁决：反驳发原检视獭，证据交换不消耗轮次（轮次按全量/delta 审视计数） |
| 5 | 次要观察"记录"去向无执行主体 | 接受并修复 | 检视獭只读建不了 issue，记录义务明确归作者 |
| 6 | review-dimensions 未同步焦点机制 + 标点瑕疵 | 部分接受 | 补深度分化说明；拒绝把文档适配表复制进 review-dimensions（双份维护漂移，单一真相源保持在 SKILL.md） |

**作者反驳条**：无全条反驳；两条部分接受的拒绝边界已记录理由（观察 2 防流程膨胀、观察 6 防双份漂移）。

### 第 2 轮（delta 审视，独立 agent）

**结论**：可以合入（附条件）。6 条发现 5 条修复验证通过（作者声称与实际改动逐条相符，无虚报）；fix-regression 无阻断。

**残留处置**：

| # | 残留 | 处置 | 理由 |
|---|------|------|------|
| 观察 3 残留 | requirement-analysis step 6 缺同款报告合规门禁（文档审视路径仍无执行方） | 接受并修复 | 属实，step 6.2 已补同款校验 |
| 回归 1 | protocol 修写时丢失"不许多轮拉扯"，与 SKILL.md:102 措辞分化 | 接受并修复 | 属实，已恢复该句，两处对齐 |
| 回归 2 | step 8.2 内联复述 protocol 两条规则，与"引用避免漂移"原则有张力 | 反驳（维持现状） | 有意为之：信道分层原则——硬规则必须出现在作者的必达信道（step 8 本体），protocol 是详情源；内联仅限最关键两句，漂移风险可接受 |

### 第 3 轮（delta 复审，独立 agent；验证对象 commit 1ddc390）

**结论**：可以合入。观察 3 残留与回归 1 修复逐条亲验通过（声称与实际相符）；回归 2 反驳获认可，检视者记录理由：内联仅限两句无现实漂移、信道分层原则成立（"证据交换不消耗轮次"若被作者误解会导致回避反驳，属必达信道正当内容）、交叉引用为既有模式。

**新增漏报标注次要观察**：requirement-analysis step 6.2 以 step 编号引用 "code-implementation step 8.2"，对方重编号会成悬垂引用。处置：记录，不修——protocol:21 已有同款引用，属既有模式，重构引用体系成本远超收益。
