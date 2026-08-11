---
id: F20260805hybr
title: 混合搜索融合策略升级
type: feature
status: review
created: 2026-08-05
updated: 2026-08-05
authors:
  - orca
tags:
  - memory
  - search
  - rrf
  - jieba
summary: "使用三阶段RRF融合策略和jieba分词，解决Vec低质量结果污染和中文短查询支持问题"
---

# F20260805hybrid-search-fusion: 混合搜索融合策略升级

## 问题

搜索"梁山伯"返回不相关结果（"继续"、"开始"、"放到～/ai/dongbeicun下"），FTS 的 18 条正确结果被 Vec 低质量结果挤掉。

**根因**：RRF 只用排名位置不用分数值，Vec 对中文短文本语义区分能力不足时，低相关性结果会因排名靠前而污染最终结果。

## 解决方案：三阶段融合策略

参考业界实践（Weaviate alpha 参数、Elasticsearch RRF），设计三阶段融合：

### 阶段 1：Vec 质量门控
- 将 cosine distance 转换为 similarity：`similarity = 1 - distance`
- 过滤掉 `similarity < vecSimilarityThreshold`（默认 0.3）的结果
- 过滤掉"继续"、"开始"等与查询语义不相关的结果

### 阶段 2：加权 RRF 融合
- 引入 `alpha` 参数控制 FTS 和 Vec 的权重
- `alpha = 0.4`（默认）：偏信任 FTS 精确匹配
- `ftsWeight = 1 - alpha = 0.6`，`vecWeight = alpha = 0.4`

### 阶段 3：一致性加权
- 如果 FTS 和 Vec 都命中同一个 entry（source="both"），分数乘以 `bothBoost`（默认 1.2）
- 奖励两路一致的结果，提高置信度

## 配置参数（架构师决策）

| 参数 | 默认值 | 说明 |
|------|--------|------|
| alpha | 0.4 | Vec 权重，0=纯 FTS，1=纯 Vec |
| vecSimilarityThreshold | 0.3 | Vec 相似度阈值，低于此值被过滤 |
| bothBoost | 1.2 | 两路命中加成系数 |

**决策理由**：
- alpha = 0.4：中文场景下 FTS 精确匹配更可靠，偏信任 FTS
- vecSimilarityThreshold = 0.3：保守策略，避免误杀语义相关内容
- bothBoost = 1.2：轻微加成，不影响大局

## 修改文件

1. `src/usecases/memory/search-engine.ts` - 核心算法，三阶段融合逻辑
2. `src/frameworks/config-service.ts` - 配置系统，添加新参数
3. `tests/usecases/memory/search-engine.test.ts` - 单元测试，覆盖新功能
4. `tests/usecases/memory/search-memory.test.ts` - 集成测试，混合搜索场景
5. `tests/usecases/memory/manage-terminology.test.ts` - 更新配置

## 验证结果

### 修改前
```
搜索"梁山伯" → 返回全是 vec 结果（"继续"、"开始"、"放到～/ai/dongbeicun下"）
FTS 的 18 条正确结果完全丢失
```

### 修改后
```
搜索"梁山伯" → 返回全是 fts 结果（正确的梁山伯话剧内容）
不再有低质量 vec 结果污染
```

### 功能测试

| 场景 | 查询 | 结果 | 说明 |
|------|------|------|------|
| 1 | 梁山伯 | ✅ | 返回正确的梁山伯话剧内容 |
| 2 | 记忆系统 | ✅ | 返回记忆系统相关设计文档 |
| 3 | UI设计 | ✅ | 返回 UI 设计相关的用户意图锚 |
| 4 | Agent | ✅ | 返回 Agent 框架相关文档 |

## 测试覆盖

### 单元测试
- 15 个测试用例，覆盖 alpha 权重、vecSimilarityThreshold 门控、bothBoost 加成

### 集成测试
- 17 个测试用例，覆盖 FTS 高质量 + Vec 低质量场景、Vec 高质量结果保留场景

### 功能测试

| 场景 | 查询 | 结果 | 说明 |
|------|------|------|------|
| 1 | 梁山伯 | ✅ | 返回正确的梁山伯话剧内容，不再有不相关结果 |
| 2 | 记忆系统 | ✅ | 返回记忆系统相关设计文档 |
| 3 | UI设计 | ✅ | 返回 UI 设计相关文档 |
| 4 | Agent | ✅ | 返回 Agent 框架相关文档 |
| 5 | chunk | ✅ | 返回 feature_chunk 类型内容 |
| 6 | circuit breaker | ✅ | 返回相关特性文档 |
| 7 | 渐进式披露 | ✅ | 返回相关设计文档 |

### 渐进式披露召回机制

| detail_level | 结果 | 说明 |
|--------------|------|------|
| snippet | ✅ | 返回带高亮标记的片段（`<b>` 标签） |
| summary | ✅ | 返回首句 |
| full | ✅ | 返回完整内容 |

### 对话历史搜索

| 场景 | 查询 | layer | 结果 | 说明 |
|------|------|-------|------|------|
| 1 | 梁山伯 | working | ✅ | 返回 message 类型内容 |
| 2 | chunk | document | ✅ | 返回 feature_chunk 类型内容 |

### 库选择

| library | 结果 | 说明 |
|---------|------|------|
| conversation | ✅ | 返回对话库内容 |
| terminology | ✅ | 返回术语库内容 |

### 内容类型过滤

| content_type | 结果 | 说明 |
|--------------|------|------|
| feature_chunk | ✅ | 返回 chunk 内容 |
| feature | ✅ | 返回 summary 内容 |

### 已修复

- trigram tokenizer 对2字符中文支持有限（如"海獭"无法匹配）
- 解决方案：使用 jieba 对中文内容进行预分词，存储到 memory_fts_jieba 表
- 优点：支持任意长度中文查询，分词质量高，使用 FTS 索引查询速度快
- 验证：搜索"海獭"、"大獭"、"小獭"现在可以正常返回结果

## 相关 PR

- #150: feat(memory): 混合搜索融合策略升级 - 三阶段 RRF 融合
