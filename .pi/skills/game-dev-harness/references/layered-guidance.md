# Game Dev Harness 四层分级指导

> 本文是 `game-dev-harness` skill 的参考展开。skill 正文给速查，这里给**每一层的可操作细节**与**规模评估指引**。LLM 按需取用，不必全读。出处归特性文档 frontmatter causal_links 与 git 历史。

源自 Kyle Kukshtel《Your Game Is A Harness》（2026-10-10）。核心一句话：**游戏不是成品，是 agent 的调试 harness**。当 LLM 能像读代码一样「读游戏」（看状态、推 tick、截屏 diff），游戏开发的迭代速度会数量级提升。

---

## 第一层：第一性原理

**游戏是 agent 的调试 harness，不是仅给人类玩的成品。**

这条原理改变开发优先级：

- 一个**不可读**但好玩的游戏，对 agent 来说几乎不可维护（每次改动都要人肉试玩）。
- 一个**可读**但稍简单的游戏，agent 可以快速迭代到「简单但正确」再往上堆复杂度。

所以投入可读性接口不是「额外工作」，是**让游戏可维护的前提**。

### 落地推论

- 玩法逻辑不要藏在闭包里——挂在 `window` 或导出到 `S`/`B` 这种全局状态对象上。
- 随机数要走可注入的 PRNG，不要直接 `Math.random()`。
- 帧循环要可暂停、可单步——否则无法定格截图。
- 所有「墙钟驱动」的玩法节拍（setTimeout 链）都要可转成「逻辑 tick 驱动」。

---

## 第二层：底线（不可让步）

底线层缺任何一条，agent 都无法可靠调试游戏。**新游戏接入 harness 时这 4 条必须先做**。

### B1. 种子化随机（seed 模式全局确定）

**要求**：URL 加 `?seed=N` 参数后，整个游戏（含表现层粒子、动画抖动）完全确定；同 seed 双跑像素级一致。

**做法**：

```js
// mulberry32 PRNG，替换 Math.random
var __seed = null;
(function () {
  var m = /[?&]seed=(\d+)/.exec(location.search);
  if (!m) return;
  __seed = parseInt(m[1], 10) >>> 0;
  var a = __seed;
  Math.random = function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();
```

**注意**：核心玩法和表现层必须走**同一个** `Math.random`——如果表现层用了 `Math.random` 的另一份引用（例如闭包捕获），seed 模式下表现层仍然不确定。

**验收**：同 seed 双跑 `game-shot --seed=42 --ticks=80` 产出的两张 PNG，`game-diff` 输出 `similarity=100.00%`。

### B2. 状态可读（export/import 对称）

**要求**：`window.__gameState()` 返回纯 JSON 可序列化的完整运行时状态；`window.__loadState(json)` 是它的严格逆操作（`__loadState(__gameState())` 必须等价于原状态）。

**形状参考**（海藻农场）：

```js
window.__gameState = function () {
  return {
    tick, seed, started, phase, activeId, allDone,
    player: {x, y, tx, ty},
    bag, unlocks, done, flags, codex,
    battle: S.mode === "battle" ? JSON.parse(JSON.stringify(B)) : null
  };
};
```

**注意**：`battle` 为 null 时 `__loadState` 不应误置 `S.mode`——非战斗状态不要污染战斗标志。

### B3. 确定性推进（tick 驱动）

**要求**：rAF（requestAnimationFrame）在 seed 模式下**暂停自驱**，改由 `window.__tick(n)` 手动推进 n 帧；每帧推进所有派生计时器（保持原 setTimeout 的串行语义）。

**实现**：

```js
var __tickQ = [];   // seed 模式下待派生计时器
var __auto = !/[?&]seed=/.test(location.search);
function __schedule(fn, ticks) {
  if (__seed !== null) { __tickQ.push({ fn, at: S.tick + Math.max(1, Math.round(ticks)) }); return; }
  setTimeout(fn, ticks * 16.7);
}
function __pumpTick() {
  for (var i = 0; i < __tickQ.length; i++) {
    if (__tickQ[i].at <= S.tick) { var q = __tickQ.splice(i, 1)[0]; i--; q.fn(); }
  }
}
function render() {
  S.tick++;
  __pumpTick();
  /* ...原渲染逻辑... */
  if (__auto) requestAnimationFrame(render); // seed 模式：rAF 不自驱
}
window.__tick = function (n) {
  for (var i = 0; i < n; i++) { S.tick++; __pumpTick(); if (S.dirty) bake(); }
  // 推进后补一帧渲染（略）
};
```

**为什么不用 `await page.waitForTimeout`**：墙钟推进依赖 CPU 调度和浏览器帧率，同 seed 双跑可能因帧率差异产生像素级不一致。tick 驱动把「时间」从墙钟解耦成纯逻辑步数。

### B4. 截图可定格

**要求**：`game-shot.mjs --seed=N --ticks=M --state=<json>` 产出确定性 PNG；截图时浮层/对话框不处于中间态。

**做法**：seed 模式下把 setTimeout 驱动的浮层定时（气泡淡散、进化浮层）改 `__schedule` tick 派生，或截图前 `__loadState` 统一隐藏（海藻农场：`__loadState` 后自动 `letterEl.style.display="none"` + 隐藏 dialog）。

---

## 第三层：必需（验证门）

