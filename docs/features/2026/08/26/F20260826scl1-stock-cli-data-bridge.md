---
id: F20260826scl1
title: 股票数据桥脚本入库（stock-cli 五命令）
summary: "PR1: 股票数据桥脚本入库 — scripts/stock-cli.py 单文件，封装 akshare 提供五命令数据查询"
change_type: feature
created_in_conversation: "7df22e6e-caba-4fc9-a3ab-1e9e2a3ff02d"
status: active
capability_test: "n/a: 纯 A 类脚本，无 LLM 参与行为"
---

# PR1: 股票数据桥脚本入库

## 背景

Issue #463 定义了股票数据层三期方案。PR1 是第一期：将 `scripts/stock-cli.py` 及配套测试与说明入库，为后续 PR2（TS 工具）和 PR3（skill）提供数据地基。

## 目标

- 新增 `scripts/stock-cli.py` 单文件，运行于 venv 内 Python
- 五个数据命令：kline / overview / finance / news / northflow
- 通用缓存机制（write-then-rename 原子写入）
- selftest 命令：跑一遍各接口校验返回字段
- 单行 JSON 输出 + 结构化错误

## 非目标

- PR2（stock_data TS 工具）和 PR3（skill）不在本 PR 范围
- 不改任何现有代码

## 方案设计

### 五命令 akshare 接口映射

| 命令 | akshare 函数 | 说明 |
|------|-------------|------|
| kline | `stock_zh_a_hist` | 日 K 线 OHLCV，默认摘要模式 |
| overview | `stock_individual_info_em` + `stock_bid_ask_em` | 基本信息 + 实时行情 |
| finance | `stock_financial_abstract` | 财务指标（新浪源） |
| news | `stock_news_em` | 个股新闻 |
| northflow | `stock_hsgt_fund_flow_summary_em` | 北向资金汇总 |

### 缓存机制

- 缓存目录：`.cache/stock/`（可通过 `STOCK_CACHE_DIR` 覆盖）
- 默认有效期：300 秒
- 原子写入：`tempfile.mkstemp` → `os.replace`
- `--no-cache` 强制刷新

### 安全机制

- 股票代码校验：`^\d{6}$`
- 错误输出：`{"error": "..."}` + 非零退出码
- 结构化错误包含 selftest 建议

## 影响范围

| 文件 | 变更类型 |
|------|---------|
| `scripts/stock-cli.py` | 新增 |
| `scripts/README-stock-cli.md` | 新增 |
| `tests/test_stock_cli.py` | 新增 |

## 取舍

| 决策 | 理由 |
|------|------|
| 单文件而非包结构 | PR1 范围小，单文件便于维护和移植 |
| akshare 为主路 | 设计文档指定 akshare 为主数据源 |
| 不做降级 | 设计文档明确"不要静默降级到爬虫" |
| 用 pytest 而非 vitest | Python 脚本用 Python 测试框架 |

## 验收标准

- [x] 五命令可执行（参数校验通过）
- [x] 缓存机制正常（36 项单元测试全绿）
- [x] 结构化错误输出（错误路径 exit=1）
- [x] 真实冒烟（3/6 通过，详见下方）
- [x] README 包含安装和使用说明

## 冒烟测试结果

### 真实冒烟（大獭沙箱 + 白鲸独立沙箱）

**通过（3/6）**：
- finance: 茅台 100 个季度财报数据
- news: 8/15 中报新闻「净利 445 亿同比-1.95%」
- northflow: 北向资金汇总数据

**失败（3/6）**：
- kline/overview_info/overview_quote: 东财端点被代理/网络拒绝

**结论**：东财系接口在两环境均失败，新浪/腾讯实测秒通——免费源单点不可靠当场应验，备路降级设计必要性确认（备路实现属 PR2）。

### 单元测试结果

```
36 passed in 1.66s
```

覆盖范围：
- 参数校验（7 项）：合法/非法 code、缺参数
- CLI 解析（8 项）：各命令默认值和自定义参数
- 错误路径（7 项）：akshare 异常 → 结构化错误 JSON、错误不缓存、exit code=1
- 边界校验（4 项）：--days/--quarter/--limit < 1 校验
- 缓存逻辑（10 项）：读写、过期、确定性 key、原子写入、hit/miss/no-cache

## 发现的问题

- Issue #470: lint 补 status 枚举和 title 格式校验（tech-debt）

## 变更记录

- 2026-08-26: 初版实现
- 2026-08-26: 审视修复——错误不缓存、selftest exit code、finance 列名探测、kline 摘要补 last_close/last_change_pct、边界校验、死代码清理
