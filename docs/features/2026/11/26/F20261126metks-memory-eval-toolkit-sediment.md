---
id: F20261126metks
title: 记忆评测工具集沉淀（Phase B/C 评测基建入仓）
summary: 将 R20261126amrca Phase B/C 评测的 9 个工具脚本从对话工作区沉淀为 scripts/ 下路径参数化的可复用评测基建（快照评测/采样/盲标渲染合并/Kappa/指标/阈值审计/参数网格），无正文评测证据归档至 docs/research 侧 metma-data（对话正文不进 git 历史），评测方法论另立研究文档 R20261126metma 留档。
change_type: feature
doc_type: feature
created_at: 2026-11-26
created_in_conversation: f4402db8-9dee-4979-82b9-f0d46ed4f195
capability_test: "n/a: 评测基建工具（scripts/*.mjs 独立可跑），无 LLM 自由行为；验证=归档数据复算 Kappa 与指标逐项对照（见 Verification 节），走 behavior_check"
tags: [memory, evaluation, toolkit, blind-labeling, kappa, snapshot-eval]
modules:
  - scripts/phaseb-eval.mjs
  - scripts/sample-queries.mjs
  - scripts/render-workbench.mjs
  - scripts/merge-labels.mjs
  - scripts/kappa-calc.mjs
  - scripts/metrics-calc.mjs
  - scripts/vec-threshold-audit.mjs
  - scripts/phasec-grid.mjs
  - scripts/fused-pool-recalc.mjs
  - docs/research/2026/11/26/metma-data/
intent:
  problem: "Phase B/C 评测的全部工具与证据（9 脚本 + 标注/指标/审计数据）散落在对话工作区 data/workspaces/<id>/eval/，对话归档时整体删除——评测方法（双獭盲标 + Kappa 质量门 + 阈值审计 + 参数网格）不可复用，评测结论的证据不可回溯，下一轮标定（如 K=50 验证）需从零重建。"
  expected_effect: "scripts/ 下 9 个评测工具路径参数化（--repo-root/--snapshot/--eval-dir），对归档数据复算 Kappa=0.8544、指标逐项一致、vec-audit candidates 全等、采样与渲染哈希序确定性重放一致；对话正文不进 git 历史。"
  verify_by:
    type: behavior_check
    rollback: "revert 本 PR 即移除新增脚本与归档数据，不触碰任何运行时行为（零 src/ 改动）；对话工作区原始件在对话归档前仍完整。"
    risk_note: "工具化仅做路径解耦与依赖松绑（pools/q-idx 可选推导），评测逻辑零改动；跨基线复跑存在 ±0.006 级漂移（#2062 基线行为变化所致，非工具非确定性——同基线两次重跑 25 组合全等），详见 Verification。"
---

# 记忆评测工具集沉淀（Phase B/C 评测基建入仓）

## 背景与决策链

- 来源：R20261126amrca（评测路线）→ F20261126mvhyg（索引卫生，快照与清理）→ Phase B/C 评测（M-1239dd29，本对话执行）→ F20261126swtch（参数切换 #2062）→ 搭档拍板合入后，大獭派工沉淀评测资产（2026-11-26 19:05，范围清单经大獭三点拍板：正文不进 git / scripts/ 平铺 / 编号按惯例生成）。
- 工作区原始件：`data/workspaces/f4402db8-.../eval/`（对话归档时删除；本 PR 是其唯一持久化载体）。

## 目标与非目标

### 目标

1. 9 个评测脚本工具化进 `scripts/`（路径参数化，硬编码清零）。
2. 无正文评测证据归档至 `docs/research/2026/11/26/metma-data/`。
3. 评测方法论研究文档 `R20261126metma`（与 amrca 建关系链）。

### 非目标

- 不改任何 `src/` 运行时行为（零 src 改动）。
- 不进 repo：对话正文类数据（blind-pools-phaseb.json 1.5MB 记忆全文 / sampled-queries.json 查询原文 / label-workbench/ 全文渲染 / runs-phaseb.json 的 context 字段）——搭档数据不固化进 git 历史（大獭拍板①）；halflife-revival-check / golden-halflife-check 两个一次性检查脚本（方法写进 R20261126metma，golden-halflife 与 golden-eval.test.ts 语料 setup 重复度高，不值得养两份）。
- 不挂 npm scripts（`node scripts/<name>.mjs --help` 头注即用法，对齐 audit-memory-vec 先例）。

## 设计取舍

### 机制判定留痕

机制识别检查点七项清单逐项核对（troubleshooting SKILL.md 修法决策树节）：**全部未命中**——无新增配置字段/枚举/开关（脚本 CLI 参数非系统配置）、无新增决策分支/守卫/状态生命周期/持久化/跨模块调用路径/协议或管辖变化（评测脚本运行于 repo 之外的数据，只读快照库，不触碰 memory_weights；权重恢复逻辑为既有 phaseb 模式）。新增的是独立外部工具（对齐 `audit-memory-vec.mjs` 先例，#2045 同判），非系统机制。

