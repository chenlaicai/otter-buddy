---
id: F20261119rlval
title: 记忆检索排序 Phase 1 段 4：真实查询盲标验收与 additive 默认切换
doc_type: feature
summary: |
  承接记忆检索排序 Phase 1 前三段，兑现切默认前的真实数据抽查：从生产检索日志的近期非锚点查询中固定哈希抽样 20 条，分别跑 multiply/additive，合并双算法 top-10 候选、乱序隐藏来源，由独立异体完成 0–3 级相关性盲标。FTS-only 与本机 bge-m3 混合召回两条路径的 nDCG@5、nDCG@10、MRR 均优于旧默认，故把应用配置缺省切为 additive，保留显式 multiply 回退；新增离线复跑台架，生产原始查询与标注只存本机工作区。
change_type: feature
intent:
  problem: "Phase 1 前三段已交付加法路径、贡献分量与合成集网格标定，但合成集存在时间信号反向激励，不能据此切换生产默认；需要真实查询、独立盲标与可复跑对比证明 additive 在实际语料和召回路径上不劣于 multiply"
  expected_effect: "20 条真实查询在 FTS-only 与混合召回两口径下完成双算法 pooled 盲标，三项排序指标均高于 multiply 对照；应用缺省 rerankMode 切为 additive，配置示例与 golden 地板同步，显式 multiply 保留兼容回退"
  verify_by:
    type: behavior_check
    note: "离线真实集两口径双表 + 独立盲标结构校验 + golden 默认/回退双路径 + 配置与 memory 测试；原始数据仅使用数据库副本，不进入 git"
capability_test: "tests/usecases/memory/golden-eval.test.ts"
created_at: 2026-11-19
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
causal_links:
  from: [F20261118grcal, F20261112arlxv, F20261112rnkph, F20261008mrrk]
  supersedes: []
tags: [memory, retrieval, ranking, rerank, real-evaluation, blind-labeling, additive]
modules:
  - src/frameworks/config-service.ts
  - src/usecases/memory/search-engine.ts
  - src/usecases/memory/search-memory.ts
  - config/config.yaml.example
  - tests/frameworks/config-service.test.ts
  - tests/usecases/memory/golden-eval.test.ts
  - tests/usecases/memory/real-rerank.eval.ts
  - vitest.real-eval.config.ts
  - package.json
---

# 记忆检索排序 Phase 1 段 4：真实查询盲标验收与 additive 默认切换

## 1. 范围与前置核验

本段只做真实数据验收、可复跑台架与默认切换，不改 RRF、归一化公式或系数。

- 前三段分别由已合入实现交付：加法路径、debug 分量、合成集网格标定；对应 worktree 和分支已清理。
- 开工前无段 4 的 open PR、分支或其他对话认领。相关旧文档 PR 只修改另一份语料边界文档，与本 PR 文件域不相交。
- 段 4 残留原因不是实现遗漏：段 3 明确把真实数据抽查设为切默认前置；本次搭档指令「如果没有，那你就接手开始做」解除排期等待，选择真实抽查路径而非合成集风险豁免。

## 2. 真实集抽样与盲标协议

数据源为只读生产 `search_query_logs` 的一致数据库副本，副本时间约 2026-11-19 20:08（Asia/Shanghai）。任何检索计数回写只发生在副本。

抽样规则在查看指标前固定：

1. 2026-11-01 起、历史返回数 ≥5、全库查询；剔除会触发 F/R 锚点短路的查询，因为该路径不经过本次 rerank 对比。
2. 查询文本归一化去重；同一对话最多两条，避免单一任务线淹没样本。
3. 按 queryId 的 SHA-256 排序，顺序取样本；当前快照候选少于两条时无排序可比，在盲标前剔除并顺序补样，不按指标挑样。
4. 最终 20 条查询。multiply 与 additive 各跑 top-10，合并去重；候选按 queryId+entryId 哈希乱序，隐藏算法来源、排名和分数。
5. 独立 DeepSeek 标注员逐条读查询、查询前上下文和候选正文，按 0=不相关、1=背景、2=强相关、3=核心答案标级。0 分也显式写出；键集必须完整覆盖候选，禁止池外 ID。
6. 混合召回复用完全相同的 20 查询；已有候选复用盲标，仅新增候选补盲标。原始查询、上下文、正文和标签均只落本机工作区，不进仓库。

 pooled 标注的已知边界：它公平比较双算法 top-10 内的相对排序，但不能发现两个算法都未召回的池外理想条目；因此本结论用于段 4 相对比较，不宣称全库绝对召回率。

