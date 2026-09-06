---
id: F20260906tldb
title: "工具链 D 类批次修复：stock-cli 常量化 + gateway stderr 收集 + golden runner PR 兜底"
summary: "#800：stock-cli.py 新浪实时接口字段索引 magic number 换命名常量；#801：executeCliJson 恢复 stderr 收集（debug 日志级）；#793：golden.runner.ts 本地跑 pr 字段兜底（local:<git branch>）"
change_type: fix
capability_test: "n/a: 纯基础设施修复（常量化 + 日志 + 测试兜底），行为由单元测试覆盖"
created_in_conversation: 71782d9a-32b7-4f3e-8f80-6a946b786a9d
tags: [stock-cli, gateway, golden-gate, constants, stderr, fallback, bugfix]
modules:
  - scripts/stock-cli.py
  - src/frameworks/stock/stock-quote-gateway-impl.ts
  - tests/capability/golden/golden.runner.ts
  - tests/test_stock_cli.py
created_at: 2026-09-06
---

# 工具链 D 类批次修复

## #800：stock-cli.py 新浪实时接口字段索引常量化

`fetch_sina_realtime` 中 `fields[30]`/`fields[31]` 是事实标准无官方文档的 magic number。
定义命名常量 `SINA_IDX_DATE = 30`、`SINA_IDX_TIME = 31` 等，接口改版时维护者可快速定位映射。

**改动**：
- 新增模块级常量 `SINA_IDX_*`（NAME=0, OPEN=1, PREV_CLOSE=2, PRICE=3, HIGH=4, LOW=5, DATE=30, TIME=31）
- 替换函数内所有 `fields[N]` 引用为常量
- 测试文件 `tests/test_stock_cli.py` 同步更新

## #801：executeCliJson 恢复 stderr 收集

F20260904pptq 重构时丢失了 stderr 收集。Python 端 warnings（akshare deprecation、网络警告）在 TS 侧完全丢失，下次 CLI 故障排查时诊断成本增加。

**改动**：
- `executeCliJson` 内新增 `proc.stderr.on("data", ...)` 收集 stderr
- 非零退出时 `console.debug` 输出 stderr（debug 级别，不暴露上层）

## #793：golden.runner.ts 本地跑 pr 字段兜底

本地跑 golden 测试时 `currentPr()` 返回 `undefined`，results.jsonl 条目 pr 字段缺省，PR 关联靠人工时间戳对齐。

**改动**：
- `currentPr()` 新增优先级链：`PR_NUMBER` 环境变量 → `GITHUB_REF`（CI）→ `git rev-parse --abbrev-ref HEAD`（本地兜底）
- 本地跑返回 `"local:<branch>"` 字符串，保留分支信息
- 注释说明 `PR_NUMBER` 环境变量用法

## 验证

- `npm run build`：成功
- `npx tsc --noEmit`：成功
- `npx eslint`：1 warning（no-console，预期）
- `npx vitest run`：3043/3043 通过
- `python3 -m pytest tests/test_stock_cli.py`：51/51 通过
- 已过最简检查：各改动均为最小必要修改
