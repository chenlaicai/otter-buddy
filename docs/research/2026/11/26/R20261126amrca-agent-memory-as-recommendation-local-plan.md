---
id: R20261126amrca
title: Agent 记忆作为推荐系统——外部研究证据与本机可行优化路线
summary: >-
  调研 AgentMemRec、vLLM-GR 及同期记忆研究，并结合 Otter Buddy 当前检索架构、本机硬件与 2026-11-25 活库实测，收敛出「索引卫生 → 有效评测 → 现有参数标定 → 条件触发的证据包」路线。外部论文结果均为作者报告，未在本地复现；本研究不授权数据清理或代码实施。
exploration_type: technical
tags: [memory, retrieval, recommendation, agentmemrec, vllm-gr, evaluation, index-hygiene, rrf, progressive-disclosure, local-hardware]
from: [R20260826rcmm, F20260717ctxf]
conclusion: >-
  把记忆读取理解为「候选召回—排序—集合组装」的推荐问题，但本地先做索引卫生和有效评测；只用现有机制标定参数，证据包仅在最终组装被证明是瓶颈时启动。不引入 vLLM-GR、本地重训练、第四记忆层或全量自动总结，保留 Agent 主动召回与渐进式披露。
created_in_conversation: f4402db8-9dee-4979-82b9-f0d46ed4f195
created_at: 2026-11-26
---

# Agent 记忆作为推荐系统：外部研究证据与本机可行优化路线

## 先说人话：这次研究到底决定了什么

**现在是什么。** Otter Buddy 已经有一个能用的记忆检索器：Agent 需要时主动调用 `search_memory`，系统用关键词和向量两路找候选，再按时间、使用频率、当前对话等信号排序，最后返回少量摘要；需要原文时再继续下钻。问题不是「完全没有检索」，而是我们还不能稳定回答：该找的证据究竟漏在哪一步。

**外部给了什么启发。** AgentMemRec 把这件事说得很直白：记忆读取像推荐系统，先把可能相关的候选找宽，再排序，最后在上下文预算内选出一组证据。评价重点不是「单条记忆像不像 query」，而是「回答问题需要的证据有没有全部进来」。vLLM-GR 则优化另一种事情：让生成式推荐模型更快地生成合法物品 ID；它并不替 Agent 做记忆去重、过期处理、互补证据覆盖或上下文组装。

**本地发现了什么。** 2026-11-25 的只读实测发现，向量索引里有大量已经找不到原始记忆的孤儿行，旧评测集的标准答案也大多已不在活库中。也就是说，在清理无效索引、重建有效考题之前，直接上学习排序或生成式召回，既无法证明收益，也不适合这台 2019 Intel Mac。

**最终怎么做。** 联合讨论收敛为四步：**Phase A 索引卫生 → Phase B 有效评测 → Phase C 现有参数标定 → Phase D 条件触发的证据包**。保留主动召回和渐进式披露；不做全量自动总结、第四记忆层、本地重模型训练或 GR。本文只记录研究结论，不执行清理，也不授权任何实现直接合入。

## 1. 研究范围与证据口径

### 1.1 研究问题

1. AgentMemRec 与 vLLM-GR 各自解决了什么，哪些概念能迁移到 Agent 记忆？
2. 当前 Otter Buddy 的真实瓶颈能否由外部论文直接推断？
3. 在 2019 Intel i9、32GB RAM、无 CUDA/Ascend 的本机上，哪条路线可执行、可验证、可回滚？

### 1.2 证据分层

| 层级 | 本文包含的内容 | 不能推出什么 |
|---|---|---|
| 外部一手来源 | arXiv 论文、vLLM-GR 官方 GitHub README/配置文档 | 论文作者报告不等于本地复现，也不等于适合本机 |
| 本机现场实测 | 2026-11-25 的 SQL/脚本只读复核与重复测速 | 活库快照不是常量；单次或小样本测速不保证长期收益 |
| 当前代码核对 | 本 worktree 中 FTS/Vec、RRF、重排、去重、配额与渐进披露实现 | 代码结构不能替代真实标注集上的效果评测 |
| 联合方案推演 | 大獭与 GLM 记忆方案獭的讨论、复核和最终共识 | 方案共识不等于效果已验证，更不等于实施授权 |

外部调研初稿与联合方案均来自本对话工作区：前者为 `agent-memory-research/2026-11-25-agent-memory-rec-vllm-gr.md`，后者为 `memory-optimization-final-plan.md`。本文把它们整理为可长期检索的研究记录；外部数字均未由本研究重新训练或复跑论文实验。