底线层做完后，**改玩法/改渲染前**应通过以下验证门，不通过不进 PR。

### V1. 同 seed 双跑 similarity=100%

**命令**：

```bash
node scripts/game/game-shot.mjs --seed=42 --ticks=80 --out=/tmp/a.png game/index.html
node scripts/game/game-shot.mjs --seed=42 --ticks=80 --out=/tmp/b.png game/index.html
node scripts/game/game-diff.mjs /tmp/a.png /tmp/b.png
# 期望输出：similarity=100.00% ... PASS
```

**失败排查**：
- similarity<100% → 还有未走 mulberry32 的 `Math.random`（grep 一遍游戏代码）。
- 输出尺寸不一致 → 视口没固定，加 `--viewport=480x270`。

### V2. 关键场景截图基线 ≥4 张

至少覆盖：开局 / 一个点位解锁态 / 终战战斗态 / 图鉴全开态。基线存 `game/baselines/*.seed<N>.png`，回归用。

**基线生成**（以终战为例）：

```bash
# 1. 用 game-state 导出现场状态（或手写 JSON）
node scripts/game/game-state.mjs --seed=42 --state=/tmp/scene.json game/index.html > /tmp/scene.json
# 2. 用 game-shot 截基线
node scripts/game/game-shot.mjs --seed=42 --state=/tmp/scene.json --ticks=80 \
  --out=game/baselines/battle.seed42.png game/index.html
```

### V3. 图像 diff 通过（mismatchRatio<1%）

改代码后，对新截图跑 `game-diff`，`mismatchRatio<1%` 为通过。>1% 时看 diff.png 红色像素是否落在预期区域（如 BOSS 血量条），预期内可提阈值或接受。

---

## 第四层：建议（锦上添花）

以下能力让调试更顺，但不阻塞基本迭代。按收益/成本排序：

### S1. 全存档可序列化

把整个 `localStorage` / `IndexedDB` 游戏存档 dump 成 JSON，可注入。比 `__gameState` 更彻底——`__gameState` 只覆盖「当前运行态」，存档覆盖「跨会话进度」。

**成本**：如果游戏本来就把进度放 localStorage，1 行 `JSON.stringify(localStorage)` 即可；否则要设计存档 schema。

### S2. tick 可暂停/单步

`window.__tick(1)` 单步、`window.__tick(0)` 暂停。海藻农场已实现（`__tick(n)` 任意 n）。配合 `game-state` 可以在每一步之间插桩看状态变化。

### S3. 任意时刻注入任意状态

`__loadState` 不只是「恢复之前导出的状态」，还能**构造从未存在过的状态**（如把 BOSS 血量改成 1 滴、把自己护盾叠到 99 层）来测边界分支。

**注意**：构造状态时，依赖前置状态（如 `S.mode`）的字段不要漏。参考海藻农场 `__loadState` 的实现——`json.battle` 非 null 时同步置 `S.mode="battle"`。

### S4. 性能计数器暴露

`window.__perf = { fps: 60, drawCalls: 42, particles: 137 }`，`game-state` 顺带返回。改渲染时一眼看到 drawCall 翻倍。

---

## 规模评估指引（LLM 自主判断）

四层不是「全做/全不做」的二选一，LLM 根据**改动规模**和**现有 harness 完备度**裁剪。

| 改动类型 | 底线 | 必需 | 建议 | 例子 |
|---|---|---|---|---|
| 改数值/调平衡 | ✅ B1(seed) + B4(截图) | ➖ | ➖ | 「把 BOSS 血量从 100 调到 80」 |
| 改玩法逻辑/战斗流程 | ✅ 全上 | ✅ V1+V2+V3 | ➖ | 「战斗加一回合无敌帧」 |
| 改渲染/动画/视觉 | ✅ 全上 | ✅ 全上 | ✅ S1（全存档可序列化） | 「BOSS 出场加粒子特效」 |
| 新玩法原型 | ✅ 全上 | ✅ 全上 | ✅ 全上 | 「加一个钓鱼小游戏」 |

**反向判断**：如果改动**不影响运行时表现**（如改 README、改配置），不需要 harness。

---

## 已接入游戏示例：海藻农场（game/index.html）

完整四层 + 4 个接口 + 4 张基线。接入要点回顾：

1. **PRNG 全局替换**：7 处 `Math.random` 调用（:590 烟雾粒子、:1046 战斗烟雾、:1528/:1568/:1572/:1591/:1597 战斗伤害/事件判定）统一走 mulberry32。
2. **战斗节拍派生化**：`bTurn` 链（:1525/:1559/:1576-1600）+ 占卜/洞察时延（500ms→30 ticks）改 `__schedule`；非 seed 模式回退 `setTimeout(fn, ticks*16.7)` 保持墙钟近似。
3. **浮层定时 tick 化**：气泡淡散（2400ms→144 ticks）+ 进化浮层（900/800ms→54/48 ticks）seed 模式 tick 驱动；非 seed 保持原生。
4. **接口**：`__gameState/__loadState/__tick/?seed=N` 四件套 + `__loadState` 时自动收起开场信/气泡。

**基线**：`game/baselines/{opening,unlocked,battle,codex}.seed42.png`（4 张）。

---

## 反例（什么时候不要套这套）

见 skill 正文「反例」节。补充：如果游戏已完成且不再迭代，不要回头补 harness——**收益不回本**。
