---
id: F20260901dstat
title: "文档状态自动推进：值域契约、子状态、每日批量推进器与高置信回填"
summary: "根治「干完没归档」假警报（18 条 chain_stall 主因）：status 实际值域收敛为在途/终态/未知三分组契约（单一真相源）；implemented+substatus:active 子状态让分批合入大特性不提前豁免；每日批量推进器（R1 迭代标记/R2 收口/R3 高置信归档，未知值一律不碰留痕）；回填参数化验证。"
change_type: feature
status: implemented
substatus: active
created_at: 2026-09-01
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
capability_test: "n/a: 纯数据层与判定层改动（值域契约+推进器），无 LLM 行为涉及；判定行为由 2477 单测覆盖"
tags: [health, doc-status, automation]
modules: [src/entities/document, src/usecases/health, scripts]
intent:
  problem: "docs/features 的 status 无权威 schema——实查 10 种值（8 已知 + review/reviewed 存量变体 + 行内注释），chain-builder 白名单、classifyDocOnly、feature-doc-collector 三处触点各自硬编码语义漂移；「干完没归档」的文档永远停在 development 产生 chain_stall 假警报；分批合入大特性一旦提前标 implemented 就静默豁免病态判定。"
  why_now: "合议定稿（review-lunheng.md §二 + 大獭三项拍板）：active 收编/高置信回填子集/每日批量 PR。PR1（#650）已做最小止血，本特性做系统性收敛——issue #646 立案。"
  expected_effect: "值域语义单一真相源（known-values 漂移自检）；未知手工值永不误覆盖；implemented 后的迭代参与停滞判定；推进器每日一个汇总 PR 自动归档高置信完成链，其余交僵尸阶梯消化。"
---

## 方案

### 段1：值域契约（src/entities/document/doc-status.ts）

实查分布（2026-09-01，worktree 全量 frontmatter）：development 121 / implemented 58 / active 42 / locked 37 / draft 36 / final 16 / design 9 / implemented+行内注释 7 / proposed 3 / locked+行内注释 2 / reviewed 1 / review 1。

三分组契约（单一真相源，判定层消费统一走 classifyDocStatus）：

| 分组 | 值 | 判定行为 |
|---|---|---|
| in-flight | draft / proposed / design / development / active / review / reviewed | 参与 stalled/zombie/regressed 病态判定 |
| terminal | locked / final / implemented / archived | 豁免病态判定（链已收口） |
| unknown | 其余一切 | **一律不碰**（视为稳定，推进器跳过留痕） |

关键定案（issue 留给实现时裁定，依据如下）：

- **locked = 终态**：37 篇全部是 2026-07-08~07-20 初创期设计文档（data-model/infra/domain 设计稿），此后 40+ 天零新增——语义冻结在「设计定稿」。一条反证行内注释（`# draft | development | locked | archived`）把 locked 列为流程中间态，但该作者语境是早期探索，无后续实践支撑；按行为（零新增、无推进诉求）定终态。
- **final = 终态**：语义自明。
- **review / reviewed 收编在途**：8 月初 2 篇「待对抗审视/delta 复核」文档在用，对抗审视是工作流中间环节。lint ratchet（lint-docs.mjs 上限 271）已把它们记为存量警告，终态化后另案下调。
- **null/undefined → in-flight**：与 chain-builder 原 `?? "draft"` 行为一致（缺省视为草稿在途）。
- **行内注释变体**：yaml 解析器（frontmatter-parse.ts 用标准 yaml 库）正确剥离注释，classifyDocStatus 收到裸值，另做防御性 trim 兜底。

契约完整性自检（模块加载时执行）：在途 ∪ 终态必须 ⊆ KNOWN_FEATURE_STATUSES ∪ {review, reviewed}，known-values 扩值而 doc-status 未同步分组时先炸。测试另加反向用例（KNOWN 全值不落 unknown）。

三处触点改造：chain-builder 的 classifyChain/isZombie/classifyDocOnly 统一改走契约（原 ACTIVE_DOC_STATUSES 白名单删除）；feature-doc-collector 的 status 字段保留原始值不改写（归一是消费方的事）。

### 段2：子状态机制

issue 记号 `implemented:active` 若作为字面 status 值会炸 known-values 枚举（lint 警告）且被 feature-mapper:32 的「未知值强转 draft」污染 DB——**子状态用独立 frontmatter 字段 `substatus: active`**。