## 2. 当前系统：已有混合检索，不需要推翻重来

F20260717ctxf 已确定架构边界：记忆召回是 Agent 主动调用的工具，不是系统强制查询后注入。R20260826rcmm 又确定「评估基线 > 召回加固 > 提炼」，并否决自由写入通道、第四记忆层和无差别全量 dream。本文延续这两个决策。

本 worktree 只读核对到的当前读取链路如下：

```text
Agent 主动发起 search_memory
  → FTS5 候选 + bge-m3 Vec 候选
  → 加权 RRF 融合
  → 时间 / 频率 / 当前对话 / belief / superseded 等信号重排
  → 同源去重 + 文档层配额 + 最终 limit 截断
  → summary / snippet 返回
  → Agent 按需 get_memory_detail 或邻域扩展
```

关键现状：

- FTS 候选池默认上限为 50（`src/frameworks/db/memory/sqlite-memory-repository.ts:56`）；Vec 查询深度当前跟随最终 `query.limit`（`src/usecases/memory/search-memory.ts:509`、`:519`），因此两路候选池并不对称。
- 当前默认走 additive 重排，已有 RRF、时间、频率、用户标记、当前对话及 superseded/belief 等信号（`src/usecases/memory/search-engine.ts:96-104`、`:341-381`）。
- 最终结果仍经过去重、文档配额和固定条数截断（`src/usecases/memory/search-memory.ts:618`、`:703-731`）。
- 非 full 结果保留下钻入口（`src/usecases/memory/search-memory.ts:639-641`），chunk/message 还可做邻域扩展（同文件 `:312-350`）。这说明「渐进披露」已经是系统能力，不应被证据包优化收回。

因此，外部研究的价值主要是提供更好的**测量框架和阶段划分**，不是要求替换现有架构。

## 3. 外部主线一：AgentMemRec 把记忆读取拆成可定位的四阶段

来源：Xinyu Zhang、Weiwei Sun，*Agent Memory as Recommendation: Recommender-System Design for Long-Term Memory of LLM Agents*，arXiv:2610.34673（2026-10-26，v1）。

- 摘要与论文页：https://arxiv.org/abs/2610.34673
- HTML 全文：https://arxiv.org/html/2610.34673v1

### 3.1 四阶段设计空间

| 阶段 | 推荐系统类比 | 对 Agent 记忆的含义 |
|---|---|---|
| Memory construction | item 与侧信息构造 | 把历史映射为记忆单元、来源、时间、实体等信息 |
| Candidate generation | 候选召回 | 用 BM25、dense 等通道建立足够宽的候选池 |
| Memory ranking | 学习排序 | 给候选排序，让必要证据尽量靠前 |
| Context assembly / slate construction | 有预算的 slate | 在 token 预算内选出最终记忆集合，而非机械取 top-k |

这个分解把「记忆不好用」从一句体感变成可定位问题：候选池漏证据时，后级排序无法恢复；候选池完整而最终集合不完整时，才应优化排序或组装。

### 3.2 证据完整率：最值得迁移的指标

论文定义：

- `r_pool`：回答问题所需的全部 gold evidence 都进入候选池的概率；
- `r_rank`：在候选池已经完整的条件下，全部证据仍进入最终 slate 的条件概率；
- `r_slate = r_pool × r_rank`：最终上下文包含全部必要证据的完整率。

论文进一步用完整/不完整上下文上的平均回答奖励解释最终准确率。本地不必照搬其奖励公式，但应采用同一个归因原则：**分别测候选召回和最终返回，不能只看最终 QA 分数。**

这也直接解释了为什么「Vec 池从 10 加深到 50 几乎不增加扫描时间」仍不足以成为上线理由：更深的池会改变 RRF 输入和后续排序，必须同时看 `r_pool`、`r_slate`、nDCG/MRR 和分类型失败，不能把成本不变外推成排序一定更好。

### 3.3 作者实现与结果：有启发，但不是本地验收数字

论文的基础实现使用 BM25 + bge-m3、RRF 候选池 N=128、LightGBM LambdaRank 的 10 个低成本特征，以及 2700-token 预算内的贪心组装；默认路径不要求生成式 LLM 参与写入或选择。

