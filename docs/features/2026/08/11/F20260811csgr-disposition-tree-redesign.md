---
id: F20260811csgr
title: disposition-tree-redesign
doc_type: feature

summary: |
  检视模板再设计：分级框架从「阻断/非阻断」（按是否阻断 PR）改为「严重/建议」（按是否允许反驳免去整改），
  并引入强制决策树——每条发现作者必须回答「改了让系统变好还是变更差」。
  根因：任何暗示"可延后"的分级标签都会被 LLM 解读为"可忽略"，必须靠机制（强制决策树）托底，消灭"不作为"出口。

causal_links:
  from:
    - F20260811rtrd  # 检视模板重设计（消灭「记录」黑洞）——本轮在其之上重构分级框架

status: development
change_type: prompt
tags: [skills, review, prompt]
modules:
  - .pi/skills/adversarial-review/
  - .pi/skills/code-implementation/
  - .pi/skills/_shared/
  - .pi/skills/otter-summon/
  - .pi/skills/requirement-analysis/
capability_test: "n/a: 纯 prompt/协议文档变更，无运行时代码逻辑；行为验证依赖真实审视场景中的 LLM 遵从度，非自动化测试可覆盖"
---

# F20260811csgr: 检视模板再设计——决策树驱动的强制对抗处置

## 背景

F20260811rtrd 把「次要观察」改为「非阻断发现」并消灭了「记录」黑洞——但实战中发现新病灶：**「非阻断」这个词本身就在制造许可**。

搭档观察：AI 收到「非阻断发现」分类后，注意力权重自动下降。即使协议要求"必须建 issue"，整体行为仍偏向"可以延后、可以不处理"。本质问题不在词义——「非阻断」「旁路」「延伸」「次要」任何暗示"可延后"的标签都会被 LLM 降级。

## 根因分析

**核心病灶：分级框架是错误的抽象——它把"是否阻断 PR"作为分类轴，但这与"是否需要处置"无直接关系。**

两层叠加：

| 层次 | 机制 | 后果 |
|------|------|------|
| 认知框架 | 「非阻断」字面意义=不阻断，LLM 解读为"不重要" | 真实问题被合法降级 |
| 机制漏洞 | 分级直接决定处置路径（阻断→修，非阻断→记录） | 「分级标签」变成「降级许可证」 |

rtrd 治标——靠消灭"已记录"黑洞约束处置真实性。但分级框架本身仍是降级许可证。

## 方案设计

### 核心机制：决策树驱动，不是分级驱动

每条发现，作者必须回答一个核心问题：**改了让系统变好、还是变更差？**

```
改了让系统变好 → 必须改（两条子路径）
├─ 本 PR 修复（diff 可见）
└─ 本 PR 无法承载 → 建 issue（论证成立 + 链接可见 + 登记 Discovered Issues 节）

改了让系统变更差 → 反驳（必须附证据）
├─ 反驳成立（含事实错误/看错/误解）→ 双方达成一致，问题关闭
├─ 反驳不成立 → 仍是"更好"，必须改
└─ 一轮证据交换仍对立 → 呈搭档裁决
```

**分级仍存在（严重/建议），但只决定反驳门槛，不决定处置**：

| 级别 | 默认处置 | 允许的反驳类型 |
|------|---------|---------------|
| 严重（Critical） | 必须整改 | 仅"事实错误/看错/误解"类反驳；不允许"改了变更差"反驳 |
| 建议（Suggestion） | 必须走决策树 | 反驳和修复都是合法出口；"改了变更差"反驳需附证据 |

### 不允许的处置（铁律）

- 静默忽略（发现无任何处置）
- 口头"已记录"（无 issue 链接、无 diff、无论证）
- 无理由不改（"建议不重要"、"Low risk"、"Can optimize later"）
- "建议"作为可忽略的暗示

## 变更

### 改动 1：分级术语重设计

| 旧 | 新 | 语义轴 |
|---|---|---|
| 阻断性发现 | 严重发现 | 默认必须整改；反驳门槛极高 |
| 非阻断发现 | 建议发现 | 必须走决策树；反驳和修复都是合法出口 |

新分级不描述"是否阻断 PR"，而描述"是否允许反驳免去整改"——这与作者处置决策直接相关。

### 改动 2：决策树引入——分级不再直接决定处置

每条发现增加 `更好/更差判断` 字段。处置栏改为决策树产物：

- **更好** → 本 PR 修复 / 建 issue（论证"本 PR 无法承载"成立）
- **更差** → 反驳（必须附证据，含事实错误/看错/误解）

### 改动 3：严重 vs 建议的反驳门槛差异显式表达

- 严重：仅事实错误可反驳；不允许"改了变更差"反驳
- 建议：反驳和修复都是合法出口

### 改动 4：建 issue 路径重定位

旧：建 issue 是「非阻断发现」的独立处置（默认路径）
新：建 issue 是「更好→本 PR 无法承载」子路径的执行手段（需论证成立）

