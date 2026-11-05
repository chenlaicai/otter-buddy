---
id: F20261105bndst
title: RHI 归口阻止绑定非开放 issue（#1760）
doc_type: feature
change_type: fix
created: 2026-11-05
created_at: 2026-11-05
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules:
  - src/interface-adapters
  - tests/interface-adapters
  - tests/api
summary: "单条与批量 RHI 归口在写入前核实 GitHub issue 状态，仅 OPEN 可绑定；关单、不存在或查询失败均不改信号，工具与面板 API 共用同一检查。"
tags: [rhi, triage, github, fail-closed]
intent:
  problem: "RHI 单条 bind_issue 与 batch_bind 只校验 issueNumber 存在，仍可向已关闭 issue 写入僵尸归口"
  expected_effect: "CLOSED、不存在或状态不可核实的目标均在写入前被拒绝且信号不变，OPEN 目标保持既有归口行为"
  verify_by:
    type: behavior_check
capability_test: "n/a: 纯 A 类工具、HTTP 与外部 GitHub 状态边界，由真 sqlite 行为测试和 gh CLI 边界测试覆盖"
---

# RHI 归口阻止绑定非开放 issue（#1760）

## 预注册

- 预期根因：单条 `bind_issue`、批量 `batch_bind` 与面板 API 最终只写 `issue_number`，没有在写入前核实 GitHub 目标状态。
- 预期成立标准：在未修复代码上，三个入口向 CLOSED #1319 归口的测试仍成功写库；修复后同测试拒绝且原行不变。
- 放弃原预期的反例：若生产写路径不经这些入口，或现有隐藏依赖已完成状态校验，则重新定位，不继续本方案。

## 问题与现场确认

GitHub #1760 记录 26 条 open+triaged 信号挂在已关闭 #1012/#1472/#1319。2026-11-05 15:50 只读复查生产库，这三个 issue 下仅剩 #1472 的 3 条 dismissed 历史行，原始 open 存量已清零；`gh issue view` 核实三个目标均为 CLOSED。代码缺口仍存在：`SignalRepository.triageBindIssue` 只检查 issueNumber 是否提供，`batchBindIssue` 同样直接写入。

因此本项不是清理已不存在的 26 条 open 存量，而是阻止新僵尸归口。根因判断置信度高：真实关单状态与直接写库源码相互印证。

## 方案与设计面

在 interface-adapters 层新增一个窄 GitHub issue 状态边界：用既有项目已采用的 `gh issue view <N> --json state`（execFile 参数数组、无 shell、15s 超时）读取状态。工具单条/批量和 RhiController 在写库前 await 同一检查；只有 `OPEN` 放行，其他状态、无效编号、查询失败均拒绝且不写库。

模块切分：状态查询与「可绑定吗」判断放在同一适配器模块；工具与控制器只负责调用并映射各自错误形态，SQLite 状态机不改。关键接口是 `(issueNumber) => Promise<{ok:true}|{ok:false,reason:string}>`，生产默认真实 gh 查询，测试在外部边界注入确定结果。核心数据结构不变。

被否替代：①只改 agent 工具——面板 API 可旁路；②只在 SQLite repository 内做校验——内层无法直接依赖 gh/外部 IO，且会把同步状态机改成异步，影响所有既有调用；③直接复用 unfurl 取数——它面向任意 owner/repo 的展示元数据，携带正文与标签，非本域所需且会让健康域依赖 HTTP 展示模块。

设计面由大獭按 L1 技术取舍拍板；不新增产品语义之外的决策。

## 第一性三关与代价

- **事存在吗**：存在。原始 26 条已清是存量事实，不代表入口已堵；源码和 CLOSED 目标红测独立证明。
- **方向对吗**：在既有归口语义内补缺失前置条件（修法①），不新建状态、任务、配置或存储。关单后遗留信号是另一条生命周期触发路径，不靠本修复宣称闭环。
- **代价认了吗**：每次实际 bind 增加一次 gh 网络查询与最坏 15s 延迟；gh 不可用时会暂时阻止归口（fail-closed），不会让处置者误以为已归口。无后台轮询与缓存债；检查与写入之间仍存在 GitHub 状态竞态，只能由后续关单清理路径处理。

