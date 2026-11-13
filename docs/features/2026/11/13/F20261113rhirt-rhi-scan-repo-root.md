---
id: F20261113rhirt
title: RHI 扫描 Git 工作目录绑定项目根而非隔离数据根
summary: "alpha 隔离实例以数据根（~/.otter/alpha/<hash>/）为 cwd 启动，该目录不是 Git 仓库；RhiScanWorker 的 repoPath 此前透传 rootDir（默认 process.cwd()），导致 git log 在数据根执行报 `fatal: not a git repository`、patrol 每轮 rhi-scan 失败。本次把 RHI 扫描的 Git 工作目录改为 getRepoRoot()（基于代码位置定位项目根，与 cwd 无关），与文档同步根 rootDir 解耦；sessionsDir 仍从 rootDir（数据根语义）派生不变。连带修复：CI 分离检出（actions/checkout ref=<sha>）无本地 main 分支时 `git log main` 报 ambiguous argument——git-log-collector 按 main → origin/main → HEAD 顺序回退。"
change_type: fix
capability_test: "n/a: 无 LLM 行为 golden 场景可回归；行为由全栈装配测试覆盖——tests/app/build-app.test.ts 新增 #1869 回归（rootDir 指向非 Git 空目录时 POST /api/health/scan 仍 200 且 commitCount>0，修复前 500）"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [health, rhi-scan, repo-root, alpha, path-resolution]
modules: [app, health]
created_at: 2026-11-13

intent:
  problem: "alpha 隔离实例 cwd=数据根（非 Git 仓库），RhiScanWorker.repoPath 透传 rootDir（默认 process.cwd()）导致 git log 报 not a git repository，RHI 扫描巡检每轮失败"
  expected_effect: "RHI 扫描的 Git 采集/PR 采集/特性文档采集绑定项目根（getRepoRoot），任意 cwd 启动均不再对数据根执行 git 操作；文档同步与成本采集的数据根语义不变"
  verify_by:
    type: behavior_check
---

# F20261113rhirt：RHI 扫描 Git 工作目录绑定项目根

## 背景

issue #1869：worktree 内执行 `bash scripts/alpha.sh start` 后服务正常监听，但启动日志出现 `Patrol duty failed: rhi-scan`，根因是 `git log main ...` 在 alpha 数据根执行报 `fatal: not a git repository`。

alpha 隔离实例的启动命令是 `cd <alpha_home> && node <wt_root>/dist/src/main.js --config <alpha_config>`（见 scripts/alpha.sh），进程 cwd = 隔离数据根 `~/.otter/alpha/<hash>/`。`buildApp` 中 `appRootDir = options.rootDir ?? process.cwd()`，未显式传 rootDir 时即 cwd = 数据根；`createRhiScanWorker` 又把 `rootDir` 透传给 `RhiScanWorker` 构造器的 `repoPath`，于是所有 Git 采集（git log / gh pr list / F 文档采集）都在数据根执行。

## 根因

`rootDir` 语义被混用：

- 文档同步根（syncDocuments 的 cwd）：alpha 下应是数据根（配合 OTTER_ALPHA_SYNC_DOCS 软链，默认不同步 worktree 文档，隔离语义刻意如此）。
- RHI 扫描的 Git 仓库根：必须是项目根（worktree 根），数据根不是 Git 仓库。

生产形态两者恰好重合（cwd=项目根），alpha 形态分离后暴露该 bug。

## 修复

1. **RHI 扫描工作目录绑定项目根**（`src/app.ts` `createRhiScanWorker`）：RhiScanWorker 构造器的第一个参数由 `deps.rootDir` 改为 `getRepoRoot()`（`@frameworks/repo-root`，F20260916fndv 既有机制——基于 `import.meta.dirname` 向上探测含 `package.json` 且 `name === "otter-buddy"` 的目录，与 process.cwd() 无关；vitest 直跑 src/ 与 tsc 产物 dist/src/frameworks/ 两种布局均兼容）。alpha 场景下 getRepoRoot() 返回 worktree 根（编译产物在 `$wt_root/dist/src/`，向上即 worktree 根）。`sessionsDir`（成本/产出采集的数据源）仍从 `deps.rootDir` 派生，保持数据根语义——Git 工作目录与数据根就此解耦。

