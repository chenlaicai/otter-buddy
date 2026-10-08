---
id: F20261008mrrk
title: 记忆检索排序优化：现状链路核实与候选方向
doc_type: feature
summary: |
  记忆检索排序优化特性文档（设计 + Phase 0 实现）。现状排序管线：
  FTS5(BM25) + Vec 双路召回 → 每 source top-3 预聚合 → 加权 RRF 融合（alpha 0.4、
  bothBoost 1.2）→ rerank 五信号乘法堆叠 final = rrf × time_decay × frequency ×
  user_flag × conversation_boost（search-engine.ts:183），无量纲归一化；仓内无排序
  质量评测（tests/capability/memory-recall.capability.test.ts:8 自述仅行为不变量），历次调参只能凭
  体感验收。方向依 R20260826rcmm：Phase 0 已落地 golden 评测套件（44 条五层查询 +
  50 条确定性语料，地板 0.673/0.707/0.811 随 npm test 进 CI；反事实证明五信号在
  种子集为净负贡献，地板局限已声明），Phase 1 待基线保护下实施。
  （FID 顺延自 F20260923ntq3。）
change_type: feature
intent:
  problem: "记忆检索排序无质量评测（golden 集/nDCG 缺失）且 rerank 五信号乘法堆叠无量纲归一化——排序改动只能凭单测锁定+体感验收，证明行为还在但不证明排对了，排序退化只能靠搭档事后口头反馈发现"
  expected_effect: "设计文档本身无行为改动；为后续 Phase 0（golden 查询集 + nDCG 评测基线，成为排序改动合入门禁）与 Phase 1（基线保护下的信号归一化融合）提供经代码实查的现状链路与方案骨架"
  verify_by:
    type: static_only
capability_test: "tests/usecases/memory/golden-eval.test.ts"
created_at: 2026-10-08
created_in_conversation: 08054326-2bef-42c0-ad6d-a9e91640c9e9
causal_links:
  from: [R20260826rcmm, F20260811mrpy, F20260902rcp1, F20260917cvid]
tags: [memory, retrieval, ranking, rerank, rrf, evaluation]
modules:
  - src/usecases/memory/search-engine.ts
  - src/usecases/memory/search-memory.ts
  - src/frameworks/db/memory/sqlite-memory-repository.ts
---

# 记忆检索排序优化（F20261008mrrk，原 F20260923ntq3）

> 状态：设计阶段起点文档。本文先落**现状链路核实**与**候选方向**；触发痛点与方案
> 收敛见「下一步」。文中锚点均为 2026-09-23 对 `origin/main`（22135240）实查，
> 2026-10-08 rebase 至最新 main 时全量复核（`search-engine.ts`/`search-memory.ts`
> 零变更锚点仍准；`sqlite-memory-repository.ts` 经 F20261001ftsp 两段式查询改造行号漂移已订正）。

## 背景

`search_memory` 的排序决定召回内容能否被真正用上——top-k 截断下，该在前面的没排到
前面，等效没召回。现状排序由 RRF 融合 + 一组经验系数的乘法重排构成，系数从未经过
评估基线校准，改动效果好坏目前无从度量。方向框架依 R20260826rcmm 的优先级结论：
**度量 > 召回 > 提炼**——先建评测基线，再动排序信号。

## 现状链路（2026-09-23 代码实查，2026-10-08 rebase 复核）

| 阶段 | 行为 | 锚点 |
|---|---|---|
| 召回 | FTS5 BM25（`ORDER BY fts.rank`）+ Vec 相似度检索，Vec 阈值 0.3 | `sqlite-memory-repository.ts:161,170`；`search-engine.ts:11-12` |
| 预聚合 | 每 source 最多保留 top-3 chunk，防长文档霸占 limit（双路同规则） | `search-memory.ts:481,484,717-749` |
| RRF 融合 | 加权 RRF：`alpha` 默认 0.4（偏信任 FTS），双路命中 `bothBoost` 1.2 | `search-engine.ts:71-74,137` |
| rerank | `final = rrf × time_decay × frequency × user_flag × conversation_boost` 五信号直接连乘 | `search-engine.ts:46-54`（公式注释）、`:166`（rerank 入口）、`:183`（finalScore） |
| 时间衰减 | 通用条目半衰期 7 天（`config/config.yaml.example:72`），文档层（feature/research）90 天 | `search-engine.ts:20-23,181-182` |
| 本对话加成 | 本对话来源条目 ×1.5（乘法，rerank 阶段） | `search-engine.ts:16-18,189` |
| 同源去重加分 | 按 source 去重取最优，多 chunk 命中 +0.01/个（上限 5） | `search-memory.ts:562-564,678,705-709` |
| 可解释性 | `debug=true` 注入中间分量（rrfScore/timeDecay/frequencyBoost/multiHitCount） | `search-memory.ts:68,80,98` |

