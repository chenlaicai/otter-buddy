---
id: F20260721x7k3
title: docs-format-sync
doc_type: feature

# 记忆索引
summary: |
  统一所有文档格式，同步最新的 frontmatter 规范。
  将 42 个文档（40 feature + 2 research）转换为 YAML frontmatter 格式，
  支持 doc_type、summary、causal_links 等新字段。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260721qh74   # 文档数据模型设计

# 元数据
status: development
change_type: refactor
tags: [documentation, frontmatter, format, memory-index]
modules: [docs/]

# 时间
created_at: 2026-07-21
---

# F20260721x7k3 - 文档格式统一与规范化

## 1. 需求背景

### 1.1 问题陈述

基于 [F20260721qh74](F20260721qh74-document-data-model.md) 定义的文档数据模型规范，当前文档体系存在以下格式问题：

| 问题 | 描述 | 影响 |
|------|------|------|
| **格式不统一** | 存在三种格式：YAML frontmatter（旧）、Markdown 元信息、无元数据 | 无法程序化解析 |
| **字段缺失** | 缺少 `doc_type`、`summary`、`causal_links` 等新字段 | 记忆系统无法索引 |
| **编号不规范** | Research 文件使用描述性名称，未遵循 `R{YYYYMMDD}{random4}` 格式 | 无法通过 ID 前缀区分类型 |
| **引用不一致** | 文件重命名后引用可能断裂 | 链接失效 |

### 1.2 设计目标

1. 将所有文档统一为 YAML frontmatter 格式
2. 补充 `doc_type`、`summary`、`causal_links` 等必需字段
3. 重命名 Research 文件为标准编号格式
4. 更新所有文档间的引用链接

---

## 2. 设计方案

### 2.1 格式转换规则

**从旧 YAML 格式转换**：
```yaml
# 旧格式
---
id: F20260709p4q7
title: data-model-design
from_ids: [F20260709x7k3, F20260709m2n8]
tags: [data-model, design]
modules: [data-model]
doc_kind: spec
status: locked
created_at: 2026-07-09
---

# 新格式
---
id: F20260709p4q7
title: data-model-design
doc_type: feature

summary: |
  设计 SQLite 数据库 Schema、Repository 接口、记忆存储映射。
  基于产品形态定义和能力模块架构，建立数据模型基础。

causal_links:
  from:
    - F20260709x7k3
    - F20260709m2n8

status: locked
change_type: feature
tags: [data-model, design]
modules: [data-model]
created_at: 2026-07-09
---
```

**字段映射**：
| 旧字段 | 新字段 | 说明 |
|--------|--------|------|
| `from_ids` | `causal_links.from` | 正向依赖链路 |
| `doc_kind` | `doc_type` | spec→feature |
| 无 | `summary` | 新增，用于记忆索引 |
| 无 | `doc_type` | 新增，区分文档类型 |

### 2.2 Research 文件重命名

**命名规范**：
```
R{YYYYMMDD}{random4}-{descriptive-name}.md
```

**本次重命名**：
| 旧文件名 | 新文件名 | ID |
|---------|---------|-----|
| `pi-capability-analysis.md` | `R20260716x2k9-pi-capability-analysis.md` | R20260716x2k9 |
| `pi-integration-analysis.md` | `R20260717y3k8-pi-integration-analysis.md` | R20260717y3k8 |

**引用更新策略**：
- 使用 `find` + `sed` 批量替换所有引用
- 验证无旧引用残留

### 2.3 Summary 字段规范

**要求**：
- 长度：1-500 字符
- 内容：概括文档核心内容，用于记忆索引匹配
- 格式：多行文本，使用 `|` 语法

**示例**：
```yaml
summary: |
  将 KeyFact 合并到 LinkedResource，统一制品模型。
  消除三层记忆架构的复杂性，简化为两层，降低 Agent 认知负担。
```

---

## 3. 实现方案

