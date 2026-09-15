---
id: F20260915desc
title: 定时任务 description 字段：面板任务描述与 function 型任务空白治理
summary: scheduled_tasks 表新增 description 列（≤500 字符人类可读描述），面板优先显示；未填时回退渲染 body（JSON 包装自动提取 prompt 字段）；function 型任务 body 为 '{}' 时显示「未填写任务描述」兜底。paper-trading 两个 seed 任务迁移时自动回填描述。create/update API、agent 工具、Web 编辑弹窗全链路支持。
change_type: feature
capability_test: "n/a: 纯字段透传 + UI 渲染逻辑，由单测覆盖（migration 2 个新用例 + repository 1 个新用例 + usecase 2 个新用例 + modal/section 全量回归通过）"
created_in_conversation: 53d775fd-2167-465a-ae2e-c6962d5f4dfb
doc_type: feature
tags: [scheduled-task, ux, description, paper-trading, web-ui]
modules: [src/entities/scheduled-task/, src/frameworks/db/, src/usecases/scheduled-task/, src/interface-adapters/http/, src/interface-adapters/agent-runtime/tools/, web/src/pages/conversation/]
created_at: 2026-09-15T15:03:00+08:00
intent:
  problem: "定时任务面板直接渲染 task.body——function 型任务 body 为 '{}' 导致面板一片空白（搭档实证：不知道 paper-trading-match-orders 是干啥的）；agent 型任务 body 是 JSON 包装（{\"prompt\":...}）直接裸渲也不可读"
  expected_effect: "面板每个任务都有一句话人类可读描述——填了 description 优先显示；未填 agent 型自动提取 body.prompt；function 型显示「未填写任务描述」明确提示，而不是一片空白"
  verify_by:
    type: behavior_check
---

# F20260915desc 定时任务 description 字段

## 背景

2026-09-15 搭档在纸面交易对话里看到两个定时任务，第一个（`paper-trading-match-orders`）面板上一片空白——function 型任务 `body='{}'`（无 prompt，直接调用后端函数），而 `ScheduledTaskSection.tsx:115` 直接裸渲 `task.body`，导致「我都不知道是啥内容」。

根因拆解：
1. **function 型任务没有人类可读描述**——名字 `paper-trading-match-orders` 不言自明度不够，不看代码不知道是「每个交易日 15:05 撮合昨日挂单」
2. **agent 型任务直接裸渲 body**——`daily-trading` body 是 `{"prompt":"# 操盘獭每日任务...","watchlist":[...]}` JSON 包装，面板看到的是 JSON 开头而不是任务说明

## 方案设计

字段：`scheduled_tasks.description TEXT`（nullable，CHECK ≤500 字符）

**面板显示优先级**（`resolveTaskPreview`）：
1. `description` 非空 → 显示 description
2. 未填 → agent 型尝试 JSON.parse(body) 提取 `prompt` 字段（去除 watchlist 包装）；非 JSON body 直接预览原文
3. body 为空/`'{}'`（典型 function 型）→ 显示「未填写任务描述」灰字提示，而不是一片空白

**全链路透传**：
- DB schema + migration（PRAGMA 幂等探测）
- 实体 `ScheduledTask.description: string | null`
- mapper/repository SQL（INSERT/UPDATE 均加列）
- usecase create/update input 校验（`isValidDescription` ≤500）
- HTTP DTO + controller
- agent 工具 `create_scheduled_task` 新增 `description` 参数（推荐填写）
- Web：`ScheduledTaskModal` 加字段（500 字符上限），`ScheduledTaskSection` 渲染优先级，api client DTO 同步

**存量任务数据回填**（迁移内一次性）：paper-trading 两个 seed 任务名字固定，按 `name` 匹配 + `WHERE description IS NULL OR description = ''` 幂等回填：
- `paper-trading-match-orders` → 「每个交易日 15:05 撮合昨日挂单：以当日开盘价撮合 pending 订单（涨跌停校验）→ 更新持仓与净值 → 除权检测 → 渲染当日绩效。」
- `paper-trading-daily-trading` → 「每个交易日 15:30 操盘獭上岗：分析自选池行情/财务/消息，提交当日买卖订单，并撰写日报（引擎数字段 + AI 理由段）。」

seed 代码（`ensure-paper-trading-scheduler.ts`）同步补 `description` 字段，新环境直接建出带描述的任务。

