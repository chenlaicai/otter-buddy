---
id: F20260907itri
title: Issue 看板治理：三维标签体系 + 标题规范 + 全入口落地机制
summary: 解决「issue 越清越多、标签缺失、人眼无法一眼看到关键点」的结构性问题——建立 type×priority×source 三维正交标签、[模块] 标题规范，并对全部 4 个 issue 生成入口做 prompt/tool 层落地收口
change_type: prompt
capability_test: "n/a: prompt/流程层改动，验证走 lint 脚本自测 + 存量补标前后大盘对比"
intent:
  problem: "issue 看板 46 条 open 中 41% 无标签、bug 标签 0 次使用、priority 维度完全缺失，搭档无法一眼看到严重bug/待讨论/加强优化/待分析的分布，只能靠海獭逐条人肉分析；且 4 个生成入口无标签约定，生成不合规持续发生"
  expected_effect: "新产出 issue 100% 带 type+priority 标签且标题 [模块] 格式；每日任务产出 issue 大盘统计行；存量 46 条补标后 lint 不完整率 <5%；周一 backlog digest 可按 priority 排序呈搭档"
  verify_by:
    type: static_only
    reason: "prompt/流程层改动，无 LLM 行为可采样；行为验证走 lint 脚本对 GitHub issue 的实际扫描（大盘数字与 gh 实测交叉验证），issue 打标 golden 场景列为后续待办（见验证节）"
created_in_conversation: d8d6a5c6-0e3c-421c-9597-ec6ce03d6033
tags: [issue-management, labels, prompt, governance, lint]
modules: [".pi/SYSTEM.md", "prompts/scheduled/", "scripts/", ".pi/skills/"]
created_at: 2026-09-07
---

## 背景

> 搭档原话（2026-09-07）：
> 「我看issue一致很多，其实我一直想清理掉，但发现，清理的同时也在不断增加。所以我引起另外一个思考，既然issue是本系统很重要的一个记录看板，那么，我认为有必要要整理清晰issue的使用规范。（我隐约记得之前做过一次这个规范整理）。本次重点则是，tag的使用上，现在一大堆issue都没tag，标题也没啥统一格式，导致我人眼无法一眼看到关键点，全都依赖于海獭们逐个去分析处理，以及我也无法得知当前有几个是严重bug、待讨论、加强优化、待分析等等等状态。所以，你结合业界主流的issue管理规范，来分析看看，咱们的issue应该如何管理好」
>
> 补充指令（同日）：
> 「你来做，我补充一点，规范定了后，你也要分析好 海獭们 如何去遵守这件事，比如说 咱们当前是否有skill？或者tool？不能光有规范、而没有实际落地分析」

### 现状数据（2026-09-07 实测）

- open issue 46 条：19 条无标签（41%），标签库 16 个实际只用 5 个
- `bug` 标签使用次数 0——实质 bug（#822 编排链中断悬置、#814 错过触发窗口静默）全部未挂
- 标题前缀民间 9 种：[daily-review]、[signal-protocol]、[tech-debt]、[Bug]、[rhi]、[F...follow-up]、[ctx-quality]、[stock-cli]、[scheduler]——与标签体系脱节
- 吞吐失衡：生成端日均 ~5 条（健康检查 3-7 条 + 海獭运行中随手提），消费端每日任务上限 3 条，净增长永不为负
- intake 输入域只圈「今天 daily-review + 昨天非 daily-review」，19 条存量无标签 issue 不在任何任务的输入域，永久滞留

### 生成入口盘点（落地分析基础）

代码层无自动开 issue 路径，全部经海獭手动执行 `gh issue create`，共 4 类入口：

| 入口 | 位置 | 现有标签约定 | 现状问题 |
|------|------|-------------|---------|
| 每日健康检查 | prompts/scheduled/daily-health-check.md | 「label: daily-review」一句 | 无 type/priority 约定；同模块问题拆多条（#826/827/828 三连） |
| 开发流程转出 | .pi/skills/code-implementation/SKILL.md 步骤 9 | 「带标签 tech-debt / bug」 | 无 priority；bug 标签实际 0 次使用（未被执行） |
| 审视转出 | adversarial-review references（anti-patterns.md / author-response-protocol.md） | 无标签约定 | 只要求贴链接，标签完全缺位 |
| 海獭/user 散点手提 | 无固定位置 | 无 | 19 条无标签 issue 的主要来源 |

### 历史脉络

