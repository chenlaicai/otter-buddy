---
id: F20260814giim
title: gitignore-runtime-data-dirs
doc_type: feature

summary: |
  把 `data/metrics/` 与 `data/workspaces/` 加入 .gitignore。
  根因：MetricsRegistry (F20260812mtrc) 与 NodeWorkspaceGateway 在运行时向 `data/` 下落盘，但 `.gitignore` 只覆盖了 `data/*.db*` 与 `data/sessions/`，导致 metrics 当前每次都污染 git status，workspaces 在被工具写入后也将污染。
  修复：补 `data/metrics/` 与 `data/workspaces/`，并系统排查其余 `data/` 子目录确认覆盖完整。

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

# F20260814giim: 忽略 data/ 下的运行时产物目录

## 背景与需求

### 问题描述
调度器/指标模块上线后，`git status` 经常冒出未跟踪文件：

```
?? data/metrics/
```

内部是 `metrics-2026-08-14.jsonl` 之类的文件，每行一条 prom-client 指标快照。

### 根因分析
「新增运行时落盘目录时，配套 .gitignore 同步遗漏」的系统性缺失。本次触发点是 F20260812mtrc 引入的 `MetricsRegistry`（`src/frameworks/metrics/registry.ts`），按设计把运维指标 flush 到文件而非 SQLite，路径默认 `./data/metrics/`，每 60s 写一次、保留 7 天。但 `.gitignore` 当时只覆盖了 `data/*.db*` 与 `data/sessions/`。

### 数据实锤：data/ 子目录历史证据链排查

对 `data/` 下所有子目录逐一 `git log --all -- data/<dir>/` + `git check-ignore` 排查：

| 目录 | 用途 | 当前是否污染 git status | 历史是否入库 | 处置 |
|------|------|----------------------|------------|------|
| `data/metrics/` | prom-client 指标 JSONL 快照（registry.ts:58） | ✅ 是（触发本 PR） | 否（从未提交） | 加入 .gitignore |
| `data/workspaces/{conversationId}/` | 每会话工作区（node-workspace-gateway.ts:10） | 否（现有子目录均为空，git 不跟踪空目录） | 否 | 加入 .gitignore（latent 污染源，工具写入后即触发） |
| `data/sessions/` | agent 会话 | 已忽略 | — | 已覆盖 |
| `data/logs/` | 运行日志 `otter-buddy.log` | 已被 `logs/` 通配（.gitignore:39）覆盖 | — | 已覆盖 |
| `data/otter-buddy.db`, `data/otter.db` | SQLite 业务库 | 已被 `data/*.db` 覆盖 | — | 已覆盖 |
| `data/terminology/seed-terminology.json` | 种子术语数据 | **故意入库**（F20260813actk 引入，唯一 1 个文件） | 是（e283cd4 等多次提交） | **不忽略**，保持入库 |

证据来源：
- `git ls-files data/` 仅返回 `data/terminology/seed-terminology.json` 1 个文件
- `git log --all -- data/metrics/` 空，`-- data/workspaces/` 空 → 二者从未入库，无需 `git rm --cached`
- `git log --all -- data/terminology/` 命中 F20260813actk 相关 3 条提交 → 故意跟踪

## 方案设计

### 技术方案
在 `.gitignore` 的 data 区段按子目录粒度补 `data/metrics/` 与 `data/workspaces/`，与既有 `data/sessions/` 并列。不使用 `data/*` 通配——`data/terminology/` 是故意入库的种子数据，必须保留跟踪。

### 目标
- T1: `data/metrics/` 与 `data/workspaces/` 下的运行时产物不再出现在 `git status`
- T2: `data/terminology/seed-terminology.json` 继续被跟踪

### 成功标准
- `git check-ignore data/metrics/ data/workspaces/` 命中
- `git check-ignore data/terminology/seed-terminology.json` 不命中
- `git status --porcelain` 不含 `data/metrics/` 或 `data/workspaces/`

## 验收标准

### 验收场景
| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | metrics 不污染 | 触发一次 metrics flush（或等待 60s）后 `git status --porcelain` | 不含 `data/metrics/` |
| AT-2 | workspaces 不污染 | 通过 workspace 工具写入任一会话目录后 `git status --porcelain` | 不含 `data/workspaces/` |
| AT-3 | 种子术语仍被跟踪 | `git ls-files data/terminology/` | 返回 `seed-terminology.json` |

### 能力测试映射
n/a（纯配置改动）

## 实现细节

### 改动范围
| 文件 | 操作 | 说明 |
|------|------|------|
| `.gitignore` | 修改 | data 区段新增 `data/metrics/`、`data/workspaces/` 两条 |

## 设计决策

**为什么用子目录粒度而非 `data/*` 通配？** `data/terminology/seed-terminology.json` 是故意入库的种子数据（F20260813actk），`data/*` 通配会误伤。按实际运行时目录逐一列出，新增运行时目录时由对应特性 F 文档同步补 ignore 即可。