> 2026-10-08 复核新事实：9/23 后合入的 F20261001ftsp（#1279）在 FTS 召回层引入
> 两段式查询（AND 交集优先、OR 兜底，检索读放大降 79%），只影响查询构造不影响
> 排序信号——本文档的排序管线描述不受影响，评测基线设计时需以该版本为基线。

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
- [ ] 通过后拆两个实现 PR：Phase 0 / Phase 1 分开交付（Phase 0 已完成，见下方实现记录）

## Phase 0 实现记录（2026-10-08）

搭档 2026-10-08 10:05 拍板「实现也带上」，本节补记 Phase 0 落地事实。

### 交付物

| 组件 | 位置 | 说明 |
|---|---|---|
| 指标纯函数 | `tests/usecases/memory/ranking-metrics.ts` | nDCG@K / MRR / mean；线性增益（分级 3/2/1/0），无生产依赖 |
| 指标单测 | `tests/usecases/memory/ranking-metrics.test.ts` | 14 例手算期望值锁定（独立推导，非实现回代） |
| golden 语料+查询集 | `tests/usecases/memory/golden-corpus.ts` | 50 条确定性 fixture（含 5 组近邻干扰簇）+ 44 条五层查询，合成种子集声明 |
| 评测 runner+地板 | `tests/usecases/memory/golden-eval.test.ts` | 全链路指标 + 地板断言 + 防腐化结构断言 |
| 便捷脚本 | `package.json` | `npm run eval:golden`（本地复跑/基线更新入口） |

