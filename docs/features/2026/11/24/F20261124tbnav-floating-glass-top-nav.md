---
id: F20261124tbnav
title: "顶栏收敛为系统图标与名称及居中悬浮玻璃一级菜单"
summary: "顶栏保留系统图标、Otter Buddy 系统名称和七个一级路由，中央菜单采用 frost-only 宽底座与单个开源 Liquid Glass 选中透镜；静止和运动均折射清晰静止画布，使用位置信号与速度 wobble 驱动弹性切换，无双端蓝黑细线。执行机系统级 badge/请求移除，对话级能力不变。"
change_type: feature
capability_test: "n/a: Web UI 与材质变更，以 TopBar 行为测试、material-v3 CSS 契约、生产构建及 3184 Chromium/WebKit 真实静止/运动验收为载体"
intent:
  problem: "旧 TopBar 通长玻璃底板混淆品牌、导航和系统级执行机；后续手写灰块与 turbulence 方案只像薄纱，静止没有真实折射，逐项玻璃和连接起终点的长药丸也不符合钉钉录屏。"
  solution: "透明 header 保留左侧系统图标、Otter Buddy 系统名称与居中一级菜单；宽底座只画透明 veil，唯一选中透镜使用 @samasante/liquid-glass 的 SDF displacement、motion values 和 useLensWobble，折射同一静止画布副本。静止保留折射，运动时灰色 tint 退出并由实时速度驱动 squash/stretch。"
  expected_effect: "清晰背景下静止与运动都能看到小透镜折射和连续轮廓，无蓝绿点线或黑色断线；未选中项无胶囊，底座不变形，快速连点可中断，Chrome 与 WebKit 一致。"
  verify_by:
    type: behavior_check
    assertions:
      - "TopBar.test.tsx 10/10：开源单透镜、静止光学参数、位置/尺寸/tint 独立信号、快速连点停止旧动画、详情/无激活路由、resize、减少动态效果与减少透明度"
      - "material-v3.test.ts 12/12：宽底座无 backdrop-filter、折射仅复制静止画布、真实内容层独立、减少透明度实色降级"
      - "3184 Chromium/WebKit：默认与自定义清晰画布、静止/展开/移动/收缩、正反向、连续改目标、1024px resize 和 reduced-motion；底座约 603×40、居中偏差 0、无溢出或 pageerror"
      - "双端 2× 清晰背景静止及运动截图：折射可见，轮廓无蓝绿点线或黑色断线；最终由搭档确认‘有点意思，按照这个来’"
created_in_conversation: 3995c48d-499a-4c2d-b04f-e3581a3d3e28
tags: [web, ui, topbar, glass, navigation, responsive]
modules:
  - web
causal_links:
  - {type: "extends", id: "F20260724glas", note: "沿用静止画布与材质无障碍边界；小面积导航是唯一常驻折射例外"}
  - {type: "references", id: "F20261113uaccs", note: "仅移除 TopBar 系统级执行机展示，保留投影端点和对话级消费方"}
---

# 顶栏收敛为系统图标与名称及居中悬浮玻璃一级菜单

## 最终目标

以搭档提供的钉钉录屏为权威视觉参照，同时保留 Otter Buddy 的桌面信息架构：左侧系统图标与 Otter Buddy 系统名称、中央横向七个一级路由、透明 header。中央菜单是清晰背景上的悬浮玻璃，不是通长顶栏，也不是逐项玻璃胶囊。

最终视觉契约：

- 宽底座静止，仅透明 veil、细边和轻投影，不让整条宽条承担 displacement。
- 只有一枚内容大小的选中透镜；静止也有真实背景折射，不能在停下后退回灰色薄纱。
- 切换沿用搭档认可的 B 版运动：原位展开、移动液滴、目标收缩；位置与速度形变分离，不连接起终点形成长药丸。
- 文字和图标始终在独立清晰层；背景本身不做 blur，只有小透镜内的静止背景副本发生光学弯折。`Glass` 不再接收第二份清晰 children 背景，避免折射源之外再绘制一层矩形画布。
- 轮廓不得出现蓝绿色散点线、黑色断线或上下短截采样缝。
- 快速连点继承当前运动信号；无激活路由卸载透镜，对话详情保持“对话”激活，resize 重新贴合，减少动态效果直接到位。

## 最终实现

### 开源光学与运动

引入 `@samasante/liquid-glass@0.1.1`（MIT，React peer，零运行时依赖）。选择它的原因是小透镜 SDF displacement、`refract` 静止副本路径、WebKit 专门处理及 `useLensWobble` 速度形变。`rdev/liquid-glass-react` 在 Safari/Firefox 缺少折射，Vaso 的持续 DOM 克隆对常驻顶栏过重，均未采用。

`<Glass>` 的关键配置：

