---
id: F20261124tbnav
title: "顶栏收敛为系统图标与名称及居中悬浮玻璃一级菜单"
summary: "顶栏保留系统图标、Otter Buddy 系统名称和七个一级路由；中央静止底座承载 bilalgursen/liquid-glass 的开源 GlassLens，静止为乳白凸起选中块，切换为单枚折射液滴流动并回落，双端无重复画布和色散断线。执行机系统级 badge/请求移除，对话级能力不变。"
change_type: feature
capability_test: "n/a: Web UI 与材质变更，以 TopBar 行为测试、material-v3 CSS 契约、生产构建及 3132 Chromium/WebKit 真实静止/运动验收和独立多模态评审为载体"
intent:
  problem: "旧 TopBar 通长玻璃底板混淆品牌、导航和系统级执行机；后续手写灰块、turbulence 与 @samasante 原型虽保留技术折射，却在第二项静止时退成薄纱，并出现 WebKit 色边、运动中文字变淡和重复矩形画布。连续参数补偿没有稳定达到钉钉录屏的乳白静止气泡与单液滴运动。"
  solution: "透明 header 保留系统图标、Otter Buddy 名称与居中一级菜单；采用业界开源 bilalgursen/liquid-glass 的 GlassLens、WebGL2 引擎和 DOM 采样层，静止使用不透明白色选中块，运动由开源弹簧驱动一枚清晰透镜，到位恢复乳白块。真实路由链接保持原生语义，不再自写光学或位置动画。"
  expected_effect: "默认与清晰背景下第二项均有明确乳白凸起静止态；点击时原位展开、单枚液滴连续移动、目标收缩；文字无透明动画，底座不动，无长药丸、逐项胶囊、重复矩形、蓝绿点线或黑色断线。"
  verify_by:
    type: behavior_check
    assertions:
      - "TopBar.test.tsx 8/8：开源 GlassLens、真实链接语义、最新目标唯一高亮、快速连点、详情/无激活路由与减少透明度"
      - "material-v3.test.ts 12/12：GlassLens/WebGL2/ResizeObserver/reduced-motion 接入、乳白静止块、清晰内容层与实色降级"
      - "3132 Chromium/WebKit：默认与清晰背景的第二项静止、正反向长距离、快速连点、1024px resize、reduced-motion；errors=[]、highlights=1、copies=0、svgFilters=0"
      - "独立多模态验收者读取真实静止图、20fps 正反向逐帧与交互截图后 verdict=ACCEPT；最终视觉仍由搭档确认，不以机器验收代替搭档裁决"
created_in_conversation: 3995c48d-499a-4c2d-b04f-e3581a3d3e28
tags: [web, ui, topbar, glass, navigation, responsive, webgl]
modules:
  - web
causal_links:
  - {type: "extends", id: "F20260724glas", note: "沿用常驻材质不持续重采样的边界；小面积导航仅在交互时运行开源 WebGL 透镜，静止后停止 rAF"}
  - {type: "references", id: "F20261113uaccs", note: "仅移除 TopBar 系统级执行机展示，保留投影端点和对话级消费方"}
---

# 顶栏收敛为系统图标与名称及居中悬浮玻璃一级菜单

## 最终目标

以搭档提供的钉钉录屏为权威视觉参照，同时保留 Otter Buddy 的桌面信息架构：左侧系统图标与 Otter Buddy 系统名称、中央横向七个一级路由、透明 header。中央菜单是清晰背景上的悬浮玻璃，不是通长顶栏，也不是逐项玻璃胶囊。

最终视觉契约：

- 宽底座静止，有最低对比的半透明底色、细边和轻投影；不让整条宽条承担位移或拉伸。
- 静止选中项是**不透明乳白凸起块**与深色清晰文字，包括第二项「记忆召回」；不能在到位后退成灰色薄纱。
- 切换只有一枚内容附近的透明液态透镜：原位展开、连续移动、目标收缩；不连接起终点形成长药丸。
- 真实文字和图标保持独立 DOM；不做 opacity/filter 内容动画。透镜扫过文字的短暂折射属于开源模型和钉钉参照的同类行为。
- 无重复矩形画布、蓝绿色散点线、黑色断线或上下采样缝。
- 快速连点接续当前弹簧状态；无激活路由清空透镜，对话详情保持“对话”激活，resize 重新贴合，减少动态效果直接到位。

## 最终实现

### 采用业界开源 GlassLens，不再自研光学引擎