## 机制识别与修法

逐项检查：无新增配置字段/开关；无新增状态生命周期；无新增定时任务/后台进程；无新增信号类型/消息格式；无新增持久化存储；无会被记住并影响后续行为的新决策分支。新增一条适配器到 GitHub CLI 的调用路径，但它只是既有归口动作的前置外部查询，不形成独立机制。

修法决策树①（既有机制语义内补前置校验），`Modification-Class: narrow-fix`。命中「跨模块调用路径」但不涉净新增机制：无新状态/配置/持久化/后台职责，只让原有 bind 动作获得它本应核实的输入有效性。

原 issue 的「关单时列出 open 信号数」不纳入本次：绑定前校验无法覆盖「先绑 OPEN、后关单」，但那是另一条关单触发路径；本 issue 的代码关闭标准明确是 bind 对 CLOSED 拒绝，且当前存量已清零。此处保留边界，不把本次交付描述成全生命周期治理。

## 验证与验收标准

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 工具单条绑 CLOSED | 调 `triage_signal(bind_issue, issueNumber=1319)` | 返回错误含 CLOSED；信号 triage_status/issue_number/triaged_at 不变 |
| 工具批量绑 CLOSED | 调 `triage_signal(batch_bind, issueNumber=1319, filterSignalType=...)` | 返回错误；所有匹配行不变 |
| 面板绑 CLOSED | POST 等价 controller 调用 | HTTP 422；信号保持未接单 |
| OPEN 回归 | 单条、批量、面板分别绑 OPEN #1760 | 既有写库结果不变 |
| 查询失败 | gh 不存在、非零退出或返回畸形 JSON | fail-closed；无信号写入 |
| 真实目标只读核验 | `gh issue view 1319/1760 --json state` | 分别 CLOSED/OPEN；不向生产 signals 写测试数据 |

### 失败用例证据

- 修复前：`npx vitest run tests/interface-adapters/agent-runtime/tools/rhi-signal-issue-state.test.ts tests/api/rhi-signal-issue-state.test.ts` → 2 files、5 tests 中 **3 failed / 2 passed**；单条与批量工具均未报错，面板返回 200 而非 422。首次运行的 0-test import 错误是测试路径修正前的无效证据，不计入红测。
- 修复后：同命令 → **2 files / 5 tests 全通过**；相关 9 files / 99 tests 全通过；全量 `npm test` → **434 files / 5698 tests 全通过**（2026-11-05 16:05 本地实测）。
- 复现：对真实 CLOSED #1319 的等价边界注入，在工具与 API 入口发起归口；断言错误与数据库零写入。真实 GitHub 只读状态另核 #1319=CLOSED、#1760=OPEN。

### 最简实现检查

已过最简检查：采用仓库已有 gh CLI 取数模式 + 一个共享前置函数；不改 repository 同步 API、不引入依赖、配置、缓存或定时扫描。旧工具测试仅在外部 GitHub 边界固定 OPEN，不改既有归口断言。

## 自检

- [x] 相关回归、全量测试、TypeScript、ESLint、build、docs/intent/tests/capability 闸通过；capability/docs 的既有 warning 未增加。
- [x] 真实 GitHub 只读状态核验：#1319=CLOSED，#1760=OPEN；未向生产 signals 写测试数据。
- [x] 无 UI/schema/迁移/兼容桥；负面对照证明 CLOSED 与查询失败均不写库。
- [x] 失效文档核查：本变更不使既有状态机设计失效，只补原设计遗漏的目标有效性；历史文档不回改。
- [ ] 异体对抗审视与 CI：PR 创建后执行。

## 影响与回滚

只影响 RHI 归口写路径；in_progress/dismiss、healing 事件归口和 GitHub 关单本身不变。无 schema/数据迁移。回滚 revert 本特性提交即恢复旧行为，但会重新允许僵尸归口。
