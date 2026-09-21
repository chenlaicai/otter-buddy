---
id: F20260921snpt
title: 锚点命中时 snippet 回退显示文档标识
summary: extractSnippet 在 token 全未命中时（锚点命中的典型形态——锚点词只注入 FTS 索引前缀、不在 content 本体），fallback 从「前 200 字符」改为「[sourceId] 前 200 字符」，snippet 与命中原因不再脱节（#740）。
change_type: fix
capability_test: "n/a: 纯检索投影层改动，无 LLM 参与行为"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [memory, fts, snippet, ux]
modules: [src/frameworks/db/memory/sqlite-memory-repository.ts]
---

# 锚点命中时 snippet 回退显示文档标识（#740）

## 背景

F20260902rcq3 给文档类条目（feature/research）的 FTS 索引注入 sourceId 前缀——查「F20260829raft」能命中目标文档。但 extractSnippet 从**原 content**（不含前缀）提取高亮窗口：锚点词在 content 里 indexOf 不到，走「前 200 字符」fallback——用户看到的 snippet 与命中原因（锚点）脱节。

检视獭-rcq3 当时的处置：改动涉及 snippet 投影链，出 PR 范围，立 issue #740 跟踪。

## 修复

issue 建议的可选方案落地：**snippet 无命中词时回退显示文档标识前缀**。

- `searchFTSWithHighlight` 调用点把 `row.source_id` 传入 extractSnippet（新可选参数 sourceIdPrefix）
- fallback 分支：有 sourceIdPrefix 时输出 `[F20260829raft] <前200字符>`；无 prefix（非文档条目或旧调用方）维持原行为
- 正常命中路径（token 在 content 里找得到）零改动——锚点注入后正文中若真含锚点词仍走高亮窗口

## 设计取舍

- **只改 fallback 分支不动正常高亮**：锚点命中是异常路径（token 与 content 完全不相交），正常路径多传一个用不上的参数无行为影响
- **前缀格式 `[sourceId] `**：与 FTS 注入格式（`sourceId content`）语义一致，用户看到方括号编号可直接识别文档 ID
- 不改 SnippetHit 接口/不新增字段：消费端（search-memory snippetMap）零感知，改动面最小

## 已知边界

- 非锚点的「token 全未命中」场景（理论上 MATCH 过的 query 大概率 content 命中，fallback 本就少见）也会带 prefix——行为变化无害（多一个文档标识，信息量只增不减）
- source_id 非 FID 形态的文档（如 conversation 类条目）prefix 是 UUID——更长但仍有定位价值

## 验证

- 修复前：查 FID 锚点 → snippet 为正文前 200 字符，无锚点词无文档标识（命中原因不可见）
- 修复后：同查询 → snippet 为 `[F<id>] <正文前 200 字符>`——文档标识可见
- 单测：extractSnippet fallback 带/不带 sourceIdPrefix 两分支 + 正常命中不受影响

## Modification-Class

`narrow-fix`（既有 fallback 语义内增强，无新机制）
