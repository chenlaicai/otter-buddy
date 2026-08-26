#!/usr/bin/env python3
"""
Stock CLI — A 股数据查询工具 (akshare 封装)

安装：
    python3 -m venv .venv-stock
    source .venv-stock/bin/activate
    pip install akshare

用法：
    python scripts/stock-cli.py <command> [options]

命令：
    kline <code> [--days N=120] [--adjust qfq] [--raw]
    overview <code>
    finance <code> [--quarter N=4]
    news <code> [--limit N=10]
    northflow
    hkline <code> [--days N=120] [--raw]
    hvaluation <code>
    selftest

通用选项：
    --max-age SEC    缓存有效期秒数（默认 300）
    --no-cache       强制刷新缓存
    --cache-dir DIR  缓存目录（默认 .cache/stock/，可被 STOCK_CACHE_DIR 覆盖）
"""

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CODE_RE = re.compile(r"^\d{6}$")
HK_CODE_RE = re.compile(r"^\d{5}$")
ANY_CODE_RE = re.compile(r"^\d{5,6}$")
DEFAULT_CACHE_DIR = os.environ.get("STOCK_CACHE_DIR", ".cache/stock")
DEFAULT_CACHE_MAX_AGE = 300  # seconds

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def die(msg: str, code: int = 1) -> None:
    """Print error JSON to stdout and exit."""
    print(json.dumps({"error": msg}, ensure_ascii=False))
    sys.exit(code)


def validate_code(code: str) -> None:
    """Validate A-share stock code format; die on invalid."""
    if not CODE_RE.match(code):
        die(f"Invalid stock code: {code!r}. Must be exactly 6 digits (e.g. 600519)")


def validate_hk_code(code: str) -> None:
    """Validate HK stock code format; die on invalid."""
    if not HK_CODE_RE.match(code):
        die(f"Invalid HK stock code: {code!r}. Must be exactly 5 digits (e.g. 01810)")


def cache_key(cmd: str, **kwargs) -> str:
    """Build a deterministic cache key from command + params."""
    parts = [cmd] + [f"{k}={v}" for k, v in sorted(kwargs.items())]
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]


def cache_path(cache_dir: str, key: str) -> Path:
    return Path(cache_dir) / f"{key}.json"


def cache_read(cache_dir: str, key: str, max_age: int) -> dict | None:
    """Read cached result if valid; return None on miss/expired."""
    p = cache_path(cache_dir, key)
    if not p.exists():
        return None
    age = time.time() - p.stat().st_mtime
    if age > max_age:
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def cache_write(cache_dir: str, key: str, data: dict) -> None:
    """Atomically write cache (write-then-rename)."""
    Path(cache_dir).mkdir(parents=True, exist_ok=True)
    p = cache_path(cache_dir, key)
    fd, tmp = tempfile.mkstemp(dir=cache_dir, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, p)
    except Exception:
        # Cleanup temp file on failure
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def with_cache(cmd: str, cache_dir: str, max_age: int, no_cache: bool, params: dict, fetcher) -> dict:
    """Cache wrapper: read from cache or call fetcher()."""
    key = cache_key(cmd, **params)
    if not no_cache:
        cached = cache_read(cache_dir, key, max_age)
        if cached is not None:
            return cached
    data = fetcher()
    # Why: 不缓存错误结果——瞬时网络故障会被固化到缓存过期，
    # 即使上游已恢复；LLM 调用方未必想得到用 --no-cache 逃生
    if isinstance(data, dict) and "error" not in data:
        try:
            cache_write(cache_dir, key, data)
        except Exception:
            pass  # cache write failure is non-fatal
    return data




