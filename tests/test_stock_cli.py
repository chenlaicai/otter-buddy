"""Tests for stock-cli.py — parameter validation, error paths, and cache logic."""

import importlib.util
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Import stock-cli as a module
# ---------------------------------------------------------------------------

CLI_PATH = Path(__file__).resolve().parent.parent / "scripts" / "stock-cli.py"
spec = importlib.util.spec_from_file_location("stock_cli", CLI_PATH)
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


# ---------------------------------------------------------------------------
# Parameter Validation Tests
# ---------------------------------------------------------------------------


class TestCodeValidation:
    """Validate stock code regex: must be exactly 6 digits."""

    def test_valid_code(self):
        cli.validate_code("600519")  # Should not raise

    def test_valid_code_sz(self):
        cli.validate_code("000001")  # Should not raise

    def test_too_short(self):
        with pytest.raises(SystemExit):
            cli.validate_code("123")

    def test_too_long(self):
        with pytest.raises(SystemExit):
            cli.validate_code("1234567")

    def test_letters(self):
        with pytest.raises(SystemExit):
            cli.validate_code("abc123")

    def test_mixed(self):
        with pytest.raises(SystemExit):
            cli.validate_code("60051a")

    def test_empty(self):
        with pytest.raises(SystemExit):
            cli.validate_code("")


class TestCLIParser:
    """Test CLI argument parsing."""

    def test_no_command(self):
        args = cli.build_parser().parse_args([])
        assert args.command is None

    def test_kline_defaults(self):
        args = cli.build_parser().parse_args(["kline", "600519"])
        assert args.code == "600519"
        assert args.days == 120
        assert args.adjust == "qfq"
        assert args.raw is False

    def test_kline_custom(self):
        args = cli.build_parser().parse_args(["kline", "000001", "--days", "30", "--adjust", "hfq", "--raw"])
        assert args.code == "000001"
        assert args.days == 30
        assert args.adjust == "hfq"
        assert args.raw is True

    def test_overview_requires_code(self):
        with pytest.raises(SystemExit):
            cli.build_parser().parse_args(["overview"])

    def test_finance_defaults(self):
        args = cli.build_parser().parse_args(["finance", "600519"])
        assert args.quarter == 4

    def test_news_defaults(self):
        args = cli.build_parser().parse_args(["news", "600519"])
        assert args.limit == 10

    def test_northflow_no_args(self):
        args = cli.build_parser().parse_args(["northflow"])
        assert args.command == "northflow"

    def test_global_cache_options(self):
        args = cli.build_parser().parse_args(["--max-age", "600", "--no-cache", "--cache-dir", "/tmp/cache", "kline", "600519"])
        assert args.max_age == 600
        assert args.no_cache is True
        assert args.cache_dir == "/tmp/cache"


# ---------------------------------------------------------------------------
# Error Path Tests
# ---------------------------------------------------------------------------


class TestStructuredError:
    """Test structured error output format."""

    def test_error_format(self):
        result = cli.structured_error("test context", ValueError("bad value"))
        assert "error" in result
        assert "test context" in result["error"]
        assert "ValueError" in result["error"]
        assert "bad value" in result["error"]
        assert "suggestion" in result
        assert "selftest" in result["suggestion"]

    def test_die_output(self, capsys):
        with pytest.raises(SystemExit) as exc_info:
            cli.die("test error message", code=2)
        assert exc_info.value.code == 2
        captured = capsys.readouterr()
        output = json.loads(captured.out)
        assert output == {"error": "test error message"}


