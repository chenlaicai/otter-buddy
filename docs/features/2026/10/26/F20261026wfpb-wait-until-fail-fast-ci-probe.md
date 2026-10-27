---
id: F20261026wfpb
title: "wait until gh pr checks 业务失败 fail-fast（stderr 分类）+ 三态正道文案（#1623，含 Review-1640 返修）"
summary: "等 CI 场景三重陷阱收口：① wait/until 描述与守卫文案教「带过滤用 gh pr checks --json」，但 JSON 模式恒 exit 0，含 fail 也返回成功（假绿）；② until 非零一律重试，真实 CI 业务失败也盲等满 seconds 预算；③ 文案推荐 --watch 但 watch 无 --fail-fast 时首个失败不退出（伪 watch）。首版用通用 exit 1 fail-fast，Review-1640 生产路径反例（test -f/grep 未就绪、gh 网络错误、NONE 均 exit 1）证伪后返修为 stderr 分类：仅 gh + exit 1 + stderr 空 + stdout 含 bucket 表格行判终态失败，其余一律预算内重试。"
doc_type: feature
change_type: fix
intent:
  problem: "2026-10-25 PR #1611 等 CI 现场：獭用 --exit-status（gh 2.89 已删除，unknown flag 报错）、--watch（首快照失败即退误读 / 不带 --fail-fast 时失败不退出）、4 次 20s sleep 盲等。wait until 已有预算内轮询（F20261022wtpr），但描述推荐 --json 假绿路径，且 exit 1 终态失败也重试到预算耗尽——正道存在但语义错。"
  why_now: "用户勾选 #1623 今日开工（2026-10-26）；gh CLI 2.89 的 pr checks 退出码语义已稳定为三态（0/1/8，官方 help 明文），工具文案与实现可以对齐真实语义。"
  expected_effect: "等 CI 全绿的獭走 wait(seconds, reason, until=gh pr checks <PR>)：pending 自动重试、全绿即通过、有失败约 2 秒内终止并拿到失败现场，不再盲等满预算、不再被 --json 假绿骗过。非 gh 场景（服务探活 curl -sf 等）保持预算内重试语义不变。"
  verify_by:
    type: behavior_check
    note: "A 类单测覆盖 gh pr checks 真实业务失败 fail-fast（含带空格 check 名 TAB 分列）、argv 范围限定、失败现场 stdout 透传、transport 错/NONE/非 gh exit 1 反例不误判；真实生产链路无 mock 验证（v2 轮：文件就绪重试/坏代理超时/真实失败终止/all-pass/不存在 PR；v3 轮：真实失败现场透传）。描述属 B 类软代码，只提供可跟随指引。"
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

# wait until gh pr checks 业务失败 fail-fast（stderr + TAB 列分类）+ 三态正道文案

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
| PR#99999 不存在 | 1（stderr GraphQL 错误） | — | 探针错误，预算内重试；超时报错，不误报 CI 业务失败 |
| PR#1613 已合入 | 0（最终态全绿） | — | 就绪 |

修复前 until 行为（F20261022wtpr 实现）：非零一律重试到预算耗尽——PR#1639 场景 exit 1 也会盲等满 300s。

## 修复设计（v2，Review-1640 返修后）

修法决策树①（既有机制语义内修），机制识别检查点七项全未命中（无新增配置/状态/定时任务/信号/存储/决策分支/跨模块路径）。

### 首版教训（v1：通用 exit 1 fail-fast → 被生产反例证伪）

首版把 exit 1 统一判为终态失败。Review-1640 用生产路径反例证伪：

- **test -f <missing> / grep 未匹配**：exit 1 = 未就绪可恢复，文件 1 秒后出现就被误报「确认失败」终止（我在 head bf15a036 复现：第 1 次探测即停，永不等到第 3 次）
- **gh 网络失败**（坏代理）：exit 1 = transport 错误，非业务失败（复现：误报终止，重试后可恢复）
- **gh 2.89 NONE 形态**（PR 无 check）：走通用错误 exit 1（上游 output.go:173-177），首版文档「NONE 不会 exit 1、语义安全」论断错误；实测刚推送 PR 在 check 注册前窗口 exit 8=pending（PR#1642 临时探测），CI 注册后正常三态
- **curl -sf 连接拒绝实测 exit 7**（非 1）——首版测试 mock 用 1 强造了错误前提

