---
id: F20260827ppta
title: 纸面交易账户：AI 操盘模拟系统（PR4 账本引擎 + PR5 操盘循环）
summary: "搭档拍板路线1本机纸面账户：固定逻辑账本引擎（券商边界原则）+ AI 双操作面（行情/下单）+ 定时决策循环，模拟一个月验收。v2 含对抗审视 13 项处置（涨跌停/复权口径/交易日历/executor/日报结构化）"
change_type: feature
created_in_conversation: "7df22e6e-caba-4fc9-a3ab-1e9e2a3ff02d"
status: development
capability_test: "n/a: 账本引擎纯计算无 LLM 参与；操盘循环走单测+干跑验证"
tags: [stock, paper-trading, ledger, agent-loop]
from:
  - F20260826scl1
  - F20260826scd2
  - F20260826scd3
  - F20260826scd4
---

# 纸面交易账户：AI 操盘模拟系统

> **v2 修订**：白鲸对抗审视（7 严重 + 6 建议）全部处置完毕，处置明细见文末「决策史」。骨架未变，收紧了撮合保真度、价格口径、基础设施归属、日报结构化四方面。

## 背景

搭档原话（意图锚）：

> 「那要不，你还是回到方案1，本机先搞，然后我看看你操盘一个月的效果如何；但是，我觉得必须要分清楚哪些是 软件系统（固定计算逻辑），然后你每次操作只能操作 每天的真实大盘数据和 买入卖出，不能去动 收益计算这些，防止收益计算错误」

> 「我之前一开始预想的效果是，你作为经理直接帮我管理一个账户」（前一条消息）

背景脉络：股票数据层三期已合入（#467/#473/#491 港股+操作参考 #499），stock_data 工具与 stock-analysis skill 已可用。搭档要求升级为「AI 作为基金经理直接操盘」：模拟一个月验收效果，通过后再评估真实资金通道（券商 miniQMT 等，因 Windows/权限门槛暂缓）。

## 目标

T1: **固定逻辑账本引擎**——虚拟账户的撮合、持仓、收益、净值全部由确定性代码计算，带单元测试锁死，AI 无任何工具可篡改（「券商边界」原则）
T2: **AI 双操作面**——AI 仅能：① 读取真实大盘数据（复用 stock_data）② 提交买卖订单（新增 paper_trade 工具）。无第三口
T3: **定时操盘循环**——交易日每日定时：扫自选池 → 分析 → 生成订单 → 次日撮合 → 留痕决策理由
T4: **可复盘**——每笔交易关联决策理由（当时为什么买卖，含数据锚点）；绩效日报/周报数字段由账本引擎渲染，AI 只引用不许自算
T5: **验收产出**——模拟一个月后的绩效报告：净值曲线、vs 沪深300 对比、逐笔交易与理由对照

## 非目标

- 真实资金通道（miniQMT/富途）——模拟验收通过后另立 issue
- 盘中实时交易——本阶段 T+1 日频循环，决策基于日线收盘数据
- 期权/融资融券/港美股——仅 A 股现货（数据层已就绪，港股留给后续）
- 自建行情源——全部复用 stock_data（stock-cli.py + akshare）
- 分红送转的自动处理——检测告警+人工录入因子（见「除权处理」），不自动调整

## 方案设计

### 总体架构（信任边界）

```
┌─ AI 操作面（不信任边界）────────────────┐
│  stock_data（只读，已有）               │
│  paper_trade（新增：下单/查账，走账本）  │
└──────────────┬─────────────────────────┘
               ↓ 只能通过这两个口
┌─ 账本引擎（信任边界内，固定逻辑）────────┐
│  订单队列 → 撮合器（T+1 次日开盘价）     │
│  持仓表 / 成交记录 / 现金 / 净值曲线     │
│  风控闸（限额/仓位/熔断）——先于撮合      │
│  撨合执行器（function executor，无 LLM） │
│  SQLite 持久化（better-sqlite3，已有栈） │
└────────────────────────────────────────┘
```

### 价格口径（全链路声明）

**行情、撮合、成本、市值、净值，全链路统一使用不复权价（adjust=""）。**

- 撮合价 = T+1 日不复权开盘价；持仓成本 = 成交时不复权价；市值 = 当日不复权收盘价
- 理由：不复权价是「真实成交价」口径，与模拟撮合语义一致；前复权价随除权改写历史，若成本按前复权记账，除权日后口径分裂、收益计算失真（搭档红线的字面命中）
- stock-cli kline 默认 `adjust="qfq"`（前复权）——**账本引擎调用 kline 时显式传 `adjust=""`**，代码注释注明原因

