# Stock CLI — A 股数据查询工具

基于 [akshare](https://github.com/akfamily/akshare) 的命令行 A 股数据查询工具，输出单行 JSON 到 stdout。

## 安装

```bash
# 创建虚拟环境
python3 -m venv .venv-stock
source .venv-stock/bin/activate

# 安装依赖
pip install akshare
```

## 命令速查

```bash
# K 线（默认摘要：最近 30 日 OHLCV + 区间统计）
python scripts/stock-cli.py kline 600519

# K 线全量数据
python scripts/stock-cli.py kline 600519 --raw

# 自定义天数和复权方式
python scripts/stock-cli.py kline 600519 --days 60 --adjust hfq

# 个股概览（基本信息 + 实时行情 + 估值）
python scripts/stock-cli.py overview 600519

# 财务指标（最近 4 季度）
python scripts/stock-cli.py finance 600519

# 财务指标（最近 8 季度）
python scripts/stock-cli.py finance 600519 --quarter 8

# 个股新闻
python scripts/stock-cli.py news 600519

# 个股新闻（最近 5 条）
python scripts/stock-cli.py news 600519 --limit 5

# 北向资金
python scripts/stock-cli.py northflow

# 自检（诊断各接口连通性）
python scripts/stock-cli.py selftest
```

## 缓存机制

所有命令支持透明缓存，默认有效期 300 秒（5 分钟）。

| 选项 | 说明 |
|------|------|
| `--max-age SEC` | 缓存有效期（秒），默认 300 |
| `--no-cache` | 强制刷新，忽略缓存 |
| `--cache-dir DIR` | 缓存目录，默认 `.cache/stock/` |

环境变量 `STOCK_CACHE_DIR` 可覆盖默认缓存目录。

缓存使用 write-then-rename 原子写入，避免中断时产生损坏文件。

## 输出格式

- **成功**：单行 JSON 到 stdout，退出码 0
- **错误**：`{"error": "..."}` 到 stdout，退出码非 0

## Selftest

运行 `selftest` 命令诊断各接口连通性：

```bash
python scripts/stock-cli.py selftest
```

输出示例：
```json
{
  "test_stock": "600519",
  "akshare_version": "1.18.94",
  "timestamp": "2026-08-26T09:00:00",
  "summary": {"ok": 6, "error": 0, "total": 6},
  "results": { ... }
}
```

## 注意事项

- 股票代码必须为 6 位数字（如 `600519`、`000001`）
- 数据来源为东方财富（via akshare），受网络和接口可用性影响
- 本工具仅供研究参考，不构成投资建议
