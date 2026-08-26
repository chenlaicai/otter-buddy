---
id: R20260826rcmm
title: 记忆系统优化设计方案（三獭对抗讨论终版）
summary: 基于三模型（glm/kimi/mimo）对抗讨论收敛的记忆系统优化路线：Phase 0 评估基线 → Phase 1 召回加固 → Phase 2 预加载式精益提炼。推翻了原始"dream 做 P0"方案，优先级翻转为度量>召回>提炼。涵盖写入通道盘点、生命周期现状、digest 归属决策（预加载层而非检索池）、评估方法与验收标准。
exploration_type: technical
tags: [memory, retrieval, recall, dream, digest, evaluation, rrf, architecture, multi-agent-debate]
from: [F20260708r6p5, F20260709x7k3, F20260811mrpy, F20260812mrcq, R20260811rclo, F20260713c7p2]
conclusion: 优先级翻转——评估基线 > 召回加固 > 提炼；digest 走预加载层（增强既有 sessionSummary 机制）不进检索池；write_memory 独立通道不做。
---

# 记忆系统优化设计方案（三獭对抗讨论终版）

## 背景

搭档原话（意图锚）：

> 「同事说《我是倾向于，agent 实时写记忆，然后未来可能定时任务 auto dream，去提炼。通过记忆的来源反查 trajectory》，是关于记忆系统的设计思路的」
> 「你拉上kimi和mimo，你们三个獭一起来对抗讨论下，不一定按照你说的这个方案来，问题还是这个记忆系统优化方向」
> 「你写文档，然后写了再让他俩对抗审视下，最终你们输出一份设计方案文档」

演进脉络：大獭（glm）初版方案「write_memory 前置 + dream 做 P0」→ kimi（范式/架构层批判）+ mimo（工程/算法层批判）两轮对抗 → 初版 P0 被推翻，路线翻转为「评估 → 召回 → 精益提炼」→ 本文为终版设计。

对抗讨论净产出：
1. 原方案 P0（定时 dream 批量提炼）被杀：幻觉不可验收 + 成本前置 + 检索侧依赖未建
2. 「移出默认检索池」机制不存在：search-engine 对 superseded 零感知（grep 实证），原方案隐含召回侧工作量
3. digest 归属翻转：不进检索池，走既有 DynamicContext 预加载机制（agent-invoker.ts:425「记忆召回由 agent 通过 search_memory 主动触发」本就是系统设计哲学）
4. write_memory 独立通道被杀：四条既有通道语义清晰是优势，自由通道制造去重债务 + 检索污染
5. 评估维度从无到有：无 recall@k 基线，任何优化方向都是观点之争

## 目标

- **T1**: 建立记忆检索评估基线——真实查询标注 + recall@5/10 + MRR + 失败分类，让后续优化可度量
- **T2**: 按失败分类定向加固召回管线，每项改动对基线验收
- **T3**: 用预加载式 digest 增强会话前情摘要质量，替代当前占位级摘要（实测新对话注入「前情都已完成，现在开始新对话」——平台运行时注入行为，非仓库代码）
- **T4**: 修复文档状态与实现脱节（F20260811mrpy/F20260812mrcq 已落地但 status 仍 draft）
- **T5**: 搭档可感知性——前情摘要从占位级升级为可读 digest，记忆优化不再是对搭档的黑盒（R7 溯源行继续保留）

## 非目标

- **N1**: 不做 write_memory 自由写入通道（三獭共识，含别名形式）
- **N2**: 不做 insight 提炼、自动关系边、跨对话聚合（P2 议题，数据达标前不动）
- **N3**: 不加第四记忆层（复用 working/historical/document 三层）
- **N4**: 不做全量 historical 批量 dream（事件驱动 + 增量水位，不做 cron 无差别批量）
- **N5**: 本方案不改变既有写入通道语义（消息自动索引/fact/文档同步/RHI 信号保持不变）

## 方案设计

### 总路线

```
Phase 0 评估基线（知道多差）
   ↓ 产出失败分类，决定 Phase 1 顺序
Phase 1 召回加固（让桶不漏）——按失败分类定向，不预设
   ↓ recall@k 达标
Phase 2 精益提炼（在不漏的桶里装水）——预加载式 digest
```

三 Phase 串行，每 Phase 有独立验收，未达标不进入下一 Phase。

### Phase 0 · 评估基线（埋点上线 + 7-14 天数据积累 + 标注 2-3 天）