### 数据模型（新增表，schema.ts）

```sql
paper_account       -- 账户：id, initial_cash(默认 1000000), created_at, status
paper_positions     -- 持仓：account_id, code, shares, avg_cost, updated_at
paper_orders        -- 订单：id, account_id, code, side(buy/sell),
                    --   shares, reason(决策理由, ≥30字符), created_at,
                    --   status(pending/filled/rejected/expired), reject_reason
paper_trades        -- 成交：order_id, code, side, shares, price, fee,
                    --   trade_date, executed_at
paper_nav_history   -- 净值：account_id, date, cash, market_value, total, nav
paper_reports       -- 日报/周报存档：id, date, type(daily/weekly),
                    --   numbers_md(引擎渲染的绩效数字段), created_at
trading_calendar    -- 交易日历：date, is_trading_day, year
```

关键约束：
- 撮合价、费率计算只在账本引擎代码中出现；paper_orders.reason 只写不改
- 新增字段消费方声明（#379 ⑥）：paper_nav_history 消费方=绩效报告与日报生成；paper_trades.fee 消费方=净值计算；paper_orders.reason 消费方=复盘报告（AI 引用展示）；paper_reports.numbers_md 消费方=操盘獭日报引用与搭档核对

### 撮合规则（固定逻辑，写测试锁死）

1. **次日开盘价成交**：T 日产生的订单，T+1 日以不复权开盘价撮合（防前瞻偏差：决策只能用 T 日收盘前的数据）
2. **撮合时点 15:05**（收盘后）：撮合任务在 T+1 日 15:05 执行，取当日完整 K 线 bar 的开盘价成交——盘后历史接口当日 bar 必然可得，规避盘中数据可用性风险；语义不变（成交价仍是 T+1 日开盘价），只是撮合动作发生在收盘后。**成交确认时点 = T+1 日 15:05，trade_date = T+1**——T+1 卖出限制按 trade_date 判定：T+1 日成交买入的持仓最早 T+2 日卖出（与真实 A 股 T+1 规则一致），单测锁定此语义（白鲸 D1）
3. **T+1 卖出限制**：当日买入的股票当日不可卖（A 股规则），按成交记录 trade_date 校验
4. **涨跌停可成交性校验**：撮合前计算涨跌停价（`round(prev_close × (1±幅度), 2)`，四舍五入到分）——开盘价 ≥ 涨停价时买单不成交（保持 pending，reject_reason 循环标注 limit-up）；开盘价 ≤ 跌停价时卖单不成交（标注 limit-down）。幅度规则表：主板 ±10%、创业板（30xxxx）/科创板（68xxxx）±20%、ST ±5%、北交所（8xxxxx/4xxxxx）±30%。**一字板即不成交，不模拟盘中开板——偏保守方向**（模拟收益偏悲观而非虚胖，验收公正性优先）
5. **费用模型**：佣金万 2.5（最低 5 元）+ 印花税卖出千 1 ——固定参数写入引擎配置
6. **整手约束**：买入必须 100 股整数倍；卖出可清零碎股
7. **订单过期**：pending 订单 5 个交易日未撮合自动 expired（如连续一字板/停牌）
8. **撮合顺序**：同批订单按 created_at 提交序逐单撮合；买单预检现金（含费用）不足拒单；卖单校验持仓（含 T+1 限制）不足拒单（reject_reason: insufficient_position）
9. **幂等**：submit_order 时同交易日同 code+side+shares 已存在 pending/filled 订单 → 拒绝并返回原 order_id（防 LLM 重试导致重复成交）
10. **reason 质量约束**：引擎校验 reason ≥30 字符；操盘獭 prompt 要求 reason 引用当日数据锚点（收盘价/信号值/仓位数据）

### 除权处理（检测告警 + 人工录入，非自动）

- 撮合任务每日检查持仓票：当日不复权开盘价 vs 昨收盘跳空幅度超出涨跌停可解释范围（如主板 >11%）→ paper_reports 标注「疑似除权，待人工确认」
- 确认除权后，由**运维 CLI 脚本**（非 agent 工具，AI 无调用通道）录入除权因子调整持仓股数与成本——券商边界不动摇：AI 物理上没有调整账本的工具
- 一个月模拟期内分红送转事件概率低（自选池 3-5 票），人工录入成本可忽略

### 风控闸（先于撮合，固定逻辑）

