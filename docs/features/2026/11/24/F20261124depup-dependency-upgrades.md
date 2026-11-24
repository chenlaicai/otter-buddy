---
id: F20261124depup
title: 统一升级依赖版本（2026-11-19 批次）
doc_type: feature

summary: |
  统一升级依赖版本，关闭 Dependabot 自动创建的 3 个 PR（#1922–#1924）。
  本批实做 1 包：better-sqlite3 13.0.3→13.2.0。
  pi-durable 与 pi-coding-agent 升级暂缓（fail-closed 守卫与 overrides 耦合，见下）。

causal_links:
  from:
    - F20261112duqgd

change_type: feature-update
tags: [deps, dependencies, upgrade, dependabot]
modules:
  - package.json
  - package-lock.json
capability_test: "n/a: 纯依赖升级，无 LLM 参与行为"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
created_at: 2026-11-19

intent:
  problem: "Dependabot 3 个依赖 PR 零散堆积无人收敛"
  expected_effect: "可安全升级的包并入统一 PR，守卫耦合包显式暂缓并留痕，Dependabot 待办清零（暂缓包由 Dependabot 重新提信号）"
  verify_by:
    type: behavior_check
---

# F20261124depup: 统一升级依赖版本（2026-11-19 批次）

## 背景与需求

Dependabot 开了 3 条依赖升级 PR：

| PR | 包 | from → to |
|---|---|---|
| #1922 | @earendil-works/pi-durable | 1.5.0 → 1.5.2 |
| #1923 | @earendil-works/pi-coding-agent | 1.5.0 → 1.5.2 |
| #1924 | better-sqlite3 | 13.0.3 → 13.2.0 |

按既定流程（PR #419 决策：只处理 Dependabot 信号），关闭全部 bot PR，在 worktree 内做统一升级。
**实做 1 包、暂缓 2 包**，理由如下。

## 升级清单（实做 1 包）

| 包 | from → to | 来源 PR | 类型 |
|---|---|---|---|
| better-sqlite3 | ^13.0.3 → ^13.2.0 | #1924 | minor |

- 无守卫耦合，native 模块经 tarball 内 `prebuilds/` 直供（13.x 均无 install script，
  旧 lockfile 的 `hasInstallScript` 标记为历史残留，本批随版本刷新一并消失）。
- 锁文件变更净 9 行（version/resolved/integrity），零新增/移除包条目，无计划外升级。

## 暂缓清单（2 包）

### @earendil-works/pi-durable 1.5.0 → 1.5.2（暂缓）

- `scripts/check-sdk-patch.mjs`（F20261028egitx fail-closed 守卫，经 F20261109pidrx
  改写为 pi-durable 运行时版本锁）硬编码 `pkg.version === "1.5.0"`，升 1.5.2 必红。
- pi-durable 是整个系统的**执行 runtime**（Harness / session 持久化），版本锁的存在即
  团队对运行时升级的敏感度标记。经核实 1.5.2 仍导出 `Harness` 与 `createCodingTools`
  （实质条件满足），但守卫注释明示「升级 SDK 时必须复核补丁与真实装配测试」——
  该复核属 R8 高杠杆路径，不宜由 01:00 定时任务代劳。
- 处置：暂缓，Dependabot 会重新提信号，待专项升级时同步抬升守卫版本锁并跑真实装配验证。

### @earendil-works/pi-coding-agent 1.5.0 → 1.5.2（暂缓）

- package.json `overrides` 将 pi-coding-agent 的 5 个同伴包
  （chord / pi-agent-core / pi-codemode / pi-mcp / pi-tui）锁定在 1.5.0，
  与 pi-coding-agent 版本配套。升 1.5.2 后若不同步退役/抬升 overrides，
  会形成「1.5.2 主体 + 1.5.0 同伴」版本错配（正是 11-01 批次 pi-codemode
  破坏事件的反向形态）；抬升 overrides 属「专项升级」范畴（F20261101depup 结论）。
- 11-01 批次对 pi-coding-agent 升级已确立暂缓先例（#1677 守卫耦合暂缓）。
- 处置：暂缓，待 pi-durable 专项升级时连同 overrides 一并退役/抬升。

### 存量观察（非本批引入，提请搭档知晓）

主仓 lockfile 与 package.json overrides 存在历史性漂移：pi-coding-agent 1.5.0 声明
`pi-codemode`/`pi-mcp` 1.5.0，但 lockfile 仍残留嵌套 `pi-coding-agent/node_modules/`
下 1.1.0 的孤儿条目（11-01 时期 overrides 1.1.0 的遗留，11-09 #1783 抬升 overrides 时
未随之清理）。`npm ci` 与 `npm install --package-lock-only` 在无 package.json 变更时
均不触碰该条目（npm 判定 in-sync），故主仓 CI 一直绿。本批刻意未在 better-sqlite3
升级中顺手清理，保持 diff 最小；建议在 pi-* 专项升级时一并处理。

## 验证（全绿）

- `node scripts/check-sdk-patch.mjs`：✅ durable public runtime verified @1.5.0
- `npm run build`：✅ exit 0（含 SDK patch 检查 + tsc + tsc-alias + bge-m3 复用主仓模型）
- `npm run lint`：✅ exit 0
- `npm test`：✅ **501 文件 / 6400 测试全部通过**（无环境性失败）
- `npm ci` 干净安装复验：✅ better-sqlite3 13.2.0 native 模块加载/CRUD 正常

## Dependabot PR 处置

#1922、#1923、#1924 已全部关闭（关闭评论注明「将合并到统一的依赖升级 PR」）；
Dependabot 分支已删除（`git push origin --delete`）。
#1922/#1923 对应包暂缓，Dependabot 将按自身调度重新提 PR 信号。

## 2026-11-24 定稿复验

- 编号按合入日顺延：`F20261119depup` → `F20261124depup`；分支与历史 commit 保留旧号，
  文档 ID／路径／H1／PR 标题与最终 commit 使用新号。
- 已 rebase 到最新 main `4c867108c0d26c5bac404aa4f4ea2b886e1116bf`，无冲突；diff 仍仅为
  better-sqlite3 版本与 lockfile 元数据、本文档。
- `npm ci`：PASS（560 packages）；better-sqlite3 13.2.0 native 模块加载及内存 DB 建表／写入／读取
  CRUD 复验通过。`npm run build`、`npm run lint`：PASS。
- `npm test`：**526 文件 / 6817 测试全部通过**。
- 11-18 旧 `check` 失败仅为 PR body 缺少 Rollback 与证据分层声明，非依赖或测试失败；定稿 body 已补齐。