def structured_error(context: str, exc: Exception) -> dict:
    """Build a structured error dict with selftest suggestion."""
    return {
        "error": f"{context}: {type(exc).__name__}: {exc}",
        "suggestion": "Run 'selftest' command to diagnose: python scripts/stock-cli.py selftest",
    }


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_kline(args) -> dict:
    """Fetch daily kline data with optional summary."""
    import akshare as ak

    code = args.code
    days = args.days
    adjust = args.adjust
    raw = args.raw

    def fetch():
        end = datetime.now().strftime("%Y%m%d")
        start = (datetime.now() - timedelta(days=days + 30)).strftime("%Y%m%d")  # extra days for holidays
        try:
            df = ak.stock_zh_a_hist(
                symbol=code,
                period="daily",
                start_date=start,
                end_date=end,
                adjust=adjust,
                timeout=15,
            )
        except Exception as e:
            return structured_error(f"stock_zh_a_hist({code})", e)

        if df is None or df.empty:
            return {"error": f"No kline data for {code}", "code": code}

        # Standardize column names
        col_map = {
            "日期": "date",
            "开盘": "open",
            "收盘": "close",
            "最高": "high",
            "最低": "low",
            "成交量": "volume",
            "成交额": "amount",
            "振幅": "amplitude",
            "涨跌幅": "change_pct",
            "涨跌额": "change",
            "换手率": "turnover",
        }
        df = df.rename(columns=col_map)

        # Take last N trading days
        df = df.tail(days).reset_index(drop=True)

        if raw:
            records = df.to_dict(orient="records")
            # Convert numpy types for JSON serialization
            for r in records:
                for k, v in r.items():
                    if hasattr(v, "item"):
                        r[k] = v.item()
            return {"code": code, "adjust": adjust, "count": len(records), "data": records}

        # Summary mode: last 30 trading days + stats
        summary_df = df.tail(30).reset_index(drop=True)
        ohlcv = summary_df.to_dict(orient="records")
        for r in ohlcv:
            for k, v in r.items():
                if hasattr(v, "item"):
                    r[k] = v.item()

        # Compute stats over full period
        stats = {}
        if len(df) > 0:
            highs = df["high"].astype(float)
            lows = df["low"].astype(float)
            closes = df["close"].astype(float)
            volumes = df["volume"].astype(float)

            # Latest values — most frequently needed by LLM
            last_row = df.iloc[-1]
            stats["last_close"] = float(last_row["close"])
            stats["last_change_pct"] = float(last_row["change_pct"])
            stats["last_date"] = str(last_row["date"])

            stats["period_high"] = float(highs.max())
            stats["period_low"] = float(lows.min())

            # Moving averages
            for ma in [5, 20, 60]:
                if len(closes) >= ma:
                    stats[f"ma{ma}"] = round(float(closes.tail(ma).mean()), 2)

            # Volatility (annualized, 20-day)
            if len(closes) >= 20:
                returns = closes.pct_change().dropna().tail(20)
                stats["volatility_20d"] = round(float(returns.std() * (252 ** 0.5) * 100), 2)

            # Volume trend: compare last 5 vs previous 5
            if len(volumes) >= 10:
                recent_5 = float(volumes.tail(5).mean())
                prev_5 = float(volumes.tail(10).head(5).mean())
                if prev_5 > 0:
                    ratio = recent_5 / prev_5
                    if ratio > 1.3:
                        stats["volume_trend"] = "放量"
                    elif ratio < 0.7:
                        stats["volume_trend"] = "缩量"
                    else:
                        stats["volume_trend"] = "平稳"
                    stats["volume_ratio"] = round(ratio, 2)

        return {
            "code": code,
            "adjust": adjust,
            "summary_days": len(ohlcv),
            "ohlcv": ohlcv,
            "stats": stats,
        }

    return with_cache("kline", args.cache_dir, args.max_age, args.no_cache,
                       {"code": code, "days": days, "adjust": adjust, "raw": raw},
                       fetch)


def cmd_overview(args) -> dict:
    """Fetch stock overview: basic info + current quote + valuation."""
    import akshare as ak

    code = args.code

    def fetch():
        result = {"code": code}
        errors = []

        # Basic info
        try:
            info_df = ak.stock_individual_info_em(symbol=code, timeout=15)
            if info_df is not None and not info_df.empty:
                info = {}
                for _, row in info_df.iterrows():
                    key = str(row.iloc[0]).strip()
                    val = row.iloc[1]
                    if hasattr(val, "item"):
                        val = val.item()
                    info[key] = val
                result["basic_info"] = info
        except Exception as e:
            errors.append(f"stock_individual_info_em: {type(e).__name__}: {e}")

        # Bid/ask (current quote)
        try:
            bid_df = ak.stock_bid_ask_em(symbol=code)
            if bid_df is not None and not bid_df.empty:
                quote = {}
                for _, row in bid_df.iterrows():
                    key = str(row.iloc[0]).strip()
                    val = row.iloc[1]
                    if hasattr(val, "item"):
                        val = val.item()
                    quote[key] = val
                result["quote"] = quote
        except Exception as e:
            errors.append(f"stock_bid_ask_em: {type(e).__name__}: {e}")

        if errors:
            result["warnings"] = errors

        if "basic_info" not in result and "quote" not in result:
            return structured_error(f"No overview data for {code}", Exception("; ".join(errors)))

        return result

    return with_cache("overview", args.cache_dir, args.max_age, args.no_cache,
                       {"code": code}, fetch)