| 规则 | 默认值 | 说明 |
|---|---|---|
| 单日下单限额 | 10 笔/交易日 | **按交易日计数**（非日历日）；防 AI 失控刷单 |
| 单票仓位上限 | 20% | 以 T 日收盘市值计 |
| 单票最小持仓期 | 无 | 暂不设，观察一个月数据后再定 |
| 现金不足拒绝 | 引擎判定 | 买单预检现金（含费用） |
| 熔断 | 账户回撤 >10% 暂停开仓 | 只允许平仓，日报显式标注。**注意：连续一字跌停时卖单不成交（规则 4），熔断后的平仓同样受涨跌停约束——模拟不虚标逃生能力** |

### 估值口径

- nav 每日收盘后计算一次（15:05 撮合完成后，作为撮合任务收尾步骤）
- 持仓市值按当日不复权收盘价；无当日 bar（停牌）按最近可得收盘价
- nav = total / initial_cash；total = cash + Σ(持仓市值)

### AI 操作面：paper_trade 工具设计（TS 工具，复用 PR2 模式）

聚合式单工具，命令枚举：
- `submit_order`（code, side, shares, reason 必填，幂等校验）→ 引擎校验+入队，返回 order_id
- `account`（账户快照：现金/持仓/净值，只读）
- `orders` / `trades`（订单/历史成交，只读）
- `nav`（净值历史，只读）
- `perf`（绩效指标：收益率/最大回撤/vs 沪深300，由引擎计算，基准数据来自 index 命令）
- `report`（按日期取引擎渲染的日报/周报数字段 markdown + report_id，操盘獭引用）
- `is_trading_day`（查交易日历，操盘獭每日第一步调用）

**工具不做**：任何写入账本数值的命令（无 update/patch/delete）——submit_order 是唯一写入口，且写的只是「订单」，不是账

### 权限矩阵

| 角色 | paper_trade 命令面 | 说明 |
|---|---|---|
| 操盘獭（small, paper 组） | 全命令 | 设计中的唯一下单者，prompt + 风控闸双重约束 |
| 大獭（big, tools: "*"） | 全命令（manifest 通配，自动获得） | **接受并论证**：模拟账户阶段资金虚拟，最坏情形=风控闸限额内（10 笔/日、单票 20%）的虚拟损失，全程留痕可复盘；真实资金阶段（后续 PR）必须升级 manifest 支持命令级白名单（已记入待办） |
| 撮合执行器 | 不经工具面 | function executor 直接调引擎函数，无 agent 会话 |

### 操盘循环（PR5，复用 scheduled_tasks + 新增 function executor）

- **每日 15:05 定时任务（function executor，无 LLM）**：撮合任务——交易日判断 → 取 pending 订单以当日开盘价撮合（涨跌停校验）→ 更新持仓/净值 → 除权检测 → 渲染当日绩效数字段存 paper_reports
- **每日 15:30 定时任务（agent，操盘獭新 session）**：第一步 `is_trading_day` 判断，非交易日直接收工（最小 token 消耗）→ 读自选池 → stock_data 逐票分析（stock-analysis skill 四层结论）→ 生成订单（submit_order，reason 含数据锚点）→ speak 日报
- **日报两段式（结构性防线）**：绩效数字段=引擎渲染的 paper_reports.numbers_md（含 report_id 锚定），操盘獭原样引用；决策理由与解读段=AI 撰写。搭档可随时 `report --id` 调引擎原文核对——数字不经 LLM 生成，篡改可发现且留痕
- **自选池来源**：搭档维护（对话里说「自选池加 600519」），存 otter_context；AI 可提议加入（需搭档确认）
- **周末**：周报任务——绩效 vs 沪深300、逐笔理由回放、下周计划（数字段同样引擎渲染）

### 基准数据（vs 沪深300）

stock-cli 新增 `index` 命令（akshare `stock_zh_index_daily`，symbol=sh000300），返回指数日线（不复权口径一致）。纳入 PR4 改动范围。perf 命令与周报的基准对比数据全部来自此命令，引擎计算区间涨跌幅。

### 交易日历

- trading_calendar 表：启动时从 akshare `tool_trade_date_hist_sina` 同步年度日历；同步失败 fallback 内置当年国务院节假日表
- 消费方：撮合任务（交易日判断）、订单过期（5 交易日计数）、单日限额（交易日口径）、操盘獭（is_trading_day 第一步）
- 非交易日：15:05 撮合任务直接退出；15:30 操盘獭第一步判断后收工——不烧分析 token

### 撮合执行器（基础设施扩展，归 PR4）