- `refract` 与真实底座共用 `.glass-nav-copy` 静止画布结构；不采样滚动或流式 DOM。
- `mapSize=512`、`pixelUnits`、静止 `edgeBias=0.5`，避免宽副本上小透镜的采样缝。
- `dispersion=0`，消除 RGB 色散点线；折射由凸面、深度和边缘 bend 提供，不靠彩色描边冒充玻璃。
- `frost=0`、`brightness=0`、`behind=transparent`，底座 veil 为 0.18；静止 tint 为 0.28，运动时退出。
- opticScale 静止约 0.409、运动约 0.42，depth=0.72、curvature=0.62、bend=0.42；停下后不降低为平面材质。
- 默认柔和画布上增强定向高光与静止态内外阴影：顶部高光、宽幅浅内阴影和柔和外投影共同读出体积，不用深色细描边冒充玻璃。

位置由 `animateGlassValue` 驱动，`useLensWobble` 读取位置信号速度并派生 squash/stretch；尺寸、tint、shadow 分别使用独立信号。单次切换为 420ms 位置动画、120ms 展开和 240ms 后的 160ms 收缩；运动态保留 8% 轻微 tint 与高光/柔影，确保默认柔和画布上也能读出流动轨迹。减少动态效果直接写目标值。

### 布局与路由边界

`Glass` 内联 `position:absolute`，避免库默认 `position:relative` 将透镜计入布局并撑宽导航。resize/preference effect 只挂载一次，防止路由 cleanup 清掉 collapse 定时器。导航内容层为 `z-index:10`，真实链接不参与折射。

执行机 badge、TopBar DTO 和 `/api/execution-machines` 请求均移除；后端投影端点和对话页执行机列表/切换保持不变。路由清单和激活规则不变。

### 材质与无障碍边界

材质 v3 的常驻大面 R=0 原则不变。`.glass-nav` 是约 603×40px 的明确例外，且只在 header 背后为静止画布时成立；若未来覆盖滚动、流式或动画内容，必须撤掉复制画布和折射，退回实色半透材质。

`prefers-reduced-transparency` 下不渲染开源折射库，只显示 `var(--nav-active-bg)` 实色目标块。自定义深色壁纸使用浅色导航文字，默认画布保留深色文字。

## 关键迭代与最终纠偏

首版通长顶栏、后续逐项玻璃、420ms 长药丸和手写 turbulence 均被真实观感否决。开源调研后先在 3190 隔离原型验证 B 版，再移植 3184。集成中实际修复了文字被 tint 遮挡、负 margin 几何偏移、路由 cleanup 清定时器、库内联定位撑宽底座、深色壁纸文字对比和滤镜采样缝。

最终不再要求生产参数机械等于原型，而是同时满足“静止真实折射 + B 版运动 + 无蓝黑细线”。最终配置经清晰背景双端放大截图检查，搭档于 2026-11-23 20:54 明确回复“有点意思，按照这个来”。

2026-11-24 搭档补充左侧系统图标与 Otter Buddy 名称，并指出默认画布又缺少水玻璃质感。对比确认此前认可的是清晰纹理背景，默认柔和渐变下原参数体积感不足；单纯放大 displacement 1.5～3 倍无明显改善。最终保持 dispersion=0 与 B 版运动不变，增强凸面深度、边缘弯折和定向高光，并用宽幅浅内阴影替代深色下描边。默认画布与清晰纹理都纳入验收，避免不同背景下反复退回平面胶囊。

随后搭档按截图箭头指出按钮、菜单栏之外还有一层方形背景。DOM 分层复现确认：`refract` 已有折射源，但 `Glass` 的清晰 children 又渲染了一份完整 `.glass-nav-copy`，形成矩形底。删除这份重复 children 后方形层消失；折射源仅一份，真实链接仍是唯一内容清晰层。组件测试同时钉住折射源存在且清晰 children 不含 `.glass-nav-copy`。

## 验证证据

- 组件 10/10、材质契约 12/12，共 22/22；全量 Web 89 文件、881/881 测试通过；TypeScript 与 Vite 生产构建通过。jsdom 通过 `src/test/setup.ts` 提供标准 ResizeObserver 接口，AppLayout 真实挂载 TopBar 的回归测试同步通过。
- 工作区报告：`production-glass-verification.md`；脚本：`verify-production-glass.cjs`。
- 双端真实点击视频：`production-glass-{chromium,webkit}-clicks.webm`。
- 静止与运动帧：`production-glass-{chromium,webkit}-{rest,expand,moving,arrive,settle}.png`。
- 最终清晰背景放大图：`final-clear-{chromium,webkit}-2x.png`；静止折射可见，无蓝绿点线或黑色断线。
- 双端 1024px 内容无溢出，底座保持约 603×40；默认画布菜单中心偏差为 0。

## Rollback

`git revert <merge-commit>` 恢复旧顶栏；同时移除 `@samasante/liquid-glass` 依赖。无 schema、配置或数据迁移。
