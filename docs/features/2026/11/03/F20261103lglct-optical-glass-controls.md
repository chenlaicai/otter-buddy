---
id: F20261103lglct
title: 光学玻璃小控件——薄纱底座上的局部 Liquid Glass 原型
summary: 在材质 v3.0 薄纱底座上，将发送按钮、浮动獭和左侧栏每个对话条目升级为静态画布折射、色散边缘和高光的真玻璃；不使用实时 DOM 采样。
change_type: feature
capability_test: "n/a: 纯确定性 Web 组件与 CSS，不涉及 LLM 行为"
created_in_conversation: 9ae84389-031a-4da1-be13-0238bcdf6a29
created_at: 2026-11-03T19:00:00+08:00
doc_type: feature
causal_links:
  - F20261102glmtr
  - R20261102glass
tags: [web, glass, material, liquid-glass]
modules: [web]
intent:
  problem: "薄纱解决了闪动但缺少苹果 Liquid Glass 的折射和透镜边缘；通用库的 DOM 复制兜底又不适合运行中界面"
  expected_effect: "发送按钮、浮动獭和对话条目有可辨识的静态画布折射和边缘高光，消息流 DOM 不被复制、观察或逐帧重采样，其他面板保持薄纱"
  verify_by:
    type: behavior_check
---

# 光学玻璃小控件

## 目标

落实搭档确认的「薄纱 + 部分按钮是玻璃」，并按后续意见把左栏每个对话条目作为独立玻璃块；不是全仓铺材质。

## 非目标

- 不将中栏、侧栏、输入框、卡片、弹窗恢复为实时玻璃。
- 不引入 Vaso 等 DOM 克隆 / 逐帧对齐运行时，不宣称与 Apple 原生材质逐像素一致。
- 不改变发送语义、浮动獭拖动、未读气泡或动画。

## 方案与设计面

- 新增 `OpticalGlassButton`，组合原生 `button`、静态纹理折射层、镜面高光层、独立内容层。
- 折射纹理由 `feImage + feDisplacementMap` 生成，输入是按钮自身的 CSS 静态画布；消息流 DOM 不进入滤镜。
- 按钮画布沿用 `--custom-bg-image`、主色 `--canvas-tint-rgb` 和极光 token；自定义背景保持与视口对齐。
- 两个形状使用固定 PNG 位移图；无需 canvas、MutationObserver、ResizeObserver、requestAnimationFrame 或第三方运行库。
- 文字与图标在独立内容层；禁用、键盘焦点、reduced-motion / reduced-transparency 保留。玻璃滑杆本轮不接管小控件，避免引入额外的光学语义。
- 主发送按钮、浮动獭、每个对话条目采用玻璃；排队按钮与输入框不跟随。侧栏底板仍是薄纱。
- 长条对话块降低折射与阴影强度，文字独立；ResizeObserver 只测条目尺寸，不监听消息内容。

## 取舍与风险

- **静态画布 ≠ 活内容透镜**：背后的消息文字不会经按钮折射。这是换取不闪与稳定性能的明确取舍。
- **轻量原生实现 ≠ 苹果原生引擎**：用 Web 标准表达折射/色散边缘/高光，不宣称系统级材质等价。
- 固定纹理只在本原型小按钮与对话条目尺寸使用；后续扩尺寸须重新检查折射尺度和视觉性能。
- 折射层恒挂 `translateZ(0)`，避免外层动画/拖动使 fixed 背景锚定跳变；不得用 JS 实时采样替代。
- 机制检查：复用既有组件和 CSS 渲染，不新增决策机制 / 守卫 / 流程；无决策者变化。机器契约测试锁静态源边界，视觉判断由浏览器证据和搭档验收。

## 验收标准

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 对话列表 | 点击条目、新建、置顶、右键、搜索 | 每个条目独立玻璃，原交互与状态不变 |
| 主发送 | 输入文字、点击主发送按钮 | 发送行为与 disabled 语义不变，按钮呈折射玻璃 |
| 浮动獭 | 点击、拖动、触发现有动画 | 开关面板、拖动、未读显示不变，玻璃不遮挡头像 |
| 运行中界面 | 流式消息更新 | 无 DOM 克隆 / MutationObserver / rAF；不发生旧式色块闪动 |
| 背景偏好 | 默认画布、自定义背景、reduced transparency | 玻璃与画布对齐；减少透明度时折射和高光退化实色 |
| 跨浏览器 | Chromium / WebKit 真浏览器 | 均有静态源折射；文字与图标保持清晰 |

## 验证

- `web/src/components/OpticalGlassButton.test.tsx`：原生交互与内容隔离。
- `web/src/styles/material-v3.test.ts`：浮动獭离开 backdrop-blur 白名单，面板豁免不扩散。
- 浏览器：Chromium 与 WebKit，默认画布与自定义条纹背景；发送/悬浮助手局部截图与整页截图、真实点击/开关面板。脚本位于对话工作区 `visual-check.cjs` / `send-check.cjs` / `background-check.cjs`，提交后留存 `/tmp/otter-evidence-F20261103lglct`。
- 实测修正：多层背景变量组合与相对 rgb 语法曾导致纹理 `none`，改为与画布一致的 rgba 语法。独立检视发现 Playwright 的 reduced-transparency 模拟不透传；以 CDP 实测并补齐高光层实色退化。
- 左栏玻璃块截图：`/tmp/otter-evidence-F20261103lglct/chromium-sidebar-glass.png`、`webkit-sidebar-glass.png`。
- 浏览器环境用隔离 alpha：3154；仅提交测试 HTML/CSS/代码，不把测试对话与条纹背景带入主环境。
- 最简实现检查：一个组件、一个局部 CSS、两个静态纹理，不引入通用 glass 框架；无新依赖。

## 负向契约检查

不恢复常驻面 `backdrop-filter`，不观察/复制消息流，不修改历史材质文档，不删除既有 reduced-transparency 降级，也不通过扩大白名单掩盖实时采样。
