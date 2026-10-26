---
id: F20261026wfpb
title: "wait until exit 1 fail-fast + gh pr checks 三态正道文案：修假绿指引与盲等满预算（#1623）"
summary: "等 CI 场景三重陷阱收口：① wait/until 描述与守卫文案教「带过滤用 gh pr checks --json」，但 JSON 模式恒 exit 0，含 fail 也返回成功（假绿）；② until 非零一律重试，exit 1（确认失败）也盲等满 seconds 预算；③ 文案推荐 --watch 但 watch 无 --fail-fast 时首个失败不退出（伪 watch）。修复：until 探测区分 exit 1（终态失败，立即终止）与其他非零（未就绪，预算内每 10s 重试）；描述与守卫文案改为 gh pr checks 裸命令三态语义（0=全绿、1=有失败、8=pending），删 --json 假绿指引、明示 --watch 不可用于 until。"
doc_type: feature
change_type: fix
intent:
  problem: "2026-10-25 PR #1611 等 CI 现场：獭用 --exit-status（gh 2.89 已删除，unknown flag 报错）、--watch（首快照失败即退误读 / 不带 --fail-fast 时失败不退出）、4 次 20s sleep 盲等。wait until 已有预算内轮询（F20261022wtpr），但描述推荐 --json 假绿路径，且 exit 1 终态失败也重试到预算耗尽——正道存在但语义错。"
  why_now: "用户勾选 #1623 今日开工（2026-10-26）；gh CLI 2.89 的 pr checks 退出码语义已稳定为三态（0/1/8，官方 help 明文），工具文案与实现可以对齐真实语义。"
  expected_effect: "等 CI 全绿的獭走 wait(seconds, reason, until=gh pr checks <PR>)：pending 自动重试、全绿即通过、有失败约 2 秒内终止并拿到失败现场，不再盲等满预算、不再被 --json 假绿骗过。非 gh 场景（服务探活 curl -sf 等）保持预算内重试语义不变。"
  verify_by:
    type: behavior_check
    note: "A 类单测覆盖 exit 1 fail-fast / pending(8) 重试后转 fail / 非 gh exit 1 fail-fast / pending 重试至成功 / 超时预算；真实生产链路用无 mock 的真实子进程验证 4 用例（all-pass 即绪 2.3s、fail 约 2s 终止、不存在 PR 约 2s 终止、非 gh 场景 exit 7×2→0 重试 21.3s 第 3 次通过）。描述属 B 类软代码，只提供可跟随指引。"
capability_test: "n/a: 核心行为为确定性工具控制流，由 tests/interface-adapters/agent-runtime/tools/wait-tool.test.ts 验证；description/守卫文案为软引导，断言锚点存在性不冒充 LLM 采纳率证明"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
created_at: 2026-10-26
tags: [wait-tool, gh-cli, ci-wait, fail-fast, exit-code, bash-guard, sleep]
modules: [src/interface-adapters/agent-runtime/tools/tool-factory.ts, src/frameworks/agent/sleep-command-guard.ts, tests/interface-adapters/agent-runtime/tools/wait-tool.test.ts, tests/frameworks/agent/bash-sleep-guard.test.ts]
causal_links:
  - F20261022wtpr（until 预算内安全轮询；本特性在其循环上加 exit 1 终止分支并修正指引）
  - F20260928slan（until 单命令禁元字符防注入边界；本特性不放开）
  - F20260922slan（sleep 工具化+梯度分层；守卫文案同步三态语义）
  - issue #1623（案发现场与派工来源）
---

# wait until exit 1 fail-fast + gh pr checks 三态正道文案

## 案发现场与独立取证（2026-10-26，gh 2.89.0 本机实测）

issue #1623 描述 2026-10-25 PR #1611 等 CI 的三重困境。本次开工先独立复核，取证结果**部分修正了 issue 前提**：

| #1623 假设 | 实测结果 |
|---|---|
| 「封装 `gh pr checks --exit-status` 判定 exit code」 | `--exit-status` 在 gh 2.89 **已删除**（unknown flag，实锤）；无需封装——**裸 `gh pr checks` 已是三态**：exit 0=全绿、1=有失败、8=有 pending（`gh help pr checks` 官方明文 Additional exit codes: 8 = Checks pending） |
| 「文档建议 --json」可作正道 | **假绿陷阱**：`gh pr checks 1639 --json ...` 在含 FAILURE check 的 PR 上实测 **exit 0**——JSON 模式恒 0，探活语义失效。原 wait 描述「带过滤需求请让命令自身支持（如 gh pr checks --json）」在教一条假绿路 |
| 「--watch 先快照失败即退」 | 属实且更糟：gh 官方文档「Without --fail-fast, watch continues after a failure」——watch 无 --fail-fast 时**有失败也不退出**；且 until 单次探测 30s 上限，watch 长轮询必超时被杀 |

退出码全表（实测锚点，命令与输出存 workspace/glm-1623/）：

| 场景 | 裸命令 exit | `--json` exit | wait until 期望行为 |
|---|---|---|---|
| PR#1634 全绿 | 0 | 0 | 就绪 |
| PR#1639 含 fail check | **1** | **0（假绿）** | 确认失败，立即终止 |
| PR#1639 含 pending | 8 | 0 | 未就绪，重试 |
| PR#99999 不存在 | 1（stderr GraphQL 错误） | — | 确认失败，立即终止 |
| PR#1613 已合入 | 0（最终态全绿） | — | 就绪 |

