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
            # Re-import to get fresh akshare reference
            import akshare as ak
            ak.stock_zh_a_hist = MagicMock(side_effect=ConnectionError("network down"))

            result = cli.cmd_kline(mock_args)
            assert "error" in result
            assert "network down" in result["error"]

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
        ak.stock_zh_a_hist = MagicMock(side_effect=ConnectionError("network down"))
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


