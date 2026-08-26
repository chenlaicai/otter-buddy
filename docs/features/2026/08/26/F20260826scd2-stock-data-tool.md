---
id: F20260826scd2
title: 股票数据 TS 工具注册（stock_data 聚合工具）
summary: "PR2: stock_data TS 工具 — child_process 调桥脚本 + manifest 挂 stock capabilityBlock + mock 子进程单测"
change_type: feature
created_in_conversation: "7df22e6e-caba-4fc9-a3ab-1e9e2a3ff02d"
status: development
capability_test: "n/a: 纯 A 类工具封装，无 LLM 参与行为"
---

# PR2: 股票数据 TS 工具注册

## 背景

Issue #463 定义了股票数据层三期方案。PR2 是第二期：将 `stock_data` TS 工具注册到 otter-buddy 的工具系统，使 LLM 可以通过 `stock_data` 工具调用 PR1 的桥脚本获取 A 股数据。

## 目标

- 新增 `src/interface-adapters/agent-runtime/tools/stock-tools.ts`：聚合式单工具 `stock_data`
- 注册到 `tool-factory.ts`
- 添加 `stock` capabilityBlock 到 `config/tool-manifest.json`（big/small 均开放）
- `.gitignore` 补 `.venv-stock/` 和 `.cache/stock/`
- mock 子进程单测

## 非目标

- PR3（stock-analysis skill）不在本 PR 范围
- 不改任何现有工具行为

## 方案设计

### 工具设计

`stock_data` 是聚合式单工具，不拆成多个细工具——防 tool-factory 膨胀。

**参数**：
- `command`（枚举 kline/overview/finance/news/northflow/selftest）
- `code`（可选，6 位数字校验）
- `days`/`quarter`/`limit`（可选，数值参数）
- `adjust`（可选，kline 命令：qfq=前复权/=不复权/hfq=后复权）
- `no_cache`（可选，布尔）

**执行**：
- `child_process.spawn`（参数数组、不经 shell）调 `python3 <repo>/scripts/stock-cli.py`
- stdout 解析为 JSON 透传
- 退出码非 0 时保留 error 结构

### venv 定位

探测顺序：
1. 环境变量 `STOCK_PYTHON`
2. `<repo>/.venv-stock/bin/python`
3. 系统 `python3`

探测失败/akshare 缺失时返回结构化错误，内含 venv 安装指引。

### 超时

spawn 加 timeout（60s），超时 kill 返回 `{"error":"timeout"}`。

### manifest 挂载

`stock` capabilityBlock 加入 `tool-manifest.json`，big/small 均开放。
设计文档说「分析獭才有眼睛」，但 manifest 目前只有 big/small 两类路由，未来的分析獭是 small otter，所以本 PR 先 small 全量开放。

## 影响范围

| 文件 | 变更类型 |
|------|---------|
| `src/interface-adapters/agent-runtime/tools/stock-tools.ts` | 新增 |
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | 修改（注册） |
| `config/tool-manifest.json` | 修改（添加 stock block） |
| `.gitignore` | 修改（补 venv/cache） |
| `tests/interface-adapters/agent-runtime/stock-tools.test.ts` | 新增 |
| `docs/features/2026/08/26/F20260826scl2-stock-data-tool.md` | 新增 |

## 取舍

| 决策 | 理由 |
|------|------|
| 聚合单工具而非拆分 | 防 tool-factory 膨胀 |
| 无依赖直接注册 | workspaceGateway 那种条件注册模式不适用 |
| small 全量开放 | 未来分析獭是 small otter，类型系统扩展留给后续 |
| 60s 超时 | 防 LLM 卡死等一个挂掉的上游 |

## 验收标准

- [x] stock-tools.ts 实现（参数校验 + spawn + JSON 透传 + venv 探测）
- [x] tool-factory.ts 注册
- [x] tool-manifest.json 添加 stock block
- [x] .gitignore 补 venv/cache
- [x] 单测覆盖（10 项 mock 测试）
- [x] 特性文档

## 单元测试结果

覆盖范围：
- 参数校验（3 项）：未知命令、缺 code、非法 code
- 参数构造（2 项）：kline 参数透传、no_cache 透传
- 错误透传（3 项）：bridge error、spawn 失败、空输出
- venv 探测（1 项）：STOCK_PYTHON 优先级
- akshare 检查（1 项）：缺失时返回安装指引

## 变更记录

- 2026-08-26: 初版实现
