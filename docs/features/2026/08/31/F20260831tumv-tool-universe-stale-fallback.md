---
id: F20260831tumv
title: 工具白名单 stale fallback 修复：manifest "*" 展开以注册全集为 universe
summary: 0831 操盘日报现场发现 big 型 session 缺 stock_data/paper_trade——getOtterToolNamesForType 的 allToolNames 传 undefined 时 fallback 到硬编码列表，manifest "*" 展开以此为全集，tool-factory 新注册的工具被 whitelist 滤掉。修复：pi-session-factory 先调 cfg.createTools 取注册全集再算白名单；附带修复 coding-tools.test.ts「生产路径」断言的路径多算一级问题（原断言从未走过 manifest，假绿）。
change_type: fix
created_in_conversation: 53d775fd-2167-465a-ae2e-c6962d5f4dfb
from:
  - F20260820a4rt
  - F20260829ppta
tags: [agent, tools, manifest, whitelist, tool-routing]
modules:
  - src/frameworks/agent/pi-session-factory.ts
  - src/frameworks/agent/session-helpers.ts
  - tests/frameworks/agent/tool-universe.test.ts
  - tests/frameworks/agent/coding-tools.test.ts
---

# 工具白名单 stale fallback 修复（F20260831tumv）

## 背景

2026-08-31 15:30 操盘日报定时任务触发时，大獭（big 型）session 的工具清单缺 `stock_data` 与 `paper_trade`（healing 已挂账）。同日创建的操盘獭（small 型）session **有**这两个工具。

## 根因

调用链（file:line 锚定）：

1. `pi-session-factory.ts` `_createSessionWithTools`：`getOtterToolNamesForType(otterType, undefined, process.cwd(), logger)` —— `allToolNames` 传 **undefined**
2. `session-helpers.ts:40-60`：fallback 硬编码列表（35 个工具名）不含 stock_data/paper_trade（PR4/PR5 只改了 manifest，没同步这里）
3. `tool-manifest-loader.ts` `getToolNamesFromManifest`：big 型 `tools: "*"` → `return allToolNames` = 那个 stale 硬编码列表
4. `tool-builder.ts`：用该列表 filter 已注册工具 → stock_data/paper_trade 被滤掉

**为什么 small 型没事**：small 走 groups 显式展开（manifest capabilityBlocks 的 stock/paper-trading 块），不经过 `"*"` 展开的 universe。

**结构性问题**：`"*" ` 的语义是"tool-factory 注册的全部工具"，但 universe 与注册集脱钩、靠手工同步——每加一个新工具都可能再踩一次。

## 方案设计

- **修复点**：`pi-session-factory.ts` `_createSessionWithTools` 中，先调用 `this.cfg.createTools(EMPTY_TOOL_CONTEXT, ...)` 获取**实际注册的工具全集**（只取名字），再传给 `getOtterToolNamesForType` 作为 universe。manifest 加载失败时 fallback 到硬编码列表 = 注册全集（自动正确）；manifest 加载成功时 `"*"` 展开为注册全集（自动正确）。两路都不再依赖手工同步。
- **为何不删 fallback 硬编码列表**：它是 manifest 加载失败（文件缺失/JSON 损坏/schema 不合规）时的最后防线，保留但从此只作为 `allToolNames` 缺省时的兜底（生产主路径已传注册全集，不再触达）。
- **不选方案**（记录取舍）：
  - 在 fallback 列表里补上 stock_data/paper_trade —— 治标，下次加工具再踩
  - tool-builder 内部注册后回读白名单重算 —— 时序耦合更深，改动面大
- **副作用评估**：`createTools` 提前调用一次，工厂函数是纯注册（构造工具对象，不执行副作用——Ledger 等实体是构造注入，不发请求）；真实 ctx 构造在 `buildCustomTools` 原样保留，第二次调用才是"实弹"。EMPTY_TOOL_CONTEXT 传占位值（client 为 undefined!，工具工厂不读该字段），若未来工厂改为按 ctx 字段惰性过滤注册集，需重构此处（见遗留观察）。

## 改动清单

| 文件 | 类型 | 说明 |
|------|------|------|
| src/frameworks/agent/pi-session-factory.ts | 修改 | `_createSessionWithTools`：注册全集先于白名单计算；新增 `EMPTY_TOOL_CONTEXT` 占位上下文（带 Why 注释） |
| tests/frameworks/agent/tool-universe.test.ts | 新增 | 5 断言：stale fallback 复现 / 修复后展开 / 真实 manifest big 型 / small 型 groups 展开 / 防退化（缺省 universe 不含新工具） |
| tests/frameworks/agent/coding-tools.test.ts | 修改 | 「生产路径（manifest）」2 处 `projectRoot` 从 4 级改 3 级——原路径落在 `.claude/worktrees/` 上无 config/ 目录，loadToolManifest 返回 null，断言一直在测 fallback（假绿）；顺带补 small 型 stock_data/paper_trade 断言 |

## 验证

- `npx tsc --noEmit`：通过
- `npx vitest run tests/frameworks/agent/ tests/frameworks/config/`：19 文件 315 测试全过
- 全量套件：**193 文件 2365 测试全过**（无 pre-existing 失败，无需声明）
- `npx eslint`（改动文件）：通过
- **最简实现检查**：已过——单点改动（一处调用序修正 + 占位 ctx），无新增依赖、无新增文件（测试文件除外），未引入抽象层。

## 遗留观察（非阻断）

1. **fallback 硬编码列表与 tool-factory 注册集仍是两份**——本次修复后生产主路径不再依赖它，但它仍作为 manifest 失败时的缺省 universe。长期可考虑 lint 规则强制两者同步，或从注册集动态生成。
2. `coding-tools.test.ts` 原「生产路径」断言假绿暴露出**断言面与生产面同构性**的脆弱性——F20260827c2sg 曾专门为此加过真实 manifest 断言，却因路径错误失效。测试中 `join(import.meta.dirname, ...)` 类路径计算建议加一个 `existsSync(config/tool-manifest.json)` 前置断言（本 PR 的 tool-universe.test.ts 通过「防退化」断言间接覆盖）。
