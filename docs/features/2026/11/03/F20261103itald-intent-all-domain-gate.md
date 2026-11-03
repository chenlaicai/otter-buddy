---
id: F20261103itald
title: intent 声明域扩至全部 change_type：lint 全域时间界收口 + skill 口径同步 + 漏填批次回填（#1740）
summary: 11-02 批次 intent 声明率 78.6% 跌破 80% 止损线（#1740），排查发现根因是规则口径分裂——lint 判定域只对 feature/prompt 与软代码缺块 error（#839/#1238），硬代码 fix/refactor 缺块仅 warning；而 P0-c 统计口径（8:30 体检）按全量分母计。搭档 2026-11-03 拍板「intent 所有硬代码和软代码都要填，口径分裂是 bug」。本次三件套：lint-intent 新增全域时间界（created_at ≥ 2026-11-03 缺块 error，存量不追诉）、code-implementation 与 adversarial-review 两处 skill 口径同步、11-01/11-02 漏填的 5 篇历史文档回填（.doc-fix 元数据订正）。新门实跑当场捕获 11-03 当日合入的 F20261103portx 缺块（他对话产出），一并补齐。
change_type: fix
capability_test: tests/lint/lint-intent.test.ts
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
tags: [lint, intent, docs, quality]
modules:
  - scripts/lint-intent.mjs
  - tests/lint/lint-intent.test.ts
  - .pi/skills/code-implementation/SKILL.md
  - .pi/skills/adversarial-review/SKILL.md
created_at: 2026-11-03
intent:
  problem: "intent 声明规则口径分裂：lint 只对 feature/prompt（#839）与软代码（#1238）缺块 error，硬代码 fix/refactor 缺块仅 warning，而 P0-c 体检统计按全量分母——11-01/11-02 批次连续漏 5 篇触发 #1740，且打地鼠循环已四轮（#930→#839 族→#1740）"
  expected_effect: "created_at ≥ 2026-11-03 的新文档任何 change_type 缺 intent 块 → lint error 阻断 commit；存量（含 created_at 缺失）不追诉保持 warning；lint 判定域与 P0-c 统计口径一致，止损线误报循环终结"
  verify_by:
    type: behavior_check
---

# F20261103itald：intent 声明域扩至全部 change_type（#1740）

## 拍板与背景

**搭档 2026-11-03 10:19 原话**：

> 有点奇怪，我觉得intent这个所有的 硬代码和软代码 都要填的呀，我觉得很有必要。为啥你说，只有软代码才需要呢？
> 至于你说的导致现在的问题是由于多处规则没统一导致的，那这就是个bug，没啥疑问

拍板前过程（含大獭两次判断被纠偏）：
1. 大獭初判「打地鼠循环根因=自觉会漂，提议升合入阻断门」——被搭档追问背景后修正：漏的 5 篇全是硬代码，skill 字面（软代码触发）下海獭没违反规则，是规则口径分裂不是自觉漂移
2. 大獭又判「消费方只关心软代码，向 skill 口径对齐（分母改软代码）」——搭档直接拍板推翻：**全都要填**，口径分裂是 bug

## 根因链（证据）

- lint 判定域现状（改动前 `scripts/lint-intent.mjs`）：
  - `INTENT_REQUIRED_CHANGE_TYPES = {feature, prompt}`（#839，L45）：缺块 error
  - 软代码域 `isSoftCodeChange(fm) && isNewEnough(fm)`（#1238，L258 附近）：缺块 error
  - `INTENT_RECOMMENDED_CHANGE_TYPES = {fix, refactor, feature-update}`（#1295）：缺块仅 warning——**放行面**
- P0-c 统计口径（`prompts/scheduled/daily-health-check.md` L92）：「新增 intent 率 <80%」按全量新增分母
- 漏填 5 篇（全部 change_type=fix/refactor/feature-update，modules 不含 prompts//.pi/，全部走 RECOMMENDED 分支出 warning 放行）：
  - 11-01：F20261101depup（feature-update）、F20261101tcdlc（fix）
  - 11-02：F20261102blkcm（fix）、F20261102knssx（refactor）、F20261102mvbsk（fix）
  - 提交链：PR #1721/#1722/#1723/#1725/#1726，author=chen_n
- #930（10/10 关闭）称「CI intent gate 拦截」——实测 CI 只跑 `npm run lint:intent`（ci.yml L109），对 RECOMMENDED 域确实不拦（warning 不影响退出码）

## 变更清单

