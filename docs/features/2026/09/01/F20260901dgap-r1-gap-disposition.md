---
id: F20260901dgap
title: "R1 推进器 14-60 天空窗处置：显式接受为 R2 收口等价终态 + gapDispositions 审计留痕"
summary: "#661 空窗场景实测频率为 0（371 链 0 命中，23 条纯 implemented 全为「随 PR 同步拍板」形态）；语义分析证明空窗态 ≡ R2 收口后终态（判据完全等价），且 issue 前提「R3 60 天兜底」不成立（R3 仅适用 in-flight 链）；处置 = 显式接受 + gapDispositions 审计留痕通道（纯留痕零动作），放宽 R1 上限方案因制造 R1/R2 振荡被否决。"
change_type: feature
status: implemented
substatus: active
created_at: 2026-09-01
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
capability_test: "n/a: 纯数据层改动（推进器留痕通道），无 LLM 行为涉及；判定行为由 28 单测覆盖"
tags: [health, doc-status, automation]
modules: [src/usecases/health, scripts]
intent:
  problem: "issue #661（源自 PR #659 审视建议发现 1）：implemented 后又有新 commit 但静默超 14 天的链——R1 窗口已关、R2 无 substatus 可收、据 issue 描述 R3 60 天后才兜底——14-60 天间无规则可触发，形成理论空窗。"
  why_now: "issue 验收标准要求空窗场景有明确处置（显式规则或显式接受并记录）；且 #659 合入后推进器即将挂 scheduled task 每日运行，空窗语义应在挂载前定案。"
  expected_effect: "空窗链在每日运行时可审计（gapDispositions 留痕），语义定案写入代码注释与本文档；不为 0 频率场景增加任何自动改写行为。"
---

## 实测频率（issue 任务 1：评估空窗真实频率）

测量脚本（/tmp 临时，纯读）：复现 planImplemented 的空窗判定分支，全史窗口（since-days=365）跑真实仓库。

| 指标 | 值 |
|---|---|
| 总链数 | 371 |
| 纯 implemented 链 | 23 |
| 其中「链尾 commit 未触碰文档」（叉迭代形态） | **0** |
| **空窗链（未触碰 ∧ 静默>14 天）** | **0** |

结论：当前仓库空窗频率 = **0**。23 条纯 implemented 链全部是「文档随链尾 commit 同步标注」形态（docLastTouchedSha == 链尾 sha）——R1 的证据门槛（#646 dry-run 修正）已把这类「完成拍板」排除在迭代标记外。空窗仅在「文档先标 implemented、之后链上叉出代码 commit、且推进器连续 14 天漏跑」的复合条件下才会出现。

## 语义分析（处置依据）

### 发现 1：空窗态 ≡ R2 收口后终态（判据等价证明）

R2 close-iteration 的触发条件：`implemented + substatus:active ∧ idleDays > 14`。收口动作：删 substatus → 纯 implemented（病态判定豁免）。

空窗链的状态：纯 implemented ∧ docUntouchedAfterLastCommit ∧ idleDays > 14。

若空窗链当初被 R1 标过（idleDays ≤ 14 时窗口内），idleDays 越过 14 后 R2 必然将其收口为纯 implemented。空窗链之所以在空窗，只因 R1 从未标过（漏跑/窗口外）。**两条路径的终点状态完全一致**：纯 implemented、豁免病态判定、静默。给空窗链补规则产生的终态与什么都不做在语义上不可区分——规则是空操作。

### 发现 2：issue 前提「R3 60 天后兜底」不成立

R3 archive 仅处理 in-flight 链（planInFlight 分支，classifyDocStatusWithSubstatus !== "in-flight" 直接 return）。implemented 链走 planImplemented，R3 永远不触及——空窗链 60 天后也无 R3 兜底。但这不影响处置结论：由发现 1，空窗态本身已是等价终态，无需兜底。（issue 的这个前提描述与代码事实不符，已在本节澄清。）

### 否决方案：放宽 R1 窗口条件（如「未触碰 ∧ 静默>14 天仍可标记」）

会产生 **R1/R2 振荡**：放宽后 R1 给空窗链加 substatus:active → 次日 R2 发现 idleDays > 14 删掉 → 再次日 R1 又加 → 每日一个空 commit 的汇总 PR，永不收敛。除非 R1 与 R2 窗口解耦，但那引入两个不一致的时间语义（何时算迭代中、何时算静默），复杂度收益比为负——0 频率场景不值得。

## 处置（issue 任务 2：显式接受并记录）

**显式接受 + 审计留痕**：

1. `AdvancementPlan` 新增 `gapDispositions: Array<{ fid, idleDays, reason }>` 通道——空窗链进留痕，不进 actions，零文件副作用
2. `planImplemented` 空窗分支（!iterating ∧ docUntouched ∧ idleDays > iterationDays）push 留痕，reason 注明「显式接受为 R2 收口等价终态（空窗处置 #661）」
3. CLI（docs-advance.mjs）输出 gapCount + gapDispositions——每日运行的审计可见性
4. **复活路径**：空窗链若复活（未来新 commit 距今 ≤14 天），R1 直达 mark-iterating，空窗自动退出——语义闭环无死角

不改 R1/R2/R3 任何既有规则的语义（#659 已合入主体不动，issue 边界遵守）。

## 验证

- 新增 5 测试：空窗核心留痕 / 不误伤 R2（close-iteration 优先）/ 复活路径（R1 直达）/ 非空窗不误留痕（同步拍板形态）/ 幂等（留痕零副作用）
- 全仓 205 files / 2556 tests 全绿；tsc 零错误；eslint 0 error（5 warnings 均存量其他文件）
- **真实仓库端到端 dry-run 对照**（#614 证据）：基线（stash 后）chainCount 371 / actions 0 / skipped 0；本改动后 371 / 0 / 0 / gapCount 0——零回归，gapDispositions 通道生效且实测 0 命中
- **最简实现检查**：已过——备选方案「新增 R1.5 规则」需改 applyAdvancements 改写器 + 振荡防护（更高复杂度）；「纯 issue 回复不改代码」损失每日审计可见性；本方案纯留痕通道是达成「显式接受 + 可审计」的最小实现

## 已知边界与遗留

- gapDispositions 留痕仅进 CLI stdout（每日汇总 PR 的描述素材），未入库 DB——审计需求升级时可在 CLI 层扩展，plan 结构已就绪
- issue 前提「R3 兜底」的表述失实已在本文档「语义分析·发现 2」澄清；若 issue 正文需要勘误，由大獭裁量在 GitHub 上回复

## 对既有特性的影响

- F20260901dstat（#659）：本特性是其「已知边界」的收口——不修改其任何规则语义，仅扩展 plan 输出结构（AdvancementPlan 新增可选语义字段 gapDispositions；类型上为必填字段，但语义纯留痕）。存量测试的 PLAN 工厂已同步补字段
