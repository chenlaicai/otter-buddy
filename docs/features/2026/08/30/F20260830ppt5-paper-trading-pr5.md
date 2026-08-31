---
id: F20260830ppt5
title: 纸面交易操盘循环（PR5）：定时任务 seed + 操盘獭 prompt + 干跑验证
date: 2026-08-30
status: development
summary: PR5 操盘循环落地——15:05 撮合 + 15:30 操盘獭定时任务（幂等 seed 挂真实 conversation）、操盘獭 prompt、自选池管理、3 交易日干跑验证；含对抗审视 5 严重发现修复 + 大獭补真实启动冒烟 13/13
created_in_conversation: 7df22e6e-caba-4fc9-a3ab-1e9e2a3ff02d
capability_test: "n/a: 纯 A 类改动（定时任务基建 + 测试），不涉及 LLM 行为"
---

# F20260830ppt5: 纸面交易操盘循环（PR5）

> 承接 [F20260829ppta](./../08/29/F20260829ppta-paper-trading-ai-fund.md)（PR1-PR4 已合入）——本篇为 PR5（操盘循环）的实现与验证。方案 v2「待完成（PR5）」四项即本特性任务清单。

## 背景

F20260829ppta PR1-PR4 已交付纸面交易引擎（账本/撮合/净值/日报/企业行动），PR5 补齐操盘循环最后一块：**让系统每个交易日自动运行**——15:05 撮合待成交订单、15:30 操盘獭分析自选池并下单。

原 PR5 曾直接修改 F20260829ppta 文档（追加「实现状态（PR5）」节）——按终审意见（2026-08-30），特性文档分篇：每 PR 一个文档，不回改已归档篇目。

## 实现内容

### 1. 定时任务 seed（幂等）

- **15:05 撮合任务**：`executor_type: 'function'`，functionName=match\_orders，cron `5 15 * * 1-5`（工作日）
- **15:30 操盘獭任务**：`executor_type: 'agent'`，cron `30 15 * * 1-5`，body 携带 prompt + 自选池
- **ensure 真实 conversation + bigOtterId**（对抗审视发现 1 修复）：`ensurePaperTradingConversation` 仿 healing 先例（[F20260818shec] ensure-healing-conversation）创建真实对话满足 FK，settings 缓存 id 幂等复用；`talkingStonePassedTo` 指向真实 bigOtterId（发现 3 修复），不使用幽灵 `system` id
- prompt 文件读取失败 fail loud（不落残废任务），外层 catch 记 error 不吞错

### 2. 操盘獭 prompt

`prompts/scheduled/paper-trading-daily.md`：

- 流程：`is_trading_day`（非交易日一句话收工省 token）→ 读自选池 → stock\_data 逐票分析（四层结论）→ `submit_order`（reason ≥30 字符含当日数据锚点：收盘价/信号值/仓位数据）→ speak 两段式日报
- **数字禁区**：日报数字段取 `report` 命令引擎渲染的 `numbersMd` 原样引用（带 report id），禁止自算任何绩效数字；理由与解读段自由撰写
- **工具面限定**（prompt 注入面防线）：分析工具仅 stock\_data 与 paper\_trade，日报用 speak 输出（措辞修复见发现 5 对策——原文「只有两个工具可用」与 speak 自相矛盾）
- 账本写通道仅限 submit\_order，无其他写通道

### 3. 方案一致性要点

- **自选池管理**：存定时任务 body（备选方案——原方案 otter\_context 按 otterId 隔离，跨 session 不成立）。初始池 600519/000001/300750；搭档维护 + AI 提议确认。存储结构问题已建 issue #610
- **日报两段式**：数字段（引擎渲染）+ 理由段（AI 撰写）——数字不可自算，确保与账本表一致
- **重启对齐**：15:30 任务 `restartBeforeInvoke: true`（每日新 session 防上下文污染）；15:05 撮合任务为 function executor 无 session 概念，不重启

### 4. 干跑验证（集成测试）

`tests/usecases/paper-trading/pr5-dry-run.test.ts`：

- 模拟 3 个交易日全链路：下单 → 撮合 → 净值 → 日报
- **强断言**（发现 4 修复）：`parseNumbersMd` 逆解析日报四项数字（现金/持仓市值/总资产/净值），与 paper\_nav\_history 表值 `toBeCloseTo` 逐项比对（误差 <0.01）——从 `toContain('600519')` 弱断言升级
- 新增 `getFirstActiveAccountId` 测试（有账户/无账户两态）+ `match_orders` 缺省 accountId 自动取值测试

### 5. 撮合链修复（发现 2）

`register-functions.ts` 的 `match_orders` 函数补缺省逻辑：

- `accountId` 缺省时取首个 active 账户（与工具链同口径）；无账户时 **fail loud** 抛错，不静默空转
- `tradeDate` 缺省取今日 Asia/Shanghai（`toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })`，时区安全写法，禁 toISOString——N1 教训）

### 6. 数据模型补齐

`PaperTradeRepositoryImpl.createAccount` 同时初始化 `paper_cash` 表（初始资金 = initialCash）——否则首笔撮合前 getCash 查无此行。

