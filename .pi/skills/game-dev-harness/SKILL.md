---
name: game-dev-harness
description: >-
  Use when: 进行游戏开发/调试图形行为/给游戏加可读性接口/做确定性回归——「游戏开发 harness」方法论要求每个游戏暴露 agent 可读的调试状态、种子化随机、确定性推进、截图 diff 能力。
  Not for: 通用代码调试（非游戏） → troubleshooting. 游戏实现完成后做代码审视 → adversarial-review. 闲聊设计想法 → companion.
  Output: 游戏侧可读性接口（seed/state/tick/screenshot）+ 截图基线 + 同 seed 双跑 similarity=100% 的回归证据；或按四层分级指导评估现有游戏缺哪层，给出补接口建议。
  能力摘要：把「游戏作为调试 harness」从理念落成四层分级指导 + 三个原子工具（game-shot/game-diff/game-state），LLM 按规模灵活取用，不做强 SOP。
co_loads: []
category: technique
---

# Game Dev Harness（游戏开发 Harness）

源自 Kyle Kukshtel《Your Game Is A Harness》（2026-10-10）。核心主张：游戏不是成品，是 agent 调试系统的 harness——暴露足够的可读性接口（state/seed/tick/screenshot）后，LLM 就能像读代码一样「读游戏」、回归验证玩法改动。

本仓已配齐三个原子工具（见下「配套工具」），本 skill 负责讲清楚**何时用、按什么优先级用、缺接口时如何补**。四层分级是本 skill 的核心——LLM 按规模灵活取用，**不做强 SOP**（这是搭档 2026-10-14 的设计决策：agent 时代，分级指导优于固定步骤）。

## 四层分级（搭档定稿：第一性原理 > 底线 > 必需 > 建议）

详细展开见 `references/layered-guidance.md`。速查：

- **第一性原理**：游戏是 agent 的调试 harness，不是仅给人类玩的成品。所有可读性投入都服务这一件事。
- **底线**（不可让步）：种子化随机（同 seed 双跑必须 similarity=100%）、状态可读（export/import 对称）、确定性推进（tick/step 函数）、截图可定格。
- **必需**（验证门）：同 seed 双跑 similarity=100%、关键场景截图基线 ≥4 张（含战斗态）、图像 diff 通过（mismatchRatio<1%）。
- **建议**（锦上添花）：全存档可序列化、tick 可暂停/单步、任意时刻注入任意状态、性能计数器暴露。

## 规模评估（LLM 自主判断）

改动越大，越需要 harness 兜底；改动越小，四层可以裁剪。判断锚点：

- **改数值/调平衡**：底线即可（seed + 截图对比）。
- **改玩法逻辑/战斗流程**：底线 + 必需全上。
- **改渲染/动画/视觉**：必需 + 建议层的「全存档可序列化」（视觉回归要状态可复现）。
- **新玩法原型**：四层全上。

## 配套工具（scripts/game/）

| 工具 | 用途 | 核心参数 |
|---|---|---|
| `game-shot.mjs` | Playwright 截图（seed/ticks/state 可控） | `--seed=N --ticks=N --state=<json> --out=x.png --viewport=WxH` |
| `game-diff.mjs` | 两张 PNG 图像 diff（pixelmatch+pngjs） | `<a.png> <b.png> [--threshold=0.1] [--max-ratio=0.01]` |
| `game-state.mjs` | 调 `window.__gameState()` 导出 JSON | `--seed --ticks --state` |
| `lib/launch.mjs` | 共享启动序列（加载→seed→state→tick） | 内部模块 |

三者互相独立，可单独调用，也可串成「截图→diff→再截图」的回归链路。

## 工作流（参考流程非强制步骤）

> ⚠️ 本节是参考流程，**不是强制 SOP**。LLM 根据改动规模、现有 harness 完备度灵活裁剪步骤顺序。四层分级是指导，步骤序列只是常见组合。

### 给新游戏接入 harness

1. **暴露 4 个接口**（底线层）：
   - `window.__gameState()` — 返回可 JSON 序列化的完整运行时状态（玩家/背包/解锁/flags/战斗 B 状态）。
   - `window.__loadState(json)` — `__gameState` 的逆操作；校验字段后写回，可直达任意场景（开局/某点位/终战/图鉴）。
   - `?seed=N` — URL 参数触发 mulberry32 PRNG 替换 `Math.random`（核心玩法 + 表现层粒子都要走同一 PRNG，seed 模式下表现层同样确定）。
   - `window.__tick(n)` — 推进 n 步确定性逻辑（rAF 暂停自驱，由 tick 驱动）。
2. **战斗节拍 tick 化**：把 `setTimeout(bTurn, 400)` 这类墙钟节拍改成 tick 派生（`__schedule(fn, ticks)`，16.7ms/tick），保持串行语义。
3. **接工具**：`game-shot` / `game-diff` / `game-state` 开箱即用，不需要游戏侧再写胶水代码。
4. **立基线**：对关键场景（开局/某点位解锁态/终战战斗态/图鉴全开态）跑 `game-shot --seed=42 --state=<scene>.json`，产出 4-6 张基线 PNG 入库 `game/baselines/`。
5. **回归**：改玩法后跑同 seed 双截图，`game-diff` mismatchRatio<1% 为通过。

### 给现有游戏补 harness（诊断模式）

如果接手一个无 harness 的游戏，按四层查缺：

- 缺 seed → 加 `?seed=N` 入口（mulberry32 替换 Math.random 是最小改动）
- 缺 state → 加 `__gameState/__loadState`（先从只读导出做起，再补写入）
- 缺 tick → 把 setTimeout 链改派生队列（见 `references/layered-guidance.md`「战斗节拍派生化」节）
- 缺截图 → 用 `game-shot.mjs` 接入（Playwright 已装）

### 视觉回归（改渲染/动画时）

1. `game-state` 导出关键场景状态到 JSON。
2. 改代码。
3. `game-shot --state=<scene>.json --seed=42 --ticks=80 --out=new.png`。
4. `game-diff game/baselines/<scene>.seed42.png new.png` → mismatchRatio<1% 通过；>1% 人工看 diff.png 判断是否预期。

## 已接入的游戏

- **game/index.html（獭之传说 · 海藻农场）**：完整四层。`__gameState/__loadState/__tick/?seed=N` 均已实装；`game/baselines/` 有 4 张关键场景基线（seed=42）。
- 其它游戏未接入。接入成本参考：海藻农场首次接入约 3 小时（含接口 + 基线 + 回归脚本）。

## 反例（什么时候不要套这个 skill）

- 改纯逻辑层（无 Canvas 表现、无随机）：直接 `npm test` 就够，不需要 harness。
- 游戏已完成、不再迭代：不需要补 harness，收益不回本。
- 排查通用系统问题（非游戏）：走 troubleshooting。

## 参考

- `references/layered-guidance.md` — 四层详细展开 + 规模评估指引 + 海藻农场接入示例
- 《Your Game Is A Harness》原文：https://kylekukshtel.com/your-game-is-a-harness