现有 scheduled_tasks 唯一执行形态 = cron → 发消息给獭 → LLM 会话（agent-invoker 核实）。**新增 `executor_type: agent | function` 字段**：

- `function` 类型：cron 触发时直接调用注册的引擎函数（撮合入口），不创建 agent 会话、不挂任何工具——「无 LLM」承诺的基础设施支撑
- 归属 PR4（账本引擎同批交付，因撮合入口是引擎函数）
- 兼容性：现有任务默认 executor_type=agent，行为不变

### PR 拆分

| PR | 内容 | 验收 |
|---|---|---|
| PR4 账本引擎+基础设施 | 5+2 表（含 trading_calendar/paper_reports）+撮合器+风控闸+paper_trade 工具+function executor+stock-cli index 命令+单测 | 撮合规则全路径单测绿（T+1/涨跌停/费用/整手/拒单/熔断/幂等/顺序）；seed 数据模拟 5 个交易日断言账本不变量（现金+持仓市值=总资产，误差<0.01）；function executor 触发撮合无 LLM 会话产生 |
| PR5 操盘循环 | 操盘獭 prompt+日报/周报格式+自选池管理 | 3 个交易日全链路实跑：操盘獭真实提交订单（模拟账户）、撮合任务真实执行，日报绩效数字段与 paper_nav_history/paper_orders 表逐日人审一致，reason 含数据锚点 |

## 影响范围

- 新增 domain/paper-trading 用例层（clean-architecture，同现有 otter/memory 分层）
- schema.ts 新增 7 表（迁移幂等，参照 signal_events 先例）
- scheduled_tasks 扩展 executor_type 字段（管理用例+执行器分支）
- tool-manifest.json：paper capabilityBlock，挂 big/small
- stock-cli.py：+index 命令
- 无现有功能破坏——纯增量（executor_type 默认 agent 兼容存量）

## 风险与约束

- **数据源依赖**：akshare 免费接口有不稳定风险（PR1 已遇东财端点代理墙）——撮合失败/行情缺失时订单保持 pending，次日重试，日报标注
- **AI 决策质量**：一个月样本不足以统计显著——日报持续给搭档看，验收标准由搭档主观判断（这是产品实验不是学术回测）
- **LLM 成本**：每日 15:30 分析自选池（假设 10 票×5 命令）约消耗数万 token/日——先小池（3-5 票）起步；非交易日零分析成本
- **涨跌停简化偏差**：一字板不成交是保守简化（真实市场盘中开板可成交），模拟收益偏悲观——方向正确（不会虚胖误导真实决策）

## 不兼容更新

无——纯新增模块。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 撮合时点 | T+1 开盘价成交，15:05 收盘后撮合 | 09:35 盘中撮合 | 成交价语义相同；盘后当日 bar 必然可得，规避盘中接口可用性实证负担 |
| 价格口径 | 全链路不复权 + 除权人工录入 | 全链路前复权 | 不复权=真实成交价口径；前复权随除权改写历史导致成本口径分裂 |
| 涨跌停 | 一字板不成交（保守） | 概率模拟盘中开板 | 保守方向偏差可接受；概率模型引入随机性破坏可复盘性 |
| 除权处理 | 检测告警+CLI 人工录入 | 引擎自动调整 | 调整账本的通道绝不对 AI 开放（券商边界）；事件概率低人工成本可忽略 |
| 收益计算 | 引擎独占 | AI 可算 | 搭档红线：「不能去动收益计算，防止收益计算错误」 |
| 日报数字段 | 引擎渲染+report_id 锚定 | AI 自由文本 | 结构性消灭抄错数字/选择性引用；篡改可核对可留痕 |
| 账本存储 | SQLite（复用现有栈） | JSON 文件 | 事务性+查询能力+与现有 schema 统一 |
| 大獭命令面 | 接受全命令（模拟阶段） | manifest 命令级白名单 | 风控闸兜底+全程留痕；真实资金阶段必须升级（待办） |
| 港股支持 | 本期不做 | 港股纸面账户 | 聚焦 A 股验证命题；港股撮合规则（T+0/汇率）另立 |
| 自选池管理 | 搭档维护+AI 提议确认 | AI 全权选股 | 起步阶段控制变量；AI 选股能力后续开放 |
| 操盘獭形态 | 每日新 session 定时唤醒 | 常驻獭 | 定时任务机制现成；新 session 防上下文污染 |

## 验证

