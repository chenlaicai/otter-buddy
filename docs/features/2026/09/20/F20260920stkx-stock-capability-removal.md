---
id: F20260920stkx
title: 炒股能力完整移除：量化实验+看盘工具下架
summary: 删除 stock_data/paper_trade 工具、paper-trading 用例层、stock 网关层、stock-cli、定时任务种子与全部装配点；DB 交易数据与历史文档按拍板保留
change_type: refactor
capability_test: "n/a: deletion——被测对象（炒股工具/用例）已删除，回归防线为零残留扫描+全量测试绿+悬空引用零容忍（tsc/ESLint）"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: 2026-09-20
causal_links:
  - R20260920stkx: 实验复盘与移除决策（本 PR 的决策依据）
tags: [deletion, stock, paper-trading]
modules: [stock, paper-trading, scheduler, tools, config, web]
---

# F20260920stkx 炒股能力完整移除

## 决策背景

搭档 2026-09-20 拍板选项 A：全移除（量化 paper_trade + 看盘 stock_data）。一个月实验 3 买 0 卖、净值 0.99995，败于数据链稳定性 + 主动性缺失。完整复盘见 R20260920stkx（同日研究文档）。

- 决策原话与实验数据：R20260920stkx §1-§2
- 拍板载体：选项卡片回执（choice=A）

## 移除范围

### 整目录/整文件删除（git rm）

| 路径 | 内容 |
|------|------|
| `src/usecases/paper-trading/`（除 function-registry.ts 迁移，见下） | 6 文件：ledger / repository 接口 / quote-gateway 接口 / ensure-scheduler / register-functions / sync-trading-calendar |
| `src/frameworks/stock/` | stock-quote-gateway-impl.ts / python.ts |
| `src/entities/paper-trading/` | paper-account 实体 |
| `src/frameworks/db/paper-trade-repository-impl.ts` | DB 仓储实现 |
| `src/interface-adapters/agent-runtime/tools/stock-tools.ts` | stock_data 工具 |
| `src/interface-adapters/agent-runtime/tools/paper-trade-tool.ts` | paper_trade 工具 |
| `scripts/stock-cli.py` + `scripts/README-stock-cli.md` | Python 数据 CLI |
| `.pi/skills/stock-analysis/` | 看盘 skill |
| `prompts/scheduled/paper-trading-daily.md` | 操盘定时任务 prompt |
| `tests/`：test_stock_cli.py、stock/、paper-trading 用例、repository-impl 两个测试、stock-tools/paper-trade-tool 工具测试 | 对应测试 |

### 装配点/引用清理（逐处）

| 文件 | 清理内容 |
|------|----------|
| `src/bootstrap/platforms.ts` | createTools 内 Ledger 装配（PR4 块）、initAgentAndScheduler 内 registerPaperTradingFunctions/syncTradingCalendar/seedPaperTradingTasks（PR5 块）、functionRegistry 注入；清理后 gateOn/inferDomainActive import 收回 |
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | stock_data/paper_trade 注册、paperLedger 参数（第 6 参数删除，恢复 5 参签名） |
| `src/frameworks/db/migration.ts` | addDescriptionColumn 的 paper-trading 两 seed 任务描述回填（清单置空；存量 DB 已回填值保留） |
| `src/bootstrap/feature-gates.ts` | DOMAIN_TASK_NAMES/FeatureGates/resolveFeatureGates 的 paperTrading 域整体移除 |
| `src/frameworks/features-config.ts` + `config-service.ts` | features.paperTrading 三态归一化链（RawFeatures/NormalizedFeatures/AppConfig.features/RawConfig.features） |
| `config/tool-manifest.json` | capabilityBlocks.stock / capabilityBlocks.paper-trading 两块 + small groups 引用 |
| `eslint.config.mjs` | restrictedFrameworks 的 `stock(?:/|$)` 负向前瞻豁免、interface-adapters 层 `stock/python` 豁免、ignores 的 `.venv-stock/**`（被 `.venv*/**` 覆盖） |
| `.github/workflows/ci.yml` | 「Run stock-cli Python tests」步骤（含 pip install pytest akshare） |
| `web/src/pages/skills/index.tsx` | 元规范组 stock-analysis 条目 |
| `prompts/skills/manifest.yaml` | stock-analysis skill 声明（领域层） |
| `src/frameworks/agent/pi-session-factory.ts` | 注释中 stock_data/paper_trade 具名示例改中性表述（机制说明保留） |
| `src/usecases/scheduler/prompt-template-reconciler.ts` | 注释更新：JSON 包装兼容标注为通用机制（原 paper-trading 场景已移除，无在用者） |