def cmd_finance(args) -> dict:
    """Fetch financial indicators."""
    import akshare as ak

    code = args.code
    quarter = args.quarter

    def fetch():
        try:
            df = ak.stock_financial_abstract(symbol=code)
        except Exception as e:
            return structured_error(f"stock_financial_abstract({code})", e)

        if df is None or df.empty:
            return {"error": f"No financial data for {code}", "code": code}

        # stock_financial_abstract returns a DataFrame with columns:
        # 选项, 指标, then one column per reporting period
        # Reshape to a more usable format
        result = {"code": code, "sections": {}}

        # Detect the indicator column name (akshare versions vary)
        indicator_col = None
        for candidate in ["指标", "item_title", "ITEM_TITLE"]:
            if candidate in df.columns:
                indicator_col = candidate
                break
        if indicator_col is None:
            # Fallback: use second column (after 选项)
            indicator_col = df.columns[1] if len(df.columns) > 1 else df.columns[0]

        if "选项" in df.columns:
            for section_name, group in df.groupby("选项"):
                section_data = []
                for _, row in group.iterrows():
                    item = {"指标": str(row[indicator_col])}
                    # Get the latest N quarters' values
                    value_cols = [c for c in df.columns if c not in ("选项", indicator_col)]
                    for col in value_cols[:quarter]:
                        val = row[col]
                        if hasattr(val, "item"):
                            val = val.item()
                        item[str(col)] = val
                    section_data.append(item)
                result["sections"][str(section_name)] = section_data
        else:
            # Fallback: return raw records
            records = df.head(50).to_dict(orient="records")
            for r in records:
                for k, v in r.items():
                    if hasattr(v, "item"):
                        r[k] = v.item()
            result["raw"] = records

        return result

    return with_cache("finance", args.cache_dir, args.max_age, args.no_cache,
                       {"code": code, "quarter": quarter}, fetch)


def cmd_news(args) -> dict:
    """Fetch stock news."""
    import akshare as ak

    code = args.code
    limit = args.limit

    def fetch():
        try:
            df = ak.stock_news_em(symbol=code)
        except Exception as e:
            return structured_error(f"stock_news_em({code})", e)

        if df is None or df.empty:
            return {"code": code, "news": [], "message": "No news found"}

        df = df.head(limit)
        news = []
        for _, row in df.iterrows():
            item = {}
            for col in df.columns:
                val = row[col]
                if hasattr(val, "item"):
                    val = val.item()
                # Convert pandas Timestamp to string
                if hasattr(val, "isoformat"):
                    val = val.isoformat()
                item[str(col)] = val
            news.append(item)

        return {"code": code, "count": len(news), "news": news}

    return with_cache("news", args.cache_dir, args.max_age, args.no_cache,
                       {"code": code, "limit": limit}, fetch)


def cmd_northflow(args) -> dict:
    """Fetch northbound capital flow summary."""
    import akshare as ak

    def fetch():
        try:
            df = ak.stock_hsgt_fund_flow_summary_em()
        except Exception as e:
            return structured_error("stock_hsgt_fund_flow_summary_em", e)

        if df is None or df.empty:
            return {"error": "No northbound flow data available"}

        records = df.to_dict(orient="records")
        for r in records:
            for k, v in r.items():
                if hasattr(v, "item"):
                    r[k] = v.item()
                if hasattr(v, "isoformat"):
                    r[k] = v.isoformat()

        return {"count": len(records), "data": records}

    return with_cache("northflow", args.cache_dir, args.max_age, args.no_cache,
                       {}, fetch)