作者报告：在 LongMemEval-S 中证据跨多个 session 的问题上，相对若干基线准确率提高约 10–31 个百分点，`r_pool=0.981`、`r_slate=0.94`，选择阶段 serving cost 相比每查询 64 次 LLM 调用的 reranker 低 3.2 倍。**这些全部是论文作者报告，本研究未复现。** 论文实验以长对话 QA 为主，也不能直接覆盖工具调用、软件协作和程序性经验等本地记忆类型。

两个反面约束同样重要：

- 监督排序使用开发问题的 gold evidence 标签；无 gold-label 版本也仍需训练或蒸馏流程，不是零成本配置项。
- near-miss filler 实验中，相似干扰会显著伤害回答；证据跨至少 3 个 session 时，作者报告 Qwen 下降 39.4 分。因此「填满 token 预算」不是普适目标，干扰惩罚必须与完整率一起测。

调研时论文页未见官方代码链接，按 AgentMemRec 名称也未定位到官方实现；本文不引用来源不明的第三方仓库冒充官方代码。

## 4. 外部主线二：vLLM-GR 优化生成合法 ID，不替代记忆集合后处理

官方来源：

- 仓库：https://github.com/vllm-project/vllm-gr
- README：https://github.com/vllm-project/vllm-gr/blob/main/README.md
- 配置文档：https://github.com/vllm-project/vllm-gr/blob/main/docs/configuration/README.md
- 相关系统论文：https://arxiv.org/abs/2611.23339

### 4.1 它实际优化什么

vLLM-GR 面向 generative recommendation：模型读取交互历史，通过 Beam Search 自回归生成物品的 Semantic IDs（SIDs）。官方列出的优化包括整个 Beam 只向 EngineCore 提交一次、BeamAttn 与共享 prompt KV cache、异步调度，以及 **on-device Beam postprocessing**。

这里的 on-device 后处理发生在 token/Beam 层：device kernel 应用 catalog constraints，过滤非法 SID continuation，并选择高分合法后续 token，避免每一步回 host。官方当前模型列表聚焦 OneRec-1.7B，「对给定候选集排序」在调研时仍标为 planned。

### 4.2 两种后处理不能混为一谈

| 维度 | vLLM-GR 的 Beam 后处理 | Agent 记忆需要的集合后处理 |
|---|---|---|
| 处理对象 | SID token、Beam、catalog 合法性 | 记忆条目及其来源、时间、状态和相互关系 |
| 典型规则 | 合法前缀、top-k continuation | 同源去重、superseded 降权、互补证据覆盖、冲突与干扰控制 |
| 预算语义 | Beam width / candidate / result count | 真实渲染 token、detail level、最终上下文预算 |
| 能保证什么 | 生成合法 catalog ID | 不自动保证记忆集合完整、正确、无重复或无过期信息 |

一种未来可研究的组合是把 GR 当作第三条候选通道：`GR memory SID + BM25 + dense → 融合 → 排序 → 集合后处理`。这是架构推演，不是上述论文已经验证的 Agent 记忆结论。新记忆冷启动、频繁 catalog 更新、SID 碰撞与记忆拆分合并后的稳定性都需要另行解决；验收也只能看相对现有混合检索的**增量 `r_pool`**。

## 5. 同期研究只保留三条辅助启示

为避免把调研写成名词清单，以下工作只用于校准评测原则，不进入近期实施路线：

| 工作 | 作者报告/核心观点 | 对本地路线的约束 |
|---|---|---|
| MemComposer（https://arxiv.org/abs/2610.21091） | 把选哪些经验、选几个、如何排序作为联合策略，以完整 Agent 任务结果训练 | 「相似度」不是最终目标；但 GRPO 式训练不属于本机近期方案 |
| Leto（https://arxiv.org/abs/2611.33005） | 用有/无记忆的结果差衡量价值，并保留 raw conversation source access；在线 utility index 是 serving heuristic | 保留原始证据入口，评测要有无记忆对照；弱反馈不能直接当因果贡献 |
| Memory Tax（https://arxiv.org/abs/2610.34073） | 复杂记忆构造可能带来 faithfulness/accessibility/robustness 税，raw history 联合召回是重要修补 | 新机制必须击败 raw-history hybrid RAG 基线，不能默认提炼越多越好 |

三者共同支持本文主线：**先测证据是否找全、是否有用，再决定是否增加模型或写入结构。**

## 6. 本机约束与现场证据

### 6.1 为什么不在本机引入 vLLM-GR 或重训练