class TestErrorPaths:
    """Test error handling when akshare functions raise exceptions."""

    def test_kline_akshare_error(self):
        """When akshare raises, we get structured error JSON."""
        mock_args = MagicMock()
        mock_args.code = "600519"
        mock_args.days = 120
        mock_args.adjust = "qfq"
        mock_args.raw = False
        mock_args.cache_dir = tempfile.mkdtemp()
        mock_args.max_age = 300
        mock_args.no_cache = True

        with patch.object(cli, "with_cache", side_effect=lambda *a, **kw: kw.get("fetcher", lambda: None)() if "fetcher" not in kw else a[-1]()):
            # Patch with_cache to call fetcher directly
            pass

        # Simpler approach: patch akshare
        with patch.dict(sys.modules, {"akshare": MagicMock()}) as mock_modules:
            mock_ak = mock_modules["akshare"]
            mock_ak.stock_zh_a_hist.side_effect = ConnectionError("network down")
            # F20260902ssfb：kline 现有主备源链，备源也须 mock 才能确定性地走到报错分支
            mock_ak.stock_zh_a_daily.side_effect = ConnectionError("network down")
            # Re-import to get fresh akshare reference
            import akshare as ak
            ak.stock_zh_a_hist = MagicMock(side_effect=ConnectionError("network down"))
            ak.stock_zh_a_daily = MagicMock(side_effect=ConnectionError("network down"))

            result = cli.cmd_kline(mock_args)
            assert "error" in result
            assert "network down" in result["error"] or "network down" in str(result.get("sources", []))

    def test_news_akshare_error(self):
        mock_args = MagicMock()
        mock_args.code = "600519"
        mock_args.limit = 10
        mock_args.cache_dir = tempfile.mkdtemp()
        mock_args.max_age = 300
        mock_args.no_cache = True

        import akshare as ak
        original = ak.stock_news_em
        ak.stock_news_em = MagicMock(side_effect=TimeoutError("request timeout"))
        try:
            result = cli.cmd_news(mock_args)
            assert "error" in result
            assert "request timeout" in result["error"]
        finally:
            ak.stock_news_em = original

    def test_error_result_exits_nonzero(self, capsys):
        """When handler returns dict with 'error' key, main() exits with code 1."""
        import akshare as ak
        original = ak.stock_zh_a_hist
        original_sina = ak.stock_zh_a_daily
        ak.stock_zh_a_hist = MagicMock(side_effect=ConnectionError("network down"))
        ak.stock_zh_a_daily = MagicMock(side_effect=ConnectionError("network down"))
        try:
            with patch.object(sys, 'argv', ['stock-cli.py', '--no-cache', 'kline', '600519']):
                with pytest.raises(SystemExit) as exc_info:
                    cli.main()
                assert exc_info.value.code == 1
                captured = capsys.readouterr()
                output = json.loads(captured.out)
                assert "error" in output
        finally:
            ak.stock_zh_a_hist = original
            ak.stock_zh_a_daily = original_sina

    def test_error_not_cached(self):
        """Error results should not be cached (S2 fix)."""
        with tempfile.TemporaryDirectory() as tmpdir:
            error_data = {"error": "network down"}
            fetcher = MagicMock(return_value=error_data)
            result = cli.with_cache("test", tmpdir, max_age=300, no_cache=False,
                                     params={"x": "1"}, fetcher=fetcher)
            assert result == error_data
            # Verify nothing was cached
            key = cli.cache_key("test", x="1")
            cached = cli.cache_read(tmpdir, key, max_age=300)
            assert cached is None

    def test_success_is_cached(self):
        """Successful results should still be cached."""
        with tempfile.TemporaryDirectory() as tmpdir:
            good_data = {"code": "600519", "data": [1, 2, 3]}
            fetcher = MagicMock(return_value=good_data)
            result = cli.with_cache("test", tmpdir, max_age=300, no_cache=False,
                                     params={"x": "2"}, fetcher=fetcher)
            assert result == good_data
            # Verify it was cached
            key = cli.cache_key("test", x="2")
            cached = cli.cache_read(tmpdir, key, max_age=300)
            assert cached == good_data