def cmd_hkline(args) -> dict:
    """Fetch HK stock daily kline data with summary."""
    import akshare as ak

    code = args.code
    days = args.days
    raw = getattr(args, "raw", False)

    def fetch():
        try:
            df = ak.stock_hk_daily(symbol=code)
        except Exception as e:
            return structured_error(f"stock_hk_daily({code})", e)

        if df is None or df.empty:
            return {"error": f"No HK kline data for {code}", "code": code}

        # stock_hk_daily returns: date, open, high, low, close, volume, amount
        # Convert types for consistency
        for col in ["open", "high", "low", "close", "volume", "amount"]:
            if col in df.columns:
                df[col] = df[col].astype(float)

        # Take last N trading days
        df = df.tail(days).reset_index(drop=True)

        if raw:
            records = df.to_dict(orient="records")
            for r in records:
                for k, v in r.items():
                    if hasattr(v, "isoformat"):
                        r[k] = v.isoformat()
                    elif hasattr(v, "item"):
                        r[k] = v.item()
            return {"code": code, "market": "HK", "adjust": "", "count": len(records), "data": records}

        # Summary mode: last 30 trading days + stats
        summary_df = df.tail(30).reset_index(drop=True)
        ohlcv = summary_df.to_dict(orient="records")
        for r in ohlcv:
            for k, v in r.items():
                if hasattr(v, "isoformat"):
                    r[k] = v.isoformat()
                elif hasattr(v, "item"):
                    r[k] = v.item()

        # Compute stats (same logic as A-share kline)
        stats = {}
        if len(df) > 0:
            highs = df["high"]
            lows = df["low"]
            closes = df["close"]
            volumes = df["volume"]

            last_row = df.iloc[-1]
            stats["last_close"] = float(last_row["close"])
            stats["last_date"] = str(last_row["date"])
            if "change_pct" in df.columns:
                stats["last_change_pct"] = float(last_row["change_pct"])
            stats["period_high"] = float(highs.max())
            stats["period_low"] = float(lows.min())

            # Moving averages
            for ma in [5, 20, 60]:
                if len(closes) >= ma:
                    stats[f"ma{ma}"] = round(float(closes.tail(ma).mean()), 2)

            # Volatility (annualized, 20-day)
            if len(closes) >= 20:
                returns = closes.pct_change().dropna().tail(20)
                stats["volatility_20d"] = round(float(returns.std() * (252 ** 0.5) * 100), 2)

            # Volume trend: compare last 5 vs previous 5
            if len(volumes) >= 10:
                recent_5 = float(volumes.tail(5).mean())
                prev_5 = float(volumes.tail(10).head(5).mean())
                if prev_5 > 0:
                    ratio = recent_5 / prev_5
                    if ratio > 1.3:
                        stats["volume_trend"] = "放量"
                    elif ratio < 0.7:
                        stats["volume_trend"] = "缩量"
                    else:
                        stats["volume_trend"] = "平稳"
                    stats["volume_ratio"] = round(ratio, 2)

        return {
            "code": code,
            "market": "HK",
            "adjust": "",
            "summary_days": len(ohlcv),
            "ohlcv": ohlcv,
            "stats": stats,
        }

    return with_cache("hkline", args.cache_dir, args.max_age, args.no_cache,
                       {"code": code, "days": days}, fetch)


def cmd_hvaluation(args) -> dict:
    """Fetch HK stock valuation with percentile ranking (PE-TTM, PB)."""
    import akshare as ak

    code = args.code

    def fetch():
        result = {"code": code, "market": "HK", "indicators": {}}
        errors = []

        for indicator, label in [("市盈率(TTM)", "pe_ttm"), ("市净率", "pb")]:
            try:
                df = ak.stock_hk_valuation_baidu(
                    symbol=code, indicator=indicator, period="近三年"
                )
                if df is not None and not df.empty:
                    values = df["value"].astype(float)
                    current = float(values.iloc[-1])
                    three_year_min = float(values.min())
                    three_year_max = float(values.max())
                    # Percentile: % of historical values <= current
                    percentile = round(float((values <= current).sum() / len(values) * 100), 1)
                    result["indicators"][label] = {
                        "current": round(current, 2),
                        "three_year_min": round(three_year_min, 2),
                        "three_year_max": round(three_year_max, 2),
                        "percentile": percentile,
                        "data_date": str(df["date"].iloc[-1]),
                    }
                else:
                    errors.append(f"{indicator}: empty result")
            except Exception as e:
                errors.append(f"{indicator}: {type(e).__name__}: {e}")

        if errors:
            result["warnings"] = errors

        if not result["indicators"]:
            return structured_error(f"No valuation data for HK {code}", Exception("; ".join(errors)))

        return result

    return with_cache("hvaluation", args.cache_dir, args.max_age, args.no_cache,
                       {"code": code}, fetch)


