---
id: F20260907qexp
title: quote 命令暴露给 LLM 工具 + Python 测试接入 CI
date: 2026-09-07
summary: 搭档裁决暴露 quote 实时行情命令给 stock_data 工具（VALID_COMMANDS 收录 + 描述更新），附带补上 stock-cli.py 51 个 Python 测试的 CI 缺口（裸 pytest 亲测 7 挂——测试真 import akshare，CI 需装完整依赖）。
change_type: feature
tags: [stock-tools, quote, ci, python-tests, tool-expose]
modules: [src/interface-adapters/agent-runtime/tools/stock-tools.ts, .github/workflows/ci.yml, tests/interface-adapters/agent-runtime/stock-tools.test.ts]
capability_test: "n/a: 工具枚举扩展与 CI 接入，行为由单元测试覆盖（stock-tools 17/17 含 quote 新用例）"
from: [F20260904pptq]
created_in_conversation: 71782d9a-32b7-4f3e-8f80-6a946b786a9d
intent:
  problem: "quote 实时行情命令只有 gateway 内部降级时可用，海獭无法直接查盘中实时价；stock-cli.py 51 个 Python 测试不在 CI 覆盖内，quote 兜底链改坏只能等真实操盘才炸"
  expected_effect: "海獭可直接 command=quote 查实时价（同一条命令链，无绕过风险）；CI 每 PR 跑 pytest，Python 侧回归即时可见"
  verify_by:
    type: capability_test
---

## 背景与需求

#802（PR #799 检视遗留 open question）：quote 命令（新浪实时行情，9/4 生产故障后 gateway 兜底链的一部分）是否暴露到 stock_data 工具。当时不暴露的理由是「防 LLM 绕过 gateway 兜底链」——检视-D类批次（9/7）复核此理由不成立：quote 走的就是同一条 gateway 命令链（spawn stock-cli.py），与 kline 受同样的缓存/超时/输出截断约束。海獭查实时价只能绕道 kline 拿收盘价，盘中数据缺失。

**搭档裁决（2026-09-07 09:45-10:13）**：暴露（倾向被采纳）；同批补 CI pytest（检视-D类批次 发现的存量缺口）。搭档并追问了「为什么有 Python / gateway 是什么 / 命令清单是什么」——架构澄清后授权「ok，你合」（终审合并权下放，本 PR 凭此授权在异体审视通过后由大獭执行 merge）。

## 方案设计

### 1. quote 收录（#802）

- `VALID_COMMANDS` + `"quote"`（白名单枚举，stock-tools.ts:18）
- `COMMANDS_NEEDING_CODE` + `"quote"`（需 code）
- 工具描述补 quote 行 + 港股 hkline/hvaluation 两行（原描述漏列，顺带补全）；首行「A 股数据查询」改「A 股+港股」（描述与枚举实际不符，遗留）
- code 参数 description 同步更新必填清单

### 2. CI pytest step（检视-D类批次观察项）

ci.yml check job 末尾新增 `Run stock-cli Python tests`：

```yaml
python3 -m pip install --quiet pytest akshare
python3 -m pytest tests/test_stock_cli.py -q
```

**踩坑记录（重要）**：初版只装 pytest——假设「测试全 mock 不需要 akshare」。**临时 venv 模拟 CI 环境实测 7 挂**：测试文件内部真 `import akshare as ak`（mock.patch 需要真模块存在），`ModuleNotFoundError`。装 akshare 后 51/51 绿（本机裸 venv 验证 25s）。CI 时长代价：akshare 安装约 1-2 分钟（无缓存首跑），可接受；后续可优化 pip cache。

### 3. 测试新增（stock-tools.test.ts）

- `quote 收录进合法命令清单`：透传断言 spawn 参数末尾 `["quote", "600519"]`；mock 模式对齐「venv 探测优先级」用例（首次 spawn = akshare 探测 exit 0，二次 = 数据）——测试执行顺序影响 checkAkshare 缓存命中，新用例需自备探测 mock
- `quote 未提供 code 时拒绝`：COMMANDS_NEEDING_CODE 覆盖
- 成功路径断言用 `result.isError ?? false`（textResponse 工厂不带 isError 字段，与 errorResponse 形状不同）

## 验证结果

- stock-tools.test.ts 17/17（含新增 2）
- 全量 3064 passed (245 files)
- tsc --noEmit 0 error
- Python：本机 venv 51/51；裸 venv + akshare 51/51（CI 环境模拟）
- CI 实跑：PR 创建后 check job 实查（含新 pytest step）

## 影响范围

- 海獭可盘中直接查实时价（quote 出现在工具 enum + 描述，LLM 可发现）
- CI 每 PR 多跑 pytest（约 +2-3 分钟），Python 侧回归即时可见
- gateway 内部降级链不受影响（不经 VALID_COMMANDS）

## 合并授权记录

搭档原话「ok，你合」（2026-09-07 10:13，在 #802 倾向暴露 + CI pytest 方案陈述后）。本 PR 由大獭实现，按流程经检视獭异体审视后由大獭执行 merge，决策链在此留痕。
