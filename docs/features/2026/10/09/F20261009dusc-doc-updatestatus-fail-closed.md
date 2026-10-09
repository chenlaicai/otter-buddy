---
id: F20261009dusc
title: feature/research 两仓 updateStatus 对不存在 ID fail-closed（#1385）
summary: sqlite-feature/sqlite-research 两仓 updateStatus 照搬 #1370 修法——UPDATE changes=0（ID 不存在）抛错，杜绝 sync 产物状态流转假成功（同 #1370 族模式）
change_type: fix
capability_test: "n/a: DB 回执语义修复，验证走单测（sqlite-document-repository-updatestatus 四用例），无独立 LLM 能力面"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
created_at: 2026-10-09
tags: [db, sync-documents, bugfix]
modules: [document]
causal_links:
  from: [F20261009hefs]
---

# feature/research 两仓 updateStatus 对不存在 ID fail-closed

## 背景（#1385）

PR #1383（#1370 healing 假成功修复）检视报告 Discovered Issue：`sqlite-feature-repository.ts` / `sqlite-research-repository.ts` 的 `updateStatus` 与 healing_events 同族——执行 `UPDATE ... WHERE id = ?` 后不看 `result.changes`，对不存在的 ID 静默成功（no-op 但调用方感知为成功）。

当前危害面小：调用方为 sync-documents 归档真实文件（ID 来自刚扫描的文件系统，不存在的概率低）。但与 #1370 同属「回执不可信」族——sync 产物的状态流转若静默失败，文档入库闭环无告警。

## 修法（narrow-fix，照搬 #1383 模式）

修法决策树①既有语义内修，与 F20261009hefs 完全同构：repo 层 `updateStatus` 对 `changes === 0` 抛错（`feature 不存在: <id>` / `research 不存在: <id>`）。改动面：2 文件各 +2 行 + 4 个单测。

**机制识别检查点（动手前判定）**：四问全未命中——不改语义边界、不引入新机制、无退役条件问题、无后续机制依赖——判定 narrow-fix 一行留痕。

**同族模式排查（范围修正）**：#1385 范围限定 feature/research 两仓。对抗审视（PR #1389）另发现 3 处同族残留——scheduled-task / im-connection / conversation 仓 updateStatus 同模式不看 changes，跟进取 issue #1391。

## 验证

- 新增 `tests/frameworks/db/document/sqlite-document-repository-updatestatus.test.ts` 四用例：两仓各「不存在 ID 抛错」+「存在 ID 正常更新不回归」，4/4 通过
- 修复前行为证据：better-sqlite3 `UPDATE ... WHERE id = ?` 不匹配返回 `changes: 0` 不抛错（#1370 已实证，同族同机制）
- 回归：`tests/frameworks/db` + `tests/usecases/document` 37 文件 353 用例全绿
- 最简实现检查：已过——2 文件各 +2 行（result 接收 + changes 判断），无更简路径