## 3. 验收结果

### FTS-only（20 查询，268 候选标签）

| 模式 | nDCG@5 | nDCG@10 | MRR |
|---|---:|---:|---:|
| multiply 旧默认 | 0.5049 | 0.5934 | 0.8267 |
| additive | **0.7168** | **0.8123** | **0.9083** |

### bge-m3 混合召回（同 20 查询，263 候选标签）

| 模式 | nDCG@5 | nDCG@10 | MRR |
|---|---:|---:|---:|
| multiply 旧默认 | 0.5117 | 0.6064 | 0.8267 |
| additive | **0.7107** | **0.8130** | **0.9333** |

两条路径三项均高于旧默认，满足实施规格「真实标注集三项不劣于生产默认」门槛。逐查询 nDCG@5 在两口径下均为 18 条更好、2 条更差；不是无差别全胜，结论只声明聚合门槛成立。系数保留设计回填 `0.6/0.3/0.1` 与偏置 `0.05/0.05`，没有采用合成集网格顶格的「时间权重为 0」候选。

## 4. 实现与兼容

- `config-service.ts`：应用缺省 `memory.rerankMode` 从 `multiply` 改为 `additive`。
- `config.yaml.example`：说明新缺省与显式 `multiply` 回退；系数示例与生产缺省一致。
- `golden-eval.test.ts`：生产默认配置改 additive，地板重锁为 0.776/0.790/0.908；新增显式 multiply 回退用例，精确锁旧值 0.6732/0.7079/0.8114；全中性化反事实不变。
- `real-rerank.eval.ts` + 独立 vitest config + `npm run eval:real`：提供抽样、盲标池导出、同查询混合召回重跑、标签结构校验和三项指标复算。它不是默认测试套件成员，也不读取或写入在线生产库。

底层 `SearchEngine` 与 `config-service` 的缺省统一切为 additive，避免直接构造与应用配置分叉；两条路径均保留显式 `multiply` 回退。

## 5. 设计取舍与失效处置

- **谁需要该机制**：后续修改排序信号或系数的人需要真实集复跑台架；普通检索调用方无需感知标注细节。
- **机制失败的用户可感知后果**：缺数据库副本或标签时 eval 明确失败，不影响生产检索；若错误切换造成排序回归，用户会看到历史/相关记忆排位异常。
- **状态出错后的处理**：标签键集不完整、池外 ID、非 0–3 整数均 fail-closed；生产配置可显式设 `rerankMode: multiply` 立即回退，无需数据迁移。
- **退役条件**：若未来建成持续更新、隐私合规且覆盖池外理想条目的真实基准，可替换本次固定快照 pooled 台架；multiply 只有在明确结束兼容期后才可删除，本段不删除。

## 6. 验证与回滚

- 真实集 FTS-only 与混合召回指标见 §3；标签机械校验分别为 268/268、263/263，20 个 queryId 唯一且键集完整。
- `npm run eval:golden`：9/9；默认 additive 实测 0.7769/0.7906/0.9085，全中性化反事实 0.7998/0.8029/0.9364，显式 multiply 旧值不变。
- memory/config 目标测试 138/138；TypeScript 与目标 ESLint 通过。
- 无 schema 迁移、无在线 DB 写入、无一次性脚本。代码回滚用 `git revert <merge-commit>`；运行时回退只需配置 `memory.rerankMode: multiply`。

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 大獭
