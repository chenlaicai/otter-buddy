---
id: F20261009rdps
title: "AI 雷达持久化入库：脚本与任务模板迁出对话工作区"
summary: "「每日 AI 雷达」定时任务的脚本（radar/）与任务指令此前只存在于「外部洞察」对话专属工作区（gitignore 区），形成持久化孤儿——备份脚本不覆盖 workspaces/、同事克隆仓库拿不到资产、误删不可恢复。本次对齐仓内既有模式（prompts/scheduled/ 模板 git 化，PR #428/#784）：脚本入 scripts/radar/、任务模板入 prompts/scheduled/（reconciler 启动自动同步 DB body）、月度剪枝任务模板同步入库。scan.mjs 仅一处适配：输出目录参数化（运行时数据不进仓库），抓取逻辑零改动。"
change_type: refactor
capability_test: "n/a: 无 src/ 改动。scan.mjs 参数化后实测三源抓取跑通（2026-10-09：HN 14 条/GitHub 30 个/Anthropic 10 篇，零错误，产物落 /tmp/radar-test-data/raw/2026-10-09.json）；模板入库后由 reconciler 启动对账自动同步 DB（机制见 src/usecases/scheduler/prompt-template-reconciler.ts）"
created_in_conversation: 9d6ffef1-c9b2-48f9-b2ac-0751090f3ebf
causal_links:
  - issue: "428"
    note: 定时任务 body git 化先例（prompts/scheduled/ 为真相源，本次对齐该模式）
  - issue: "784"
    note: prompt 启动对账机制（模板漂移自动同步 DB——本次模板入库后无需手改数据库的依据）
tags: [scheduler, radar, persistence, prompt-template, workspace]
modules:
  - scripts/radar/scan.mjs
  - scripts/radar/README.md
  - scripts/radar/fetch_anthropic.py
  - prompts/scheduled/daily-ai-radar.md
  - prompts/scheduled/monthly-prune-review.md
---

# AI 雷达持久化入库：脚本与任务模板迁出对话工作区

## 背景与问题

搭档 2026-10-09 发问：「外部洞察是置顶每日任务，脚本却在对话工作区里？重启后任务还在吗？关键固定对话应该持久化在代码仓。」

梳理结论（三层事实）：

1. **任务定义不丢**：scheduled_tasks 表在 SQLite，launchd KeepAlive 保 otterbar-core 常驻——重启后任务与调度都在。
2. **但 radar 脚本是持久化孤儿**：四个文件只活在「外部洞察」对话工作区 `data/workspaces/98bd9fdd…/radar/`（gitignore 区）。`scripts/backup-runtime-data.mjs` 只备 data/metrics 与日志尾部，**不含 workspaces/**——再来一次 9/17 式误删事故即永久丢失。
3. **仓内已有正确模式未复用**：三省吾身系 8 个任务的指令模板全部 git 化在 prompts/scheduled/（PR #428），reconciler 启动自动对账同步 DB（#784）。radar 与月度剪枝（同挂「外部洞察」对话）是唯二未入库的。

同事复用受阻是同一根因的直接后果：克隆仓库找不到 radar 目录（2026-10-09 搭档转述「同事说没有 rader 目录」）。

## 方案

对齐既有模式，资产分层归位：

| 资产 | 原位置（工作区） | 新位置（仓库） |
|---|---|---|
| scan.mjs / fetch_anthropic.py | `data/workspaces/98bd9fdd…/radar/` | `scripts/radar/` |
| README.md（管线真相源） | 同上 | `scripts/radar/README.md` |
| 雷达任务指令 | 仅 DB body | `prompts/scheduled/daily-ai-radar.md`（真相源） |
| 月度剪枝任务指令 | 仅 DB body | `prompts/scheduled/monthly-prune-review.md`（真相源） |
| 运行时数据（raw/*.json、last-report.json） | 工作区 data/ | **不动**（易变数据留在运行时区） |

### scan.mjs 唯一功能改动

输出目录参数化：`node scan.mjs [输出数据目录]`，缺省脚本旁 data/。原版用 `import.meta.url` 相对定位写死在脚本旁——入库后仓库不该接收运行时数据，参数化后生产用法传工作区 data 目录。抓取逻辑（三源、串行间隔、正则、stdout 摘要格式）逐行保留。

### 任务模板漂移即同步

daily-ai-radar.md 模板体相对 DB 现值有两处有意变更：第 1 步执行命令改为 `node /Users/orca/ai/otter-buddy/scripts/radar/scan.mjs data`（工作区内执行，脚本走仓库绝对路径），第 3 步规则引用改为 `scripts/radar/README.md`。scheduler 下次启动时 reconciler 检测漂移自动更新 DB body，无需手改数据库。monthly-prune-review.md 与 DB 现值逐字一致（纯入库，无变更）。

## 非目标

- 不改抓取源与分拣规则（已验证有效的逻辑零改动）
- 不迁移运行时数据历史（raw 日档留在工作区，可追溯性不受影响）
- 不处理工作区备份盲区本身（backup-runtime-data.mjs 是否扩围另立议题——本次入库后脚本资产已进 git，风险敞口已闭合大半）

## 验证

- scan.mjs 参数化版实测（2026-10-09 09:2x）：`node scripts/radar/scan.mjs /tmp/radar-test-data` 跑通，三源零错误（HN 14 / GitHub 30 / Anthropic 10），产物结构与原版一致（date/generatedAt/sources 三键）
- 模板 frontmatter task_name 与 DB 任务名精确匹配：「每日 AI 雷达」「月度剪枝审视（D3 剪枝出口）」（sqlite3 核对）
- reconciler 匹配规则核对：task_name 精确匹配 + 无 dynamic 标记 → 启动对账必命中

## 上线后动作

- PR 合入后 scheduler 重启（或下次启动）自动完成 DB body 同步
- 工作区 radar/ 原件保留（过渡期双轨，下次雷达任务跑通新版命令后可清理——不在本 PR 范围）
- 同事复用路径更新：克隆仓库即可获得全部资产（README 末节「复用部署」）
