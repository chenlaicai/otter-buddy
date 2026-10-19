---
id: F20261019kbpc
title: kill 族拦截文案补 kill-by-pid 出口指引 + kill 族文案唯一文案源收口（#1540）
summary: 案发现场（2026-10-19 重启后 20 分钟 4 癞 11 拦，3 升 high）：海獭清理自己起的 dev server/测试进程（kill $VPID / lsof 组合杀 / pkill -f）连撞 bash 守卫——kill-by-pid 受控出口（F20261008hcpa）早已存在但拦截文案零提及（grep src/ 零命中），出口存在却走不到。修复：①self_kill_nonliteral/byname 文案补 kill-by-pid 出口指引（含 --project 归属示例 + 起进程即记 PID 引导）；②appendDevServerGuidance 动态段补 kill-by-pid 形态；③sleep 文案补 wait+until 探活示范（until 语义实测）；④根治文案拷贝漂移——同文案原 4+2 处拷贝靠注释人肉同步（实证只改 V1 时 V2 返回旧文案=改了等于没改），抽 kill-block-messages.ts 唯一文案源。
doc_type: feature
change_type: fix
intent:
  problem: "bash 守卫拦截文案只给 alpha.sh stop/start 两条路，对「清理自己起的自有项目 dev server/测试进程」的正当诉求是死路——海獭于是变体重试（组合杀/pkill -f），连撞升 high 烧重试配额；kill-by-pid 受控出口存在但文案零提及（自纠无路可走的结构性摩擦，#1540 家族 1 两个 high 事件实证）。文案 4+2 处拷贝、人肉同步，是「出口落地了但文案没跟上」的根因。"
  why_now: "2026-10-19 案发（4 癞 11 拦、3 升 high + 1 二拦终态）后当日立案当日修；搭档指令「按照优先级，你来逐个处理修复」。"
  expected_effect: "self_kill_nonliteral 族升 high（同 otter 6h≥3 次）周发生次数较基线（3 条/周）下降；文案 grep 可验含 kill-by-pid 出口指引；文案后续改动单点同步，拷贝漂移面归零。"
  verify_by:
    type: capability_test
    note: "单测锁文案含 kill-by-pid/--project（bash-safety-guard.test.ts #1540 两用例 + bash-sleep-guard.test.ts wait+until 示范用例）+ guard-model-judge V2 链文案锚用例；端到端探针验证 issue 家族 1 两个真实形态（kill $VPID / PID=$(lsof …); kill $PID）拦截文案含指引；周趋势断言由 healing_events 统计跟踪（到期 2026-11-18，见 issue 验证断言）。"
capability_test: "checkBashCommandSafety('kill $VPID', mainPid) 返回文案含 kill-by-pid 与 --project；checkBashCommandSafety('pkill node', mainPid) 同；sleep 30 拦截文案含 until= 探活示范"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: 2026-10-19
tags: [bash-guard, self-kill, kill-by-pid, copy-guidance, single-source-of-truth]
modules: [src/frameworks/agent/kill-block-messages.ts, src/frameworks/agent/bash-safety-guard.ts, src/frameworks/agent/guard-model-judge.ts, src/frameworks/agent/circuit-breaker-helpers.ts, src/frameworks/agent/sleep-command-guard.ts]
causal_links:
  - F20261008hcpa（kill-by-pid 受控出口本体——本特性只补「文案指路」，不动出口校验逻辑）
  - F20260914dsrv（端口白名单 + restart-service 受控脚本生态——appendDevServerGuidance 动态段宿主）
  - F20260928slan（sleep 拦截与 wait 工具——wait+until 示范补在 buildSleepBlockMessage 唯一文案源）
related_issues: [1540]
---

# kill 族拦截文案补 kill-by-pid 出口指引（#1540）

## 目标

让「清理自己起的 dev server/测试进程」这一高频正当诉求，在拦截文案里就能看到可走的受控出口（`node scripts/restart-service.mjs kill-by-pid <pid> --project /abs/path`），并引导「起进程即记 PID/归属」的前置习惯——出口存在但走不到 = 死路，死路是连撞升 high 的根因。

## 非目标