本机为 2019 MacBook Pro：Intel i9-9880H（8 核 16 线程）、32GB RAM，Intel UHD 630 + AMD Radeon Pro 5500M 4GB；没有 CUDA，也没有 Ascend NPU，且不是 Apple Silicon。vLLM-GR 当前推理路径面向 CUDA/Ascend，因此不是「调低 batch 就能运行」的问题。

现有 bge-m3 通过 transformers.js + onnxruntime 在 CPU 上运行，默认 fp32，代码与方案记录模型约 2.27GB。向量推理需保持串行（`MAX_IN_FLIGHT=1`、默认 2 个 intra-op 线程）；历史上长文本并发曾触发 onnxruntime 死锁。短查询 embedding 约 230ms，长文本约 1–2 秒/条。再叠加 cross-encoder、第二个 embedding 模型、本地 LightGBM/GRPO 训练或 GR serving，会增加内存、延迟和稳定性负担，却没有当前数据证明其必要。

以上是本地硬件与既有运行记录，不是对论文系统在其他硬件上的性能否定。

### 6.2 2026-11-25 实测：先修测量地基

| 现场 | 实测结果 | 结论边界 |
|---|---|---|
| Vec 索引卫生 | `memory_vec` 152,936 行，其中 83,236 行没有对应 `memory_entries`，孤儿率 54.4% | 大獭独立只读复核；活库持续写入，数量会漂移，后续必须按一致性快照重算 |
| 旧 gold 存活 | 旧评测 829 个唯一 gold ID 中仅 25 个仍存活，存活率 3.0% | 旧召回分数不能再作为当前活库的可比基线 |
| Vec k=10 / k=50 | 各重复 5 次，中位耗时约 466ms / 450ms | 该快照下加深 k 未显示明显扫描成本增加；不能推出 recall、排序或端到端体验一定更好 |

孤儿形成根因尚未核实。`cascadeDeleteSatellites` 当前会在 `vecTableExists` 守卫下删除 Vec（`src/frameworks/db/memory/sqlite-memory-repository.ts:145-160`），但「历史上扩展不可用导致跳过删除」仍只是待查假说；也可能涉及更早的直接 SQL 清理或其他路径。不能把存量现象直接写成已证实根因。

同理，清理的固定提速数字不作承诺。主要正确性收益是移除无效扫描与恢复索引语义；实际延迟必须由同机、同快照、同查询的前后对照给出。

## 7. 联合讨论如何收敛

讨论不是把两份方案简单拼接，而是经过两轮校正：

1. **GLM 提出两个地基问题**：大量孤儿 Vec 使扫描带上死重量；旧 gold 大面积失效使历史评测失去意义。同时指出 Vec 池跟随最终 limit、与 FTS=50 不对称。
2. **大獭独立复核并补测速**：确认孤儿、gold 存活和 k=10/50 中位耗时；据此收紧「Vec 池 50 必须评测门控」，并修正单样本线性外推的提速表述。
3. **双方接受防复发约束**：一次性清理不等于根因修复，必须包含删除路径回归、成因核实与既有日报中的持续对账。
4. **最终共同路线**：索引卫生优先于有效评测，有效评测优先于参数标定；证据包只有在最终组装被证明是瓶颈时才启动。双方无悬置异议。

这条路线没有推翻 R20260826rcmm，而是把「先评估」进一步具体化：若索引和 gold 都已失效，必须先修复评估对象本身。

## 8. 最终方案：A → B → C → D

### Phase A：索引卫生与防复发

**目标**：让 Vec 索引与真实记忆重新对齐，并使同类问题可观测、可回归。

- 在一致性快照上统计总行数、孤儿数和孤儿率；使用相同查询向量测 k=10/20/50，多次记录中位数与 P95，同时记录完整 `search_memory` 延迟。
- 清理对象仅限「`memory_vec` 中不存在对应 `memory_entries`」的索引行，不删除原始消息、事实或文档。
- 实际维护顺序必须是：dry-run 报告 → SQLite 一致性备份 → 搭档批准删除 → 维护窗口 apply → 复跑审计与测速。本研究不执行其中任何删除。
- 核查所有删除路径与历史批量清理，补「删除记忆后 FTS/Vec/权重等卫星数据一致」的回归测试；根因未明时不宣称防复发已完成。
- 复用既有每日健康检查加入 Vec 孤儿率，不新增守护进程。GLM 提议的 >5% 进日报候选、>20% 告警只作为待观测初值，不是永久阈值。
- 不在线 VACUUM 主库；空间回收如有必要另立维护动作。

