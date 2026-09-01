---
id: F20260901wtpa
title: scheduled_task watchlist-only patch：自选池更新与 prompt 全文解耦
date: 2026-09-01
status: development
summary: issue #610——操盘獭任务 body 为 {prompt, watchlist} 全文 JSON，改自选池需整包重写 body 丢一字即坏。为 HTTP update 通道增加 watchlist-only patch 语义（服务端读旧 body 只替换 watchlist 字段），调用方不再携带 prompt 全文。含两方向选型论证（独立存储 vs patch 语义）
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
capability_test: "n/a: 纯 A 类改动（HTTP 更新通道 + 测试），不涉及 LLM 行为"
---

# F20260901wtpa: scheduled_task watchlist-only patch

> 承接 [F20260830ppt5](./../08/30/F20260830ppt5-paper-trading-pr5.md)（PR5 落地了操盘任务 seed，body 携带 prompt + 自选池）。本篇为 issue #610（PR #596 对抗审视海星建议 3 的跟踪修复）。

## 背景与问题

- **位置**：`src/usecases/paper-trading/ensure-paper-trading-scheduler.ts`（seed 组装 body）；HTTP 更新通道 `src/interface-adapters/http/controllers/scheduled-task-controller.ts`
- **问题**：操盘獭任务 body = `JSON.stringify({ prompt: <81 行全文>, watchlist: [...] })`。搭档改自选池（「自选池加 601318」）需整包重写 body——必须携带 prompt 原文，丢一字则 prompt 损坏，且 body 无 schema 校验兜底
- **注入面实测**：watchlist 变更通道唯一（HTTP PATCH update）；agent 工具面仅 create 无 update——不在本 issue 范围（见「非目标」）
- **存量盘点**（生产库 `data/otter-buddy.db`，2026-09-01）：操盘 agent 任务 1 条（body 1813 字符 JSON 信封），其余 8 条 agent 任务 body 均为纯文本——**JSON 信封是操盘任务独有的 body 形态**，不是通用约定

## 选型论证（issue 两方向对比）

issue #610 给出两个方向，逐项对比：

| 维度 | 方向 1：watchlist 独立存储（settings 表） | 方向 2：HTTP patch 语义（本次采纳） |
|---|---|---|
| 改动面 | settings 读写 + seed 拆分 + 运行时拼接（scheduler 消费侧）+ 存量 body 迁移 + prompt 第二步语义改写（「从任务 body 读自选池」→「从 settings 读」） | DTO + usecase 各一处，seed/调度器/prompt/前端零改动 |
| 操盘 prompt | 必须改写第二步（任务简报约束「不动操盘獭 prompt 的语义内容」→ 冲突） | 零改动——prompt 仍从 body JSON 读 watchlist，信封形态不变 |
| 架构纯净度 | 通用调度器被迫懂操盘业务（trigger 时查 settings 拼 body）——`ScheduledTask.body` 自包含语义被打破 | 调度器保持通用：body 仍是完整自包含 JSON |
| 存量兼容 | 需数据迁移（旧 body 拆出 watchlist 写 settings，body 去掉 watchlist） | 天然兼容：旧 body 本就是 `{prompt, watchlist}`，读旧改新即可 |
| 消费侧 | scheduler/agent 两处（运行时拼接点） | 零改动 |

**结论：采纳方向 2（watchlist-only patch 语义）**。理由：方向 1 的代价集中在「通用调度器懂业务 + prompt 语义改写 + 存量迁移」三点，收益（watchlist 成为独立资源、可被多任务共享）在当前只有 1 个操盘任务、1 个消费场景的现实下不成立。方向 2 用最小改动面（2 文件 + 前端 DTO 同步）直击 issue 痛点：**改自选池不再需要携带 prompt 全文，且服务端保证 prompt 原样保留**。

## 实现内容

### 1. usecase 层（`src/usecases/scheduled-task/manage-scheduled-task.ts`）

