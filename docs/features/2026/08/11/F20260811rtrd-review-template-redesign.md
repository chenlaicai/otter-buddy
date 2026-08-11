---
id: F20260811rtrd
title: review-template-redesign
doc_type: feature

summary: |
  检视报告模板重设计：消灭「次要观察」术语的心理降级框架，
  消灭「记录」作为无需可验证产物的黑洞处置。
  非阻断发现处置必须可验证（本 PR 修复 diff 可见，或建 issue 链接可见），
  delta 审视增加核对落实的验收项，代码 PR + 方案文档双路径完整覆盖。

causal_links:
  from:
    - F20260806arfp  # 焦点协议与作者处置协议（引入阻断性/次要观察分级）
    - F20260807aropt  # 对抗审视反讨好优化（移除"可以合入"出口）
    - F20260810sopt   # Skill 系统优化（PR 留痕机制）

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

# F20260811rtrd: 检视模板重设计——消灭「记录」黑洞

## 背景

搭档识别到两个症状：

1. **「次要观察」被轻率打发**：AI 开发者收到检视报告后，对「次要观察」分类一律说"已记录，不需修改"——但这是偷懒行为。初衷是追求尽善尽美，问题再小也是问题。
2. **scope 外问题静默丢失**：认真分析后确认某问题非本次 PR 目标且较大时，应借助 GitHub issue 记录。但现状是口头说"已记录"实际等于直接丢失——没有 issue 创建。

## 根因分析

**核心病灶：「记录」是一个黑洞处置——口头声称即被接受，无需任何可验证产物。**

两层叠加效应：

| 层次 | 机制 | 后果 |
|------|------|------|
| 认知框架 | 「次要」二字天然制造心理降级——LLM 看到这个词，注意力权重自动降低 | 检视者把真实问题归入"不重要"桶 |
| 机制漏洞 | 「记录」提供无需可验证产物的逃逸通道 | 作者说"已记录"即合规，无人验证是否真的建了 issue |

两者合谋，问题被合法地丢掉了。

现有协议（F20260806arfp 引入的 author-response-protocol.md）其实已有约束——"记录的执行主体是作者"，但缺**强制可验证性**：说了"记录"就算合规，没有人验证是否真的建了 issue。

## 变更

### 改动 1：术语重设计——从严重度分级改为处置路径分类

| 旧 | 新 | 理由 |
|---|---|---|
| 阻断性问题 | 阻断性发现 | 与「非阻断发现」平行，统一为「发现」 |
| 次要观察 | 非阻断发现 | 只描述事实（不阻断 PR），不暗示重要性 |
| 观察 N | 发现 N | 「观察」暗示可忽略；「发现」是有重量的产物 |

这不只是改名——改的是 LLM 的认知框架。看到"次要"，LLM 的注意力权重自动降低；看到"非阻断发现"，LLM 理解这是"一个需要处置的真实问题，只是处置路径不同"。

### 改动 2：消灭「记录」作为独立处置——所有处置必须可验证

| 旧处置 | 新处置 |
|---|---|
| 在当前 PR 修复 | 本 PR 修复（diff 可见） |
| 记录（issue / PR 描述） | 建 issue #N（链接可见） |
| 记录 / 在当前 PR 修复 | 本 PR 修复 / 建 issue（#N 链接） |

口头「已记录」不构成处置——列入禁用语和 Let It Slide 反模式。

### 改动 3：验证闭环——delta 审视核对落实

review-loop.md delta 审视增加第 ③ 项职责：

> 核对上轮非阻断发现处置的落实（信息来源：大獭在材料中附的 delta 核对材料——检视者无 gh 权限，不自行访问 GitHub）。没有落实 = 处置未完成，不能收敛。

关键设计：检视者是只读角色，无 `gh` 权限，不能自行访问 GitHub。信息来源是大獭在 systemPrompt / delta 材料中附的 PR 描述全文或方案文档。这条链路在 review-protocol.md（材料清单）→ review-loop.md（核对职责）→ collaboration-patterns.md（编排者材料）三处闭环。

### 改动 4：双路径覆盖——代码 PR + 方案文档

| 路径 | 非阻断发现载体 | delta 核对方式 |
|------|--------------|--------------|
| 代码 PR | PR 描述 Discovered Issues 节（issue 链接 #N） | 核对 issue 链接存在 |
| 方案文档 | 方案文档待办/决策史节（段落定位） | 核对段落存在且可定位 |

author-response-protocol.md 新增「方案审视路径的处置适配」节。

### 改动 5：审查者自省 +1 条

> 我是否用"已记录"逃避了真实处置？

元认知层面加一道自检。

## 改动范围

| 文件 | 改动 |
|------|------|
| `adversarial-review/SKILL.md` | 报告模板、PR comment 模板、禁用语、审查者自省 |
| `adversarial-review/references/author-response-protocol.md` | 非阻断发现处置（消灭「记录」）+ 方案路径适配节 |
| `adversarial-review/references/anti-patterns.md` | Let It Slide 强化（"已记录"无链接变体）+ 术语替换 |
| `adversarial-review/references/review-loop.md` | delta 审视验收项 + 路径区分的 delta 核对材料 |
| `_shared/review-protocol.md` | 代码 PR 路径附 PR 描述（双层用途）；方案路径 delta 补核对指令 |
| `code-implementation/SKILL.md` | 问题处理三步走 Discovered Issues 节格式；delta 审视描述同步 |
| `code-implementation/references/commit-convention.md` | Discovered Issues 节要求 issue 链接；模板关系说明 |
| `otter-summon/references/collaboration-patterns.md` | 编排者 systemPrompt 材料同步（双路径区分） |
| `requirement-analysis/SKILL.md` | 方案路径 delta 材料描述同步 |
| `.github/pull_request_template.md` | 补 Discovered Issues 节（与 convention 对齐） |

