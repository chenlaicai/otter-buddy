---
id: F20260923ntq3
title: 记忆检索排序优化：现状链路核实与候选方向
doc_type: feature
summary: |
  记忆检索排序优化的起点文档（设计阶段，本 PR 无代码改动）。现状排序管线：
  FTS5(BM25) + Vec 双路召回 → 每 source top-3 预聚合 → 加权 RRF 融合（alpha 0.4、
  bothBoost 1.2）→ rerank 五信号乘法堆叠 final = rrf × time_decay × frequency ×
  user_flag × conversation_boost（search-engine.ts:183），无量纲归一化；仓内无排序
  质量评测（memory-recall.capability.test.ts:8 自述仅行为不变量），历次调参只能凭
  体感验收。候选方向依 R20260826rcmm「度量>召回>提炼」排序：Phase 0 golden 查询集
  + nDCG 评测基线先行，Phase 1 在基线保护下做信号归一化融合。触发本特性的具体
  痛点场景待搭档补充。
change_type: feature
capability_test: "n/a: 设计阶段文档，仅盘点现状与候选方向，无行为改动；实现提交时补 capability 用例"
created: 2026-09-23
created_in_conversation: 08054326-2bef-42c0-ad6d-a9e91640c9e9
causal_links:
  from: [R20260826rcmm, F20260811mrpy, F20260902rcp1, F20260917cvid]
tags: [memory, retrieval, ranking, rerank, rrf, evaluation]
modules:
  - src/usecases/memory/search-engine.ts
  - src/usecases/memory/search-memory.ts
  - src/frameworks/db/memory/sqlite-memory-repository.ts
---

# 记忆检索排序优化（F20260923ntq3）

> 状态：设计阶段起点文档。本文先落**现状链路核实**与**候选方向**；触发痛点与方案
> 收敛见「下一步」。文中锚点均为 2026-09-23 对 `origin/main`（22135240）实查。

## 背景

`search_memory` 的排序决定召回内容能否被真正用上——top-k 截断下，该在前面的没排到
前面，等效没召回。现状排序由 RRF 融合 + 一组经验系数的乘法重排构成，系数从未经过
评估基线校准，改动效果好坏目前无从度量。方向框架依 R20260826rcmm 的优先级结论：
**度量 > 召回 > 提炼**——先建评测基线，再动排序信号。

## 现状链路（2026-09-23 代码实查）

| 阶段 | 行为 | 锚点 |
|---|---|---|
| 召回 | FTS5 BM25（`ORDER BY fts.rank`）+ Vec 相似度检索，Vec 阈值 0.3 | `sqlite-memory-repository.ts:156,165`；`search-engine.ts:11-12` |
| 预聚合 | 每 source 最多保留 top-3 chunk，防长文档霸占 limit（双路同规则） | `search-memory.ts:481,484,717-749` |
| RRF 融合 | 加权 RRF：`alpha` 默认 0.4（偏信任 FTS），双路命中 `bothBoost` 1.2 | `search-engine.ts:71-74,137` |
| rerank | `final = rrf × time_decay × frequency × user_flag × conversation_boost` 五信号直接连乘 | `search-engine.ts:46-54`（公式注释）、`:166`（rerank 入口）、`:183`（finalScore） |
| 时间衰减 | 通用条目半衰期 7 天（`config.yaml.example:72`），文档层（feature/research）90 天 | `search-engine.ts:20-23,181-182` |
| 本对话加成 | 本对话来源条目 ×1.5（乘法，rerank 阶段） | `search-engine.ts:16-18,189` |
| 同源去重加分 | 按 source 去重取最优，多 chunk 命中 +0.01/个（上限 5） | `search-memory.ts:562-564,678,705-709` |
| 可解释性 | `debug=true` 注入中间分量（rrfScore/timeDecay/frequencyBoost/multiHitCount） | `search-memory.ts:68,80,98` |

## 问题

- **P1 乘法堆叠无归一化**：五个固定乘数直接连乘，信号量级耦合——rrf 被 time_decay
  指数压低后，conversation_boost 只能线性补偿；连乘放大分数方差，排序对单个系数
  高度敏感，组合效应不可预期。
- **P2 无排序质量评测**：`memory-recall.capability.test.ts:8` 自述「断言全部为行为
  不变量：检索命中、工具轨迹顺序、答案含关键 token」——只覆盖召回**存在性**，不含
  排序**正确性**指标（nDCG/MRR 一类）；仓内未见既有排序评测用例。
- **P3 调参无量化依据**：F20260902rcp1、F20260917cvid 等历次排序相关改动只能以
  「单测锁定 + golden 场景不回归」验收——证明行为还在，不证明排对了；排序退化只能
  靠搭档事后口头反馈发现。