修复前 until 行为（F20261022wtpr 实现）：非零一律重试到预算耗尽——PR#1639 场景 exit 1 也会盲等满 300s。

## 修复设计

修法决策树①（既有机制语义内修），机制识别检查点七项全未命中（无新增配置/状态/定时任务/信号/存储/决策分支/跨模块路径）：

1. **exit 1 fail-fast**（tool-factory.ts `runUntilPolling`）：探测失败时区分退出码——`exit 1` 视为探活命令自身判定的**终态失败**，立即终止轮询并返回失败现场（附 gh 三态语义提示与「误判换探活命令」出口）；其他非零（8=pending、7=连接拒绝、127=找不到命令）语义上是未就绪/未知，保留预算内每 10s 重试。失败不会随时间自愈（重试=盲等），pending 才会——这是把「继续等有意义吗」交给探活命令自己的退出码约定。
   - 非通用性问题已权衡：非 gh 命令 exit 1 若另有含义（少见），返回文案明确教「改用能映射就绪/未就绪的探活命令」；`curl -sf` 恰是 exit 1=连接失败语义，与 fail-fast 对齐。
2. **文案三处对齐真语义**：
   - until 参数描述：删「带过滤需求…（如 gh pr checks --json）」假绿指引 → 教裸命令三态 + 「勿加 --json（恒 exit 0 假绿）、不可加 --watch（单次探测 30s 上限会超时被杀）」+ exit 1 fail-fast 语义
   - 元字符拒绝文案：同步删 --json 指引（该文案同样是引导面）
   - 守卫文案（sleep-command-guard.ts）：示范补三态语义与 fail-fast、勿加 --json/--watch
3. **不放开任何元字符**：单命令、execFile 无 shell、禁管道/重定向/引号的 F20260928slan 防注入边界原样保留——gh 裸命令已内建判定，无需管道。

### 被否方案

- **封装 `gh pr checks --json` + 内建解析成 CI probe 工具/参数**：新增机制（决策树④），且 gh 裸命令三态已覆盖核心判定需求；仅当未来需要「只等 required checks」等细粒度时再议（--required flag 也可直接用）。
- **放开管道让獭自己写判定**：违反注入边界，否。
- **仅改提示词不动实现**：exit 1 盲等满预算的体验问题仍在，且简报明确不允许。

## 验证

### A 类单测（tests/…/wait-tool.test.ts，vi.mock execFileAsync，fake timers）

新增 describe「F20261026wfpb（#1623）wait until exit 1 fail-fast」4 用例 + 既有用例校正：

- exit 1 → 「第 1 次探测确认失败，已停止轮询」、无残留计时器
- pending(8) 重试一次后转 1 → 「第 2 次探测确认失败」终止
- 非 gh 命令（curl -sf）exit 1 → 同样 fail-fast
- pending(8) ×2 → 第 3 次成功（重试语义保留，mock 从旧 1 校正为真实语义 8）
- 既有「持续非零重试至预算耗尽」用例 mock 改用 exit 2（非终态），语义更准
- 描述断言：不再含「带过滤需求请让命令自身支持」、含三态/勿加 --json/不可加 --watch/fail-fast 指引
- 守卫文案断言（bash-sleep-guard.test.ts）：补三态语义/fail-fast/勿加 --json 或 --watch 三锚点

### 真实生产链路（无 mock，真实子进程）

直接调 `createTools()` 的 wait 工具（与生产同码路径），命令与完整输出存 workspace `glm-1623/`：

| 用例 | 结果 |
|---|---|
| CASE1 all-pass PR#1634 | 第 1 次探测通过，elapsed 2.3s |
| CASE2 fail PR#1639 | 「第 1 次探测确认失败，已停止轮询」，elapsed ~2s（修复前会盲等满 300s） |
| CASE3 不存在 PR#99999 | 确认失败终止 + GraphQL stderr 现场，elapsed ~2s |
| CASE4 非 gh 探活脚本前 2 次 exit 7、第 3 次 exit 0 | 第 3 次探测通过，elapsed 21.3s（重试语义完整保留） |
| （顺带）探活脚本自身报错 exit 1 | fail-fast 正确拦截，报文含错误现场 |

### 全量回归

- vitest tests/interface-adapters/ + tests/frameworks/agent/：98 文件 2322 passed | 6 skipped
- tsc --noEmit 0；npm run build 0；npm run lint 0

### 未尽事项

- NONE 形态（PR 刚推送 CI 未注册，gh 输出「no checks」的退出码）近 50 个 closed PR 未找到样本，未实测——但该形态按 gh 约定不会是 exit 1（无失败事实），最坏落「未就绪重试」直到 checks 注册，语义安全。本 PR 创建后可用自身 PR 的 pending 窗口观察。
- golden-selftest / e2e CI 为最终门。

## 测试改动声明

- 既有用例 mock 退出码 1→8（pending 重试至成功）、1→2（持续非零重试至超时）——按 gh 真实三态语义校正 mock 数值，用例意图与断言不变。方向：**语义校正，非收紧或放松**。
- 描述/文案断言同步更新（删旧 --json 指引断言，补三态锚点）。

## 产出

- PR：`feat/1623-wait-ci-probe`（Fixes #1623）
- 本文档