- 单元测试：撮合器全路径（T+1/涨跌停四板块幅度/费用/整手/拒单/熔断/幂等/顺序/过期）、净值计算、估值口径（停牌票）、交易日历（节假日/周末）
- 集成干跑：seed 数据模拟 5 个交易日（含一字涨停买单、一字跌停卖单、现金不足拒单场景），断言账本不变量（现金+持仓市值=总资产，误差<0.01）
- executor 验证：function executor 触发撮合，日志断言无 agent 会话创建
- 操盘循环：PR5 实跑 3 个交易日，日报绩效数字段与表记录逐日人审一致

## 实现状态（PR4）

### 已完成

1. **数据模型**：schema.ts 新增 7 张表（paper_accounts, paper_positions, paper_cash, paper_orders, paper_trades, paper_nav_history, paper_reports, trading_calendar, paper_corporate_actions）
2. **账本引擎**：Ledger 类实现（撮合/风控/净值/日历/报告渲染）
3. **仓储层**：PaperTradeRepository 接口 + SQLite 实现
4. **AI 工具**：paper_trade 聚合工具（submit_order, account, orders, trades, nav, perf, report, is_trading_day）
5. **函数注册表**：FunctionRegistry 类 + 纸面交易函数注册（match_orders, calculate_nav, detect_corporate_action, render_daily_report）
6. **调度器扩展**：scheduler-service.ts 支持 executor_type='function'，直接调用注册函数无 LLM 会话
7. **基准数据**：stock-cli.py 新增 index 命令（sh000300 沪深300）
8. **工具注册**：tool-manifest.json 新增 paper-trading capabilityBlock
9. **单元测试**：ledger.test.ts + paper-trade-tool.test.ts

### 待完成（PR5）

1. **操盘循环**：每日 15:05 撮合任务 + 15:30 操盘獭任务
2. **日报格式**：两段式（引擎渲染数字段 + AI 撰写理由段）
3. **自选池管理**：搭档维护 + AI 提议确认
4. **实跑验证**：3 个交易日全链路实跑

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/db/schema.ts | 修改 | +7 表（5 账本表+calendar+reports） |
| src/usecases/paper-trading/* | 新增 | 账本引擎（撮合/风控/净值/日历/报告渲染） |
| src/usecases/scheduled-task/* | 修改 | executor_type 字段+function 分支 |
| src/interface-adapters/agent-runtime/tools/paper-trade-tool.ts | 新增 | paper_trade 聚合工具 |
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | 修改 | 注册 |
| config/tool-manifest.json | 修改 | paper capabilityBlock |
| scripts/stock-cli.py | 修改 | +index 命令（sh000300） |
| scripts/paper-adjust-corporate-action.ts | 新增 | 除权因子录入 CLI（运维通道，非 agent 工具） |
| tests/**/paper-trading/*.test.ts | 新增 | 引擎单测 |
| prompts/scheduled/paper-trading-daily.md | 新增 | 操盘獭任务文案（PR5） |
| docs/features/2026/08/27/F20260827ppta*.md | 新增 | 本方案+实现文档 |

## 待办（审视发现的后续项）

- **真实资金阶段前置**：manifest 升级支持命令级白名单（paper_trade 下单命令与只读命令拆分挂载）——模拟阶段接受全命令（见权限矩阵），真实资金不可接受。段落定位：权限矩阵节
- **盘中开板成交模拟**：若一个月模拟显示一字板场景高频出现且影响验收判断，再评估概率模型。段落定位：撮合规则 4

## 决策史

| 日期 | 事件 | 决策 |
|---|---|---|
| 2026-08-27 | 方案 v1 → 白鲸对抗审视（7 严重+6 建议，报告存工作区 paper-trading-design-review.md） | 13 项全部「接受并修复」，v2 修订落档：S1 撮合 executor_type 基础设施归 PR4；S2 涨跌停可成交性校验（一字板不成交，保守方向）；S3 全链路不复权口径+除权 CLI 人工录入；S4 stock-cli index 命令补基准数据源；S5 日报数字段引擎渲染+report_id 锚定；S6 trading_calendar 表+交易日口径；S7 PR4/PR5 验收标准改写为可判定。建议项：A1 权限矩阵节（大獭全命令+论证+待办）；A2 submit_order 幂等；A3 reason ≥30 字符+数据锚点；A4 估值口径节；A5 撮合时点改 15:05 收盘后（消灭盘中数据可用性实证需求）；A6 参数与边界清单补齐（initial_cash 默认 100 万、撮合顺序、持仓不足拒单）。处置无反驳项——13 条事实全部核实成立（manifest/agent-invoker/stock-cli 源码锚点） |

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 大獭 🦦