### 机制保留与迁移（非删除项）

| 项 | 处置 | 理由 |
|----|------|------|
| `FunctionRegistry`（function executor 注册表） | **迁移**：`@usecases/paper-trading/function-registry` → `@usecases/scheduler/function-registry`；删除全局实例 paperTradingFunctionRegistry | function executor 是 scheduler 通用机制（schema executor_type 列、mapper、核心循环 PR4 分支），唯一消费者退役不等于机制退役；类重命名为通用描述。注册表为空时 function 任务触发会抛 validation 错（不静默降级），存量 DB 若残留 executorType='function' 的 active 任务会在触发时显式失败——运行时清理见下 |
| prompt-template-reconciler JSON 包装兼容 | 保留机制 | 模板→DB 对账方向，模板文件已删，存量任务天然不再被对账（无模板=天然豁免），代码路径无 paper 依赖 |
| scheduler-service function executor 分支 | 保留 | 同 FunctionRegistry——通用调度能力 |

## 保留项（拍板的一部分，一样不许删）

- **DB 表与数据**：paper_accounts / paper_positions / paper_cash / paper_orders / paper_trades / paper_nav_history / paper_reports / paper_corporate_actions（9 表）——**建表语句保留在 schema.ts**（历史数据可查），存量数据不删不迁移。3 笔买入与净值历史是实验档案
- **历史特性文档**：docs/features/ 下已合入的炒股相关文档（F20260827test 等）——历史不可变铁律
- **DB schema 建表语句**：createPaperTradingTables 保留（见上）

## 影响面

- 小獭工具白名单：manifest small groups 少了 stock/paper-trading 两块，small 型不再持有 stock_data/paper_trade（工具本体已删，白名单随之无意义）
- config.yaml 中残留的 `features.paperTrading` 键：被忽略（RawFeatures 无此字段），不报错不 warn——老配置无需立即清理
- 存量 DB 的 paper-trading 定时任务（scheduled_tasks 两行 active）：**运行时清理由大獭在合入后执行**（见下），代码侧 seed/注册已移除，重启后不会再注入

## 运行时后续动作（合入后由大獭执行，不在本 PR）

1. **scheduled_tasks 表清理**：两行 active 记录（paper-trading-daily-trading / paper-trading-match-orders）删除或置 disabled——不清也不会复活（seed 已删），但会留着无效触发（daily 任务在 executorType=agent 下会唤醒獭读已删 prompt；match-orders 为 function 型，触发时抛 validation 错进失败计数）
2. **.venv-stock 自循环符号链接清理**：本机运行时垃圾（9/17 事故产物），git 外文件
3. **issue 关闭**：#734（overview 备源触发条件——宿主已删，wontfix）、#803（push2delay 第三备源——同上）

## 已知边界

- migration.ts 的 paper-trading 描述回填已移除，但 addDescriptionColumn 函数本身保留（列迁移对老库仍必需）
- tool-universe / coding-tools 测试改用中性虚拟工具名（future_tool_a/b）承载回归语义——F20260831tumv 的「manifest '*' 展开以注册全集为 universe」机制与具体工具解耦
- 测试 fixture 中保留的 paper-trading-match-orders 任务名（migration.test 存量数据模拟、reconciler 无）仅为老库仿真，非活引用

## 验证

- `npx tsc --noEmit`：rc=0（零悬空引用）
- `npx eslint src tests scripts`：0 errors
- 全量测试：见 PR 描述（commit 时实测数字）
- 零残留扫描：`grep -rl 'stock\|paper-trad' src/ tests/ scripts/ config/ prompts/ .pi/ web/ .github/`——命中仅为负向断言（not.toContain）、历史注释、DB schema 建表（保留项）