**结论：exit 1 是多义码，不可用裸退出码分类。**

### v2/v3 设计：gh pr checks 专属 stderr + TAB 列分类

终态失败判定四条件（全部满足才 fail-fast）：

1. argv[0..2] = `gh pr checks`（**v3**：子命令限定——`gh pr view` 等其他子命令的 exit 1 不适用，Review-1640 delta 复现误入风险）
2. exitCode === 1（裸 gh 的 CI 失败码；仅与另外三项同时成立时分类，非通用 exit 1 fail-fast）
3. stderr 为空（gh transport 错误/GraphQL 错误都在 stderr；业务输出只在 stdout）
4. stdout 含 bucket 表格行——列分隔为 **TAB**（**v3**：v2 用任意空白拆列，check 名含空格时（如 `Build Web Frontend<TAB>fail`）名字中的词被误当 bucket，导致合法含空格 check 名的失败无法 fail-fast，Review-1640 独立复现漏判；gh 表格列间是制表符，实测 #1639/#1640）

**v3 失败现场透传**：终态报文附带 stdout 表格（失败 check 名 + job 链接）。v2 只透传 formatUntilFailure（stderr 优先，业务失败 stderr 空时只剩 `Command failed`），拏不到处置线索——违背本特性「拿到失败现场」承诺，已修。

四条件外的所有形态（非 gh 命令、非 pr checks 子命令、exit 8 pending、stderr 非空的 transport 错、NONE）一律保留预算内每 10s 重试——与 F20261022wtpr 契约兼容，非 CI 等待（文件/服务/文本）零影响。

文案三处同步（until 描述/元字符拒绝文案/守卫文案）：删 --json 假绿指引，教裸命令三态 + 勿加 --json（恒 exit 0 假绿）/不可加 --watch（until 单次探测 30s 上限，watch 会超时被杀）+ 确认 CI 失败时提前终止。元字符禁令/F20260928slan 防注入边界零改动。

### 被否方案

- **v1 通用 exit 1 fail-fast**（首版）：被 Review-1640 生产反例证伪（见上），返修取代。
- **v2 任意空白拆列 + 仅验 argv[0]**：被 Review-1640 delta 复现证伪（含空格 check 名漏判、其他 gh 子命令误入、失败现场丢失），v3 取代。
- **封装 `gh pr checks --json` + 内建解析成 CI probe 工具/参数**：新增机制（决策树④），且 gh 裸命令三态+stderr 分类已覆盖判定需求；仅当未来需要「只等 required checks」等细粒度时再议（--required flag 也可直接用）。
- **放开管道让獭自己写判定**：违反注入边界，否。
- **仅改提示词不动实现**：盲等满预算体验问题仍在，且简报明确不允许。

## 验证

### A 类单测（tests/…/wait-tool.test.ts，vi.mock execFileAsync，fake timers）

describe「F20261026wfpb（#1623 返修）」v2+v3 用例：

- gh 真实业务失败（stdout 表格 + stderr 空）→ 「第 1 次探测确认 CI 失败，已停止轮询」、无残留计时器、**报文含失败 check 表格与 job 链接（v3）**
- **v3：check 名含空格**（`Build Web Frontend<TAB>fail`）→ TAB 分列正确 fail-fast 并带回现场
- **v3：非 pr checks 子命令**（`gh pr view 123`，构造同形态 stdout）→ 不判终态，预算内重试
- gh transport 错误（stderr 非空）→ 不判终态，预算内重试后可成功
- gh NONE（stdout 无 bucket 行）→ 不判终态，重试到预算耗尽
- **Review-1640 反例**：文件探活 exit 1×2 → 第 3 次成功（未就绪不再误终止）
- 非 gh 命令持续 exit 1 → 重试到预算耗尽返回超时报文（不提前终止）
- pending(8)×2 → 第 3 次成功（重试语义保留）
- pending(8) 重试后转真实业务失败 → 第 2 次确认终止
- 既有用例 mock 按真实语义校正（pending 用 8、用法错用 2）；描述/守卫文案断言同步 v2 语义