1. **scripts/lint-intent.mjs**：新增 `ALL_DOMAIN_ENFORCE_DATE = "2026-11-03"` 常量 + 缺块分支（RECOMMENDED 分支前）：`created_at ≥ 2026-11-03` 且非豁免清单文档缺 intent 块 → error。时间界归一化重构为 `isNewEnoughFor(fm, enforceDate)` 参数化，软/全域两界共用同一实现（防双实现漂移）。导出面同步扩（isNewEnoughFor / ALL_DOMAIN_ENFORCE_DATE）
2. **tests/lint/lint-intent.test.ts**：新增 describe 块 5 用例——新 fix/refactor/bugfix 别名缺块 error、时间界前存量 warning 保持、created_at 缺失宽容保持
3. **.pi/skills/code-implementation/SKILL.md** L80 Intent 段：触发条件从「软代码改动必须」改为「所有特性文档必填」，标注 F20261103itald/#1740 与机械门
4. **.pi/skills/adversarial-review/SKILL.md** B6 维度：检查范围从「软代码改动」改为「全部特性文档」（B7 Golden Gate 仍仅软代码）
5. **存量回填（.doc-fix 元数据订正，纯 frontmatter）**：5 篇漏填文档补 intent 块（problem/expected_effect 从各自 summary 与 issue 提炼，verify_by=behavior_check）+ F20261103portx（11-03 当日合入、新门实跑捕获的第 6 篇）
6. **.doc-fix 声明文件**：本 commit 内随交，提交后按惯例删除（squash 合入后不进 main 净 diff）

## 设计取舍

**修法决策树①（narrow-fix）**：机制识别七项检查全未命中——无新配置字段（ALL_DOMAIN_ENFORCE_DATE 是与 SOFT_CODE_ENFORCE_DATE 同构的既有时间界模式复用）、无状态生命周期/定时任务/信号类型/持久化/跨模块调用。命中清单项「新增决策分支」论证不成立：validateIntent 内新增的是纯函数分支（不落库不落文件），且语义是既有「时间界增量收口」模式（#839 豁免清单 ratchet、SOFT_CODE_ENFORCE_DATE、#1238）的第四次同型扩展，非净新增机制。

**为何全域用时间界而非全量追诉**：945 存量文档 614 篇无 intent（65%），全量追诉=一次性阻断所有无关 PR 的合入链；时间界增量收口与 #1238 先例同构——新规则管新文档，存量走 ratchet（豁免清单）与回填逐步消化。代价是绕过面（不写 created_at 降 warning）与软代码域同构共存——lint:docs 不强制 created_at，该面暂不新增治理（如实声明：这是已知残余口子，与既有软代码域同款，非本次新增）。

**为何 skill 仍写「软代码 Golden Gate 而仍全量 intent」**：intent（为什么改+怎么验，全量）与 Golden Gate（golden 评测记录，软代码专属）是两个机制——前者是声明协议，后者依赖 golden 场景集只覆盖软代码行为的事实。skill 文案已区分（B6 全量 / B7 软代码）。

**拍板替代路径（已否决）**：向 skill 口径对齐（分母改软代码新增）——搭档拍板「全都要」直接终结该方向；统计口径保持全量分母不动。

**工具化提案（搭档 10:00 提出，未包含在本次）**：lint-intent 加 init/生成模式，参数引导产出合规 frontmatter 块（schema 硬约束优于 skill 文本软提醒）。按消费强度先进候选池，不与本修复绑同一 PR——本 PR 是口径修复，工具化是增量增强，爆炸半径分开。

## 验证

- 失败证据（修复前，troubleshooting 5a 固化）：新增 5 用例中 3 failed（fix/refactor/bugfix 缺块无 error，实际仅 warning）——`npx vitest run tests/lint/lint-intent.test.ts -t "all-domain intent block gate"` 3 failed | 2 passed
- 修复后：71/71 passed（新增 5 + 既有 66）
- 全量 lint 实跑：`node scripts/lint-intent.mjs` exit=0（0 error，633 warning 全为存量豁免/推荐提示，不阻断）——新门实跑捕获 F20261103portx（11-03 当日合入文档）缺块，已补齐
- P0-c 对齐验证：lint 判定域与统计口径（全量分母）一致化后，#1740 的触发条件（新增缺块率）与 lint 拦截面重合，误报循环闭环
- 最简实现检查：已过——零新依赖、零新文件（除 .doc-fix 声明）、参数化重构复用既有归一化实现

## 验收标准（断言化）

| 场景 | 操作 | 预期 |
|---|---|---|
| 新硬代码文档缺块 | validateIntent({change_type: 'fix', created_at: '2026-11-03'}) | errors 含 "Missing intent block for all-domain change" |
| 时间界前存量 | created_at: '2026-10-31' 同上 | 无该 error，warning 保持 |
| 全量 lint | node scripts/lint-intent.mjs | exit=0 |
| 测试套 | npx vitest run tests/lint/lint-intent.test.ts | 71 passed |

## Discovered Issues

- 搭档工具化提案（lint-intent init 生成模式）→ 候选池（消费强度待观察，非本次范围）
- `M-fd533d78`（lint:intent 挂 pre-commit 老 matter）与本次「新文档缺块 error」机制相关，若后续 pre-commit 接入需与本门对齐——不在本次范围