## 影响范围

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/entities/scheduled-task/scheduled-task.ts` | 修改 | `description` 字段 + `isValidDescription` 校验 |
| `src/frameworks/db/schema.ts` | 修改 | CREATE TABLE 加列 + CHECK 约束 |
| `src/frameworks/db/migration.ts` | 修改 | `addDescriptionColumn`（PRAGMA 幂等 + seed 回填） |
| `src/frameworks/db/scheduled-task/scheduled-task-mapper.ts` | 修改 | Row↔Entity 双向映射 |
| `src/frameworks/db/scheduled-task/sqlite-scheduled-task-repository.ts` | 修改 | INSERT/UPDATE SQL 加列 |
| `src/usecases/scheduled-task/manage-scheduled-task.ts` | 修改 | create/update 校验 + 赋值 |
| `src/interface-adapters/http/dto/scheduled-task-dto.ts` | 修改 | DTO + toScheduledTaskDTO |
| `src/interface-adapters/http/controllers/scheduled-task-controller.ts` | 修改 | create/update 透传 |
| `src/interface-adapters/agent-runtime/tools/scheduled-task-tools.ts` | 修改 | 工具参数加 description |
| `src/usecases/paper-trading/ensure-paper-trading-scheduler.ts` | 修改 | seed 任务带 description |
| `web/src/lib/mappers.ts` | 修改 | LocalScheduledTask/DTO 加字段 |
| `web/src/api/client.ts` | 修改 | Create/Update DTO 加字段 |
| `web/src/pages/conversation/ScheduledTaskSection.tsx` | 修改 | `resolveTaskPreview` + 渲染优先级 |
| `web/src/pages/conversation/ScheduledTaskModal.tsx` | 修改 | 表单加 description 字段 |
| `web/src/pages/conversation/ScheduledTaskModal.test.tsx` | 修改 | `fillRequiredFields` 用 maxLength=10000 锁定 body（description textarea 插在前面后选择器错位修复） |
| `tests/frameworks/db/migration.test.ts` | 修改 | +2 用例（补列幂等 + seed 回填不覆盖已有描述） |
| `tests/frameworks/db/scheduled-task/sqlite-scheduled-task-repository.test.ts` | 修改 | fixture 加 description + 1 新用例（null/有值两路） |
| `tests/usecases/scheduled-task/manage-scheduled-task.test.ts` | 修改 | +2 用例（500 上限校验 + 合法值落库） |
| `tests/usecases/scheduler/healing-analysis-template.test.ts` 等 4 个 | 修改 | fixture 补 `description: null` |

## 验证

- [x] TSC 通过（后端 + 前端 0 error）
- [x] 后端单测 3035/3035 通过
- [x] 前端单测 431/431 通过
- [x] `npm run check` 0 error 4 warning（全部 pre-existing：console/useEffect deps，与本次无关）
- [x] 新迁移用例 2 个通过（PRAGMA 幂等 + seed 回填不覆盖已有描述）
- [x] description 校验用例 2 个通过（501 字符拒 + null/有值落库）
- [x] repository 层 null/有值两路落库读取一致
- [x] 最简实现检查：已过阶梯——复用既有迁移（PRAGMA 幂等模式）/列校验（`isValidDescription` 仿 `isValidTimeoutMinutes`）/面板渲染（CSS class 复用），未引入新依赖/新表/新机制。checked: 已过最简检查

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 描述字段 | 新增 `description` 列 | 复用 body 或 functionName | body 是机器指令不是人话；functionName 只覆盖 function 型；新增列语义最清晰 |
| 必填性 | 可选 | 必填 | 存量任务无描述可回退渲染（body 提取 / functionName 徽标），强制必填会卡死老任务编辑 |
| 长度上限 | 500 | 100 / 2000 | 一句话到两句话说明，500 足够覆盖「干什么+什么时候干+产出什么」 |
| 面板兜底 | 提取 body.prompt | 直接显示 body 开头 | paper-trading-daily-trading 等 agent 任务 body 是 JSON 包装，直接截断会看到 `{"prompt":"...` 乱码 |
| function 型兜底 | 显示「未填写任务描述」 | 显示 functionName 徽标 | 空白会让搭档误以为坏了；functionName 徽标可作为后续增强，本 PR 先用文字提示兜底 |
| 存量任务 | 迁移内按 name 回填 paper-trading 两条 | 不回填 / 全部回填 | paper-trading 是唯一官方 seed 且名字固定，精准回填成本最低；其他对话自建任务由用户/獭后续补 description |

## 不兼容更新

无。新字段可选，存量任务 description 为 NULL 时面板走回退渲染（body 提取或「未填写」提示），不会出现比之前更差的体验。

## 后续动作

- agent 工具 `create_scheduled_task` description 参数已加「推荐填写」提示，观察后续獭建任务时的填写率
- 若填写率低，考虑在 daily-review 加一条「无 description 任务清单」检测（当前不动，机制预算约束）