### 真实生产链路（无 mock，真实子进程，返修后复验）

| 用例 | 结果 |
|---|---|
| R1 Review-1640 反例：文件探活 exit 1×2 后就绪 | 第 2 次探测通过 10.2s（v1 误报终止） |
| R2 Review-1640 反例：坏代理 gh transport exit 1 | 35s 重试 4 次后超时报文（不误报终态） |
| R5 真实业务失败（PR#1640 自身 check 红） | 1.5s 「第 1 次探测确认 CI 失败」终止（目标行为）；v3 起报文含失败 check 表格与 job 链接 |
| R4 all-pass PR#1634 | 第 1 次探测通过 1s |
| R3 不存在 PR#99999（GraphQL 错 stderr） | 重试后超时报文（不误报终态） |
| 附加：刚推 PR#1642 pending 窗口实测 exit 8 | 与 gh 约定一致，走重试 |
| 首版 CASE4 非 gh 探活 exit 7×2→0 | 第 3 次通过 21.3s（v1 已验，v2 行为不变） |

证据存 workspace glm-1623/（含 gh-transport.txt、c1639.txt、none-check.txt）。

### v3 delta 后交付面勘误（2026-10-26，大獭元数据收尾）

- Review-1640 review `5648153046` 确认代码两项已闭合、无新代码发现，剩余为交付说明与 CI 声明。
- 本文 PR#99999 行曾沿用 v1「确认失败、立即终止」，与现行 stderr 分类及真实 GraphQL 重试结果矛盾，已改为「预算内重试、超时报错」；四项判定说明补明裸退出码不构成通用失败分类。
- PR 测试声明只接受「收紧/放宽」枚举；描述性「语义校正 + 反例保护，无放松」无法过机械闸，按实际保护意图登记为「收紧」。此项为文档与 PR 元数据修订，不改动运行时代码。

### 全量回归

- vitest tests/interface-adapters/ + tests/frameworks/agent/：99 文件（v3 后单测 29 项，详见 PR CI）
- tsc --noEmit 0；npm run build 0；npm run lint 0；rebase origin/main 57edd41c+ 后全过

### 已消除的未尽事项（v1 遗留 → v2 实测补齐）

- ~~NONE 形态未实测~~ → PR#1642 临时探测：刚推送 CI 注册前窗口 exit 8=pending（auto-close skipping 同现）；上游 output.go 证实注册后无 check 的 NONE 走 exit 1 + stderr——v2 的 stderr 非空分类正确把它归入重试。
- golden-selftest / e2e CI 为最终门。

## 测试改动声明

- v2 返修轮：fail-fast 用例重写为 stderr 分类语义（v1 的「非 gh exit 1 也 fail-fast」用例改为反例保护用例）；mock 补 stdout/stderr 字段（node promisify(execFile) 失败路径真实携带）
- v3 delta 轮：新增带空格 check 名 TAB 分列用例、非 pr checks 子命令不误判用例；真实失败用例补「报文含失败表格与 job 链接」断言
- 首轮：既有用例 mock 退出码 1→8（pending 重试至成功）、1→2（持续非零重试至超时）——按 gh 真实三态语义校正 mock 数值，用例意图与断言不变。方向：**收紧**（CI 测试声明的枚举口径；语义层面是反例校正与保护，未放松既有断言）
- 描述/文案断言同步更新（删旧 --json 指引断言，补三态锚点）

## 产出

- PR：`feat/1623-wait-ci-probe`（Fixes #1623）
- 本文档
