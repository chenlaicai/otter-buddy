---
id: F20260902ssfb
title: 'stock-cli 数据源降级链：东财拒连时新浪 K 线 + 百度估值兜底，修复 finance NaN 致 JSON 解析失败'
doc_type: feature
summary: |
  2026-09-01 起东财行情域名（push2his/push2.eastmoney.com）持续拒连，
  kline 与 overview 全挂，操盘循环连续两天零数据零交易。三项修复：
  1) kline 加新浪备源（东财失败自动切换，补算 change/change_pct/amplitude，
     结果标记 source 字段）；
  2) overview 加百度估值备源（PE-TTM/PB + 三年分位，非东财域）；
  3) finance 的 NaN 字面量修复——akshare 返回的 NaN 经 json.dumps 输出
     非标准 JSON 字面量导致 JS JSON.parse 拒收（MCP 包装层报「输出非 JSON」），
     模块级 _normalize 将 NaN/Inf 归一化为 null + allow_nan=False 保险丝。
status: final
change_type: fix
tags: [stock-cli, akshare, fallback, data-source, paper-trading, bugfix]
modules: [scripts/stock-cli.py, tests/test_stock_cli.py]
created_in_conversation: 53d775fd-2167-465a-ae2e-c6962d5f4dfb
capability_test: "n/a: 纯 Python 脚本层修复（非 prompt/协议软代码），行为由 7 个新增 pytest 用例覆盖"
causal_links:
  from:
    - F20260826scl1   # stock-cli 初建（数据桥）
    - F20260829ppta   # 纸面交易系统（下游消费方）
---

# F20260902ssfb: stock-cli 数据源降级链 + finance NaN 修复

## 背景（生产故障实证）

- 2026-09-01、09-02 连续两个交易日：selftest 8 项中 3 挂（kline/overview_info/overview_quote），
  5 活（finance/news/northflow/hkline/hvaluation）
- 挂的接口全部指向东财行情两台主机（push2his / push2.eastmoney.com）：
  MCP 进程内 ProxyError（代理不可达）+ curl 直连 0.2s 被掐（服务器空回复）——持续拒连，非偶发
- 活的接口全部走新浪/百度域（finance=新浪、hkline=新浪、hvaluation=百度、news=东财另一域）
- **影响砍在要害**：kline 挂 → 技术面（MA5/20/60、量能）无数据；overview 挂 → 估值面（PE/PB 分位）无数据。
  操盘任务规定订单 reason 必须引用当日数据锚点，无数据即无锚点 → 连续两天风控性空仓
- **伴随 bug**：finance 命令虽然 selftest ok，但 MCP 包装层报「输出非 JSON」——
  akshare 财务表中存在 NaN 值，`json.dumps` 默认输出 `NaN` 字面量（Python 特有扩展，
  JS `JSON.parse` 拒收）

## 方案

三处修复，全部在 `scripts/stock-cli.py`（akshare 封装层），不改 MCP 包装层：

### 1. kline 主备源链（东财 → 新浪）

- 主源 `stock_zh_a_hist`（东财）失败或空 → 备源 `stock_zh_a_daily`（新浪）
- 新浪源差异处理：
  - 列名已是英文（东财中文列经 col_map rename 对其无操作）
  - 补算东财有而新浪无的列：`change`/`change_pct`（由 close shift 求出）、
    `amplitude`（(high-low)/close_prev）——首行 close_prev 为 NaN，由修复 3 兜底转 null
  - `amount` 新浪本来就有（实测验证），量纲一致
  - volume 量纲：新浪为股，东财为手（×100）——结果带 `source` 字段，调用方可感知
- 双源全挂：返回结构化错误（`sources` 数组含两源错误明细，替代原单源错误）

### 2. overview 百度估值备源

- 东财双接口（stock_individual_info_em + stock_bid_ask_em）全挂时，
  调 `stock_zh_valuation_baidu`（百度域，同港股 hvaluation 数据源）
- 提供 PE-TTM/市净率当前值 + 三年 min/max/分位——估值面分析恰好够用
- 部分成功（东财任一接口活）：保持原逻辑，warnings 记录失败明细

### 3. finance NaN 归一化（root fix）

- 模块级 `_normalize()`：递归把 float NaN/Inf 转 None（序列化为 null，合法 JSON）
- `json.dumps(..., allow_nan=False)` 作保险丝：漏网的 NaN 直接抛异常走 die 路径，
  而不是输出坏 JSON 让下游解析失败
- 全命令生效（不只 finance）——任何命令的 NaN 都会毒化 stdout

## 验证

- **真实环境验证**（2026-09-02 东财真挂的活体测试）：
  - `kline 600519 --days 30` → source=sina，30 日 OHLCV + 补算列完整，收盘 1292.01
  - `overview 600519` → valuation 块含 PE 19.92（三年分位 17.3%）/ PB 6.46（分位 10.8%），warnings 带东财错误明细
  - `finance 000001/300750` → node JSON.parse 通过（修复前必炸）
- **测试**：`pytest tests/test_stock_cli.py` 44/44 通过（存量 37 + 新增 7：
  kline 备源成功/双源全挂/东财正常不走备源，overview 备源成功/全挂报错，NaN 归一化 ×2 + 端到端）
- 存量测试适配：`test_kline_akshare_error`/`test_error_result_exits_nonzero`
  补 mock 备源（否则 fallback 会打真实新浪接口，测试变 flaky）
- **最简实现检查**：已过——零新依赖（akshare 已含两个备源接口）、零 MCP 层改动、
  复用 hvaluation 同款百度估值逻辑（历史可算分位）
- **无 golden gate**：本次不改 prompt/skill/协议层（纯 Python 数据脚本）

## 影响范围

- `stock_data` 工具的 kline/overview/finance 三个命令——MCP 调用方（操盘獭定时任务、
  stock-analysis skill）无感升级：东财正常时行为不变（source=eastmoney），
  东财挂时自动降级不再全灭
- 其余命令（news/northflow/hkline/hvaluation）不受影响
- NaN 修复对全部命令生效

## 遗留

- 东财域名拒连根因（代理配置 or IP 封禁）未定位——降级链保证可用性，但主源恢复
  后建议核查 selftest 何时转绿；如长期不恢复可考虑调整主备顺序
- 新浪源 volume 量纲为股（东财为手）：下游做量能对比时注意 source 字段；
  若产生实际困扰可在备源层做 ×100 对齐（本次未做，避免引入隐性数据变换）
- overview 备源仅估值数据（无股本/市值等基本信息）——东财恢复前 basic_info 缺席
