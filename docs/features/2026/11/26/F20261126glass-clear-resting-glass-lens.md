---
id: F20261126glass
title: 顶栏静止块改为常驻透明水玻璃透镜，退役乳白选中块
summary: 搭档指出静止选中块不该是乳白/薄纱——水玻璃从始至终透明。GlassLens 透镜改为静止常驻：静止端参数集重定义为清玻璃（frost≈0、保留光效/投影/可见折射），液滴流动端点不动；DOM 高亮块降级为 fallback 并去掉纯白；修复透镜首次绘制的两个启动死点（IO 后无 wake、静止帧无 dirty）。
change_type: feature
intent:
  problem: "顶栏静止选中块是纯白乳白 DOM 块（engine 静止端 frost=1 实心染色 + 旧高亮块纯白填充），与搭档要求的水玻璃（从始至终透明、无乳白无薄纱）不符"
  expected_effect: "静止选中块由 WebGL 清玻璃透镜常驻绘制（frost=0.03、静止端 strength=0.5、可见折射），DOM 高亮块仅在降级路径可见且不再使用纯白十六进制色；液滴流动动画端点参数零变化；透镜生命周期闭环（无选中退场、reduced-motion 动态切换退场、几何变化重对位）"
  verify_by:
    type: behavior_check
capability_test: "n/a: 视觉效果类改动——机器验收 = material-v3.test.ts 契约断言（锁 frost/strength 端点与兜底样式）+ 894 单测（含 7 条生命周期行为测试） + Playwright 截图目检（静止/运动/连点/自定义背景标）"
created_in_conversation: 3995c48d-499a-4c2d-b04f-e3581a3d3e28
created_at: 2026-11-26
from: [F20261124tbnav]
tags: [web, ui, topbar, glass, navigation, webgl]
modules: [web]
---

# 顶栏静止块改为常驻透明水玻璃透镜，退役乳白选中块

## 背景

F20261124tbnav 交付的顶栏形态为「乳白静止块＋单枚液滴流动」并已合入（PR #1994）。搭档 2026-11-26 实看后反馈：静止块不应该是乳白色的——水玻璃从始至终没有乳白，也不该是薄纱；液滴流动效果不错，保持。

根因：bilalgursen/liquid-glass 上游的设计是「透镜只在运动/按压时出现，静止回落为 DOM flat highlight」，而集成时 DOM 高亮块样式为纯白 `#ffffff`（globals.css `.glass-nav-highlight`）。同时 engine shader 的静止端 `frost=1` 也会把透镜染成 flat highlight 色——两头都是乳白。

这正是 F20261124tbnav 迭代记录里否决过的「薄纱/tint」问题的残留：当时解决的是宽底座 tint，选中块的乳白被保留成了「凸起选中块」语义，与搭档的水玻璃预期不符。

## 目标 / 非目标

**目标**
1. 静止选中块 = 透明水玻璃：真折射（背景与文字透过玻璃，边缘弯折）、无白色实心填充、无薄纱（frost 趋零）。
2. 运动液滴流动完全保持（press=1 全动端参数零改动）。
3. 降级路径（无 WebGL2 / prefers-reduced-motion / GPU 丢失 / prefers-reduced-transparency）保留可用的静态选中指示，但不再是纯白乳白块。

**非目标**
- 不改 engine.ts（shader / 主循环 / 上游渲染语义零改动）。
- 不动底座、路由、DOM 结构与可访问性语义。

## 方案

全部改动集中在 `web/src/components/liquid-glass/glass-lens.tsx` 与 `web/src/styles/globals.css`：

### 1. 透镜静止常驻（glass-lens.tsx）

- `stop()`（到位即退场）拆为两语义：
  - 移除原「到位 stop 退场」：`step` 中 `if (!moving && !pressed)` 分支不再退场，运动自然 settle，透镜常驻。
  - 新增 `detach()`：真退场（`active=false` + 清 `data-glass-moving/traveling`），仅用于 reduced-motion（`step` 的 still 分支）、GPU `lost()`、`measure()` 失败（无 highlight）三种情形。
- `sync` 非动画分支（初始挂载 / resize / reduced-motion 跳位）：`active=true; place(next); view.dirty=true; engine.wake()`——透镜无动画 snap 到位。
- `measure()` 中 `selectedColor` 改为无条件重读（透镜常驻后 `active` 恒真，原 `if (!active)` 会冻结颜色；front 层只在 frost 高时可见，动画路径已有 `keepColor` 保护）。
- 文件头标注 Otter Buddy fork：静止常驻清玻璃，偏离上游「settles into the flat highlight」。

### 2. 静止端参数集（lens()，核心视觉）

`pc = clamp(press.x)` 的静止端点（pc=0）重定义，全动端（pc=1）不动：

| 参数 | 原静止端 | 新静止端 | 全动端（不变） |
|---|---|---|---|
| frost | 1（实心染 uColor） | 0.03 | 0 |
| strength | 0（无光效） | 0.5 | 1 |
| refract | ≈0.26（不可见） | 20×OPTICS | 37×OPTICS |
| magnify | 0 | 0.05 | 0.12 |
| dispersion | 0 | 0.05 | 0.12 |
| shadow | 0.066 | 0.09 | 0.12 |

