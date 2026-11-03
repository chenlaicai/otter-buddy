---
id: F20261103blnkr
title: supersede 反向索引：扫描期计算 + from 链存在性校验（#1294）
change_type: feature
status: implemented
created: 2026-11-03
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules:
  - scripts/lint-docs.mjs
  - tests/lint/lint-docs-backlinks.test.ts
summary: "#1294（部分闭环，issue 保持开放）：反向关系计算能力+from 链存在性校验，消费面接入为显式遗留项。方向定案（搭档终审拦截）：append-only——反向关系不物化，扫描期 computeReverseIndex 计算（id→指向者列表），零补登零文档改动；初版物化方案（amended_by+DB 列+617 补登债）被拦截撤回，复盘立案 #1749。交付：①computeReverseIndex 纯函数（已实现待接，消费面载体待论证）②findBrokenBacklinks 存在性校验（断链 ratchet 基线 31=28 真断链+3 元素形态违规；自指环/标量形态 error）③红测 11 用例。遗产：31 断链与文件名≠frontmatter id 陷阱发现。"
tags: [docs, data-integrity, lint, ratchet, append-only]
intent:
  problem: "读旧特性文档的人不知道内容已被新文档订正（#1294 原始痛点）+ from 链存在大量断链无人看见（扫描时发现的真实数据质量问题）"
  expected_effect: "反向关系随扫描即时可查（computeReverseIndex），旧文档零改动；from 断链在 lint 层照亮并 ratchet 收敛（新断链被 error 拦截）；append-only 原则不被破坏"
  verify_by:
    type: capability_test
capability_test: "tests/lint/lint-docs-backlinks.test.ts"
---

# supersede 反向索引（#1294）

## 问题与方向定案

原始痛点：旧文档被订正后无提示（F20261005imfg 三处作废内容无标记指向订正文档）。issue 给了两个方向：①旧文档 frontmatter 物化反向字段 ②不改文档的计算注入。

**初版选了方向一**（amended_by 字段 + DB 全链 + 617 处存量补登债），完成两轮对抗审视后在终审被搭档拦截：**文档体系 append-only/快照可信——每合入新文档回头改旧文档是写放大，617 补登债正是方案自身制造的代价**。方案撤回，复盘立案 #1749（方向性错误穿透审视链：两轮对抗+锚点重放全部聚焦实现质量，无一环质疑方案前提）。

**定案方向二**：反向关系不物化，扫描期计算。

## 方案（最终形态）

### ① computeReverseIndex——反向索引计算（核心交付）

```js
// 文档 id → 指向它的文档 id 列表（Map），扫描全量 entries 一次构建
computeReverseIndex(entries) // 零文档改动、零补登、随扫描即时新鲜
```

读旧文档知被谁订正的查询路径：**待接**（消费面载体——记忆边 vs lint 呈现 vs sync 时机——需单独论证定案，不在本 PR 顺手决定；#1294 保持开放直到消费面交付）。**反向关系是算出来的不是存的**——append-only 下无一致性维护负担。

### ② findBrokenBacklinks——from 链存在性校验

| 形态 | 级别 |
|---|---|
| from 指向不存在的文档 | warning + ratchet（基线 31，存量） |
| from 含自身 | error（环） |
| from 标量形态（非数组非空） | error（防静默归零） |

存量断链 31 处首次照亮（7-8 月历史 from 指向从未存在的 id——检视獭抽样考据证实；其中 F20260802hybrid 案例揭示「文件名 id 段≠frontmatter id」陷阱，轻件候选）。

## 机制识别检查点论证（Modification-Class: narrow-fix）

新增 lint 信号类别（⚠/✗ [backlink]）与 ratchet 基线常量命中「新增信号类型/消息格式」检查点，判①收窄——论证：lint-docs 既有机制内追加规则（与 #470 MAX_WARNINGS、#1274 duplicate-id 同族），ratchet 沿用既有配额模式（只减不增常量），无新状态生命周期、无新存储、无新守护进程；lint 是 commit-time 既有 gate 的规则扩展，非净新增机制。

## 设计取舍（方向一 → 方二的决策记录）

- **物化 vs 计算索引**：append-only 系统里反向关系计算几乎总是优于物化——物化要维护双向一致（本 PR 初版的 from⟺amended_by 对偶校验防的全是自己制造的复杂度）、要补登存量（617 处）、每合入新文档都要动旧文档
- **.doc-fix 通道的边界**：通道存在是为订正 frontmatter 的*错误*（改错 id/补状态），不是追加新关系数据——「通道恰好允许」不构成「应该做」
- **保留存在性校验**：断链照亮与方向无关（真数据质量问题），且不触旧文档

## 验证

- [x] 红测 8 用例（存在性 5 + 反向索引 3，含断链不入索引/跨域/聚合）全绿
- [x] build 0 错；tests/lint 95 用例过；docs 972 OK；intent 1/1
- [x] CI：见 checks
- [x] 撤回验证：src/ 零改动（git diff 空），物化残迹零残留

## 后续观察

- 31 断链 ratchet 收敛（修复后调低基线）；文件名≠frontmatter id 陷阱轻件
- computeReverseIndex 的消费面（#1294 的遗留交付项，issue 保持开放）：载体方案（sync 时写记忆边 / lint 呈现）待论证——本 PR 只交付计算能力与存在性校验，两者独立成立（断链照亮已即时生效）

## 影响

- from 断链可见（新断链 error 拦截，存量 ratchet 收敛）
- 反向查询能力就位（计算式，零维护成本）
- 文档体系 append-only 原则保持完整