### 3.1 批量转换脚本

**脚本功能**：
1. 检测文档当前格式（YAML/Markdown/无元数据）
2. 提取现有字段（id、title、status、tags 等）
3. 生成新的 YAML frontmatter
4. 保留正文内容不变
5. 自动提取 summary（从正文前 150 字符）

**执行流程**：
```bash
# 1. 创建 worktree
git worktree add .claude/worktrees/docs-update -b docs/format-sync origin/main

# 2. 运行转换脚本
bash convert-docs-v2.sh

# 3. 手动优化 summary 字段
# 4. 提交并创建 PR
```

### 3.2 文件重命名流程

**步骤**：
1. 创建独立 worktree
2. 重命名文件（`mv`）
3. 批量更新引用（`find` + `sed`）
4. 验证无旧引用残留
5. 提交并创建 PR

**验证命令**：
```bash
# 检查是否还有旧引用
grep -r "pi-capability-analysis" docs/**/*.md | grep -v "R20260716x2k9" | wc -l  # 应为 0
grep -r "pi-integration-analysis" docs/**/*.md | grep -v "R20260717y3k8" | wc -l  # 应为 0
```

---

## 4. 涉及文件

### 4.1 PR #58: 文档格式统一

| 类型 | 数量 | 说明 |
|------|------|------|
| Feature 文档 | 40 | 转换为新 YAML frontmatter 格式 |
| Research 文档 | 2 | 添加 YAML frontmatter |

**关键文件**：
- `docs/features/**/*.md`（40 个文件）
- `docs/research/*.md`（2 个文件）

### 4.2 PR #59: Research 文件重命名

| 类型 | 数量 | 说明 |
|------|------|------|
| 重命名文件 | 2 | 改为标准编号格式 |
| 更新引用 | 6 | 修复文件引用链接 |

**重命名文件**：
- `docs/research/R20260716x2k9-pi-capability-analysis.md`
- `docs/research/R20260717y3k8-pi-integration-analysis.md`

**更新引用的文件**：
- `F20260715f4k9-frameworks-layer-implementation.md`
- `F20260715k4p2-frameworks-layer-implementation.md`
- `F20260716i5n2.md`
- `F20260716sq6e-pi-agent-core-vs-coding-agent.md`
- `F20260716t2ab-tool-skill-mechanism.md`
- `F20260716zq9q-conversation-session-architecture.md`

---

## 5. 验证清单

### 5.1 格式验证

- [x] 所有文档都有 YAML frontmatter（以 `---` 开始和结束）
- [x] 所有文档都有 `doc_type` 字段（feature 或 research）
- [x] 所有文档都有 `summary` 字段（1-500 字符）
- [x] Feature 文档有 `change_type` 字段
- [x] Research 文档有 `exploration_type` 字段

### 5.2 编号验证

- [x] Feature 文档 ID 格式：`F{YYYYMMDD}{random4}`
- [x] Research 文档 ID 格式：`R{YYYYMMDD}{random4}`
- [x] Research 文件名格式：`R{YYYYMMDD}{random4}-{name}.md`

### 5.3 引用验证

- [x] 所有 `causal_links.from` 中的 ID 都存在对应文档
- [x] 所有文件间引用链接都指向正确的文件路径
- [x] 无旧文件名残留引用

### 5.4 内容验证

- [x] 正文内容完整保留，无丢失
- [x] Summary 字段准确概括文档核心内容
- [x] 元数据字段（status、tags、modules 等）正确迁移

---

## 6. 关联文档

- **文档数据模型设计**：[F20260721qh74](F20260721qh74-document-data-model.md)
- **Pi Agent 能力探索**：[R20260716x2k9](../../research/R20260716x2k9-pi-capability-analysis.md)
- **Pi 集成方式对比**：[R20260717y3k8](../../research/R20260717y3k8-pi-integration-analysis.md)

---

## 7. 偏差记录

无偏差。