- 2026-08-31 #629「issue/healing 闭环飞轮」：intake triage + 每日上限 3 条 + 认领三问——处理侧协议已成型，但标签/标题维度从未建立
- 2026-09-04 搭档要求 55 条全量过盘、逐条拍板——事后清理模式的极限测试，清理速度追不上生成速度
- 结论：处理协议（#629）+ 生成规范（本方案）合起来才是完整闭环

## 目标

T1: **标签体系**——建立 type × priority × source 三维正交标签，让「严重 bug / 待讨论 / 加强优化 / 待分析」成为一眼可筛的一等维度
T2: **标题规范**——`[模块] 摘要` 统一格式，淘汰与标签重复的前缀，人眼扫列表即知模块
T3: **全入口落地**——4 个生成入口全部收口（3 个 prompt/skill 改造 + 1 个 lint 工具兜底），规范有实际执行机制而非纸面约定
T4: **存量归零 + 持续审计**——46 条存量一次性补齐标签，之后每日任务例行审计，标签不完整率维持 <5%

## 非目标

- 不做 issue 状态机改造（GitHub 原生 open/close + label 够用）
- 不引入 area/ 子系统标签维度（模块信息走标题前缀，避免标签膨胀；见设计取舍 D2）
- 不做 GitHub Actions CI 硬卡（issue 均为内部海獭创建，lint 脚本审计足够；见设计取舍 D4）
- 不改变 #629 已确立的处理协议（intake triage / 每日上限 3 条 / 认领三问原样保留，仅扩输入域）

## 方案设计

### 1. 标签体系（16 → 10 个，三正交维度）

| 维度 | 标签 | 规则 | 回答的问题 |
|------|------|------|-----------|
| **type**（必打 1 个） | `bug` / `enhancement` / `tech-debt` / `question` | bug=行为不符预期；enhancement=新能力增强；tech-debt=能用但结构烂；question=待讨论/待分析（搭档拍板前不定型） | 「这是什么东西」→ 对应搭档说的严重bug / 加强优化 / 待讨论·待分析 |
| **priority**（必打 1 个） | `P0` / `P1` / `P2` | P0=影响正确性或数据安全，当天进入开发流程；P1=应尽快（本周内）；P2=等排期。海獭初判，周一 backlog digest 搭档校准 | 「有多急」→ 排序与筛选的一等维度 |
| **source**（0 或 1 个） | `daily-review` | 保留现有语义——每日任务 intake 靠它圈输入域。无此标签 = 海獭运行中/用户手提，不再细分 | 「哪来的」→ 工作流有真实依赖，唯一保留的来源标签 |

**废弃标签（9 个，删除）**：`phase-0` / `phase-1` / `phase-2` / `phase-3`（0 使用，阶段语义已由特性文档承接）、`good first issue` / `help wanted`（无外部贡献者）、`documentation`（type 维度由 tech-debt/enhancement 覆盖）、`invalid`（关闭理由用 GitHub 原生 close as not planned）、旧 `question`（与新增 question 语义冲突，删除后按新定义重建）。

**保留标签**：`agent-evolution` / `observability`（2 使用，跨 issue 主题聚类，允许作为第 4 个可选标签保留，不强制）；GitHub 原生 `duplicate` / `wontfix`（关闭语义，非 open 态标签）。

**新增标签**：`P0`（红 #d73a4a）/ `P1`（橙 #fb8c44）/ `P2`（灰 #8b8b8b）；新 `question`（薰衣草 #7057ff，语义=待讨论）。

**多规则细节**：一条 issue = type 1 个 + priority 1 个 + daily-review（如适用）+ 可选主题标签（≤1 个）。

### 2. 标题规范

格式：`[模块] 一句话摘要（祈使语气，说清症状/目标）`

- **模块枚举**（开放集，常用先列）：`signal-protocol` / `scheduler` / `web` / `memory` / `healing` / `im` / `stock` / `skill` / `prompt` / `docs` / `rhi` / `general`
- **保留**：[signal-protocol]、[stock-cli]、[ctx-quality] 等模块型前缀（信息量独立于标签）
- **淘汰**：[daily-review]（与标签重复）、[tech-debt]（与标签重复）、[Bug]（与标签重复且大小写不一）、[rhi]（rhi-linked 由每日任务语义判断，不靠前缀）
- **保留特例**：[F…-followup]（特性文档可追溯性，放模块位：`[F20260902rcq3-followup] ...`，单连字符 followup，与 SYSTEM.md R2 一致）

### 3. 落地机制（四层防线，回应「不能光有规范」）