def cmd_selftest(args) -> dict:
    """Run self-diagnostic: test each API endpoint and report status."""
    import akshare as ak

    test_code = "600519"  # 贵州茅台 for testing
    results = {}

    # Test kline
    try:
        df = ak.stock_zh_a_hist(symbol=test_code, period="daily",
                                 start_date="20260801", end_date="20260826",
                                 adjust="qfq", timeout=15)
        results["kline"] = {
            "status": "ok" if df is not None and not df.empty else "empty",
            "function": "stock_zh_a_hist",
            "columns": list(df.columns) if df is not None else [],
            "rows": len(df) if df is not None else 0,
        }
    except Exception as e:
        results["kline"] = {"status": "error", "function": "stock_zh_a_hist", "error": str(e)}

    # Test overview (basic info)
    try:
        df = ak.stock_individual_info_em(symbol=test_code, timeout=15)
        results["overview_info"] = {
            "status": "ok" if df is not None and not df.empty else "empty",
            "function": "stock_individual_info_em",
            "columns": list(df.columns) if df is not None else [],
        }
    except Exception as e:
        results["overview_info"] = {"status": "error", "function": "stock_individual_info_em", "error": str(e)}

    # Test overview (bid/ask)
    try:
        df = ak.stock_bid_ask_em(symbol=test_code)
        results["overview_quote"] = {
            "status": "ok" if df is not None and not df.empty else "empty",
            "function": "stock_bid_ask_em",
            "columns": list(df.columns) if df is not None else [],
        }
    except Exception as e:
        results["overview_quote"] = {"status": "error", "function": "stock_bid_ask_em", "error": str(e)}

    # Test finance
    try:
        df = ak.stock_financial_abstract(symbol=test_code)
        results["finance"] = {
            "status": "ok" if df is not None and not df.empty else "empty",
            "function": "stock_financial_abstract",
            "columns": list(df.columns) if df is not None else [],
        }
    except Exception as e:
        results["finance"] = {"status": "error", "function": "stock_financial_abstract", "error": str(e)}

    # Test news
    try:
        df = ak.stock_news_em(symbol=test_code)
        results["news"] = {
            "status": "ok" if df is not None and not df.empty else "empty",
            "function": "stock_news_em",
            "columns": list(df.columns) if df is not None else [],
        }
    except Exception as e:
        results["news"] = {"status": "error", "function": "stock_news_em", "error": str(e)}

    # Test northflow
    try:
        df = ak.stock_hsgt_fund_flow_summary_em()
        results["northflow"] = {
            "status": "ok" if df is not None and not df.empty else "empty",
            "function": "stock_hsgt_fund_flow_summary_em",
            "columns": list(df.columns) if df is not None else [],
        }
    except Exception as e:
        results["northflow"] = {"status": "error", "function": "stock_hsgt_fund_flow_summary_em", "error": str(e)}

    # Test HK kline (if available)
    hk_test_code = "01810"  # Xiaomi
    try:
        df = ak.stock_hk_daily(symbol=hk_test_code)
        results["hkline"] = {
            "status": "ok" if df is not None and not df.empty else "empty",
            "function": "stock_hk_daily",
            "columns": list(df.columns) if df is not None else [],
            "rows": len(df) if df is not None else 0,
        }
    except Exception as e:
        results["hkline"] = {"status": "error", "function": "stock_hk_daily", "error": str(e)}

    # Test HK valuation (PE-TTM)
    try:
        df = ak.stock_hk_valuation_baidu(symbol=hk_test_code, indicator="市盈率(TTM)", period="近三年")
        results["hvaluation"] = {
            "status": "ok" if df is not None and not df.empty else "empty",
            "function": "stock_hk_valuation_baidu",
            "rows": len(df) if df is not None else 0,
        }
    except Exception as e:
        results["hvaluation"] = {"status": "error", "function": "stock_hk_valuation_baidu", "error": str(e)}

    # Summary
    ok_count = sum(1 for r in results.values() if r.get("status") == "ok")
    err_count = sum(1 for r in results.values() if r.get("status") == "error")
    total = len(results)

    return {
        "test_stock": test_code,
        "test_hk_stock": hk_test_code,
        "akshare_version": ak.__version__,
        "timestamp": datetime.now().isoformat(),
        "summary": {"ok": ok_count, "error": err_count, "total": total},
        "results": results,
    }