- `UpdateScheduledTaskInput` 新增可选字段 `watchlist?: string[]`
- 新增导出函数 `applyWatchlistPatch(body, watchlist): string | null`——读旧 body JSON、只替换 watchlist 字段、其余键原样保留；body 非 JSON 对象（纯文本/数组/标量）返回 null
- `update()` 中：`watchlist` 与 `body` 显式互斥（双传抛 validation）；patch 结果 null 抛 `DomainError('Cannot patch watchlist: task body is not a JSON object...')`（HTTP 映射 400，指引调用方走 full body update）；patched body 复查 10000 字符上限不变量
- 校验：watchlist 必须为非空字符串数组（元素代码格式不做 A 股假设——通用通道不预设业务）；**空数组合法**（操盘 prompt 对空自选池有明确行为：报告搭档「自选池为空」，清空是合法操作）

### 2. HTTP 层（DTO + controller）

- `UpdateScheduledTaskRequestDTO`（服务端 `src/interface-adapters/http/dto/scheduled-task-dto.ts` 与前端 `web/src/api/client.ts` 各自的拷贝）同步新增 `watchlist?: string[]`
- controller `update()` 透传 watchlist 字段——PATCH 请求带 `{"watchlist": ["601318", ...]}` 即完成自选池变更，无需 body

### 3. 使用示例

```bash
# 旧通道（脆弱）：改自选池必须携带 81 行 prompt 全文，丢一字即坏
curl -X PATCH /api/scheduled-tasks/<taskId> -d '{"body": "{\"prompt\": \"# 操盘獭每日任务...81行\", \"watchlist\": [...] }"}'

# 新通道：watchlist-only patch，prompt 服务端原样保留
curl -X PATCH /api/scheduled-tasks/<taskId> -d '{"watchlist": ["600519", "601318"]}'
```

## 兼容性（简报硬约束）

- **读侧**：调度器消费逻辑零改动——body 形态不变（仍是 `{prompt, watchlist}` JSON），操盘 prompt 第二步照常解析
- **写侧**：旧通道（整包 body 替换）保留且行为不变；新通道为增量语义，与旧通道互斥使用
- **存量任务**：无需迁移——生产库唯一操盘任务的 body 本就是 JSON 信封格式，天然支持 patch；纯文本 body 任务 patch 会被显式拒绝（400 + 原因说明），不会静默破坏

## 验证

- **单测**（`tests/usecases/scheduled-task/manage-scheduled-task.test.ts`，新增 8 用例，共 29 绿）：
  - patch 只替换 watchlist、prompt 原样保留、repo 落库、onChange 回调触发
  - 纯文本 body 拒绝 patch 且原 body 不被破坏；JSON 数组 body 同样拒绝
  - watchlist+body 双传互斥拒绝；非字符串数组拒绝；空数组合法
  - patched body 超 10000 上限拒绝（不变量对齐）
- **全量**：vitest 205 文件 / 2566 测试全绿；`tsc --noEmit` 零错误
- **最简实现检查**：已过——无新表、无新路由、无新依赖；复用既有 PATCH update 通道 + usecase 内 1 个纯函数。更简方案（仅前端拼 JSON）不满足「服务端保证 prompt 不动」的解耦目标，否决

## 非目标（issue 边界外）

- agent 工具面新增 update（issue 注明仅 create 无 update）——如需 AI 自主维护自选池再立项
- watchlist 独立存储（方向 1）——选型论证见上，现实不成立
- 操盘 prompt 语义改动——任务简报明确约束不动

## 关联

- issue：#610（Closes）
- 来源：PR #596 对抗审视（海星）建议发现 3
- 前文：F20260829ppta（纸面交易系统）→ F20260830ppt5（PR5 操盘循环，body 信封的引入点）

## 更名记录

本文档初版 ID 为 `F20260901wtlp`（后缀含 commit-msg 钩子禁用字符 `l`），PR 未合入前更名为 `F20260901wtpa`——属 PR 内重命名，非回改历史（铁律 F20260831dgim 不受影响），故 `BYPASS_HISTORICAL_DOC_LINT=1` 提交。

## 对抗审视记录（2026-09-01）

检视獭-680（mimo，异模型）：0 严重 + 1 建议，B1-B4 全过，大獭预检 6 项疑点全部核实通过。

**建议 1（接受并修复）**：patched body 超 10000 上限的报错与旧通道 body 超限不可区分——已改为 `'patched body exceeds 10000 character limit after merging watchlist'`，测试断言同步锁定区分性消息。修复 commit 见 PR #680。