**层 1——生成侧 prompt/skill 收口（改 6 处）**：

| 改造点 | 改动 |
|--------|------|
| prompts/scheduled/daily-health-check.md「issue 产出规范」节 | 写入完整规范：每 issue 必打 type+priority+daily-review、标题 `[模块]` 格式、**同模块多问题聚合为一条 issue 分点陈述**（聚合红线：同根因或同模块同类型 → 合并；#826/827/828 反例实证） |
| prompts/scheduled/每日-issue-处理.md Step 0 | 输入域扩容：+「任意 open 的标签不完整 issue（type/priority 缺失），每日补标 ≤5 条」；产出增加大盘统计行 |
| .pi/skills/code-implementation/SKILL.md 步骤 9 | 「带标签 tech-debt / bug」→「按 SYSTEM.md Issue 规范打标（type+priority）」 |
| .pi/skills/adversarial-review/references/anti-patterns.md | gh issue create 处补「按规范打标」引用 |
| .pi/skills/adversarial-review/references/author-response-protocol.md | 同上（独立于 anti-patterns 的转出路径，同等打标约束） |
| .pi/SYSTEM.md R2「Issue 处理规范」 | 从「必须有具体修复方案」扩为完整紧凑版规范（标签表+标题格式+聚合规则），作为海獭散点提 issue 的单源引用 |

**层 2——工具兜底（新增 scripts/lint-issue-labels.mjs）**：

事后审计型 lint（不卡生成）：扫描 open issue，输出不合规清单（缺 type / 缺 priority / 非法标签组合 / 标题非 [模块] 格式），支持 `--fix-suggest` 输出建议标签。约 120 行，依赖 `gh` CLI。每日任务例行调用，产出写入当日报告；标签不完整率 >5% 时在日报标红。脚本头部注释声明标签单源（改标签体系时同步 SYSTEM.md R2 与两个 prompt）。

**层 3——消费侧例行审计（每日任务内置）**：

每日 issue 处理任务产出末尾固定增加「issue 大盘」段：`open 总数 | bug/enhancement/tech-debt/question 计数 | P0/P1/P2 计数 | 无标签数（目标 <5%）`。这是搭档「一眼看到关键点」的日常出口，也让标签体系的价值被持续消费（有消费方的规范才不会腐烂）。

**层 4——周排期闸门（现有机制激活）**：

周一 backlog digest 呈搭档批量拍板时，按 P2 → tech-debt 优先级排序呈现，而非无序列表——标签补齐后该机制从「形式存在」变为「真正可用」。P0 发现即插队（digest 不等周一）。

### 4. 存量清理（一次性）

- 步骤 1：跑 lint 脚本 `--fix-suggest` 生成 46 条补标建议清单（type/priority 依据标题+body 语义判断）
- 步骤 2：派 1 只小獭逐条核实建议并执行 `gh issue edit <N> --add-label` + 标题规范化（机械+语义判断混合任务，预计半天）
- 步骤 3：完成后重跑 lint 确认清零，大盘快照写入本文档「验证」节
- 存量标题是否重命名：**只重命名淘汰前缀类**（[daily-review] / [tech-debt] / [Bug] 开头的），模块型前缀保留

### 5. 标签库操作（gh CLI，一次性）

```
删除：phase-0 phase-1 phase-2 phase-3 good first issue help wanted documentation invalid question
新增：P0(#d73a4a) P1(#fb8c44) P2(#8b8b8b) question(#7057ff, 语义=待讨论)
```

## 影响范围

- 每日健康检查 / 每日 issue 处理两个定时任务的产出形态（格式增强，无数据源变化）
- code-implementation / adversarial-review 两个 skill 的转出约定
- SYSTEM.md R2（+~400 字节，远低于 15KB 双轨阈值）
- 现有 27 条带标签 issue 中：仅 daily-review/tech-debt/agent-evolution/observability 命中保留集，无破坏性变更
- 周一 backlog digest 的呈现顺序（从无序 → 按 priority 排序）

## 风险与约束

- **海獭执行漂移**（主要风险，19 条无标签的实证）：层 1 的 prompt 约束是软的——层 2 lint + 层 3 大盘把「漂移」变成可见指标，>5% 标红即触发补标动作，形成反馈环
- **priority 初判质量**：海獭对 P0/P1/P2 的判断可能偏严或偏松——层 4 的周一搭档校准是修正机制；初版判定标准写得具体（P0=正确性/数据安全，P1=本周应修，P2=其余）降低主观空间
- **聚合策略误伤**：过度聚合会把独立问题埋进正文——聚合红线定为「同根因或同模块同类型」，daily-review 的聚合由健康检查任务自行判断，事后可拆
- **question 标签语义迁移**：旧 question（GitHub 模板语义）删除重建，存量 0 条使用，无迁移成本
- **lint 脚本依赖 gh CLI 可用性**：gh 不可用时脚本静默跳过并在日报标注，不阻塞每日任务主流程