## 对抗审视与验证记录

### 审视轮次

| 轮次 | 审视者 | 模型 | 结论 |
|------|--------|------|      |
| 初轮 | 海星 | glm（异模型） | 5 严重 + 3 建议，需修改 |
| 修复轮 | 墨鱼 | mimo | commit 5b3b1320，5 严重全部对症 |
| delta 复核 | 海星 | glm | **通过**，可进终审 |

### 5 严重发现 → 修复对照

| # | 发现 | 修复 | 验证 |
|---|------|------|      |
| 1 | seed FK 必败（`conversationId:'system'` 幽灵 id） | ensurePaperTradingConversation（真实对话 + settings 缓存幂等） | 冒烟 S1a-h + 海星独立复跑 |
| 2 | 撮合链双断线（accountId:'default' 无人创建；tradeDate 缺省静默 false） | 缺省取值 + fail loud + 时区安全写法 | 冒烟 S3/S4 + 海星加强冒烟 4/4（真成交） |
| 3 | 操盘獭幽灵 otter（`talkingStonePassedTo:['system']`） | 指向真实 bigOtterId | 冒烟 S1h 对账参与者表 |
| 4 | 弱断言（`toContain('600519')` 测不出一致性） | parseNumbersMd 逐项 vs 表值（toBeCloseTo 误差 <0.01） | 测试内嵌断言 |
| 5 | 文档 F-claim 跑在代码前 | 实现状态如实改写（现已分篇至本文档） | 逐条对账 |

### 真实启动冒烟（大獭补做，脚本存对话工作区 pr596-smoke-script.ts）

真实 sqlite（文件 DB + FK=ON）+ initSchema + 全真实 repo 链，唯一 stub 为 agentGateway（pi session 基建，不在 FK 链上）：

- **S1 seed 落库（8 项）**：专用 conversation 创建、恰好 2 任务、15:05 function / 15:30 agent 两条 cron 正确、挂真实 conversationId、大獭参与者存在、body 含 prompt+watchlist、talkingStone 指向真实参与者
- **S2 幂等重跑（2 项）**：重跑仍 2 任务、settings 缓存生效未新建 conversation
- **S3 fail loud（1 项）**：无账户撮合抛错不空转
- **S4 建户后撮合（2 项）**：缺省路径真跑通、paper\_cash 初始化
- **结果：13/13 通过**；海星 delta 复核时独立复跑并加强（真成交验证 4/4——下单后 `match_orders({})` 真撮合 1 单、持仓 100 股 @开盘价落库）

### 遗留观察（非阻断，已留痕）

1. 缺省撮合只处理首个 active 账户——单账户假设下正确，多账户是未来需求
2. 15:30 任务由大獭执行（prompt 角色靠文案支撑）——独立操盘獭 otter 留待未来
3. watchlist 耦合 body 的存储结构问题——issue #610

## 改动范围

| 文件 | 类型 | 说明 |
|------|------|      |
| src/usecases/paper-trading/ensure-paper-trading-scheduler.ts | 新增 | PR5 seed（ensure 真实 conversation + bigOtterId + 幂等） |
| prompts/scheduled/paper-trading-daily.md | 新增 | PR5 操盘獭 prompt |
| src/frameworks/db/paper-trade-repository-impl.ts | 修改 | PR5: createAccount 初始化 paper_cash + getFirstActiveAccountId |
| src/usecases/paper-trading/paper-trade-repository.ts | 修改 | PR5: 新增 getFirstActiveAccountId 接口 |
| src/usecases/paper-trading/register-functions.ts | 修改 | PR5: match_orders 缺省 accountId/tradeDate 自动取值 |
| tests/usecases/paper-trading/pr5-dry-run.test.ts | 新增 | PR5: 干跑验证（强断言） |
| src/bootstrap/platforms.ts | 修改 | PR5: seed 挂真实 conversation（含 #612 js-yaml 修复，rebase 带入） |
| tests/usecases/paper-trading/ledger.test.ts / sync-trading-calendar.test.ts | 修改 | getFirstActiveAccountId 相关单测补齐 |
| docs/features/2026/08/30/F20260830ppt5-paper-trading-pr5.md | 新增 | 本文档（终审分篇意见落地） |

## 验证

- PR5 干跑测试：6/6 passed（含 getFirstActiveAccountId 两态 + 缺省取值 + 强断言全链路）
- 真实启动冒烟：13/13（大獭）+ 加强版 4/4（海星，真成交）
- CI：run 33301681906 success（对应 fix commit）——rebase 后 run 33345501245 参见 PR 页
- 全量测试（海星独立复跑）：2217 passed / 0 failed（rebase 前基线）；rebase 后见 CI

## 关联

- 前案：[F20260829ppta](./../08/29/F20260829ppta-paper-trading-ai-fund.md)（PR1-PR4）
- 审视报告：对话工作区 pr596-star-review.md（产物 5a886877）
- 冒烟脚本：对话工作区 pr596-smoke-script.ts
- issue #610：watchlist 存储结构
