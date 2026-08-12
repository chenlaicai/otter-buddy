# Documentation

项目文档库。`features/` 存特性文档（F），`research/` 存研究文档（R）。

## 硬规则（启动时校验器强制，违反不入库）

这些规则在 `src/entities/document/frontmatter-validator.ts` 编码，启动 sync 时强制校验。**文档创建时就要看到它们**——否则写完跑 sync 才知道违规，反馈延迟到运行时。

### 必填 frontmatter 字段

| 字段 | 约束 |
|------|------|
| `id` | 格式 `F\d{8}[a-z0-9]{4}`（feature）/ `R\d{8}[a-z0-9]{4}`（research）。8 位日期 = 创建日期（YYYYMMDD）。后缀 4-10 位小写字母数字（4 位推荐，放宽兼容历史）。 |
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

### 能力测试约定（F20260806tstr Part 5，lint-capability-docs.mjs 校验）

`change_type` 为 `feature` 或 `prompt` 的 F 文档，frontmatter 应声明 `capability_test`：

```yaml
change_type: feature
capability_test: tests/capability/xxx.capability.test.ts   # 指向能力测试用例
# 或
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
```

判别标准：**改动是否涉及 LLM 参与的行为**（prompt/skill/工具选择/协议遵从等 B 类行为）。
涉及就必须有能力测试（真系统 + 真 LLM 验证）；纯软件边界内的代码逻辑（A 类）声明 n/a 即可。
缺字段警告（过渡期）、路径不存在报错。

**与 Acceptance Test 的关系**：`capability_test` frontmatter 指向能力测试文件，`## Acceptance Test` 章节定义验收场景和证据判定。两者配合使用：
- `## Acceptance Test` 定义"什么算解决了"（需求推导 + 权威证据 + 验收场景）
- `capability_test` 指向"怎么验证"（能力测试用例）
- 验收执行后，`## Acceptance Test` 的证据判定表格记录结果

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

## Acceptance Test 怎么写

**核心问题**：本特性合入后，如何证明问题真正被解决了？

### 需求推导
从问题描述推导出具体可验证的需求。不要写"代码能跑"，要写"问题不再发生"。

示例（退化输出问题）：
- 需求1：退化发生时 guard 能检测并 abort
- 需求2：session 清洗后可正常加载
- 需求3：>120s 静默触发超时

### 权威证据
为每个需求定义"什么能证明它被满足了"。证据类型：
- **文件内容**：日志、session 文件、配置文件
- **命令输出**：CLI 命令返回、API 响应
- **运行时状态**：服务状态、内存状态、DB 记录
- **测试结果**：单元测试、能力测试、集成测试

### 验收场景
把需求转化为可执行的复现步骤。每一步都要具体到可自动化执行。

### 能力测试映射
每个验收场景对应一个能力测试用例文件。能力测试使用真系统 + 真 LLM，不是 mock。

### 证据判定（Codex Completion Audit 风格）
验收执行后，按以下标准判定证据质量：

| 证据状态 | 含义 | 判定 |
|---------|------|------|
| 证明完成 | 测试通过 + 行为符合预期 | ✅ |
| 矛盾 | 测试通过但行为不符合预期 | ❌ |
| 未完成 | 测试失败 | ❌ |
| 证据不足 | 测试存在但覆盖不全 | ❓ |
| 缺失 | 测试不存在 | ❌ |

**原则**：不确定的证据 = 未达成。

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
    - F20260803m9q2   # 因果上游（sync 读取，存入 DB metadata）

status: development      # draft / proposed / design / development / locked / final / implemented / archived
change_type: feature     # feature / refactor / fix / prompt / feature-update
tags: [area, concept]
modules:
  - src/path/to/file.ts
capability_test: tests/capability/xxx.capability.test.ts   # 指向能力测试用例（见下方验收标准章节）
---

# F20260804x7k3: 标题

## 背景与需求

### 问题描述
[需求分析阶段填写]

### 根因分析
[需求分析阶段填写]

### 数据实锤
[需求分析阶段填写]

## 方案设计

### 技术方案
[方案设计阶段填写]

### 目标
- T1: ...
- T2: ...

### 成功标准
[方案设计阶段填写]

## 验收标准

### 验收场景
| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | [需求1] | [具体步骤] | [可验证的结果] |
| AT-2 | [需求2] | [具体步骤] | [可验证的结果] |

### 能力测试映射
| 验收场景 | 能力测试文件 |
|---------|-------------|
| AT-1 | tests/capability/xxx.capability.test.ts |

## 实现细节

### 代码修改
[实现阶段填写]

### 逻辑变更
[实现阶段填写]

### 改动范围
| 文件 | 操作 | 说明 |
|------|------|------|
| src/xxx.ts | 修改 | xxx |

## 验收结果

### 测试结果
[验收阶段填写]

### 证据判定
| 需求 | 证据状态 | 判定 |
|------|---------|------|
| [需求1] | 证明完成 / 矛盾 / 未完成 / 证据不足 / 缺失 | ✅ / ❓ / ❌ |

## 对抗审视记录
[审视阶段填写]

## 设计决策
[可选，记录关键选择的 rationale]

