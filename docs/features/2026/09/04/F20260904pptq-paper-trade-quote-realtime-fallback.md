---
id: F20260904pptq
title: 纸面交易下单链路修复：新浪实时行情 quote 命令 + gateway 兜底链 + no-cache 参数错位
summary: 东财双路拒连 + 新浪日线 T-1 滞后双层故障致操盘獭连续 3 交易日无法下单。新增 stock-cli quote 命令（新浪实时行情当日价）作 gateway 取价兜底终点；修复 stock-tools --no-cache 拼接位置错误。
change_type: fix
capability_test: "n/a: 数据源故障修复，行为由单元测试覆盖（tests/frameworks/stock/stock-quote-gateway-impl.test.ts 新增 8 例 + tests/test_stock_cli.py 新增 7 例）"
created_in_conversation: 53d775fd-2167-465a-ae2e-c6962d5f4dfb
tags: [stock-cli, paper-trading, gateway, fallback, data-source, bugfix]
modules:
  - scripts/stock-cli.py
  - src/frameworks/stock/stock-quote-gateway-impl.ts
  - src/interface-adapters/agent-runtime/tools/stock-tools.ts
  - tests/test_stock_cli.py
  - tests/frameworks/stock/stock-quote-gateway-impl.test.ts
  - tests/interface-adapters/agent-runtime/stock-tools.test.ts
created_at: 2026-09-04
---

# 纸面交易下单链路修复：新浪实时行情 quote 命令 + gateway 兜底链 + no-cache 参数错位

## 背景（生产故障实证）

2026-09-01、09-03、09-04 连续三个交易日，操盘獭定时任务的买单全部被引擎拒绝：
`Market data unavailable: cannot place order without current price`（ledger.ts:464）。

9/2 的 F20260902ssfb 修复了**分析路径**（kline 走新浪备源、overview 走百度估值），
但**下单路径**没修——它的故障结构与分析路径不同，是双层叠加：

1. **层一（老问题）**：gateway executeKline 走 stock-cli kline → 东财主源拒连。
   F20260902ssfb 已加新浪日线备源，这层当时已兜住；
2. **层二（本次新发现）**：新浪日线当日更新滞后——15:58 实测 kline 最新记录仍停在 T-1（09-03）。
   gateway extractQuote 按 `date === 今日` 精确匹配 → 当日记录缺席 → 返回 null → 拒单。

实测网络定位（2026-09-04 15:56）：
- 系统代理 127.0.0.1:7897 本身健康（经代理访问新浪 200 OK）
- 东财 push2 双路全死：直连 Empty reply（1s）、经代理 Empty reply（0.36s）——服务端主动拒连，本机 IP 与代理出口 IP 均被风控，持续 4+ 天非偶发
- 新浪实时接口 hq.sinajs.cn 完全可用（当日 15:34 定格收盘价）——当日价的唯一可用源

连带 bug：stock-tools.ts buildCliArgs 把 `--no-cache` 拼在子命令后（stock-tools.ts:144），
argparse 只认顶层位置 → no_cache=true 必报 `unrecognized arguments`（9/4 操盘时实测触发）。

## 方案

三处修复，全部围绕"当日价必须有兜底源"：

### 1. stock-cli.py 新增 quote 命令（当日实时行情）

- 实现 fetch_sina_realtime()：urllib 直打 hq.sinajs.cn（GBK 解码、Referer 头必需、
  33 字段载荷解析：名称/今开/昨收/现价/最高/最低/日期/时间）
- 不依赖 akshare 版本（实时接口 akshare 封装层薄且版本间差异大），标准库实现
- 输出校验：字段数 <33、日期字段非日期格式 → 结构化错误（防接口改版静默错配）
- 代码验证实测（9/4 16:00）：600519 返回当日价 1330.0（今日大涨 +2.4%）、000001 返回 11.89

### 2. gateway 兜底链（stock-quote-gateway-impl.ts）

- 提取通用执行层 executeCliJson（spawn + JSON 解析 + 退避重试），kline/quote 复用
- getClosePrice：kline 日线匹配不到当日 → quote 兜底（**日期一致性校验防跨日错配**：realtime.date !== 目标日则拒绝）
- getPrevClose：当日缺席时取 quote 的 prev_close（目标日=今日场景）
- getTodayOpen：当日缺席时取 quote 的 open
- getQuotes：当日缺席时用实时行情拼最小 DailyQuote（open/close/prevClose 齐备，high/low 取实时值）——撮合路径不再因数据源故障整日卡 pending
- 所有兜底带 NaN 防御：quote 字段缺失时不兜底，宁 null 不脏数据

### 3. stock-tools.ts 修复 --no-cache 拼接位置

- executeStockCli 拼参时把顶层参数（--no-cache）过滤到子命令之前
- 加固现有测试：从"包含 --no-cache"升级为"位置在子命令之前"（旧断言放过位置 bug）

## 验证

- Python：pytest tests/test_stock_cli.py 51/51（新增 7 例：quote 正常/深市前缀/Referer 头/网络错/坏载荷/坏日期/错误结构）
- TypeScript：vitest 23/23（gateway 兜底链 8 例：兜底触发/日期错配拒绝/全挂 null/PrevClose/Open/Quotes 兜底拼装/正常路径不走兜底；stock-tools no-cache 位置断言加固）
- ledger 集成回归：tests/usecases/paper-trading/ + db 集成 28/28 通过
- tsc --noEmit 零错误
- 真实环境：quote 命令实测当日价正确（600519/000001）

## 影响范围

- paper_trade submit_order / 撮合 / 净值估值链路：东财挂 + 新浪日线滞后时从"整日拒单"恢复为"新浪实时价成交"
- stock_data 工具 no_cache 参数从必报错恢复可用
- 东财恢复正常后 kline 命中主路径，兜底链零开销（不会多打 quote 接口）

## 审视处置

对抗审视（检视獭-799，mimo，异模型）：0 严重 / 4 建议。

| 发现 | 处置 | 结果 |
|------|------|------|
| 1. executeQuote 丢弃 high/low，兑底 DailyQuote 退化 high=low=price | 本 PR 修复 | commit de11fe0a：extractor 保留字段，getQuotes 用真实日内高低，测试补断言 |
| 2. 新浪字段索引 magic number | 建 issue #800 | 后续优化 |
| 3. executeCliJson 丢 stderr 收集 | 建 issue #801 | 后续优化 |
| 4. quote 是否暴露到 stock_data 工具 | 建 issue #802 | 待设计决策 |

## 遗留

- 东财域名拒连根因（IP 风控 or 代理出口指纹）仍未定位——本修复绕开而非解决；建议观察 selftest 何时转绿
- 新浪实时接口盘中返回的是最新成交价而非收盘价（15:30 定时任务运行时已收盘，语义一致；若未来任务时间改到盘中需重估）
- hq.sinajs.cn 无官方 SLA，若其也挂则当日价全灭（quote 是单源）——可考虑未来加腾讯行情备源
