---
id: F20261119tbnav
title: "顶栏收敛为独立系统图标与居中悬浮玻璃一级菜单"
summary: "移除整条顶栏的玻璃底板、文字品牌和系统级执行机 badge；左侧仅保留系统图标，中央一级菜单使用独立小面积真玻璃容器。执行机 API 与对话级列表/切换能力不变。组件、材质契约、Web 构建与两种视口真浏览器截图均验证通过。"
change_type: feature
capability_test: "n/a: Web 布局与材质变更，以 TopBar 组件测试、material-v3 CSS 契约测试、Web 构建及 Playwright 真浏览器布局/截图为验证载体"
intent:
  problem: "原 TopBar 用一条贯穿屏幕的玻璃底板同时承载品牌、导航和执行机状态，视觉跨度过长；执行机被错误呈现为系统一级属性，不符合其实际的列表与对话级切换语义。"
  solution: "TopBar 改为透明布局容器：系统图标绝对定位于左侧，一级导航作为独立胶囊精确居中；.glass-nav 以独立采样层接入 SVG displacement 真实折射，并保留高光、着色与降级；移除 TopBar 执行机状态、DTO 与请求。"
  expected_effect: "桌面与 1024px 最小宽度下，左侧只显示系统图标，中央菜单玻璃质感可辨且精确居中、七个入口完整无溢出，右侧无执行机标志；TopBar 不再请求执行机投影。"
  verify_by:
    type: behavior_check
    assertions:
      - "TopBar.test.tsx 3/3：独立玻璃导航、仅图标、无执行机 badge/请求、激活态与七个路由入口保持"
      - "material-v3.test.ts 12/12：玻璃只加在小面积 .glass-nav，prefers-reduced-transparency 下关闭采样并复用实色 token"
      - "Playwright 1440×900 与 1024×768：菜单中心偏差均为 0px，无页面错误、无导航溢出；支持 SVG 背景滤镜时 backdrop-filter 直接包含 url(#nav-liquid-glass) 与 blur(3px) saturate(1.4) brightness(1.25)，feDisplacementMap scale=80"
created_in_conversation: 3995c48d-499a-4c2d-b04f-e3581a3d3e28
tags: [web, ui, topbar, glass, navigation, responsive]
modules:
  - web
causal_links:
  - {type: "extends", id: "F20260724glas", note: "沿用既有玻璃 token 与激活药丸，不另建色彩体系"}
  - {type: "references", id: "F20261113uaccs", note: "仅移除执行机在 TopBar 的系统级展示，保留投影端点和对话级消费方"}
---

# 顶栏收敛为独立系统图标与居中悬浮玻璃一级菜单

## 背景与目标

原顶栏是一条 `glass-strong` 长底板：左侧图标与 “Otter Buddy” 文字、中间导航、右侧当前执行机。搭档明确的新结构是：左侧只放系统图标；顶栏缩成中间一段一级菜单并做悬浮玻璃；移除系统级执行机标志。

本次属于既有 TopBar 的 `redesign`：信息架构保持七个一级路由不变，视觉骨架从“通长三栏玻璃条”改为“透明布局层 + 左图标 + 中央菜单胶囊”。

## 方案与关键决策

- **透明 header，不再通长铺材质**：`header` 只负责 48px 高的布局与层级，无背景、边框或阴影。
- **左侧只留图标**：移除文字品牌，保留 `alt="Otter Buddy"`；图标绝对定位，避免其宽度影响菜单的真实视口居中。
- **中央菜单 Liquid Glass**：`.glass-nav-effect` 独立背景采样层使用 `blur(3px) + saturate(140%) + brightness(125%)`，并由 `feTurbulence → feGaussianBlur → feDisplacementMap(scale=80)` 产生真实位移。位移滤镜必须放进 `backdrop-filter`，直接处理背景采样；普通 `filter` 在 Chromium 只处理透明元素自身，不会产生背景折射。`.glass-nav-tint` 负责低白纱着色，高光与渐变折射边保留，文字/图标位于不参与位移的内容层。复用全局 `--glass-t`，不引入新依赖。选中项继续使用 `.nav-pill-active`。
- **小面积常驻例外**：材质 v3 的“常驻大面零采样”原则不变；本次只给约 604×40px 的一级菜单开放真玻璃，是搭档指定的明确例外。`prefers-reduced-transparency` 下关闭 blur，并随 `--chrome-bg` 一起退化实色。
- **执行机退出系统顶栏**：删除 TopBar 的 badge、状态、DTO 和 `/api/execution-machines` 请求。后端投影端点及对话页 `ExecutionMachineModal` 的列表/切换能力完全保留。
- **窄宽度兜底**：菜单设置视口最大宽度与横向滚动，隐藏滚动条；在本应用声明的 1024px 最小宽度下七项完整展示，无溢出。

## 设计取舍

机制识别检查点：未新增运行时状态、数据通道、协调协议或架构抽象；仅调整现有组件结构与 CSS，并删除 TopBar 的执行机展示，不涉净新增机制。修改类别为 `narrow-fix`。

候选“保留通长顶栏、只加强玻璃”被否决：它没有解决跨度过长与信息层级混杂的核心问题。候选“删除执行机 API”也被否决：对话级执行机列表仍需要它，本次只移除错误的系统级呈现。

代价：小面积常驻菜单现在会实时采样背景，保留极低面积的重采样成本；其收益是用户指定的一级菜单材质层级，且减少透明度偏好可完整降级。

