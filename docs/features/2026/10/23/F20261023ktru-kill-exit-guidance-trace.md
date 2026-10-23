---
id: F20261023ktru
title: kill 族正道指引绝对路径化 + restart-service 执行留痕（#1069 复发跟进）
change_type: fix
status: implemented
created: 2026-10-23
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules:
  - src/frameworks/agent/kill-block-messages.ts
  - src/frameworks/agent/circuit-breaker-helpers.ts
  - scripts/restart-service.mjs
  - scripts/restart-service.d.mts
  - tests/frameworks/agent/kill-exit-guidance-abs-path.test.ts
  - tests/scripts/restart-service-trace.test.ts
summary: "issue #1069（regression-verify 2026-10-23 按「bash问题复发就要开启」重开）：取证订正时间线——「10-20 修复合入后仍 4 条」不成立，3 条在 #1583 合入（10-21T02:05Z）前，真·修复后复发仅 1 条（10-22 colink `lsof｜xargs kill`，守卫按设计拦截但 17ms 后二拦 bounce）。根因=正道指引死链：`node scripts/restart-service.mjs` 仓根相对路径，外部项目獭 cwd 不可解析。修复：kill-block-messages 双文案 + appendDevServerGuidance 双分支改仓根绝对路径（getRepoRoot）；restart-service.mjs 补 traceUsage 执行留痕（data/metrics/restart-service-usage.jsonl 成功/拒绝双通道）——断言②执行痕迹数据源缺口补齐。"
tags: [bash-guard, kill-by-pid, guidance, traceability, fix, regression-verify]
capability_test: tests/frameworks/agent/kill-exit-guidance-abs-path.test.ts + tests/scripts/restart-service-trace.test.ts + tests/frameworks/agent/bash-safety-guard.test.ts + tests/frameworks/agent/guard-model-judge-copy-source.test.ts
from: [F20261019kbpc, F20261020kbpa, F20260930rsab]
---

# kill 族正道指引绝对路径化 + restart-service 执行留痕（#1069 复发跟进）

issue #1069（P1，regression-verify 2026-10-23 06:58Z 按搭档裁决口径「bash问题复发就要开启」重开）。本单交付：①复发样本分层取证结论；②正道指引死链修复（绝对路径化）；③执行级使用痕迹（断言②数据源）。

## 1. 取证结论（本单核心交付物）

### 1.1 修复栈时间线（合并时间锚点）

| PR | 内容 | mergedAt |
|---|---|---|
| #1513 (F20261015gsub) | 军备规则族删除（误拦面 21/31 归零） | 2026-10-15T03:27:34Z |
| #1559 (F20261019kbpc) | kill 族文案补 kill-by-pid 出口指引 | 2026-10-19T10:52:49Z |
| #1583 (F20261020kbpa) | kill-by-pid 合法根扩为多根 | 2026-10-21T02:05:42Z |

**完整修复栈 2026-10-21T02:05:42Z 才就位。**

### 1.2 复发样本分层（healing_events，ruleId=self_kill_nonliteral，10-19 起 8 条）

| 时间 (UTC) | 命令形态 | 场景 | 与修复栈关系 |
|---|---|---|---|
| 10-19 00:55/01:06/03:48 | `kill $PID` / `lsof｜xargs kill` | otter-buddy worktree dev server 清理 | #1559 合入前 |
| 10-19 11:39 | `for port … lsof … kill` | 测试进程清理 | #1559 后、#1583 前 |
| 10-20 07:46/10:17 | `kill $(cat /tmp/*.pid)` ×2 | guangdongdianlitest 外部项目 | **#1583 合入前** |
| 10-20 11:46 | kill-by-pid 验证现场（fix-1580 worktree） | PR #1583 自身 review 冒烟 | **#1583 合入前** |
| 10-22 09:45 | `lsof -ti:31100｜xargs kill` | colink 外部项目 dev server 清理 | **唯一真·修复后样本** |

**时间线订正**：重开评论「10-20 修复合入后仍拦截 4 条」不成立——10-20 的 3 条全部早于 #1583 合入（10-21 02:05Z），属修复栈生效前的存量。「复发归零」断言的 30 天窗口内，真·修复后复发 = **1 条**（10-22 09:45Z）。

### 1.3 10-22 现场链条（bounce 实锤 + 死链根因）