## 不兼容更新

- 标签库删除 9 个标签：若有外部工具按标签过滤（未发现），需适配——本项目 issue 消费方均为内部海獭+搭档，风险可忽略
- intake 输入域扩容改变每日任务的输入（新增「补标 ≤5 条」职责），每日任务产出结构变化

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| D1 模块维度载体 | 标题前缀 `[模块]` | area/scheduler 式标签 | 标签会膨胀（K8s 100+ 的前车之鉴）；模块名已在标题里，人眼直接读；lint 校验标题格式即可。代价：无法按模块 label 筛选——GitHub 搜索 `"[scheduler]" in:title` 可弥补 |
| D2 无 priority 数值化（P0-P2 三档） | 三档足够 | P0-P4 五档 | 本项目 issue 量级（open ~50）三档够用，五档徒增判断成本；量化分值（severity score）是过度工程 |
| D3 lint 事后审计 vs 生成时硬卡 | 事后审计（每日跑） | GitHub Actions 在 issue 创建时自动打标/拦截 | issue 创建者是海獭（LLM），生成时约束在 prompt 层做更精准；Actions 无法语义判断 type/priority，只能校验格式，事后 lint 同样能做且更灵活 |
| D4 无 CI 硬卡 | lint 脚本 + 大盘指标 | Actions 强制校验 | 内部项目无恶意输入；lint 每日跑的反馈延迟（≤24h）可接受；少一条 CI 配置维护成本 |
| D5 存量一次性清 vs 顺延消化 | 一次性派小獭清 | 每日任务顺延（每天 5 条） | 46 条 ÷ 5 条/天 ≈ 10 天，期间大盘统计失真、周 digest 排序不可用——标签体系的价值兑现被拖 2 周；一次性成本仅半天 |
| D6 保留 agent-evolution/observability | 保留为主题标签 | 一并废弃 | 各有 2 条 open 在用，删除需先迁移；主题聚类对 backlog digest 有信息量；上限 1 个防膨胀 |
| D7 规范单源位置 | SYSTEM.md R2 紧凑版 | 独立 docs/guides/issue-conventions.md | 海獭读规范的自然入口是 SYSTEM.md；独立文档多一次跳转且同步成本翻倍；lint 脚本注释 + R2 互相指认即可 |

## 验证

- lint 脚本单测/自测：对当前 46 条 open issue 跑，应报出 19+ 条缺 type、46 条缺 priority、标题格式违规清单——**报告数与手工盘点数一致**即通过
- 存量清理后：lint 输出 0 条不合规；大盘快照（各维度计数）写入本文档验证节
- prompt 生效验证：方案合入后首个健康检查周期（次日 9:00）产出的 issue 检查标签/标题/聚合合规性；连续 3 天合规率 100% 视为生成侧收口成功
- 大盘统计上线：首个每日任务产出含「issue 大盘」段，数字与 `gh issue list` 实测一致
- 回归确认：周一 backlog digest 按 priority 排序呈现（下周一验证）

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| .pi/SYSTEM.md | M | R2 扩为完整紧凑版 Issue 规范（标签表+标题+聚合） |
| prompts/scheduled/daily-health-check.md | M | 「issue 产出规范」节写入标签/标题/聚合硬约束 |
| prompts/scheduled/每日-issue-处理.md | M | Step 0 输入域扩容 + 补标例行 + 大盘统计段 |
| .pi/skills/code-implementation/SKILL.md | M | 步骤 9 标签约定指向 SYSTEM.md 规范 |
| .pi/skills/adversarial-review/references/anti-patterns.md | M | issue 转出处补打标引用 |
| .pi/skills/adversarial-review/references/author-response-protocol.md | M | 同上 |
| scripts/lint-issue-labels.mjs | A | 事后审计 lint（~120 行） |
| docs/features/2026/09/07/F20260907itri-issue-governance.md | A | 本文档 |
| GitHub 标签库 | gh CLI 操作 | 删 9 建 4（见方案设计 §5） |
| 存量 46 条 issue | gh CLI 操作 | 小獭补标 + 标题规范化（PR 合入后执行） |
