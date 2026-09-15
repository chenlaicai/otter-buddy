---
id: F20260915stck
title: akshareCheckCache 失败不缓存：环境修复后自愈无需重启
summary: stock_data 工具的 akshareCheckCache 成功/失败同等对待且永久缓存，导致环境修复后必须重启进程才能恢复。改为失败不缓存（成功保持缓存），环境修好后下一次调用立即恢复。closes #952
change_type: fix
capability_test: "n/a: 纯缓存行为修复，由单测覆盖（stock-tools.test.ts 22/22 含 2 个 #952 缓存行为用例）"
created_in_conversation: 53d775fd-2167-465a-ae2e-c6962d5f4dfb
doc_type: feature
tags: [stock, cache, akshare, self-healing, bugfix]
modules: [src/interface-adapters/agent-runtime/tools/stock-tools.ts]
created_at: 2026-09-15T16:17:00+08:00
intent:
  problem: "akshareCheckCache 失败永久缓存导致「环境修好后必须重启进程才能恢复」——搭档质疑「后面出问题又得重启」合理，缓存设计缺陷"
  expected_effect: "环境修复后下一次调用立即恢复，无需重启进程；成功结果保持缓存避免每次调用付 1-2s Python 冷启动税"
  verify_by:
    type: behavior_check
---

# F20260915stck akshareCheckCache 失败不缓存

## 背景

2026-09-15 15:30 操盘獭定时任务触发时，`stock_data` 工具报「akshare 未安装」，但实测脚本直调正常（akshare 1.18.94 已装好）。根因链：

1. `.venv-stock` 曾是指向自己的符号链接死循环（9/13 17:15 现场）→ 进程启动时检测到「未安装」
2. `stock-tools.ts:72` 的 `akshareCheckCache` **成功/失败同等对待且永久缓存** → 环境修复后工具仍返回缓存的旧错误
3. 必须重启进程才能清缓存——搭档质疑「后面出问题又得重启」合理，本 PR 根治

**影响**：9/14-9/15 两天撮合任务 + NAV 计算 + 操盘日报全流产（A 股收盘后无法补数据，接受为断点）。

## 方案设计

**失败不缓存**（方案 B）：删 `akshareCheckCache.set(pythonPath, msg)` 一行。

**三方案取舍**：

| 方案 | 改动 | 优点 | 缺点 | 决策 |
|---|---|---|---|---|
| A. 失败加 TTL（60s） | 缓存结构加时间戳 + 过期判断 | 环境修好后最多等 60s 恢复 | 仍有等待窗口；缓存逻辑变复杂 | ❌ |
| B. 失败不缓存 | 删一行 | 环境修好后**零等待**立即恢复；代码最简 | 环境真坏时每次调用多付 1-2s 冷启动税 | ✅ |
| C. 缓存 + 后台定时刷新 | 加定时器每 5 分钟重检 | 用户无感知 | 复杂度最高；定时器生命周期管理麻烦 | ❌ |

**选 B 理由**：
- 冷启动税只在「环境真坏」时付，而环境坏时用户本来就调不了数据，多等 1-2s 无所谓
- 生产调用面是日频（操盘獭 ~9 次/天），全失败场景多付 ~18s/天，可忽略
- 改动最小，行为最可预期

## 影响范围

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/interface-adapters/agent-runtime/tools/stock-tools.ts` | 修改 | 删 `akshareCheckCache.set(pythonPath, msg)`（失败不缓存）；成功保持缓存 |
| `tests/interface-adapters/agent-runtime/stock-tools.test.ts` | 修改 | +2 用例（失败不缓存自愈 / 成功保持缓存）；拆分 describe 满足 220 行 lint 上限 |

**未做（已记录）**：resolvePython 双源合并——尝试让 `stock-tools.ts` import `@frameworks/stock/python` 被 ESLint `no-restricted-imports` 拦截（interface-adapters 层不能 import frameworks 层）。`stock-quote-gateway-impl.ts` 在 frameworks 层可以 import，但 stock-tools 在 interface-adapters 层不行。保持现状，注释已更新记录此约束。

## 验证

- [x] stock-tools.test.ts 20/20 通过（含 2 个 #952 缓存行为用例，删除重复后）
- [x] 后端全量 3071/3071 通过
- [x] TSC 0 error
- [x] lint 0 error 4 pre-existing warning
- [x] 最简实现检查：已过阶梯——删一行 + 补 2 测试，无新依赖/新机制。checked: 已过最简检查

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 失败缓存策略 | 不缓存 | TTL 60s / 定时刷新 | 零等待恢复 + 代码最简 + 异常路径冷启动税可接受 |
| 成功缓存策略 | 保持永久缓存 | 也加 TTL | 成功状态稳定（装好 akshare 后不会自己卸载），永久缓存合理 |
| resolvePython 双源 | 保持现状 | 合并到 frameworks/stock/python | ESLint no-restricted-imports 拦截，interface-adapters 不能 import frameworks |

## 不兼容更新

无。行为变化：环境坏时每次调用多付 1-2s 冷启动税（原行为：第一次付后续命中缓存）。环境正常时行为不变。

## 后续动作

- 合入后明日（9/16）15:05/15:30 任务应恢复正常（环境已修好 + 缓存修复后不再僵尸）
- 观察是否有其他「环境探测缓存」同类问题（如网络可达性、外部服务状态）需要同样治理