**验收**：清理快照孤儿为 0；删除路径回归通过；前后测速可复跑；后续观测无持续回升。

**回滚**：恢复一致性备份；审计与健康阈值可独立撤回。

### Phase B：重建有效评测

**目标**：在与当前数据一致的固定快照上，区分候选漏召回、排序压出与最终整理误伤。

- Phase A 后生成只读评测快照，避免活库写入导致结果漂移。
- 从 3761 条真实查询日志中分层抽取第一轮 20–30 条，覆盖跨对话追问、文档定位、当前对话优先、时间更新、多证据、无答案与易混淆问题；保留查询发生时最近 3–5 条上下文。
- 先修标注指南，再由两只獭独立盲标；目标 Kappa ≥0.6，达不到先修指南和复核分歧，不用分歧数据调参。搭档抽查约 10 条。
- 既有合成 golden 套件继续作为回归地板，但不能替代真实数据评测。
- 指标至少包括 recall@5/10、MRR、nDCG、`r_pool`、`r_slate`，并把 embedding、Vec 扫描和完整搜索延迟分开记录。
- 失败分类至少覆盖：关键词漏召回、向量漏召回、排序压出、去重/配额误伤、暗化缺失和标注问题。
- 保留无记忆与 raw-history hybrid RAG 对照；复杂机制必须证明相对简单基线的净收益。

**验收**：同一快照重复运行结果一致；标注指南与分歧记录齐全；形成可比较基线报告。

**回滚**：只读评测产物，无线上行为变更。

### Phase C：只标定现有旋钮

**前提**：只在 Phase B 的固定快照与失败分类上做受控实验。

候选项：

1. Vec fetch depth：10 / 20 / 50；不预设 50 一定更好。
2. message 时间半衰期：7 / 14 / 21 天，分别检查旧记忆被压下与旧事实复活。
3. 现有 additive 权重：RRF、时间、频率、当前对话加成与 `freqCap`。
4. 仅当失败分类证实时，单独调整去重或文档配额规则，不做全局大改。

查询 embedding 与候选列表缓存一次，参数网格只重放排序；全部离线、串行执行，不与实时搜索争抢 worker。

**采用门槛**：合成回归不退化；真实集 recall@10 / `r_pool` 不下降；nDCG@5 或 MRR 有稳定提升；延迟无明显回退；没有明确赢家就保留当前默认值。

**回滚**：恢复配置默认值，用回归测试锁定原行为。

### Phase D：条件触发的证据包，不预排期

只有 Phase B/C 反复显示「`r_pool` 已较高，但 `r_slate` 明显更低，主要失败来自最终截断/去重/配额」时才立项。

改动位置仍应是现有 `search_memory` 的最后整理步骤，不新增 Agent，不恢复强制注入，不收回 `get_memory_detail` 下钻权。可评估同源重复与邻域合并、新旧结论与 superseded 标注、多证据互补覆盖、摘要与原文入口保留、按实际上下文长度安排详略。

若主要瓶颈在候选池，Phase D 不做；否则它只会掩盖真正问题并增加维护成本。

## 9. 明确不做

- 不引入 vLLM-GR，不把生成式 SID 召回排入近期实施。
- 不新增本地 cross-encoder、LightGBM、GRPO 或第二个 embedding 模型，不做本地训练。
- 不提高向量推理并发，不改变现有 worker 串行约束。
- 不让系统定期把全部历史重新总结，不新增自由写入通道、第四记忆层或跨对话自动洞察。
- 不为了提速立即更换 ANN/HNSW；先清理并测量，活跃向量到约 20 万且全扫再次成为明确瓶颈时再评估。
- 不恢复系统自动注入记忆，不把渐进式披露改成一次性塞满上下文。

这些「不做」是当前证据与硬件约束下的范围决策，不是永久否定相关研究方向。

## 10. 风险、未决项与后续研究触发条件

### 10.1 风险与处置

| 风险 | 处置 |
|---|---|
| 活库变化使审计和评测漂移 | 一致性快照；运行指标只报告当时值 |
| 一次性清理后孤儿复发 | 删除路径回归 + 既有日报观测；根因未明不宣称修完 |
| 20–30 条小样本过拟合 | 保留独立合成回归；无稳定赢家不改默认 |
| Vec 池加深只改变排序、不改善证据完整 | Phase C A/B，同时看 `r_pool/r_slate` 与排序指标 |
| 放宽时间衰减使旧事实复活 | 时间更新类查询单独验收，superseded 状态继续参与 |
| 评测抢占本机资源 | 固定快照、串行 worker、缓存 embedding，不重复跑参数组合推理 |
| Vec 代际/CAS 机制已合入，后续实现仍可能与其冲突 | 实施前核对最新 main 与相关 PR，必要时 rebase 后再做 |

