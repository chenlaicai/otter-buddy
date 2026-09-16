---
id: F20260916scts
title: stock-cli CI 测试去外网化：env 注入 mock akshare 修 test_finance_output_is_valid_json flaky
summary: issue #879。test_finance_output_is_valid_json 用 --no-cache 实调 akshare finance 接口（无效代码 999999）做「确定性错误 JSON」sanity check，CI 偶发 subprocess.TimeoutExpired（30s）误伤。修复：stock-cli.py __main__ 入口新增 STOCK_CLI_MOCK_AKSHARE env 注入点（仅测试用，生产路径零副作用），测试改为 subprocess env 注入 mock akshare——零外网，且覆盖从「错误路径」升级为「含 NaN/Inf DataFrame → main 序列化 → stdout 合法 JSON」全管线。
change_type: fix
capability_test: "n/a: 纯测试基础设施修复（Python 测试脚本 + 测试专用 env 注入点），不涉及软代码/能力行为"
created_in_conversation: a56c349e-c566-438c-97d0-653a260171ed
tags: [stock-cli, ci, flaky-test, akshare, mock, test-infra]
modules: [scripts/stock-cli.py, tests/test_stock_cli.py]
from: [F20260902ssfb]
---

# stock-cli CI 测试去外网化（#879）

## 背景

PR #866 CI（run 34306959656 第一次执行）check job 失败：
`tests/test_stock_cli.py::TestNaNNormalization::test_finance_output_is_valid_json`
报 `subprocess.TimeoutExpired`——stock-cli 带 `--no-cache` 实调 akshare finance
接口（无效代码 999999），30 秒超时。同分支 rebase 后第二次执行通过；main 上
同提交前序 run 均通过。判定为 flaky：外部数据源偶发超时，非代码问题。

CI 被外网抖动误伤 → 所有 PR 的 check 红绿随机，信心受损。

## 方案

两条候选（issue 正文建议）：

1. **mock akshare 层**——unittest.mock 无法跨 subprocess 进程边界，需注入机制
2. **换更轻的错误路径触发方式**——如 `--days 0` 本地校验即报错，零外网

取舍：方案 2 最快但**丢掉了「subprocess 端到端走 main 序列化管线」的覆盖**
（这正是 F20260902ssfb 修 NaN JSON 解析失败时要锁的回归面），与原测试意图不符。
选方案 1，注入机制用 **env 变量指向 mock 模块文件**：

- `stock-cli.py` `__main__` 入口（main() 调用前）：若 `STOCK_CLI_MOCK_AKSHARE`
  env 存在，用 importlib 加载该文件并替换 `sys.modules["akshare"]`
  ——`cmd_finance` 内部的延迟 `import akshare as ak` 自然拿到 mock
- 生产路径：env 不存在 → 完全不触发，零副作用、零性能影响
- 命名显式（`STOCK_CLI_MOCK_AKSHARE`），测试内注释标明仅测试用

## 改动

### scripts/stock-cli.py（+10 行）

`__main__` 入口加 env 注入点，附注释说明用途与生产零副作用。

### tests/test_stock_cli.py（TestNaNNormalization）

- 原 `test_finance_output_is_valid_json`（invalid code + 实调外网）**改写**：
  subprocess env 注入 mock akshare（返回含 NaN/Inf 的财务 DataFrame），
  断言 `json.loads(stdout)` 通过 + NaN/Inf 已序列化为 null + 正常值无损
  ——覆盖从「错误路径 sanity check」**升级为全管线回归测试**
  （mock DataFrame → cmd_finance 重塑 → main `_normalize` + `allow_nan=False`
  序列化 → stdout），原 sanity check 变成本用例的特例
- 新增 `test_finance_invalid_code_error_json_is_valid`：保留原 sanity check
  形态（invalid code → 确定性错误 JSON），同样走 mock 不碰外网
- subprocess 调用从 `python3` 改为 `sys.executable`——与运行 pytest 的
  解释器一致（CI 上是装了 akshare 的那个），消除解释器错位风险

## 验证

- `pytest tests/test_stock_cli.py`：52 全过，3.09s（原单条就可能 30s 超时）
- TestNaNNormalization 连跑 5 轮：全过（1.4s~3.4s），无外网依赖
- 生产路径回归：无 env 时 `stock-cli.py kline 999999 --days 2` 走真实
  akshare 返回结构化错误 JSON，行为不变

## 已知边界

- env 注入点在 `__main__` 守卫内——模块方式 import stock-cli（如测试头部
  的 `importlib` 加载）不触发，不影响其他 50 个测试的进程内 mock 方式
- mock 只有 `stock_financial_abstract` 一个函数；若未来其他命令的 subprocess
  测试要走同机制，mock 文件需扩展（测试内 MOCK_AKSHARE 常量，就近维护）
