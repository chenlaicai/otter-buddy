---
id: F202609025itn
title: '检索 summary 空投影修复：首句提取源从 FTS 窗口改为原文，content/snippet 语义分离'
doc_type: feature
summary: |
  修复 #542：search_memory summary 模式 40% 条目 content 投影为 `.`/`\n`/`2.` 单字符。
  根因：buildSnippet 的首句提取源是 FTS 匹配窗口（从文档中部开始、带 `...` 前缀），
  窗口起点即遇句末标点/换行时首句正则匹配出单字符——非随机偶发，是深匹配条目的必然。
  修复：summary content 恒为原文首句（数字感知正则），FTS 窗口归 snippet 字段；
  同步修齐 anchor 短路与邻域扩展两处 content:"" 投影点，DTO 层停止二次覆盖。
  回归：4 个确定性测试（基线 4 failed → 修复后 35/35），全量 2790/2790 通过。

causal_links:
  from:
    - F20260807snip   # 渐进式披露引入 summary 首句提取
    - F20260827mpcg   # #509 入库层防线（保留），本 issue 修正其关闭结论
  references:
    - "#542"
    - "#509"
    - "#519"

status: final
change_type: fix
tags: [memory, retrieval, progressive-disclosure, summary, projection, bugfix]
modules:
  - src/usecases/memory/search-memory.ts
  - src/interface-adapters/http/dto/memory-dto.ts
created_in_conversation: a56c349e-c566-438c-97d0-653a260171ed
capability_test: "n/a: 投影层修复，行为由 usecase 层确定性回归测试覆盖（tests/usecases/memory/search-memory.test.ts）"
---

# F202609025itn: 检索 summary 空投影修复

## 现象（#542，2026-08-28 起连续 5 日实证）

两次 `search_memory`（query 不同、detail_level 不同）命中**同一 entry**，content 完全不同：

| entry | summary 模式 | snippet 模式 |
|---|---|---|
| 707ac5c3 | `\n` | 完整匹配片段 |
| 7bb57538 | `.` | `📜 记忆溯源：…`（完整） |
| 5edc1cd2（heading `2.2 方案`） | `2.` | 完整 |

summary 模式 30 条中 12 条（40%）content 为空/单字符；feature_chunk 重灾区（char_count 1500+ → content=`.`）。9/2 干净 session 首轮复现 4/10——排除会话状态污染，连续 5 日无衰减。

## 根因

**首句提取源错误**：`buildSnippet` summary 分支从 **FTS 匹配窗口**提取首句，而非条目原文：

```
content（原文）：……铺垫铺垫铺垫 [匹配词] ……
FTS 窗口（extractSnippet）：start = max(0, 匹配位置-100)，带 `...` 前后缀
旧首句正则：^[^\n\p{Sentence_Terminal}]*[\p{Sentence_Terminal}\n]?  从窗口头部提取
```

- 匹配词在 100+ 字符后 → 窗口带 `...` 前缀 → 正则匹配 0 个非终止符 + `.` → **content=`.`**（长文档 chunk 深匹配高发，40% 的来源）
- 窗口恰以换行开头 → **content=`\n`**（9/2 样本 4 条 message 同型）
- 编号标题开头（`2.2 方案`）→ 数字感知缺失截断 → **content=`2.`**

「偶发」假象的来源：复现与否取决于匹配词在文档中的位置——深匹配条目必现，浅匹配条目正常。本地复刻 main 分支逻辑实证 4 场景全中（散文对照正常）。

**对照 #509 误判链**：#519（入库层防线）声明 issue 样本在 DB 中 content 完整、不复现——入库层无缺陷正确，但这些样本实为本投影缺陷的受害者。#509 提前关闭漏掉了主犯。

## 修复

**核心原则：content 与 snippet 语义分离，投影只做一次（usecase 层）**

1. **`buildSnippet` summary 分支**（src/usecases/memory/search-memory.ts）：
   - content = `FIRST_SENTENCE_PATTERN` 从 `entry.content` 原文开头提取首句，与匹配位置解耦
   - snippet = FTS 匹配窗口（不变，匹配上下文归 snippet 字段）
   - 前导空白剥离 + trimEnd + 超长截断 200
2. **`FIRST_SENTENCE_PATTERN`**：数字感知首句正则 `[^\n]*?(?:[.。！？!?](?!\d|[A-Za-z])|\n|$)`
   - 句末标点后紧跟数字/字母非句末（`2.2 方案`、`v1.2` 不截断）
   - 换行无条件终止（markdown 行边界）；`$` 兜底无终止符整段
3. **`buildAnchorEntry`**：非 full 模式 content 从 `""` 改为 `extractSummaryContent(entry.content)`——anchor 短路是独立投影点，同契约修齐
4. **`expandContextForEntries`**：邻域条目 content 从 `""` 改为首句——同上
5. **`toMemoryEntryDTO`**（DTO 层）：删掉「非 full 且有 snippet 时 content=snippet」的二次覆盖——usecase 已按 detailLevel 完成投影，二次覆盖会把 summary 首句替换回 FTS 窗口，重蹈覆辙

三处投影点（rerankAndReturn / buildAnchorEntry / expandContextForEntries）统一走 `extractSummaryContent` helper，契约一致。

## 为什么旧测试没拦住

旧测试两处固化了缺陷契约：
- `content === snippet` 断言（summary 模式）——把「首句从窗口提取」当成不变量
- 测试数据匹配词都在前 100 字符内（浅匹配盲区），从未构造深匹配样本

修复后按新契约更新断言，并新增 4 个 #542 回归测试（深匹配/编号开头/换行开头/双查询），全部确定性断言（不用概率）。

## 修复后契约

| detail_level | content | snippet |
|---|---|---|
| summary | 原文首句（≤200 字符，数字感知） | FTS 匹配窗口 |
| snippet | FTS 匹配窗口 | FTS 匹配窗口 |
| full | 完整原文 | 无 |

## 验证

- **回归锁死**：`git stash` 基线对照——旧代码 4 failed（含 issue 双查询实证场景）/ 新代码 35 passed（tests/usecases/memory/search-memory.test.ts）
- **全量**：vitest 2790/2790（220 文件），tsc --noEmit 通过
- **存量验证**：修复部署后 summary 模式抽查原 issue 样本 entry（707ac5c3 / 7bb57538 / 5edc1cd2），content 应为原文首句
- **最简实现检查**：已过——修复收敛在投影层 3 处 + 正则 1 个，无新依赖无新文件层级；更简方案（只改正则不改提取源）无法解决「首句与匹配位置耦合」的根因，不成立

## 关联

- #542（本 PR Closes）——#509 的关闭结论修正见 issue 评论
- #519 入库层防线保留（纵深防御仍有价值）
- F20260807snip（渐进式披露 summary 首句的引入点，本修复修正其提取源）
- F20260827mpcg（#509/#519 入库层防线的特性文档）