**输入**：近 14 天 search_memory 真实调用（查询 + 返回结果），去重后 50-100 条。

**步骤**（埋点是必经路径而非可选——现状无任何查询日志基建：memory_weights 仅含 retrieval_count/last_retrieved_at/user_flagged 三列（schema.ts:178），不含查询文本，无法回溯真实查询）：
1. **检索埋点**：新增最小埋点表——查询文本 + top 结果 + **查询发起时的对话上下文（最近 3-5 条消息）**。记录上下文是为了标注者还原查询意图，规避「测的是标注者记忆而非系统召回」的选择偏差（mimo B2）
2. **数据积累**：埋点上线后等 7-14 天，取真实查询去重后 50-100 条
3. **双人独立标注**：大獭 + mimo（或 kimi）各自先看上下文推断意图，再标注「理想应召回的条目 ID 集合」；Cohen's Kappa ≥ 0.6 才认可基线，低于 0.6 复核分歧条目对齐标准后重标；搭档只仲裁无法收敛的分歧条目
4. **指标计算**：recall@5 / recall@10 / MRR
5. **失败分类**：recall@10 < 1.0 的查询逐条归因——FTS 未匹配 / vec 未命中 / 排序问题 / 暗化条目缺失（允许多标签，主因单选）

**决策规则**（失败分类 → Phase 1 顺序）：
| 失败主因占比 | 优先动作 |
|---|---|
| FTS 未匹配 ≥ 40% | 查询改写最优先 |
| vec 未命中 ≥ 40% | 暗化补扫最优先 |
| 排序问题 ≥ 40% | SemanticReranker / 权重调优最优先 |
| 暗化缺失显著 | FTS-vec 一致性对账最优先 |

**风险预案**：若积累窗口内查询量不足 30 条，扩展窗口至 30 天或放宽去重粒度；仍不足则说明系统使用模式无需高频检索，Phase 1 降级为只做基础卫生项（对账 + 补扫）。

### Phase 1 · 召回加固（候选池，按分类激活）

候选按「ROI（预期 recall 提升 / 工程工时）× Phase 0 失败分类」双条件激活，未命中失败分类或 ROI 不达标的候选不实施：

| 候选 | 预期 ROI | 工时参考 | 激活条件 |
|---|---|---|---|
| 查询改写 | 极高（一段 prompt 解决模糊查询） | 0.5 天 | FTS 未匹配占比高 |
| 暗化补扫定时任务 | 高（复用 scanDarkEntries + 补 embed） | 1-2 天 | vec 未命中 / 暗化缺失 |
| FTS 一致性对账 | 中（收益取决于实际不一致率） | 1 天 | 对账实测有差异 |
| 权重 source 可信度因子 | 中（收益取决于通道间质量差异） | 0.5 天 | 排序问题占比高 |
| SemanticReranker | 低-中（新组件需评估+调参，收益不确定） | 3-5 天 | 排序问题为主因且轻量项已做 |

1. **查询改写**：对模糊查询（「上次那个方案」「之前讨论的」）做 LLM query expansion 后再入管线。成本一段 prompt；验收 = 该类查询 recall@10 提升
2. **暗化条目自动补扫**：scanDarkEntries + 补 embedding 做成定时任务（复用 create_scheduled_task 基建）；验收 = vecCoverage ratio → 1.0 且 vec 类失败率下降
3. **FTS 一致性对账**：抄 clowder checkConsistency() 模式（IndexBuilder.ts:385），启动时对账 memory_entries ↔ memory_fts_jieba 行数；验收 = 对账报告 0 差异
4. **SemanticReranker 评估**：FTS 召回为主 + vec 距离精排 vs 现行 RRF，用 Phase 0 基线 A/B；验收 = MRR 提升且 recall 不降
5. **权重公式加 source 可信度因子**：memory-entry 的 sourceTable 字段已区分通道（signals/linked_resources/...），权重重排引入差异化可信度；验收 = fact 类检索精度提升

### Phase 2 · 预加载式精益提炼

**核心决策：digest 不入检索池，增强既有 DynamicContext 预加载机制。**

论据：
- 「预加载概览 + 主动检索细节」本就是系统设计哲学（src/interface-adapters/agent-runtime/agent-invoker.ts:425 注释 + F20260713c7p2 session 架构；sessionSummary 赋值点 :456）
- digest（coarse 概览）与原始消息（fine 细节）服务不同粒度查询，同池竞争会导致 digest 挤占 top-k（mimo 推演：digest 新生成 time_decay 占优，fine 查询命中它挤掉原始消息）
- 预加载的代价是 digest 质量常驻污染每次对话 → 验收标准因此更严

