---
id: F20260918mrdp
title: 主仓 data/ 防误删三重防线：bash 守卫拦截 + flush 自愈 + 备份兜底
summary: 9/17 事故（rm -rf data/metrics 误删主仓运行时数据，metrics + golden 执行历史不可恢复丢失）的三层善后。搭档定调「类似 alpha 启停的双重措施」：①tool 层拦截——bash-safety-guard 新增主仓 data/ 破坏性命令检测（rm/rmdir/mv/find -delete，cwd 跟踪放行 worktree 验证正道）；②正向脚本——data/ 写删验证纪律固化进 worktree-isolation skill（alpha.sh 隔离实例 + tmpdir 是正道，主仓 data 碰不得）；③韧性+兜底——MetricsRegistry.flush 对 ENOENT 自愈（mkdir 重试，5 行内）+ backup-runtime-data.mjs 每日备份（launchd 06:30，保留 14 天）。拦截为主、备份为底，alpha 哲学延伸：从「发生了被拦」到「结构上碰不到」。
change_type: feature
created_in_conversation: 15c94835-fe92-4bfc-9bd0-49d56f9dbb10
tags: [bash-safety-guard, metrics, data-safety, backup, launchd, resilience]
intent:
  problem: "主仓 data/（gitignore 运行时数据：metrics 日粒度 JSONL + golden-results.jsonl 执行历史 + logs）无备份且可被海獭 bash 相对路径整目录删除——9/17 一条漏了 cd 前缀的验证命令删掉主仓 data/metrics，主服务 flush 崩 5 分钟、224 行 golden 历史不可恢复丢失"
  expected_effect: "指向主仓 data/ 的 rm/mv/find -delete 被 bash 守卫拦截（拦截文案引导 alpha.sh/tmpdir 正道）；worktree 内验证操作不受影响（cwd 跟踪）；即使前两层失效，目录被删后主服务 flush 自动重建（ENOENT 自愈）；每日备份可从 data/backups 恢复"
  verify_by:
    type: capability_test
    detail: "tests/frameworks/agent/bash-safety-guard.test.ts #1038 describe 块 20 例（拦截面 11 + 放行面 6 + 退化路径 2 + 误拦防 1）；tests/frameworks/metrics/registry.test.ts 自愈 2 例（ENOENT 重建重试 + 非 ENOENT 不吞错）。备份脚本沙盒验证过（产物含 metrics+golden+log tail，过期清理生效）"
modules: [src/frameworks/agent/bash-safety-guard.ts, src/frameworks/metrics/registry.ts, scripts/backup-runtime-data.mjs, scripts/launchd/com.otterbuddy.backup-runtime-data.plist, .pi/skills/worktree-isolation/SKILL.md]
capability_test: tests/frameworks/agent/bash-safety-guard.test.ts
created_at: 2026-09-18
---

# 主仓 data/ 防误删三重防线

## 背景（意图锚）

9/17 事故：大獭在主仓 cwd 模拟「主仓有 golden 记录环境」验证 lint 时，一条 bash 漏了 cd worktree 前缀，`rm -rf data/metrics` 删在主仓头上——主服务 flush ENOENT 崩 5 分钟，7 个日粒度 metrics 文件 + golden-results.jsonl（224 行执行历史）不可恢复丢失（gitignore 无 git 历史）。

事故后开两个 P1 issue：#1038（备份缺失+防误删约定）、#1039（flush 无自愈）。本轮搭档对方案方向定调（原话）：

> 「关于误删这一点，我认为还是类似于alpha启停的处理，双重措施：1.海獭tool层拦截命令 2.提供正向脚本，让海獭直接无法碰到主目录」

即从「备份兜底」升级为「结构隔离」——alpha 启停同款的双重措施（F20260830bsgr 拦截 + F20260917alph 正向脚本的组合先例），备份降级为第三层兜底。

## 方案：三重防线

| 层 | 措施 | 载体 | 哲学 |
|---|---|---|---|
| 1. 拦截 | bash 守卫拦主仓 data/ 破坏性命令 | bash-safety-guard.ts `checkDataDirDestructive` | 「发生了被拦截」 |
| 2. 正向 | 验证走隔离环境，碰不到主仓 data | worktree-isolation skill 纪律 + alpha.sh（既有） | 「结构上碰不到」 |
| 3. 韧性+兜底 | flush 自愈 + 每日备份 | registry.ts ENOENT 重试 + backup-runtime-data.mjs | 「真删了也能活」 |

### 措施 1：bash 守卫拦截（#1038 主体）

`checkDataDirDestructive(command, logger, projectRoot)`：

- **分段**：按 shell 操作符（`&&`/`||`/`;`/`&`/`\n`/`|`）切段，逐段扫描
- **cwd 跟踪**：段内 `cd <dir>` 更新跟踪 cwd——`cd worktree && rm -rf data/…` 是验证正道，必须放行（cd 到 `~`/无参 → cwd 置空，后续相对路径保守拦截）
- **三种破坏形态**（词元须在命令位置，复用 `isKillAtCommandPosition` 位置感知匹配，防 #777 类误拦）：
  1. `rm`/`rmdir` + 任一非 flag 参数解析到主仓 `data/` 下
  2. `mv` + 源参数（第一个非 flag）解析到主仓 `data/` 下（把运行时数据移走=破坏；目录内改名也拦——误拦成本低、换路即可）
  3. `find` + 主仓 data/ 路径 + `-delete`（间接删除）