- classifyDocStatusWithSubstatus：仅 implemented 定义子状态语义（final/locked/archived 真终态子状态忽略；子状态未知值不碰）
- implemented ∧ substatus:active = 迭代中（合入后又有新 commit），视同在途参与病态判定
- 纯 implemented = 豁免（合入即完成）
- CollectedFeatureDoc.substatus 可选字段（不破坏存量构造点）

分批合入大特性的正确姿势：PR1 合入后文档标 `status: implemented` + `substatus: active`——PR2 等待期停滞判定照常，不会静默失联两周；全部 PR 合入后删 substatus（推进器 R2 自动做）。

### 段3：每日批量推进器

三层交付（src/usecases/health/doc-advancer.ts + scripts/docs-advance.mjs）：

| 层 | 职责 | 测试 |
|---|---|---|
| planDocAdvancements | 纯函数：链证据 → 推进计划（无副作用） | 23 用例全边界 |
| applyAdvancements | frontmatter 逐行改写，幂等，保留行内注释 | 幂等性用例（apply 两次第二次 changed=0） |
| docs-advance.mjs | CLI 薄壳：同源采集 + 批量文档触碰 sha + dry-run | 真实仓库 dry-run |

推进规则：

- **R1 mark-iterating**：纯 implemented ∧ 链尾 commit 未触碰文档 ∧ 最后 commit ≤14 天 → 加 substatus: active
- **R2 close-iteration**：implemented+active ∧ 静默 >14 天 → 删 substatus（收口回豁免）
- **R3 archive（高置信回填）**：in-flight ∧ commitCount≥1 ∧ 全 commit 带 prNumber ∧ 静默 >60 天 → status → implemented

**R1 证据门槛（实现期关键修正）**：初版规则「implemented 后 ≤14 天有 commit 就标迭代」在真实 dry-run 立即翻车——8/31 合入的那批 PR（F20260831dgcsq 等 23 条）是「文档随 PR 同步标 implemented」（docLastTouchedSha == 链尾 sha），那是完成拍板不是迭代。修正为：仅当链尾 commit 未触碰文档（标注早于代码活动）才标迭代；无 sha 证据保守不标（宁可漏标不可误标）。CLI 批量 `git log -1 --format=%H -- <path>` 采集每文档最后触碰 sha。

**窗口口径**：默认 since-days=90——R3 需「静默>60 天」证据，链尾 commit 至少 60 天前，45 天窗口会把它误判 doc-only。

**R1 红线**：CLI 改写 docs/ 下 git 追踪文件，必须走 worktree + 每日一个汇总 PR（issue 定稿：勿逐个触发，文档 PR 噪音会淹没审查）。推荐由 scheduled task 每日触发：`git worktree add → node scripts/docs-advance.mjs → commit → gh pr create`。

### 段4：高置信回填

R3 规则即回填（issue 定稿的高置信子集：全 commit 带 prNumber ∧ FID 最后 commit >60 天；其余交僵尸阶梯 30/60/90 消化——自动全量回填会把「干一半放弃」误标「已实现」污染基线）。段4 增量为参数化验证：--quiet-days/--iteration-days 可调，降阈值实测确认 R1 证据门槛正确拒绝假迭代、R3 在当前仓库 0 命中（真实状态：全史 150 commit、静默>60 天在途链=0、121 篇 development 中 87 篇 doc-only 由僵尸阶梯管）。

## 验证

- 全仓回归 196 文件 2477 用例全绿（含 doc-status 15 / chain-builder 新增 11 / doc-advancer 23）
- issue 验收对齐：未知 status 推进器跳过且留痕（skipped 数组 + reason）✓；子状态豁免/参与判定边界有测试 ✓；批量 PR 粒度=天（CLI 设计 + 文档约定）✓；幂等性用例 ✓

## 已知边界与遗留

- feature-mapper.ts:32 / sync-documents.ts:335 的「未知 status 强转 draft」DB 写入侧模式未动（本特性范围外，建议另案：改为保留原值或入 warnings）
- lint ratchet 271 含 review/reviewed 两条存量警告（2 篇文档终态化后可下调）
- 推进器未挂 scheduler（本 PR 交付 CLI + 纯函数；挂载走 scheduled task 属运营配置，由大獭决定触发方式）
- R1 的 docLastTouchedSha 采集是每文档一次 `git log -1`（367 docs 串行约数秒）；如成为瓶颈可改 `git log --name-only` 单遍反查