**digest 生成机制**：
- 触发：session 归档事件 → 写「待 dream」记录入队列表（复用 embedding_tasks 的 claimPendingTasks 模式）→ 后台 worker 消化（事件 + 异步队列，非 cron 非同步钩子）
- 输入：单 session 全部消息（working→historical 转换后）
- 输出：该 session 的结构化 digest（决策/结论/待办/领域知识点，格式在 Phase 2 设计文档细化）
- 归属：**独立新表 session_digests（本文档拍板，不留到 Phase 2）**——digest_id / session_id / content / created_at / watermark，session_id 建索引。理由：schema.ts:7 硬约束「所有 CREATE 使用 IF NOT EXISTS，禁止 ALTER TABLE」，sessions 表加列需重建库；独立新表零迁移成本，且天然支持同 session 多版本 digest 与水位追踪。digest 是 session 的派生属性，不入 memory_entries 统一索引表

**增量与预算**：
- 水位线：只处理上次 dream 时间戳之后的归档
- token 成本推算（占位估值，按当前消息密度，Phase 2 复核）：单 session ≈ 100 条消息 × 200 token = 20K input + ~2K 输出 → 单 digest 约 ¥0.03（小模型定价量级）；单用户日均 3-5 session → 月成本 < ¥5，可控
- 预算上限：单 digest 输入 ≤ 40K token（占位估值），超限先做消息分段预压缩；预加载 ≤ 3K token/对话（占位估值）；N 初值 3-5（按 3 × ~500 token/digest 由预算反推）
- 预加载窗口按归档时间 LIFO 取最近 N 个。超龄/被挤出窗口的 digest **不是暗数据**：仍存 session_digests 表，经 session 维度路径可达（session 历史 / provenance），只是不进 search_memory 检索池——细节查询永远走原始消息，不依赖 digest

**验收门**（放量前必过）：
1. 人工抽查 **20 条** digest，幻觉率 ≤ 5%（≤1 条）才放量（10 条抽样的置信区间宽到无决策价值，[0.3%, 45%]）。幻觉定义（从严）：「digest 包含原始对话中不存在的事实性断言」——省略信息属有损压缩不计为幻觉；关键决策遗漏、时序错乱单独记为质量问题
2. 预加载 token 成本 ≤ 预算（如 3K token/对话）
3. 放量后每周抽检 10 条持续监控，幻觉率 > 5% 触发回查
4. 不达标回炉生成 prompt，连续两轮不达标暂停项目复议

**agent 行为引导**（prompt 层，防「摘要替代检索」）：sessionSummary 是概览，搭档追问具体细节（「具体怎么说的」「原话是什么」）时必须 search_memory 下钻原始消息，不得仅凭摘要回答具体事实。

**回滚**：预加载开关可随时关闭回退到现有 sessionSummary 行为；原始消息全程不动（append-only）。

### Phase 0+ · 文档状态修复（与 Phase 0 并行，半天）

F20260811mrpy / F20260812mrcq 功能已落地（anchor 短路/context-expand/vecCoverage/drillDown 均在 search-memory.ts:126-161 实现）但 status 仍 draft——补归档状态，消除「文档说没做、代码已做」的误导（本次对抗讨论中 kimi 即被此误导）。

## 影响范围

| 模块 | 影响 | Phase |
|---|---|---|
| src/usecases/memory/ | Phase 1 各候选的实施点；Phase 0 埋点 | 0/1 |
| src/usecases/otter/manage-session.ts | Phase 2 归档钩子挂载点（:168 updateLayer 处） | 2 |
| src/interface-adapters/agent-runtime/agent-invoker.ts | DynamicContext 构建处（buildDynamicContext :426 起，sessionSummary 赋值 :456）——Phase 2 预加载组装点 | 2 |
| src/frameworks/agent/session-helpers.ts | prompt 组装（:254 会话摘要注入格式） | 2 |
| src/frameworks/db/schema.ts | Phase 2 队列表/session digest 字段（按归属决策） | 2 |
| docs/features/ | mrpy/mrcq 状态修复 | 0+ |

不触碰：写入通道语义、三层模型、RRF 融合算法本身（SemanticReranker 仅评估）、既有 supersedes 状态机（linked_resources 域）。