- **路径判定** `resolvesToMainData(target, cwd, projectRoot)`：相对路径按 cwd 解析后比对主仓 `<projectRoot>/data` 前缀；尾部 glob/斜杠剥除（`data/metrics/*` → `data/metrics`）；`~` 前缀保守拦截；projectRoot 缺失保守拦截（与 `resolvesToMainCheckout` 同策略）
- **拦截文案**引导正道：alpha.sh 隔离实例 / os.tmpdir() / worktree 内路径；主仓清理报告搭档人工执行
- **接入点**：`checkBashCommandSafetyOnText`（脚本自杀检测之后、cmdLevel 之前）+ `checkWhenMainPidMissing`（不依赖 mainPid，PID 缺失仍拦——与 kill 族保守放行的差异：data/ 判定只需 projectRoot，无退化理由）

**放行面**（测试锁定）：worktree 内 rm（cd 跟踪）、/tmp 路径、非 data 前缀路径（如 `database/`）、纯读命令（ls）、引号内数据位文本（echo 'rm -rf data'）。

**Known Limitations（第一版，对抗审视评估是否补面）**：
- shell 重定向截断（`> data/metrics/x.jsonl`）不覆盖
- 路径前段 glob 变形（`dat*/metrics`）不覆盖——glob 在路径前段时 `resolvesToMainData` 按 cwd 解析失败走保守（相对+cwd 未知才保守；cwd 已知时按字面解析，`dat*/metrics` 不匹配 `data/` 前缀，漏拦）
- 子 shell `(cd worktree; rm …)` / pushd 不跟踪——cd 跟踪只看顶层段
- `chmod`/`chown` 等属性破坏不覆盖

**检视修复（检视獭-1040，2026-09-18）**：
- 严重 1（已修）：路径比较区分大小写——macOS case-insensitive FS 上 `dAta/metrics` 实际命中主仓 data/ 但静态比较漏拦。修复：`resolvesToMainData` / `resolvesToMainCheckout` 比较双侧 toLowerCase（同根因一并修）；+2 防御测试锁定
- 建议 1（已修）：PR 描述声称 20 例实为 18 例——数字勘误，补大小写 2 例后恰 20 例对齐
- 建议 2（反驳留痕）：launchd plist 硬编码 `/usr/local/bin/node`——plist 本就是机器绑定配置（脚本路径同为绝对路径硬编码），迁移时整体更新；失败有 StandardErrorPath 落点（`/tmp/otterbuddy-backup.err.log`），非完全静默

### 措施 2：验证纪律固化（#1038 约定）

worktree-isolation SKILL.md 步骤 3 追加「data/ 写删验证纪律（2026-09-18 #1038，双重措施）」段：
- 涉及 data/ 的验证命令一律在 worktree/临时目录内执行
- 验证数据用 os.tmpdir() 或 worktree 内路径；服务行为验证走 alpha.sh（独立数据根天然隔离）
- 主仓 data/ 的清理只能由搭档人工执行
- 守卫拦截是底线不是通行证——正道是不碰

### 措施 3a：flush ENOENT 自愈（#1039）

`registry.ts` flush 的 appendFileSync 包 try/catch：ENOENT 时 `mkdirSync(dir, {recursive: true})` 重建后重试一次；非 ENOENT 原样抛出（不吞错）。5 行内改动，指标不再静默丢失到下次重启。

### 措施 3b：每日备份兜底（#1038 原始建议）

`scripts/backup-runtime-data.mjs`：
- 备份范围：`data/metrics/` 全量（~20M，含 golden 执行历史）+ `data/logs/otter-buddy.log` 尾部 32M（单文件 288M 全备不现实）
- 产物：`data/backups/runtime-<时间戳>.tar.gz`（原子写：.tmp → rename；staging 用 symlink + `tar -h` 跟随，BSD/GNU tar 通吃，不依赖 GNU --transform）
- 过期清理：默认保留 14 天（KEEP_DAYS 可调）
- 调度：launchd `com.otterbuddy.backup-runtime-data.plist` 每日 06:30（plist 已入仓；**加载需搭档执行**：`launchctl load ~/Library/LaunchAgents/com.otterbuddy.backup-runtime-data.plist`——海獭不碰 launchctl）
- 沙盒验证：/tmp 假仓库结构跑通（产物 2.9M 含 metrics/golden/log-tail，过期清理生效）

## 测试

- `tests/frameworks/agent/bash-safety-guard.test.ts`：#1038 describe 块 20 例（拦截面 13：事故原形态/绝对路径/多段/rmdir/mv/find -delete/glob/尾部斜杠/大小写变形×2 等；放行面 6：worktree cd 跟规/tmp/无关路径/纯读/引号内文本；退化 2：mainPid 缺失仍拦、projectRoot 缺失保守拦）
- `tests/frameworks/metrics/registry.test.ts`：+2 例（目录删除后 flush 自愈重试 + ENOTDIR 非 ENOENT 错误不吞）
- 全量 3650/3650 绿（268 文件）；lint 0 error；build 过

## 关联

- 上游：#1038（备份+防误删）、#1039（flush 自愈）——本 PR 同时关闭两 issue
- 先例：F20260830bsgr（bash 守卫）、F20260917alph（alpha 隔离，双重措施的同款哲学）、F20260916gsrd（脚本自杀检测，路径解析先例）
- flaky 旁观：全量首跑时 `tests/usecases/memory/search-engine.test.ts` F20260917cvid 1 例偶发失败（单跑两次+全量重跑均过，与本次改动无关——改动不触及 memory 模块），建议另行跟进

## 遗留

- launchd plist 加载（搭档人工执行 launchctl load，或下次搭档在场时顺手）
- 重定向截断/路径前段 glob/子 shell cd 三类逃逸面（第一版 Known Limitations，对抗审视评估）
- search-engine flaky（F20260917cvid 回归，独立跟进）