## 设计决策

| 决策 | 结论 | 理由 |
|------|------|------|
| 术语选择 | 非阻断发现 | 只描述事实（不阻断 PR），不暗示重要性；替代候选「旁路发现」「延伸发现」语义不如「非阻断」精确 |
| 「记录」处置 | 消灭 | 黑洞处置——口头声称即被接受，无验证手段 |
| 验证责任归属 | 检视者（delta 审视） | 检视者是独立核实者；但信息来源是大獭传的材料（检视者无 gh 权限） |
| 双路径还是单路径 | 双路径 | 方案文档不是 PR，没有 Discovered Issues 节——用文档待办/决策史节代替 |
| 禁用语范围 | 限定为"作为发现处置" | 避免误伤日常合法的"已记录"用法（如"记录该决策后放行"） |

## 对抗审视记录

四轮审视，逐轮收敛：

### 第 1 轮：设计方案审视（钝刀獭）

焦点：根因分析 + 解决方案有效性 + 全链路完整性。

发现 4 条阻断 + 3 条非阻断：

| # | 发现 | 级别 |
|---|------|------|
| 1 | delta 审视验收项让检视者核对它无法访问的 PR 描述（无 gh 权限） | 阻断 |
| 2 | 方案审视路径的"建 issue"语义未定义——方案不是 PR | 阻断 |
| 3 | 禁用语"已记录"过于宽泛——日常合法使用被误伤 | 阻断 |
| 4 | code-implementation/SKILL.md:53-55 仍用模糊"记录"，与新协议矛盾 | 阻断 |
| 5 | anti-patterns.md "record it" 未更新 | 非阻断 |
| 6 | PR comment 模板格式强制说明弱 | 非阻断 |
| 7 | collaboration-patterns.md 未同步 delta 审视新验收项 | 非阻断 |

全部修复。

**核心洞察**（钝刀獭）：方案根因方向正确，但在验证闭环上犯了结构性错误——把验证责任交给了权限模型中无验证能力的角色。

### 第 2 轮：delta 设计审视（细鳞獭）

焦点：delta 修复正确性 + fix-regression。

验证第 1 轮 4 条阻断修复——阻断 3、4 通过，阻断 1、2 在代码 PR 路径完整闭合但方案路径有残留断口。

发现 2 条 fix-regression + 2 条非阻断：

| # | 发现 | 级别 |
|---|------|------|
| A | review-loop.md delta 材料硬编码"PR 描述全文"，方案路径无 PR | 阻断（fix-regression） |
| B | review-protocol.md 方案路径 delta 审视缺核对指令 | 阻断（fix-regression） |
| C | requirement-analysis:37 需同步 | 非阻断 |
| E | collaboration-patterns:31 只覆盖代码路径（此前轮次漏报） | 非阻断 |

全部修复——review-loop.md 改为路径区分的「delta 核对材料」。

### 第 3 轮：PR 审视（检视獭 fresh-eyes）

焦点：跨文件一致性、信息来源闭环、双路径对称性、自反性。

发现 1 条阻断 + 2 条非阻断：

| # | 发现 | 级别 |
|---|------|------|
| 1 | code-implementation/SKILL.md:43 delta 审视描述遗漏 delta 核对材料（其他三处都更新了，唯独这处漏） | 阻断 |
| 2 | PR 模板两版结构仍不完全对齐 | 非阻断 |
| 3 | review-protocol.md Step 1 注释"delta 审视时需核对"放在第 1 轮材料清单中，用途歧义 | 非阻断 |

全部修复。

### 第 4 轮：delta PR 复审（检视獭）

焦点：delta 修复验证 + fix-regression。

3 条修复全部通过，0 阻断，1 条非阻断（collaboration-patterns.md:31 措辞细微漂移——检视獭自评"概述层文件简化合理"，带理由反驳）。

**收敛**：修复验证全部通过 + 无阻断回归。

## 验证

- [x] 全局 grep「次要观察」「阻断性问题」在 .pi/skills/ + .github/ 下零残留（历史 docs/features/ 保留不动）
- [x] 四处 delta 审视描述全部对齐（review-protocol.md 代码/方案路径 + collaboration-patterns.md + code-implementation/SKILL.md + requirement-analysis/SKILL.md）
- [x] 信息来源闭环：review-protocol.md 材料清单 → review-loop.md 核对职责 → collaboration-patterns.md 编排者材料
- [x] 两条审视路径的 delta 核对材料都有定义
- [x] PR 自身合规：Discovered Issues 节写"无"，符合"If none, write 无"规则

## Acceptance Test

### 需求推导

1. 非阻断发现不再被口头"已记录"打发——每条必须有可验证处置
2. delta 审视能真正核对处置落实——检视者有信息来源可用
3. 方案审视路径同样适用——不只有代码 PR

### 权威证据

| 需求 | 权威证据来源 | 证据类型 |
|------|-------------|---------|
| 1 | .pi/skills/ 下无「记录」作为独立处置；禁用语含"已记录"作为发现处置 | 文件内容 |
| 2 | review-loop.md 第 ③ 项含信息来源说明；review-protocol.md 材料清单含 PR 描述 | 文件内容 |
| 3 | author-response-protocol.md 含方案路径适配节；review-protocol.md 方案路径 delta 含核对指令 | 文件内容 |

### 证据判定

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| 1 | 证明完成（grep 零残留 + 禁用语列表 + 处置模板） | ✅ |
| 2 | 证明完成（三处链路闭环 + delta 核对材料定义） | ✅ |
| 3 | 证明完成（双路径处置 + 双路径 delta 核对） | ✅ |