# ---------------------------------------------------------------------------
# CLI Parser
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Stock CLI — A 股数据查询工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    # Global options
    parser.add_argument("--max-age", type=int, default=DEFAULT_CACHE_MAX_AGE,
                        help=f"Cache max age in seconds (default: {DEFAULT_CACHE_MAX_AGE})")
    parser.add_argument("--no-cache", action="store_true", help="Force refresh (ignore cache)")
    parser.add_argument("--cache-dir", default=DEFAULT_CACHE_DIR,
                        help=f"Cache directory (default: {DEFAULT_CACHE_DIR})")

    sub = parser.add_subparsers(dest="command", help="Available commands")

    # kline
    p_kline = sub.add_parser("kline", help="Daily kline (OHLCV)")
    p_kline.add_argument("code", help="6-digit stock code (e.g. 600519)")
    p_kline.add_argument("--days", type=int, default=120, help="Trading days to fetch (default: 120)")
    p_kline.add_argument("--adjust", default="qfq", choices=["", "qfq", "hfq"],
                         help="Price adjustment: qfq=fwd, hfq=back, ''=none (default: qfq)")
    p_kline.add_argument("--raw", action="store_true", help="Output full data (default: summary)")

    # overview
    p_overview = sub.add_parser("overview", help="Stock overview (info + quote + valuation)")
    p_overview.add_argument("code", help="6-digit stock code")

    # finance
    p_finance = sub.add_parser("finance", help="Financial indicators")
    p_finance.add_argument("code", help="6-digit stock code")
    p_finance.add_argument("--quarter", type=int, default=4, help="Number of quarters (default: 4)")

    # news
    p_news = sub.add_parser("news", help="Stock news")
    p_news.add_argument("code", help="6-digit stock code")
    p_news.add_argument("--limit", type=int, default=10, help="Max news items (default: 10)")

    # northflow
    sub.add_parser("northflow", help="Northbound capital flow summary")

    # hkline
    p_hkline = sub.add_parser("hkline", help="HK stock daily kline (OHLCV)")
    p_hkline.add_argument("code", help="5-digit HK stock code (e.g. 01810)")
    p_hkline.add_argument("--days", type=int, default=120, help="Trading days to fetch (default: 120)")
    p_hkline.add_argument("--raw", action="store_true", help="Output full data (default: summary)")

    # hvaluation
    p_hval = sub.add_parser("hvaluation", help="HK stock valuation (PE-TTM/PB 3-year percentile)")
    p_hval.add_argument("code", help="5-digit HK stock code (e.g. 01810)")

    # selftest
    sub.add_parser("selftest", help="Run self-diagnostic")

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    # Dispatch
    dispatch = {
        "kline": cmd_kline,
        "overview": cmd_overview,
        "finance": cmd_finance,
        "news": cmd_news,
        "northflow": cmd_northflow,
        "hkline": cmd_hkline,
        "hvaluation": cmd_hvaluation,
        "selftest": cmd_selftest,
    }

    handler = dispatch.get(args.command)
    if handler is None:
        die(f"Unknown command: {args.command}")

    # Validate code for commands that require it
    hk_commands = {"hkline", "hvaluation"}
    if hasattr(args, "code") and args.code:
        if args.command in hk_commands:
            validate_hk_code(args.code)
        elif args.command not in {"northflow", "selftest"}:
            validate_code(args.code)

    # Validate numeric parameters (B6: boundary校验)
    if hasattr(args, "days") and args.days is not None and args.days < 1:
        die(f"--days must be >= 1, got {args.days}")
    if hasattr(args, "quarter") and args.quarter is not None and args.quarter < 1:
        die(f"--quarter must be >= 1, got {args.quarter}")
    if hasattr(args, "limit") and args.limit is not None and args.limit < 1:
        die(f"--limit must be >= 1, got {args.limit}")

    try:
        result = handler(args)
        print(json.dumps(result, ensure_ascii=False, default=str))
        # Non-zero exit when result contains error (LLM callers rely on exit code)
        # Also check selftest's error count — partial failure is still failure
        has_error = False
        if isinstance(result, dict):
            if "error" in result:
                has_error = True
            elif args.command == "selftest":
                summary = result.get("summary", {})
                if summary.get("error", 0) > 0:
                    has_error = True
        if has_error:
            sys.exit(1)
    except Exception as e:
        die(f"Unexpected error: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
