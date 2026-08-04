# Documentation

项目文档库。`features/` 存特性文档（F），`research/` 存研究文档（R）。

## 硬规则（启动时校验器强制，违反不入库）

这些规则在 `src/entities/document/frontmatter-validator.ts` 编码，启动 sync 时强制校验。**文档创建时就要看到它们**——否则写完跑 sync 才知道违规，反馈延迟到运行时。

### 必填 frontmatter 字段

| 字段 | 约束 |
|------|------|
| `id` | 格式 `F\d{8}[a-z0-9]{3,8}`（feature）/ `R\d{8}[a-z0-9]{3,8}`（research）。8 位日期 = 创建日期（YYYYMMDD）。后缀 3-8 位小写字母数字。 |
| `title` | 非空、非纯空格。建议 kebab-case，与文件名后半段对齐 |
| `summary` | **1-500 字符**。投影用途：卡片渲染、检索摘要、token 效率。详细内容写进 body，不要塞 summary |

### 路径格式（ID 中的日期与目录必须对应）

```
docs/features/YYYY/MM/DD/F<date><suffix>-<slug>.md
docs/research/YYYY/MM/DD/R<date><suffix>-<slug>.md
```

ID `F20260803emlo` → 必须 `docs/features/2026/08/03/F20260803emlo-*.md`。
ID `R20260716x2k9` → 必须 `docs/research/2026/07/16/R20260716x2k9-*.md`。

### 软警告（不阻断入库，进 health 端点 warnings）

`status`、`change_type`、`exploration_type` 的未知值不阻断，但会被校验器记入 warnings。已知值见 `src/entities/document/known-values.ts`。

### supersedes 前缀

`supersedes` 数组里每个 ID 前缀必须与本文档类型一致（F 文档只能 supersede F，R 文档只能 supersede R）。

## 反例（这些会进 reconcileGaps）

```yaml
# ❌ summary 太长
summary: |
  修复 bge-m3 embedding 模型加载失败导致 memory_vec 表永远 0 行的缺陷。
  根因是双层 bug 叠加：embedding-service.ts 把传入的 embedConfig 参数命名为 _embedConfig
  直接丢弃...（1200 字）             # 全部塞进 summary，应该挪到 body
```

```yaml
# ❌ 路径与 ID 日期不匹配
# 文件在 docs/research/R20260716x2k9-*.md（扁平）
# 但 ID 是 R20260716x2k9，期望 docs/research/2026/07/16/R20260716x2k9-*.md
```

```yaml
# ❌ 完全没写 frontmatter（只有 # Title）
# parseFrontmatterFromContent 抛 "Missing frontmatter"，sync errors
```

## summary 怎么写（蒸馏模板）

500 字以内，回答三问，**剩下挪 body**：

1. **是什么**：一句话说改动是什么（"重建 X"、"修复 Y"）
2. **为什么**：核心动机 / 根因（一个最关键的，不要列全）
3. **怎么做**：主机制（一句话），不要展开验证细节

详细根因分析、修复方案分点、验证命令、对抗审视记录——全部写进 body 对应章节。

## 模板

```markdown
---
id: F20260804xxxx
title: kebab-case-title
doc_type: feature          # 信息性字段，validator 不校验；用于区分 feature/research

summary: |
  一句话说改动是什么。
  核心动机 / 根因（最关键的一条）。
  主机制（一句话）。

causal_links:
  from:
    - F20260803xxxx   # 因果上游（sync 读取，存入 DB metadata）
  to:
    - F20260805xxxx   # 文档约定，系统不自动维护反向引用；可空

status: development      # draft / proposed / design / development / locked / final / implemented / archived
change_type: feature     # feature / refactor / fix / prompt / feature-update
tags: [area, concept]
modules:
  - src/path/to/file.ts
---

# F20260804xxxx: 标题

## 详细内容（根因、方案、验证、对抗审视记录写这里）
...
```