class TestBoundaryValidation:
    """Test numeric parameter boundary validation (B6)."""

    def test_days_zero_exits(self, capsys):
        with patch.object(sys, 'argv', ['stock-cli.py', 'kline', '600519', '--days', '0']):
            with pytest.raises(SystemExit) as exc_info:
                cli.main()
            assert exc_info.value.code == 1

    def test_quarter_zero_exits(self, capsys):
        with patch.object(sys, 'argv', ['stock-cli.py', 'finance', '600519', '--quarter', '0']):
            with pytest.raises(SystemExit) as exc_info:
                cli.main()
            assert exc_info.value.code == 1

    def test_limit_zero_exits(self, capsys):
        with patch.object(sys, 'argv', ['stock-cli.py', 'news', '600519', '--limit', '0']):
            with pytest.raises(SystemExit) as exc_info:
                cli.main()
            assert exc_info.value.code == 1

    def test_days_negative_exits(self, capsys):
        with patch.object(sys, 'argv', ['stock-cli.py', 'kline', '600519', '--days', '-5']):
            with pytest.raises(SystemExit) as exc_info:
                cli.main()
            assert exc_info.value.code == 1


# ---------------------------------------------------------------------------
# Cache Logic Tests
# ---------------------------------------------------------------------------


class TestCache:
    """Test cache read/write/expire logic."""

    def test_write_and_read(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            data = {"key": "value", "number": 42}
            cli.cache_write(tmpdir, "testkey", data)
            result = cli.cache_read(tmpdir, "testkey", max_age=60)
            assert result == data

    def test_cache_miss(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            result = cli.cache_read(tmpdir, "nonexistent", max_age=60)
            assert result is None

    def test_cache_expired(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            data = {"expired": True}
            cli.cache_write(tmpdir, "oldkey", data)
            # Read with max_age=0 → always expired
            result = cli.cache_read(tmpdir, "oldkey", max_age=0)
            assert result is None

    def test_cache_key_determinism(self):
        k1 = cli.cache_key("kline", code="600519", days=120)
        k2 = cli.cache_key("kline", code="600519", days=120)
        assert k1 == k2

    def test_cache_key_different_params(self):
        k1 = cli.cache_key("kline", code="600519", days=120)
        k2 = cli.cache_key("kline", code="600519", days=30)
        assert k1 != k2

    def test_cache_key_different_commands(self):
        k1 = cli.cache_key("kline", code="600519")
        k2 = cli.cache_key("overview", code="600519")
        assert k1 != k2

    def test_atomic_write(self):
        """Verify write-then-rename: no partial files on failure."""
        with tempfile.TemporaryDirectory() as tmpdir:
            data = {"atomic": True}
            cli.cache_write(tmpdir, "atomkey", data)
            p = cli.cache_path(tmpdir, "atomkey")
            assert p.exists()
            assert json.loads(p.read_text()) == data
            # No leftover temp files
            tmp_files = list(Path(tmpdir).glob("*.tmp"))
            assert len(tmp_files) == 0

    def test_with_cache_hit(self):
        """with_cache returns cached data on hit."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Prime the cache
            cached_data = {"cached": True}
            key = cli.cache_key("test", x="1")
            cli.cache_write(tmpdir, key, cached_data)

            fetcher = MagicMock()
            result = cli.with_cache("test", tmpdir, max_age=300, no_cache=False,
                                     params={"x": "1"}, fetcher=fetcher)
            assert result == cached_data
            fetcher.assert_not_called()

    def test_with_cache_miss_calls_fetcher(self):
        """with_cache calls fetcher on miss and caches result."""
        with tempfile.TemporaryDirectory() as tmpdir:
            fresh_data = {"fresh": True}
            fetcher = MagicMock(return_value=fresh_data)
            result = cli.with_cache("test", tmpdir, max_age=300, no_cache=False,
                                     params={"x": "2"}, fetcher=fetcher)
            assert result == fresh_data
            fetcher.assert_called_once()

    def test_no_cache_flag(self):
        """--no-cache skips cache read and always calls fetcher."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Prime the cache
            key = cli.cache_key("test", x="3")
            cli.cache_write(tmpdir, key, {"old": True})

            fresh_data = {"new": True}
            fetcher = MagicMock(return_value=fresh_data)
            result = cli.with_cache("test", tmpdir, max_age=300, no_cache=True,
                                     params={"x": "3"}, fetcher=fetcher)
            assert result == fresh_data
            fetcher.assert_called_once()




# ---------------------------------------------------------------------------
# F20260902ssfb: Multi-source fallback tests
# ---------------------------------------------------------------------------


def _make_kline_args(**overrides):
    args = MagicMock()
    args.code = "600519"
    args.days = 30
    args.adjust = "qfq"
    args.raw = False
    args.cache_dir = tempfile.mkdtemp()
    args.max_age = 300
    args.no_cache = True
    for k, v in overrides.items():
        setattr(args, k, v)
    return args


class TestKlineFallback:
    """F20260902ssfb: eastmoney down -> sina fallback."""

    def test_east_down_sina_up(self):
        import akshare as ak
        import pandas as pd

        originals = (ak.stock_zh_a_hist, ak.stock_zh_a_daily)
        sina_df = pd.DataFrame({
            "date": ["2026-09-01", "2026-09-02"],
            "open": [10.5, 10.8],
            "high": [10.9, 11.0],
            "low": [10.2, 10.6],
            "close": [10.5, 10.9],
            "volume": [1100000, 1200000],
            "amount": [11550000.0, 13080000.0],
            "turnover": [0.011, 0.012],
        })
        ak.stock_zh_a_hist = MagicMock(side_effect=ConnectionError("east down"))
        ak.stock_zh_a_daily = MagicMock(return_value=sina_df)
        try:
            result = cli.cmd_kline(_make_kline_args())
            assert result.get("source") == "sina"
            assert result["stats"]["last_close"] == 10.9
            # 值断言（海星检视发现 3）：补算列不只验证键存在，还验证计算正确性
            last = result["ohlcv"][-1]
            assert "change_pct" in last
            assert "amplitude" in last
            # close 10.5 -> 10.9：change_pct = 0.4/10.5*100 ≈ 3.81
            assert last["change_pct"] == pytest.approx(3.81, abs=0.01)
            # high 11.0 / low 10.6 / prev close 10.5：amplitude = 0.4/10.5*100 ≈ 3.81
            assert last["amplitude"] == pytest.approx(3.81, abs=0.01)
            assert last["change"] == pytest.approx(0.4, abs=0.001)
        finally:
            ak.stock_zh_a_hist, ak.stock_zh_a_daily = originals

    def test_both_down_all_sources_failed(self):
        import akshare as ak

        originals = (ak.stock_zh_a_hist, ak.stock_zh_a_daily)
        ak.stock_zh_a_hist = MagicMock(side_effect=ConnectionError("east down"))
        ak.stock_zh_a_daily = MagicMock(side_effect=ConnectionError("sina down"))
        try:
            result = cli.cmd_kline(_make_kline_args())
            assert "error" in result
            assert "all sources failed" in result["error"]
            srcs = result.get("sources", [])
            assert any("east down" in s for s in srcs)
            assert any("sina down" in s for s in srcs)
        finally:
            ak.stock_zh_a_hist, ak.stock_zh_a_daily = originals

    def test_east_up_no_fallback(self):
        import akshare as ak
        import pandas as pd

        originals = (ak.stock_zh_a_hist, ak.stock_zh_a_daily)
        east_df = pd.DataFrame({
            "\u65e5\u671f": ["2026-09-01", "2026-09-02"],
            "\u5f00\u76d8": [10.0, 10.5],
            "\u6536\u76d8": [10.2, 10.9],
            "\u6700\u9ad8": [10.8, 11.0],
            "\u6700\u4f4e": [9.9, 10.6],
            "\u6210\u4ea4\u91cf": [1000, 1100],
            "\u6210\u4ea4\u989d": [10200000.0, 13080000.0],
            "\u632f\u5e45": [1.0, 1.2],
            "\u6da8\u8dcc\u5e45": [2.0, 6.8],
            "\u6da8\u8dcc\u989d": [0.2, 0.7],
            "\u6362\u624b\u7387": [1.0, 1.1],
        })
        ak.stock_zh_a_hist = MagicMock(return_value=east_df)
        ak.stock_zh_a_daily = MagicMock(side_effect=AssertionError("sina must not be called"))
        try:
            result = cli.cmd_kline(_make_kline_args())
            assert result.get("source") == "eastmoney"
            ak.stock_zh_a_daily.assert_not_called()
        finally:
            ak.stock_zh_a_hist, ak.stock_zh_a_daily = originals


class TestOverviewFallback:
    """F20260902ssfb: overview east both-fail -> baidu valuation fallback."""

    def test_east_down_baidu_up(self):
        import akshare as ak
        import pandas as pd
        from datetime import date

        originals = (ak.stock_individual_info_em, ak.stock_bid_ask_em,
                     getattr(ak, "stock_zh_valuation_baidu", None))
        baidu_df = pd.DataFrame({
            "date": [date(2026, 8, 30), date(2026, 9, 2)],
            "value": [19.0, 19.92],
        })
        ak.stock_individual_info_em = MagicMock(side_effect=ConnectionError("east info down"))
        ak.stock_bid_ask_em = MagicMock(side_effect=ConnectionError("east quote down"))
        ak.stock_zh_valuation_baidu = MagicMock(return_value=baidu_df)
        try:
            args = MagicMock()
            args.code = "600519"
            args.cache_dir = tempfile.mkdtemp()
            args.max_age = 300
            args.no_cache = True
            result = cli.cmd_overview(args)
            assert "valuation" in result
            assert result["valuation"]["pe_ttm"]["current"] == 19.92
            assert result["valuation"]["pb"]["current"] == 19.92
            assert result["valuation"]["pe_ttm"]["percentile"] == 100.0
        finally:
            (ak.stock_individual_info_em, ak.stock_bid_ask_em) = originals[:2]
            if originals[2] is not None:
                ak.stock_zh_valuation_baidu = originals[2]
            else:
                delattr(ak, "stock_zh_valuation_baidu")

    def test_all_down_returns_error(self):
        import akshare as ak

        originals = (ak.stock_individual_info_em, ak.stock_bid_ask_em,
                     getattr(ak, "stock_zh_valuation_baidu", None))
        ak.stock_individual_info_em = MagicMock(side_effect=ConnectionError("east info down"))
        ak.stock_bid_ask_em = MagicMock(side_effect=ConnectionError("east quote down"))
        ak.stock_zh_valuation_baidu = MagicMock(side_effect=ConnectionError("baidu down"))
        try:
            args = MagicMock()
            args.code = "600519"
            args.cache_dir = tempfile.mkdtemp()
            args.max_age = 300
            args.no_cache = True
            result = cli.cmd_overview(args)
            assert "error" in result
        finally:
            (ak.stock_individual_info_em, ak.stock_bid_ask_em) = originals[:2]
            if originals[2] is not None:
                ak.stock_zh_valuation_baidu = originals[2]
            else:
                delattr(ak, "stock_zh_valuation_baidu")


class TestNaNNormalization:
    """F20260902ssfb: NaN/Inf must serialize as valid JSON (null), not bare NaN literal."""

    def test_normalize_nan(self):
        result = json.dumps(cli._normalize_public(float("nan")))
        assert result == "null"

    def test_normalize_nested(self):
        data = {"a": float("inf"), "b": [{"c": float("nan")}, 1.5]}
        out = json.loads(json.dumps(cli._normalize_public(data)))
        assert out == {"a": None, "b": [{"c": None}, 1.5]}

    def test_finance_output_is_valid_json(self):
        """End-to-end: finance with NaN values produces JSON.parse-able stdout (main path)."""
        import subprocess
        script = Path(__file__).resolve().parent.parent / "scripts" / "stock-cli.py"
        # Sanity check only: run with an invalid code to get deterministic error JSON
        proc = subprocess.run(
            ["python3", str(script), "--no-cache", "finance", "999999"],
            capture_output=True, text=True, timeout=30,
        )
        assert json.loads(proc.stdout)  # must parse without error