blurCenter/blurEdge 公式不变（由 frost 驱动，frost≈0.03 时近清晰）；bevel/band/radius 形状参数不动。

### 3. 首绘与生命周期闭环（首轮实现 + 检视补漏，共五处）

- **IO 后无 wake**：`view.visible` 初始 false，engine 主循环 `if (!v.visible) continue` 会跳过首帧；原版不画首帧（静止=DOM），常驻后必须画。IntersectionObserver 回调中 `!was && visible` 时补 `engine.wake()`。
- **静止帧无 dirty**：engine 画帧条件 `moving || dirty || repaint || relight`——非动画 snap 后全部为 false，`engine.add()` 内置的 wake 也画不出来。sync 非动画分支补 `view.dirty = true`（place 到新几何本就是 refresh 语义）。
- **无选中退场不调度帧（检视 #4）**：`value=null` 时 detach 只标 dirty，引擎静止无循环，旧玻璃残留到无关事件唤醒。`detach()` 内补 `engine.wake()`。
- **动态 reduced-motion 不生效（检视 #5）**：引擎静止无帧时 `step` 的 still 分支永远不走，运行中开启 reduced-motion 透镜不退场。组件显式监听 `prefers-reduced-motion` change：开启即 detach、关闭即 sync(false) 恢复常驻；unmount 时移除监听。
- **几何变化不同步（检视 #6）**：原 ResizeObserver 守卫 `if (!active) sync(false)` 在常驻后永不触发，选中项/容器尺寸变化后透镜停在旧位置。改为按弹簧速度分派：飞行中 `sync(true)` 改目标（动画不中断），静止时 `sync(false)` 重新 snap；按压中忽略。

### 4. DOM 高亮块降级 token 化（globals.css）

- `.glass-nav-highlight` `background: #ffffff` → `var(--nav-active-bg)`（跟随主题选中色）；该块现在仅在降级路径可见（reduced-motion / 无 WebGL2 / GPU 丢失）。
- `prefers-reduced-transparency` 分支中与之重复的 background 覆盖行移除（同值冗余），保留阴影微调。

## 取舍

- **reduced-motion 不常驻透镜**：减少动效用户维持现状（DOM 块、零动画）。静态清玻璃透镜理论上也可接受，但保守路径改动面小、行为可预期。
- **DOM 兜底块半透明而非不透明**：`--nav-active-bg` 亮色主题为 55%×glass-t 白。极端可读性场景由 `prefers-reduced-transparency`（glass-t 提高 + 专用覆盖）承接，与既有材质体系一致。
- **未微调静止 strength/投影数值**：0.5/0.09 为首轮自验合格值，审美微调待搭档实看反馈再迭代，避免无反馈空调。

## 影响范围

- 仅桌面顶栏主导航（`data-glass-host`）；engine.ts 零改动，glass-layer / 材质 v3 体系不受影响。
- 透镜常驻的额外开销：engine 无帧时不开循环——静止且无指针移动/尺寸变化时不调度任何帧；`REPAINT_EVERY=120ms` 只是在已有绘制帧上决定背景纹理是否重读的上限，不构成静止时的周期任务。静止开销 = 仅指针移动（光效 relight）或 dirty 时才有帧，帧内可能重读 back 层。

## 验证

- 单测：web 894/894 通过（新增 `glass-lens.test.tsx` 7 条行为测试：mock engine 驱动真实生命周期——初始常驻、value=null 退场、动态 reduced-motion 退场、RO 几何重对位、reduce 开→关往返恢复、按压释放重对位、离屏清空 value 后回视口清帧；`material-v3.test.ts` 契约用例更新：锁 `frost=lerp(0.03,0,pc)`、`strength=lerp(0.5,1,pc)` 静止端点 + 兜底块禁纯白十六进制色回归）。
- 类型：`tsc --noEmit` 干净。
- 截图自验（alpha 隔离实例 3162，2× Playwright，真实 WebGL2）：
  - 静止默认态/切项后：清玻璃胶囊（阴影+边缘光），无白色实心；`data-glass-moving` 在位、DOM 高亮 opacity=0、canvas 尺寸由 engine 接管（1272×192）。
  - 运动中途帧（180ms）：液滴肿胀形态路过中间项，文字穿过玻璃折射弯折——液滴流动保持。
  - 快速连点三项后静止态正常落位，无残影错位。
  - `data-custom-bg` 标记下样式分支正常（真实壁纸场景待搭档实看）。

## 残余风险

- 暗色主题下静止清玻璃的观感未截图验证（当前主用浅色）；`--nav-active-bg` 暗色值 #FFFDF9 仅影响降级路径。
- 若未来顶栏覆盖滚动/流式内容，指针移动触发的重读频率可能需要重估（与 F20261124tbnav 的合入边界同款约束）。
- 选中项自身几何变化若不触发容器尺寸变化（root RO 不响），透镜不会重对位；顶栏为编译期固定七项文案，该场景现实中不存在（检视发现的 IO/RO/dirty 修复已覆盖容器级与选中项尺寸变化经容器传导的场景）。