论证不成立 → 必须本 PR 修复，不可走 issue 子路径。

### 改动 5：Inaction 反模式新增

比 Let It Slide 更根本的反模式——连理由都不给，直接静默跳过。任何分级框架都防不住 Inaction，分级只是标签，处置才是产物。Fix = 强制决策树。

### 改动 6：审查者自省 +1 条

> 我是否用"建议"暗示了可忽略？

## 改动范围

| 文件 | 改动 |
|------|------|
| `adversarial-review/SKILL.md` | 报告模板（分级栏改名 + 决策树字段）、PR comment 模板、禁用语、审查者自省 |
| `adversarial-review/references/author-response-protocol.md` | 全面重写：决策树正文 + 分级反驳门槛 + 四分类映射决策树 + 不允许处置铁律 + 方案路径双适配表 |
| `adversarial-review/references/anti-patterns.md` | Let It Slide symptom 扩展（非阻断/建议作为降级许可证）+ 新增 Inaction 反模式 + Blind Compliance 补"未走决策树=未处置" |
| `adversarial-review/references/review-loop.md` | delta 审视验收项重写：决策树产物核对 + 严重不可延后 + 术语替换 |
| `_shared/review-protocol.md` | 方案路径 delta 描述同步（更好/更差判断 + 建议发现）|
| `code-implementation/SKILL.md` | 对抗审视原则补决策树；delta 审视描述同步；收敛判据同步 |
| `otter-summon/references/collaboration-patterns.md` | 收敛判据同步；作者处置描述补决策树 |
| `requirement-analysis/SKILL.md` | 对抗审视原则补决策树（更好→修订/写待办、更差→反驳）；delta 审视描述同步（含更好/更差判断 + 非阻断→建议）；不作为不允许 |

PR 模板（`.github/pull_request_template.md`）与 `commit-convention.md` 的 Discovered Issues 节约束依然成立（必须有 issue 链接 + 不接受口头"已记录"），本轮无需改动。

## 设计决策

| 决策 | 结论 | 理由 |
|------|------|------|
| 分级保留还是废除 | 保留（严重/建议）| 分级提供反驳门槛差异；用户拍板 |
| 决策树还是分级驱动 | 决策树 | 任何分级框架都会被 LLM 降级；机制托底才有效 |
| 严重的反驳门槛 | 仅事实错误豁免 | 用户原话："严重必须整改"——不允许价值层面反驳 |
| 建 issue 路径 | 保留，重定位为"更好-本 PR 无法承载"子路径 | 用户原话：本质区分更好/更差，更好有两种后续 |
| 全链路 vs 分阶段 | 全链路一次到位 | 用户记忆「术语改动要全局排查」 |
| F 文档策略 | 新建 F20260811csgr | rtrd 已合入；本轮是机制迭代 |
| 「非阻断」是否完全从禁用语外位置清除 | 是，仅在禁用语/反模式 symptom 中保留指代 | 让 LLM 知道这些词是被禁的 |

## 对抗审视记录

四轮审视，逐轮收敛：

### 第 1 轮：设计方案审视（钝刀獭，fresh-eyes）

焦点：决策树机制自洽性 + 全链路一致性 + 信息来源闭环。

发现 1 严重 + 2 建议，全部判断为更好→本 PR 修复：

| # | 发现 | 级别 | 处置 |
|---|------|------|------|
| 1 | `_shared/review-protocol.md:36` 代码 PR 路径收敛判据缺"无严重发现未处置"——其他 4 处都对齐，唯独此行漏 | 严重 | 更好→本 PR 修复 |
| 2 | `requirement-analysis/SKILL.md:35` 对抗审视原则缺决策树表述（与 code-implementation:38 不对称）+ :37 delta 描述缺"含更好/更差判断" | 建议 | 更好→本 PR 修复 |
| 3 | `author-response-protocol.md` 决策树正文缺"部分成立"分支出口——决策树是二分支但四分类有"部分接受" | 建议 | 更好→本 PR 修复 |

全部修复。核心洞察：决策树二分支假设"一条发现只能整体更好或整体更差"，但实践中部分成立是常见场景，必须有显式出口。

### 第 2 轮：delta 设计审视（细鳞獭）

焦点：3 条修复验证 + fix-regression。

3 条修复全部通过，无 fix-regression。新增 1 条建议：

| # | 发现 | 级别 | 处置 |
|---|------|------|------|
| 4 | `requirement-analysis/SKILL.md:35` 对抗审视原则末尾缺"不作为不允许"——本轮追求代码/方案路径对称，此铁律应同步 | 建议 | 更好→本 PR 修复 |

修复后通过。

### 第 3 轮：PR fresh-eyes 审视（检视獭-fresh3）

焦点：跨文件术语一致性 + 自反性 + 信息来源闭环完整性 + F 文档准确性。

发现 1 严重 + 4 建议：