## 飡险与约束

| 风险 | 缓解 |
|---|---|
| 人工标注成本被低估（50-100 条 × 2 人） | 大獭预标 + 搭档只复核分歧条目；每条 ≤ 2 分钟目标 |
| 失败分类边界模糊（一条失败多因） | 允许多标签，主因单选 |
| 查询改写引入新延迟（LLM 调用） | 仅对识别为模糊的查询触发；命中缓存直接复用 |
| Phase 2 digest 幻觉 | 三重护栏：抽查门 + 可回溯要求 + 随时可关的预加载开关 |
| 预加载挤占上下文预算 | N 值由预算反推；digest 超龄（如 90 天）自动退出预加载 |
| 检索日志不可用 | Phase 0 先加最小埋点，接受 7-14 天数据积累延迟 |

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 优先级 | 评估→召回→提炼 | 提炼优先（原方案） | 无基线的优化是盲飞；召回债不清单纯加 digest 收益无法度量（kimi 批判 3 + mimo 一致） |
| digest 归属 | 预加载层 + 独立 session_digests 新表 | 入 memory_entries 检索池 / sessions 表加列 | 系统哲学本就是「预加载概览+主动检索细节」；同池竞争挤占 top-k（mimo 分歧 1）；schema 禁 ALTER（schema.ts:7）使加列=重建库，新表零迁移（kimi B2） |
| digest 调度 | 事件+异步队列 | cron 定时批量 | 归档事件本就是自然时间点（kimi 批判 4）；避免无差别批量的成本前置；异步避免阻塞归档（mimo 修正） |
| write_memory | 不做（连别名不做） | 新通道/别名 | 四通道语义清晰是优势；自由通道制造去重债务+检索污染（kimi 批判 1 + mimo 补充）；prompt 层引导既有通道即可 |
| 提炼范围 | 单 session digest 起步 | 跨对话聚合/insight | 跨对话聚合无验收手段前是空中楼阁（kimi）；insight ROI 最低（mimo）；增量验证后再议 |
| 评估指标 | recall@5/10 + MRR + 失败分类 | 纯人工体感 | 需要可复现的数字基线才能验收 Phase 1（mimo Phase 0 方案） |
| 记忆层数 | 维持三层 | 加 dream 层 | 三层模型是既定架构决策（F20260708r6p5）；digest 走预加载后连新 contentType 都不需要 |

## 验证

- **Phase 0 验收**：基线报告产出（recall@5/10、MRR、失败分类分布）+ 搭档确认标注质量
- **Phase 1 验收**：每项候选对基线的量化提升（如查询改写上线后模糊类查询 recall@10 从 X→Y）；未达标项回炉或下架
- **Phase 2 验收**：抽查门 20 条幻觉率 ≤5% + 预算达标 + 关闭开关可回滚验证 + 搭档可感知（新对话前情摘要可读性提升，不再注入占位文案）
- **回归**：Phase 1 每项改动跑既有 memory 检索测试套件；Phase 2 不动检索路径（digest 不入池）天然低风险

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| docs/research/2026/08/R20260826mopt-*.md | 新增 | 本文档 |
| src/usecases/memory/（具体文件按候选激活定） | 修改 | Phase 1 各候选；Phase 0 最小埋点（如检索日志表） |
| src/usecases/otter/manage-session.ts | 修改 | Phase 2 归档入队 |
| src/interface-adapters/agent-runtime/agent-invoker.ts | 修改 | Phase 2 预加载组装（buildDynamicContext） |
| src/frameworks/agent/session-helpers.ts | 修改 | Phase 2 摘要注入格式 |
| src/frameworks/db/schema.ts | 修改 | Phase 2 队列表 + session_digests 新表（CREATE IF NOT EXISTS，遵守 schema.ts:7 禁 ALTER 约束） + Phase 0 埋点表 |
| docs/features/2026/08/11/F20260811mrpy-*.md, 08/12/F20260812mrcq-*.md | 修改 | status 修复 |

Phase 1/2 的具体文件在各自 Phase 启动时补细案——本文档定方向与验收，不预写实现细节。

## 对抗讨论参与者声明

本文档由三模型对抗讨论产生：大獭（glm，方案提出者兼仲裁）、kimi（K3，范式/架构层批判）、mimo（MiMo，工程/算法层批判）。初始方案的 P0 被推翻，本文档是三方合流后的产物，非单一模型观点。