2. **git ref 解析健壮性**（`src/usecases/health/git-log-collector.ts`）：修复后 scanOnce 真正落到 `git log main`，暴露 `main` 本地分支缺失场景（CI actions/checkout ref=<sha> 分离检出、无本地 main——alpha/production 因本地 main 存在不受影响）。`collectGitLogWithFiles` 不传 ref 时按序回退 `main → origin/main → HEAD`，首个可解析者生效；显式传 ref 时行为不变。main 在时仍优先 main，可复现指标口径（PR #417）不受影响。

改动为语义替换 + 回退链，无新增机制、无删除机制（narrow-fix）。alpha.sh / main.ts 均无需改动：getRepoRoot 不依赖任何 CLI 参数或环境变量。

## Verification

### 失败用例证据（bugfix）

回归用例：`tests/app/build-app.test.ts` 新增「RHI 扫描 git 工作目录绑定项目根而非 rootDir（#1869 回归防护）」——该文件 `beforeAll` 以 `rootDir: <非 Git 空目录>` 全栈装配 buildApp（复刻 alpha「cwd/数据根非 Git 仓库」形态），随后 `POST /api/health/scan` 触发一轮 scanOnce。

修复前（`createRhiScanWorker` 仍透传 `deps.rootDir`）：

```
 FAIL  tests/app/build-app.test.ts > buildApp 组装根启动 > RHI 扫描 git 工作目录绑定项目根而非 rootDir（#1869 回归防护）
AssertionError: expected 500 to be 200 // Object.is equality

- Expected
+ Received

- 200
+ 500
```

（500 即 scanOnce 内 `collectGitLogWithFiles` 抛 `Failed to collect git log: ... fatal: not a git repository`，经 rhi-controller handleError 转为 5xx。）

修复后：

```
 ✓ tests/app/build-app.test.ts (9 tests | 8 skipped) 17550ms
   ✓ buildApp 组装根启动 (9)
     ✓ RHI 扫描 git 工作目录绑定项目根而非 rootDir（#1869 回归防护） 17358ms
```

### 复现步骤

1. `npx vitest run tests/app/build-app.test.ts -t "1869"`（修复前 500 红，修复后 200 绿、`result.commitCount > 0`）。
2. `npx vitest run tests/usecases/health/git-log-collector.test.ts`（含新增「main 本地分支缺失时回退 HEAD」用例，CI 分离检出形态）。

### CI 实测

首版只改了 app.ts 入参，CI golden-selftest/check 的 smoke:boot 红（分离检出无本地 main → `git log main` ambiguous argument → 500）——补修 git-log-collector 回退链后转绿。

## 设计取舍

- **为什么用 getRepoRoot 而不是给 alpha.sh 加 `--repo-root` CLI 参数**：F20260916fndv 已为「非项目根 cwd 启动」建立统一机制 getRepoRoot，RHI 扫描是同一根因的又一实例；加参数需要 alpha.sh + main.ts 两处配套改动与解析测试，而 getRepoRoot 已覆盖且零参数耦合。同时它天然处理 worktree（编译产物在 worktree 内，定位到 worktree 根）与生产（cwd=项目根）两种形态。
- **为什么不动 sessionsDir 的派生**：#1869 只涉及 Git 工作目录；sessionsDir 从 rootDir 派生在 alpha 下恰是正确数据根语义，改它超出本修复范围（且当前 buildApp 未把 dataDir 传入 createRhiScanWorker，改需额外穿参，属过度扩大 blast radius）。
- **为什么不是「alpha 明确禁用 rhi-scan duty」**：隔离实例的意义是行为与生产一致（扫描真 worktree 历史/文档/PR 才有真实健康数据可验证），禁 duty 会让 alpha 丢一整个可观测面，且属于「删机制」而非修根因。