## 目标与非目标

**目标**
- G1：可复跑的排序质量评测基线（golden 查询集 + nDCG@5/@10 + MRR），成为排序改动
  的合入门禁。
- G2：在基线保护下将 rerank 信号归一化融合，消除乘法堆叠的量级耦合。
- G3：排序可解释——承接 F20260811mrpy 的 debug 通道，注入各信号贡献分量。

**非目标**
- 不换底层检索：FTS5/Vec 双路与 RRF 融合骨架不动。
- 不引入 LLM rerank：成本与延迟不可接受，违背记忆检索轻量路径定位。
- 不做 query 意图分类路由：属后续独立特性，本文档仅在取舍中预留接口。

## 候选方向（待收敛）

### Phase 0：评测基线（先行，独立可交付）

- **golden 查询集**：30-50 条查询，四层分层采样——事实定位 / 历史脉络 / 文档检索 /
  本对话主题；每条标注期望 top-k 条目。
- **指标**：nDCG@5、nDCG@10、MRR；全量复跑，进 CI 作为排序改动门禁（改动前后数字
  必须进 PR）。
- **数据来源**：直接消费 rerank 的 debug 中间分值（`search-memory.ts:68`），无需新增埋点。

### Phase 1：信号归一化融合（基线保护下实施）

- 各信号映射同量纲：rrf 做 rank 归一/log 压缩；time_decay 已在 (0,1]；frequency 取
  log 后归一；user_flag / conversation_boost 类别信号转加法偏置项。
- 融合由乘法改加法：`score = w₁·norm(rrf) + w₂·time + w₃·freq + b(user_flag) + b(conv)`，
  系数用 Phase 0 基线网格搜索标定。
- debug 注入各分量，排序结果可解释、可对比。

## 影响范围（实现阶段预估）

- `src/usecases/memory/search-engine.ts`：rerank 融合公式与系数配置。
- `src/usecases/memory/search-memory.ts`：debug 分量透传。
- `config/config.yaml.example`：新增 w/b 系数键（旧系数兼容期后移除）。
- `tests/`：search-engine/search-memory 单测同步 + Phase 0 新增评测用例。

## 取舍与风险

- **R1 顺序风险**：无基线先调参 = 盲飞 → 强制 Phase 0 先行，Phase 1 PR 必须附前后
  nDCG 对比。
- **R2 标注主观性**：golden 集期望答案有主观成分 → 分层采样 + 搭档抽查 10% 校准。
- **R3 归一化可能改变既有排序**：加法模型削弱强信号连乘的指数放大效应——已知反对
  意见。对策：基线数据说话；若加法版 nDCG 不敌乘法版，备选路径是**保留乘法、仅做
  信号归一化预处理**（各信号先归一再连乘），不预设结论。
- **R4 L1/L2 边界**：信号建模与系数标定属技术域，大獭拍板并记录理由；nDCG 门禁
  阈值、golden 集标注投入属资源投入，呈搭档确认。

## 关联在途文档（撞车披露）

同一主题已有两份未合入的在途草稿，创建本文档时（2026-09-23）实查发现，披露如下，
合并时需一并去重裁决，避免三份并存：

- `F20260922mrro`（`docs/features/2026/09/22/F20260922mrro-memory-retrieval-ranking.md`）——已提交在 worktree `.otter/worktrees/memory-retrieval-ranking` 的分支 `feature/memory-retrieval-ranking`（commit 29ff09e3），无 PR。
- `F20260922mmro`（`docs/features/2026/09/22/F20260922mmro-memory-retrieval-ranking-optimization.md`）——同 worktree 内未跟踪文件，无 commit。

三者语义高度重叠（现状链路 + 评测基线先行 + 信号归一化）。**建议**：以内容最完整
者为准，其余以 frontmatter `supersedes`/`from` 关联后归档，只保留一份进 main。

## 验证

- Phase 0：评测脚本 + 首次基线报告（nDCG 数字回填本文档）。
- Phase 1：实现 PR 附基线前后对比；既有 memory-recall / search-engine / search-memory
  测试不回归；新系数有单测锁定。

## 下一步（待搭档确认）

- [ ] 补充触发本特性的具体痛点场景（哪个查询排错了、错成什么样）
- [ ] 确认优化方向：评测基线先行 + 信号归一化（含 R3 备选路径认可）
- [ ] 确认 golden 查询集规模与标注投入（30-50 条，谁标、抽查比例）
- [ ] 裁决三份在途文档的去留合并
- [ ] 通过后拆两个实现 PR：Phase 0 / Phase 1 分开交付