**不闪前提与失效条件**：当前 `AppLayout` 中 header 与内容滚动区是上下排列的兄弟节点，菜单背后只有静止画布，没有滚动或流式内容，因此常驻采样不会遇到 v3 已根治的“运行中像素重采样”场景。若未来把菜单改成覆盖在滚动/流式内容之上，或在菜单背后加入动画，此前提即失效；届时必须撤掉 `.glass-nav` 的 blur、退回 R=0 实色半透材质，而不能依赖“小面积”继续豁免。

## 负面向验收

本次明确移除两项旧契约：TopBar 不再展示当前执行机，也不再显示文字品牌；二者均有反向测试。没有删除执行机投影端点、没有改对话级执行机选择、没有改路由清单或导航激活规则，也没有绕过玻璃减少透明度保护。

## 验收标准

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 组件结构 | `cd web && npx vitest run src/components/TopBar.test.tsx` | 3/3；仅系统图标、中央 `.glass-nav`、七入口与激活态保留，执行机 badge/请求为零 |
| 材质与无障碍 | `cd web && npx vitest run src/styles/material-v3.test.ts` | 12/12；小面积菜单 blur 例外在位，减少透明度时关闭采样 |
| 构建 | `cd web && npm run build` | TypeScript 与 Vite 构建通过 |
| 桌面视觉 | Playwright 1440×900 打开 `/conversation` | 菜单中心偏差 0px；header 透明；菜单 604.25×40px；无页面错误 |
| 最小宽度 | Playwright 1024×768 打开 `/conversation` | 菜单中心偏差 0px；`scrollWidth == clientWidth == 602`；七项完整展示 |
| 执行机功能边界 | 检索 `ExecutionMachineModal` 与 API | 对话级列表/切换文件未改，TopBar 无执行机请求 |

## 真实实例反馈后的材质修正

首版使用 `--chrome-bg` + `blur(40px)`，搭档在真实实例中指出「这明显不是玻璃啊，只是薄纱而已」。问题成立：高白纱覆盖与过度模糊抹掉背景色相，只有透明度、缺少玻璃厚度。

第二版把主体白纱覆盖降低、blur 降至 14px，并用 `::before` 增加斜向镜面高光、`::after` 增加亮边/暖色接触边交替的渐变折射边。玻璃感来自“背景透出 + 表面反射 + 边缘厚度”三者共同存在，而非继续加白。减少透明度时专用背景变量退化实色、blur 与两个装饰伪元素全部关闭。

随后按搭档要求改用 macOS 图片壁纸验证，先修正了深色纹理下的文字对比。搭档进一步明确目标是 **Liquid Glass 而非普通玻璃拟态**，因此加入 SVG displacement 折射层：背景纹理经过菜单时发生几何位移，文字与图标保持清晰不参与变形。

搭档随后实测 Safari 略有折射、Chrome 仍只是薄纱，推翻了实现者此前的浏览器判断。最小复现确认根因是滤镜挂点：普通 `filter: url(#…)` 没有折射 Chromium 的背景采样；改成 `backdrop-filter: url(#…) blur(3px) …` 后，同一图片的背景线条在 Chrome 中真实弯曲。支持 SVG 背景滤镜的浏览器走直接背景位移，其他浏览器保留原采样、透色与高光降级；减少透明度偏好下折射层和装饰层全部关闭。

图片只写入 alpha 隔离实例用于验收，不改默认画布、不向仓库添加壁纸资产。Chrome 最小复现及 1440/1024 两视口截图均已复验；Safari 仍以搭档实机目检为准，不用 Chromium 结果冒充。

## 验证证据

- 组件与材质测试：2 文件、15 用例全部通过。
- Web 构建通过；仅有既存 chunk 大小与动态/静态导入提示。
- 全量 Web 测试在本分支两次为 872/873，通过项包含本次全部用例；同一 `index.spa-nav.test.tsx` fake-timer 用例在全量并行运行时出现额外调用。该文件在分支和未改基线单跑均 11/11，基线全量两次 871/871；不归因、不隐瞒，已登记 #1969 跟踪。
- 真浏览器脚本：`data/workspaces/3995c48d-499a-4c2d-b04f-e3581a3d3e28/verify-topbar.cjs`（验证时用 Vite + API mock，页面错误为零，验证服务已停止）。
- 截图：`topbar-desktop.png`、`topbar-min-width.png`（同目录）。实现者已亲自查看，玻璃只落在菜单胶囊，左侧图标与右侧留白平衡。
- 已过最简实现检查：复用既有路由、玻璃 token、激活样式与图标，无新依赖、无新运行时机制；改动集中在 TopBar、一个 CSS 类及对应测试。

## 视觉质检门

结构选择“中心辐射”：中央一级导航是唯一主操作面，系统图标为次级品牌锚点，不保留无内容的右侧伪功能区。玻璃拟态贯彻到背景采样、半透明渐变、高光、接触线与投影，而非只加透明度。

反模式扫描：无三卡片、紫色 hero、假数据、悬浮动画或色彩超载；图标均对应导航功能，不属堆砌。自我批评发现“绝对居中可能在极窄视口与图标相撞”，已通过应用 1024px 最小宽度验证与菜单最大宽度/滚动兜底处置。无致命项，观察项均已处理。

## Rollback

`git revert <merge-commit>` 即可恢复通长顶栏；无 schema、配置或数据迁移。