采用 [bilalgursen/liquid-glass](https://github.com/bilalgursen/liquid-glass)，固定上游 commit `c2a6aad`（MIT）。该项目原生提供 `GlassTabs/GlassLens`：静止乳白 pill → 透明透镜 travel → 静止乳白 pill，与本任务模型一致。先运行其官方 demo 并录制 Chromium/WebKit 正反向长距离切换，经独立多模态路线评审通过后才集成。

vendored 文件位于 `web/src/components/liquid-glass/`：

- `engine.ts`、`dom-snapshot.ts`、`glass-layer.tsx` 与上游逐字节一致；GLSL、弹簧和采样参数未改写。
- `glass-lens.tsx` 仅增加 `data-glass-option` 选择器接入，原有 radio/tab 支持保留，使 React Router 的真实 `<Link>` 不必伪装成 tab/radio；其余引擎和运动代码不变。
- 同目录保留上游 `LICENSE`（Copyright 2026 Bilal Abdullah Gürşen）。零新增运行时 npm 依赖，移除旧 `@samasante/liquid-glass`。

### 布局、材质与内容

`TopBar` 只负责路由激活态、`GlassLens value` 和减少透明度偏好，不再维护 motion values、collapse timer、SVG displacement 或折射副本。

- 当前项内部仅一枚 `data-glass-highlight.glass-nav-highlight`：`#fff` 乳白填充、接触阴影和顶部内高光；开源透镜开始运动时隐藏静态块，停止后恢复。
- 七个入口均为真实链接，以 `data-glass-option` 接入位置测量和按压/拖动；`aria-current` 与链接语义不变。
- 文字无透明度、模糊或缩放动画。清晰背景下未选项为浅色，当前项为深色；traveling 状态只切换颜色，不做渐隐。
- 宽底座使用静态半透明底色，不引入常驻 backdrop-filter 或持续 DOM 重采样。开源引擎在弹簧静止后停止 rAF。

### 无障碍与降级

`prefers-reduced-motion` 由上游 GlassLens 直接贴合目标，不运行移动弹簧。`prefers-reduced-transparency` 下 TopBar 禁用 WebGL 透镜，默认及自定义背景的整条导航底座都改用 `var(--nav-glass-bg)` 实色与标准 hairline，保留不透明静态选中块；材质契约同时钉住两条底座背景与 canvas 降级。

无 WebGL2 或 context 丢失时沿用上游 CSS 静态高亮。路由、对话详情激活、对话级执行机能力均不变。

## 关键迭代与最终纠偏

首版通长顶栏、逐项玻璃、长药丸、手写 turbulence 和后续 `@samasante` 单透镜均经真实画面否决。旧开源原型的问题不是“没有滤镜”，而是静止恢复 28% 灰色 tint，第二项和柔和背景上主要呈现薄纱；继续加强 depth、高光、阴影和动画时长仍未解决结构问题。

2026-11-24 搭档明确不再承担反复目检，要求独立多模态验收并优先借鉴业界开源。重新扫描后排除需要实验性 WebGPU/HTML-in-Canvas 的 `liquid-dom`、仅脚本演示的 `shuding/liquid-glass`、重 DOM 镜像路线，以及不含导航运动模型的通用玻璃库；选择原生具有 GlassTabs travel 语义的 `bilalgursen/liquid-glass`。

独立验收先打回旧版：静止第二项薄纱、WebKit 黄绿色边、浅背景底座对比不足、运动中文字变淡和证据缺口。新路线官方 demo 通过路线评审后，才接入真实七项中文导航。集成后同一验收者对默认/清晰背景、第二项静止、双端正反向逐帧、快速连点、resize 和 reduced-motion 复审，结论为 **ACCEPT**。此结论不等同搭档最终认可，当前仍未推送新 PR head。

## 验证证据

工作区：`/Users/orca/ai/otter-buddy/data/workspaces/3995c48d-499a-4c2d-b04f-e3581a3d3e28`。

- 开源候选实拍：`oss-glasstabs-{chromium,webkit}-rest.png`、`oss-glasstabs-long-{chromium,webkit}-sheet.png`。
- 集成脚本：`verify-bilal-glass-3132.cjs`、`record-bilal-clean-3132.cjs`。
- 第二项静止：`bilal-{chromium,webkit}-{clear,default}-memory-rest.png`。
- 正反向逐帧：`bilal-clean-{chromium,webkit}-{clear,default}-{forward,reverse}-sheet.png`。
- 完整录像：`bilal-clean-{chromium,webkit}.webm`；交互录像：`bilal-{chromium,webkit}-all.webm`。
- 快速连点/reduced-motion/resize：`bilal-{chromium,webkit}-clear-{interrupted,reduced}.png`、`bilal-{chromium,webkit}-clear-resized.png`。
- 机器结果：`bilal-{chromium,webkit}-result.json`，双端 `errors=[]`、`highlights=1`、`copies=0`、`svgFilters=0`。
- 定向组件/材质测试 20/20、TypeScript 与 Vite 生产构建通过。rebase 最新 `origin/main` 后全量 Web **90 文件、887/887** 通过；视觉相关文件与 rebase 前逐 blob 一致。

## Rollback

`git revert <merge-commit>` 恢复旧顶栏并删除 vendored `web/src/components/liquid-glass/`；无新增运行时依赖、schema、配置或数据迁移。