`Modification-Class: narrow-fix`（依据：新增独立评测工具不改变任何既有语义，先例同判；非「未命中」式申报遗漏——本判定动手前完成，见 code-implementation 步骤 3）。

### 归档数据分级（正文不进 git）

- **进 repo**：labels-A/B.json（entryId→分数）、q-idx.json（短码↔id 映射）、metrics-phaseb.json、phasec-grid-results.json、vec-threshold-audit.json（id+distance）——全部为 id/分数/排名级数据，无对话正文。
- **不进 repo**：含对话正文的 4 类文件（见非目标）。可复现路径 = 文档写重建流程（快照从清理备份重建 → sample-queries 重采样 → phaseb-eval 重跑生成 runs/pools → render-workbench 重渲染），工具链在 repo 内自洽。
- 依赖松绑：kappa-calc / merge-labels 的池全集校验改为「blind-pools 存在则双向核对，缺省从 q-idx idMap 推导」（映射恰好覆盖池全集是渲染期不变量）——归档数据自洽可复算，Kappa 复算无需含正文文件。

### 超出派工清单 1 个脚本（呈验收定夺）

`fused-pool-recalc.mjs`（派工清单 A 组 8 个之外）：它是「双口径 r_pool」（原始并集 vs 真实融合池）这一本次评测最重要方法论教训的工具载体，与 R20261126metma 双口径节直接配套，5KB 纯读数据重算零副作用。保留理由成立可留，不成立可删。

### 一次性检查脚本不进（D 组，大獭拍板）

halflife-revival-check / golden-halflife-check 的方法与结论写进 R20261126metma（h7→h21 复活 14 条全部 ≤30 天零 superseded；h14 合成回归三项全绿 0.7684/0.7754/0.8985，h21 nDCG10 擦线出局），脚本本体不进。

## Verification

### 工具验证矩阵（9/9 PASS）

| 脚本 | 验证方式 | 结果 |
|---|---|---|
| kappa-calc | 对归档 metma-data 复算 | **κ=0.8544 与原评测完全一致**（机械校验 PASS、混淆矩阵/一致率逐项一致） |
| metrics-calc | 归档数据 + 工作区 runs | 指标逐项一致（r_pool 0.600/1.000/0.400、recall@10 0.304、MRR 0.813、延迟分解全同） |
| fused-pool-recalc | 同上 | 融合池口径表逐格一致（t0.3 行 0.40/0.40/0.40 等） |
| vec-threshold-audit | 主仓基线重跑 | candidates（20 查询 × 50 条 id+distance）**逐字节全等**，杀伤 96.4% 复现 |
| sample-queries | 主仓基线重采样 | queryId 序列与原评测完全一致（哈希序确定性） |
| render-workbench | 工作区 pools 重渲染 | q-idx 与归档逐字节一致 |
| merge-labels | 工作区 part 文件重合并 | labels-A 与归档逐字节一致 |
| phasec-grid | 主仓基线重跑 ×2 | **同基线两次重跑 25 组合全等**（工具确定性成立） |
| phaseb-eval | 主仓基线重跑 | 两路候选 20/20 全同；slate 19/20 全同 + q3 一处并列分数条目互换一位（tie-break 敏感，非逻辑差异，见下） |

### 跨基线漂移的如实说明

- 对归档结果的跨基线复跑存在 ±0.006 级微漂移（12/25 组合，集中在放阈值组合；BASELINE t0.3 组完全不变）。**同基线两次重跑全等**证明工具本身确定性；漂移归因 #2062 合入后的基线行为变化（vecCandidateLimit 接线改变了 q3 并列分数条目的 tie 环境），两路召回在全部组合不变。这一漂移恰好演示了本工具集的核心用途：捕捉基线行为变化。
- phaseb-eval q3 tie 互换：slate 第 7/8 位两个 doc-summary 条目（finalScore 并列）顺序互换，两路候选完全一致；指标影响 ≤0.006。

### 数据无正文核验

`grep -l "preview\|content" docs/research/2026/11/26/metma-data/*.json` → 0 命中（labels/q-idx/metrics/audit/grid 全部为 id/分数/排名结构）。

### 最简实现检查

已过：工具化只做路径解耦（每脚本头部统一 `arg()` 8 行，无新依赖）；未抽公共模块（9 个脚本各自独立可跑，抽公共 lib 反而增加耦合）；数据归档直接 JSON 平铺（无新格式）。

### 负面向自检

本次变更绕过/破坏的既有保护：无——零 src 改动，纯新增 scripts 与 docs 数据；gitignore 未触碰。

## 回滚

revert 本 PR 即移除全部新增文件，无运行时影响；工作区原始件在对话归档前仍完整，可随时重新沉淀。