- 不动 kill-by-pid 出口本体的校验逻辑（F20261008hcpa 域）
- 不改 self_kill 族其余文案（pidfile/literal/process_group/pipe_shell/script/eval——目标就是主进程或绕过形态，kill-by-pid 指引不适用；其拦截同样由 appendDevServerGuidance 动态段覆盖进程操作形态）
- 计数口径按规则分离 → 沿 #1421 跟踪，不在本 issue 重复

## 方案

### 1. 唯一文案源收口（根因层）

`src/frameworks/agent/kill-block-messages.ts` 新建（零依赖模块，沿 sleep-command-guard S5 去重先例）：

- `INDIRECT_KILL_BLOCK_MSG`（self_kill_nonliteral）——原 4 处拷贝：bash-safety-guard.ts checkKillSegment、guard-model-judge.ts judgeKillSegment / INDIRECT_BLOCK_MSG 常量 / 不可知载荷兜底
- `PKILL_BYNAME_BLOCK_MSG`（self_kill_byname）——原 2 处拷贝

**实证依据**：实现时先只改 V1（bash-safety-guard.ts），单测实证 V2 路径（guard-model-judge，bash-safety-guard 经 checkWithModel 调用）返回旧文案——「V1 同文案」契约靠人肉同步，改一处漏三处。guard-model-judge 不得反向 import bash-safety-guard（循环依赖），故独立模块。

⚠️ 分类锚片段（guard-intercept-classify.ts 指纹依赖）在抽取中保留：「终止进程的目标为变量或命令替换」→ self_kill_nonliteral、「按名匹配的批量终止命令」→ self_kill_byname。

### 2. 文案补 kill-by-pid 出口指引

- nonliteral/byname 两条文案补：`node scripts/restart-service.mjs kill-by-pid <pid> --project /abs/path` + `--project` 归属声明语义 + 「起进程时请记下 PID 与归属目录」前置习惯引导
- appendDevServerGuidance（circuit-breaker-helpers.ts）白名单/无白名单两分支均补 kill-by-pid 形态——进程操作形态（PROCESS_OPS_SHAPE）拦截的动态指引全量覆盖

### 3. sleep 文案补 wait+until 探活示范

buildSleepBlockMessage 补：`wait seconds=20 reason="等 dev server 起监听" until="curl -sf localhost:3001/"` 示范 + until 语义说明（醒后单命令检查，未就绪是正常返回可再补一轮）。

**假设验证记录**（issue 方案第 2 条原标注「假设，置信度中，先验证再定稿」）：wait+until 语义已实测——`wait 5 until echo probe-ok` 返回「已等待 5 秒 + 苏醒检查输出 probe-ok」，确认是「固定时长等待 + 醒后单命令检查」非条件轮询，示范措辞按实测语义定稿。

## 影响范围

- 拦截文案变化：self_kill_nonliteral / self_kill_byname 两条静态文案 + appendDevServerGuidance 动态段 + sleep 文案（分类锚片段全部保留，guard-intercept-classify 指纹不失配）
- 测试断言核查：`toContain("alpha.sh stop")` / `toContain("wait 工具")` / `includes("检测到你使用了 sleep 等待")` 等既有锚短语全部保留；guard-intercept-classify.test.ts 的 sleep 文案 fixture 已同步更新为新文案

## 验证

- 全量测试 398 文件 6252 用例通过；tsc --noEmit 0 错误；eslint 0 告警
- 新增单测 3 个：nonliteral 文案含 kill-by-pid/--project、pkill 文案含 kill-by-pid/--project、sleep 文案含 until= 探活示范
- 端到端探针：`kill $VPID`、`PID=$(lsof -tiTCP:3001 -sTCP:LISTEN); kill $PID`（issue 家族 1 真实形态）拦截文案均含指引（hasGuidance: true）；`pkill -f vite` 不拦（vite 非 otter 进程名，属正确放行，守卫只护主进程）
- 关闭标准 1（grep 可验）：`grep -rn "kill-by-pid" src/` 7 处命中（kill-block-messages.ts + circuit-breaker-helpers.ts）
- 周趋势断言（关闭标准 3）：healing_events 统计跟踪至 2026-11-18（issue 验证断言，不在本 PR 收尾）
