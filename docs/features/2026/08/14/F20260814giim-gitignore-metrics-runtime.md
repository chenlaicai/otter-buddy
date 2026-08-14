---
id: F20260814giim
title: gitignore-metrics-runtime-output
doc_type: feature

summary: |
  把 `data/metrics/` 加入 .gitignore。
  根因：F20260812mtrc 引入的 MetricsRegistry 每 60s 把 prom-client 聚合快照 flush 到 `data/metrics/metrics-YYYY-MM-DD.jsonl`，但 .gitignore 只忽略了 `data/*.db` 和 `data/sessions/`，导致运行时产物每次都进 `git status`。
  修复：补一行 `data/metrics/`，运行时指标产物不再污染工作树。

causal_links:
  from:
    - F20260812mtrc

status: implemented
change_type: fix
tags: [tooling, metrics, gitignore]
modules:
  - .gitignore
capability_test: "n/a: 纯配置改动（A 类），无 LLM 参与行为"
---

# F20260814giim: 忽略 metrics 运行时产物

## 背景与需求

### 问题描述
调度器/指标模块上线后，`git status` 经常冒出未跟踪文件：

```
?? data/metrics/
```

内部是 `metrics-2026-08-14.jsonl` 之类的文件，每行一条 prom-client 指标快照。

### 根因分析
F20260812mtrc 引入的 `MetricsRegistry`（`src/frameworks/metrics/registry.ts`）按设计把运维指标 flush 到文件而非 SQLite，路径默认 `./data/metrics/`，每 60s 写一次、保留 7 天。但 `.gitignore` 当时只覆盖了 `data/*.db*` 与 `data/sessions/`，遗漏了 metrics 目录。

这是「新增运行时落盘目录时，配套 .gitignore 同步遗漏」的典型缺失。

### 数据实锤
- `src/frameworks/metrics/registry.ts:58` 默认目录 `./data/metrics`
- `registry.ts:138` 文件名 `metrics-${YYYY-MM-DD}.jsonl`
- `.gitignore`（修复前）只有 `data/*.db*` 与 `data/sessions/`，无 metrics 条目

## 方案设计

### 技术方案
在 `.gitignore` 的 data 区段补一行 `data/metrics/`，与既有 `data/sessions/` 并列。

### 目标
- T1: `git status` 不再显示 `data/metrics/` 下的 jsonl 文件

### 成功标准
- 工作树运行后 `git status` 干净
- 已被 git 跟踪的内容不受影响（此前该目录从未入库，无需 `git rm --cached`）

## 验收标准

### 验收场景
| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | 运行时产物不污染工作树 | 触发一次 metrics flush（或等待 60s）后 `git status --porcelain` | 不包含 `data/metrics/` 任何条目 |

### 能力测试映射
n/a（纯配置改动）

## 实现细节

### 改动范围
| 文件 | 操作 | 说明 |
|------|------|------|
| `.gitignore` | 修改 | data 区段新增 `data/metrics/` 条目 |

## 设计决策

**为什么不顺手加 `data/logs/` 等其它未来目录？** 当前只有 metrics 实际在写盘，遵循「按实际产物补 ignore」原则，不为假想未来目录预扩。后续新增落盘目录时由该特性的 F 文档同步补上即可。