### 10.2 未决项

1. 83k 量级孤儿的历史根因是什么，是否有多条写入/删除路径共同贡献？
2. Phase A 后真实延迟收益有多大，P95 是否改善？当前不承诺固定毫秒数。
3. 新真实标注能否达到 Kappa ≥0.6；若不能，先修标注而非调参。
4. Vec k=50 是否带来增量 `r_pool`，以及其排序副作用是否值得接受？
5. AgentMemRec 的完整率分解在本地软件协作与工具调用记忆中是否同样解释任务结果？需要 Phase B 数据回答。
6. 外部论文结果均未本地复现，尤其不能把其准确率、成本比或 token 预算当本地目标值。

### 10.3 何时才重新研究重模型、GR 或 ANN

| 后续方向 | 必须同时/先满足的证据条件 |
|---|---|
| 轻量学习排序 | 已积累足量、质量合格的 query—evidence 标注；Phase C 已标定；失败主要发生在排序而非候选漏召回 |
| token-budget slate / 证据包 | `r_pool` 较高而 `r_slate` 持续显著更低，且失败可归因于最终组装；Phase D 单独方案与审视 |
| GR / SID 候选通道 | 运行硬件与 serving 栈真实可用；有足量训练数据；现有混合召回 `r_pool` 仍是瓶颈；小实验证明增量候选价值 |
| ANN/HNSW | 清理后活跃向量规模与全扫延迟再次成为明确瓶颈；迁移、索引维护和一致性成本有对照评估 |
| 更多写入端提炼 | raw-history hybrid RAG 与现有简单基线已被公平击败，且幻觉、来源可恢复性和成本均有验收方案 |

## 11. 结论

AgentMemRec 给本地最有价值的不是 LightGBM 或 2700-token 参数，而是**用 `r_pool/r_slate` 把记忆问题分阶段定位**；vLLM-GR 的价值在生成式推荐 serving，其 on-device Beam 后处理与记忆集合后处理不是同一层。同期研究进一步提醒：复杂记忆构造必须证明相对 raw history 的净收益，任务效用与原始证据可恢复性不能丢。

但本地现场把优先级说得更清楚：**54.4% 孤儿 Vec 与 3.0% 旧 gold 存活率先使上层优化失去可靠地基。** 因此最终路线不是「马上学习排序/GR」，而是：

```text
A 索引卫生与防复发
  → B 固定快照上的有效评测
    → C 现有检索与排序参数标定
      → D 仅由最终组装瓶颈触发的证据包
```

整条路线保留 F20260717ctxf 的主动召回与现有渐进披露，不引入本机无法承担或当前无证据支持的模型。每一阶段都有独立验收和回滚，后续实施仍需各自 PR、异体审视与必要的数据操作审批。

## 参考来源

### 内部决策与现场材料

- R20260826rcmm：《记忆系统优化设计方案（三獭对抗讨论终版）》——评估基线优先、召回加固、精益提炼及不做项。
- F20260717ctxf：《记忆召回改为主动工具调用》——主动召回架构边界。
- 本对话工作区 `agent-memory-research/2026-11-25-agent-memory-rec-vllm-gr.md`——外部调研初稿与原始链接。
- 本对话工作区 `memory-optimization-final-plan.md`——大獭 + GLM 联合共识、本机硬件与 2026-11-25 实测记录。
- 本 worktree 当前代码：`src/usecases/memory/search-memory.ts`、`src/usecases/memory/search-engine.ts`、`src/frameworks/db/memory/sqlite-memory-repository.ts`（只读核对）。

### 外部一手来源

- AgentMemRec：https://arxiv.org/abs/2610.34673
- vLLM-GR 官方仓库：https://github.com/vllm-project/vllm-gr
- vLLM-GR 相关系统论文：https://arxiv.org/abs/2611.23339
- MemComposer：https://arxiv.org/abs/2610.21091
- Leto：https://arxiv.org/abs/2611.33005
- Memory Tax：https://arxiv.org/abs/2610.34073