CI 接入方式：套件落在 tests/ 下随 `npm test` 进 check job（vitest include tests/**），
无独立 workflow 新增——门禁复用现有路径，PR 内可见指标输出（console 日志）。

### 设计取舍

- **指标增益线性而非指数**（未用 2^rel−1）：三级标注下方差过大，单条核心 miss 与
  多条弱相关命中的权衡被放大；线性增益对排序 PR 前后对比更稳。
- **时间确定性用动态相对时间**：语料 createdAt 全部 `daysAgo(N)` 运行时求值（#1126
  动态日期模式），相对年龄恒定 → time_decay 输入恒定；不写死 ISO 日期（lint:date-bombs）。
- **检索副作用隔离**：`SearchMemory.search` 会递增 retrieval_count
  （search-memory.ts:571 incrementRetrievalCounts），评测在每条查询后重置
  memory_weights 并重放 WEIGHT_PRESETS——否则查询顺序污染 frequency 信号、指标不可重复。
- **Vec 路径口径（已知边界）**：CI check job 无 bge-m3 下载步骤（golden-selftest
  job 才有），真模型进不了这条门禁；评测 mock EmbeddingGateway available=false，
  searchVec 跳过、召回降级纯 FTS——与 tests/usecases/memory 现有 search 测试同口径。
  覆盖面如实声明：**评测覆盖 FTS+预聚合+RRF+rerank 四信号；Vec 召回与 bothBoost
  在本套件为 FTS-only 降级形态**，真 Vec 评测待 capability 层后续接入。
- **地板取首跑值向下取整 3 位**：本地 3 次复跑完全一致（确定性验证），向下取整
  吸收浮点末位，语义仍是「不许变差」。下降需证明测量噪声或语义预期变化（后者
  需搭档确认），上升可直接改数字。
- **debug 分值通道**：Phase 0 指标计算不依赖中间分值——设计文档「数据来源用 debug
  分值」（search-memory.ts:68）指 Phase 1 标定系数时的诊断需求；本 Phase 零生产代码
  变更，debug 通道保持不动。

### 基线数字（v2 扩充后重录，2026-10-08）

| 指标 | 首跑值 | 地板（向下取整 3 位） |
|---|---|---|
| nDCG@5 | 0.6732 | 0.673 |
| nDCG@10 | 0.7079 | 0.707 |
| MRR | 0.8114 | 0.811 |

口径：n=44（原 32 + E 层 12），全链路 SearchMemory.search（FTS-only 形态），limit=10，
权重预设重放，查询间权重重置。本地 3 次复跑完全一致；CI 同口径（check job 无模型
下载，同样 FTS-only）。

首版基线（0.7891/0.8034/0.9115，n=32）因区分度不足被检视发现 2 否决——反事实
实验证明五信号中性化后指标反升（详见下节），v2 扩充后重录。

### 反事实与地板灵敏度（检视发现 2 复盘，2026-10-08 补记）

**事实**：检视獭反事实实验（v1 种子集）：把 rerank 五信号全部中性化（乘数归 1、
半衰期无穷），指标反升至 nDCG 0.860/MRR 1.000 满分——v1 种子集上五信号 rerank
是**净负贡献**，约 1/3 查询候选池 ≤2 条（测的是召回存在性而非排序质量）。

v2 扩充（近邻干扰簇 13 条 + E 层高区分度查询 12 条）后我们复跑反事实：

| 配置 | nDCG@5 | nDCG@10 | MRR |
|---|---|---|---|
| 生产默认（基线） | 0.6732 | 0.7079 | 0.8114 |
| 五信号全中性化 | 0.7998 | 0.8029 | 0.9364 |
| 仅关本对话加成 | 0.6611 | 0.7026 | 0.7981 |
| 仅关时间衰减 | 0.7669 | 0.7810 | 0.8845 |

**结论（如实声明）**：即使在 v2 扩充后的种子集上，五信号整体仍是净负贡献
（全关反而 0.80>0.67），时间衰减单独破坏也是指标反升（0.77>0.67）——地板
方向性失真在合成集上未根治，只被收窄（单信号关闭有向下的：关本对话加成
0.66<0.67）。这符合检视獭的判断：合成集难以凭构造出「产品信号恰好该赢」的
真实分布。

**Phase 1 验收约束（必须遵守）**：
1. 改 rerank/归一化的 PR **必须附逐信号前后对比表**（全开/全中性/逐单关），
   禁止单看地板绿灯下结论——绿灯只证明「没变更差」，不证明「变更好」；
2. 地板数值更新须在 PR 描述里附反事实数字佐证变化方向；
3. 真实数据校准（R2）后基线重录，合成集局限正式收口。

### 设计取舍（机制识别与四问）

**机制识别检查点**（修法决策树前打勾）：本 Phase 新增评测机制命中清单项：
□ 新增决策分支被记住并影响后续行为？否——评测是只读观测，无状态写入生产路径
□ 新增持久化存储？否——无新表新字段，fixture 在测试内自建自销
□ 新增配置字段/开关？否——仅 package.json scripts 加一行 eval:golden 便捷入口，
不是运行时开关
□ 新增信号类型/定时任务/跨模块调用？否
其余各项均未命中 → 净新增机制仅「评测套件本身」（测试层新设施），生产代码零变更。
声明 Modification-Class: mechanism-addition 因测试机制是新增强设施，按四问自审：

- **① 谁需要它**：改检索排序的工程师（未来 Phase 1 归一化 PR 作者，需要回归地
  板拦变差）；检视獭（需要可复现指标做对抗验证）；搭档（需要量化数字而非体感验收）。
- **② 失败后果**：内部指标异常（地板误报拦住好 PR / 误放行坏 PR）——不影响用户
  可感知行为；误报成本是作者多跑一轮反事实验证。
- **③ 后续机制**：评测机制可能出的问题：种子集腐化（结构断言已拦）、地板过期
  （重录流程已定义）、CI 时长增长（当前 +1s 可忽略）；修复手段都是改 fixture/数字，
  不产生新机制。
- **④ 退役条件**：真实使用数据校准的评测（R2）落地后，合成种子集退役换真实集；
  或检索引擎整体替换（换引擎时评测套件随管线重写）。

### 已知边界与后续

- **合成种子集**：条目与标注为人工构造（golden-corpus.ts 头注声明），非真实使用
  数据；真实数据校准需搭档抽查（R2）。种子集基线只锁定当前管线行为，不代表
  真实分布上的质量水位——数字本身不宣胜，只做回归地板。
- **分层覆盖**：fact 8 / history 8 / document 10 / conversation 6 / 高区分度探针 12
  （E 层，共 44 条，在 30-50 区间）；语料 50 条：contentType 六类全覆盖
  （message/fact/feature/feature_chunk/research/research_chunk）、年龄 1~365 天、
  3 对话 + 跨对话(null)、近邻干扰簇 5 组（13 条）、user_flagged 与 retrieval_count
  预设各一。
- **Phase 1 衔接**：信号归一化 PR 必须附前后 nDCG 对比（R1）；真 Vec 口径评测与
  golden 集真实数据校准列为后续独立工作。