1. colink 对话（conversation e2819402）执行 `cd /Users/orca/ai/others/colink && lsof -ti:31100 | xargs kill; cd .otter/worktrees/chat-pr2-dm-migration && …`
2. 09:45:35.845Z 守卫拦截（self_kill_nonliteral，按设计——非字面量 PID 终止即拦）
3. 09:45:35.862Z（17ms 后）「bash 守卫二拦终态自动回发控制信号（第 1/2 次）」——**二拦 bounce 发生**
4. 根因：拦截文案指引 `node scripts/restart-service.mjs kill-by-pid …` 是**仓根相对路径**——colink 獭 cwd 在外部项目/对话工作区（F20261014cwsp），照做即 Cannot find module。正道存在（kill-by-pid 合法根 = /Users/orca/ai 全域，PR #1583 后 colink 项目在内），但**指引形态让外部项目獭走不到**——#1069「正道死路」的残留形态。

## 2. 修复内容

| 文件 | 变更 | 说明 |
|---|---|---|
| src/frameworks/agent/kill-block-messages.ts | 改 | KILL_BY_PID_EXAMPLE 改仓根绝对路径（`RESTART_SERVICE_SCRIPT` 导出 = getRepoRoot() + scripts/restart-service.mjs）；INDIRECT/PKILL 双文案同步 |
| src/frameworks/agent/circuit-breaker-helpers.ts | 改 | appendDevServerGuidance 双分支（白名单/无白名单）的脚本指引同改绝对路径；导出供单测（此前零覆盖，双分支漏网的根因） |
| scripts/restart-service.mjs | 改 | traceUsage（append-only JSONL → data/metrics/restart-service-usage.jsonl）+ die(msg, extra) 拒绝留痕 + 成功出口留痕（kill-by-pid / restart-port 双流程全覆盖） |
| scripts/restart-service.d.mts | 改 | traceUsage 类型声明（.mjs 手写声明文件同步） |
| tests/…（2 新 2 改） | 增/改 | 详见 §4 |

## 3. 非目标（范围收窄理由）

- **alpha.sh 指引保持 worktree 相对形态**：「在 worktree 内跑 scripts/alpha.sh」的语义域是 otter-buddy worktree（alpha 实例只存在于那里，scripts/alpha.sh 在该域内可解析），非死链同族。guard 族其余内联文案（主进程族/heredoc 等）的 alpha.sh 指引同理不动。
- **断言「同模式归零」的重定义**：属 issue 层验证口径调整，在收口评论提出（见 §5），不进代码。
- **guard-intercept-classify 指纹不动**：分类锚片段「终止进程的目标为变量或命令替换」「按名匹配的批量终止命令」原样保留（guard-intercept-classify.ts:44-45 契约）。

## 4. 验证

- **测试 654 全绿**（vitest：7 文件 654 用例，含新增 10 例）。
- **红性突变实测**（gen39 教训：红性声明必须突变实测）三步：基线 654 绿 → `git stash` 撤 src 修复（保留测试）→ 新增用例 **8/10 红**（2 条为双向成立的契约保持锚：绝对路径存在性、分类锚片段保留）→ `stash pop` 恢复 → 全绿。
- **E2E 冒烟双通道实录**（真实执行，非模拟）：
  - 拒绝通道：`kill-by-pid 999999` → exit 1 + 留痕 `{"outcome":"rejected","detail":"无法解析 PID 999999 的工作目录…","action":"kill-by-pid",…}`
  - 终止通道：靶子进程（node setTimeout，PID 6584）→ `kill-by-pid 6584 --project <worktree>` → SIGTERM 校验通过、进程真实终止、留痕 `{"action":"kill-by-pid","outcome":"killed","pid":6584,"cwd":…}`
- tsc --noEmit 清；eslint 清（含 .mjs）。

## 5. 验证断言（regression-verify 回查口径）

1. **指引可达（grep 可验）**：kill 族拦截文案含 `node <仓根>/scripts/restart-service.mjs kill-by-pid <pid> --project /abs/path` 绝对路径示例，且不含 `node scripts/restart-service.mjs` 相对形态。
2. **使用证据（数据源已补）**：`data/metrics/restart-service-usage.jsonl` 出现 ≥1 条 `outcome=killed` 记录（真实正道使用）；`outcome=rejected` 记录即「正道走了但被拒」的自动取证（死链监控面）。
3. **观察项（非断言）**：self_kill_nonliteral 拦截后 24h 内同 conversation 二拦终态 bounce 率——指引可达后应回落，数据量不足暂不设硬线。