| # | 发现 | 级别 | 处置 |
|---|------|------|------|
| 5 | PR diff 含 src/main.ts、src/bootstrap/server.ts、F20260811safen 无关变更，违反 PR 范围聚焦 | 严重 | **反驳（事实错误）** |
| 6 | `review-protocol.md:32` 代码 PR 路径 Step 3 delta 材料缺"含更好/更差判断"——同文件方案路径有，代码路径漏 | 建议 | 更好→本 PR 修复 |
| 7 | `review-protocol.md` 两条路径 Step 2 四分类列表缺决策树框架——下游 code-implementation/requirement-analysis 都补了，编排者入口漏 | 建议 | 更好→本 PR 修复 |
| 8 | `SKILL.md:138` 和 `anti-patterns.md:59` 严重反驳门槛缺"/误解"——权威源是"事实错误/看错/误解" | 建议 | 更好→本 PR 修复 |
| 9 | F 文档改动范围表 requirement-analysis 描述不完整（实际改动比描述大） | 建议 | 更好→本 PR 修复 |

**严重 1 反驳证据**：ad9f038 是 PR #218（F20260811safen）已合入 origin/main 的提交。worktree 分支从 HEAD=origin/main=ad9f038 切出，本地 main ref 滞后于 origin/main（5b30aa7 vs ad9f038）。GitHub PR base 跟踪 origin/main，实际 PR diff 仅含本工作 9 个文件。检视者用 `git diff main`（指向本地滞后 ref）误诊。

建议 6-9 全部修复。

### 第 4 轮：delta 收敛审视（检视獭-delta4）

焦点：严重 1 反驳验证 + 4 条建议修复验证 + fix-regression。

| 验证项 | 结果 |
|--------|------|
| 严重 1 反驳（`git diff origin/main --stat`） | 成立——PR diff 仅含 9 个本工作文件 |
| 建议 6 修复（review-protocol.md:32 补"含更好/更差判断"） | 通过 |
| 建议 7 修复（review-protocol.md:21/59 补决策树框架，路径适配正确） | 通过 |
| 建议 8 修复（SKILL.md:138 + anti-patterns.md:59 术语统一） | 通过 |
| 建议 9 修复（F 文档改动范围表完整） | 通过 |
| Fix-regression 检查 | 无 |

**收敛**：严重 1 反驳成立 + 4 条建议修复全部正确完整 + 无 fix-regression。审视循环收敛。

## 验收标准

### 需求推导

1. 「非阻断」「阻断性发现」等暗示"可延后"的术语在 .pi/skills/ + .github/ 零残留（仅禁用语/反模式 symptom 中保留指代）
2. 决策树正文完整呈现于 author-response-protocol.md
3. 严重 vs 建议的反驳门槛差异在协议中显式表达
4. anti-patterns.md 新增 Inaction 反模式
5. 所有下游文件的术语与核心一致
6. delta 审视能核对每条发现的决策树产物是否齐备

### 权威证据

| 需求 | 权威证据来源 | 证据类型 |
|------|-------------|---------|
| 1 | grep `.pi/skills/` + `.github/` 零残留（除禁用语/反模式 symptom） | 命令输出 |
| 2 | author-response-protocol.md 决策树节 | 文件内容 |
| 3 | author-response-protocol.md 分级与反驳门槛表 + SKILL.md 严重发现模板 | 文件内容 |
| 4 | anti-patterns.md Inaction 节 | 文件内容 |
| 5 | review-protocol.md / code-implementation/SKILL.md / collaboration-patterns.md / requirement-analysis/SKILL.md 全部用新术语 | 文件内容 |
| 6 | review-loop.md delta 审视验收项第 ③ 项 | 文件内容 |

### 证据判定

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| 1 | 证明完成（grep `.pi/skills/` + `.github/` 仅 5 处残留，全部在禁用语/反模式 symptom 中作为指代保留；下游零残留） | ✅ |
| 2 | 证明完成（author-response-protocol.md:8-22 决策树正文完整：更好/更差/部分成立三分支） | ✅ |
| 3 | 证明完成（author-response-protocol.md:30 分级反驳门槛表 + SKILL.md 严重/建议发现模板 + 全局术语统一"事实错误/看错/误解"） | ✅ |
| 4 | 证明完成（anti-patterns.md:64-70 Inaction 节） | ✅ |
| 5 | 证明完成（review-protocol.md / code-implementation/SKILL.md / collaboration-patterns.md / requirement-analysis/SKILL.md 全部对齐——4 轮审视验证） | ✅ |
| 6 | 证明完成（review-loop.md:14-19 delta 审视验收项第 ③ 项含决策树产物核对：严重→diff、建议→决策树三分支产物） | ✅ |

## Acceptance Test

`capability_test: "n/a"` —— 纯 prompt/协议文档变更，无运行时代码逻辑；行为验证依赖真实审视场景中的 LLM 遵从度，非自动化测试可覆盖。
