---
id: F20260903tgif
title: Touch Bar 六态演示 GIF：渲染器离屏渲染 + README 物料
summary: 给 otterbar-renderer-swift 加 --render-demo 离屏渲染模式（六态动画帧序列导出），产出 README 用的 Touch Bar 徽章演示 GIF 与静态总览图。渲染器自己的代码画的，所见即生产所得。
change_type: feature
created: 2026-09-03
created_in_conversation: 31767a2b-4cb0-42d7-99c8-1afec8de6f08
from:
  - F20260902swft
tags:
  - touchbar
  - demo
  - readme
  - assets
  - local-tooling
modules:
  - scripts/otterbar/swift/main.swift
  - README.md
  - README.en.md
  - docs/images/touchbar-otter.gif
  - docs/images/touchbar-otter-states.png
capability_test: "n/a: 物料生产工具 + 文档插图（非主服务路径），帧内容正确性由像素统计抽样验证（琥珀/青色/灰度特征），观感由搭档肉眼验收"
---

# Touch Bar 六态演示 GIF：渲染器离屏渲染 + README 物料

## 背景

搭档验收 #737 后提议：Touch Bar 徽章是本项目有趣的亮点，应做成 GIF 放进 GitHub README
吸引眼球。问题：此前截图通道（screencapture -b）在本机返回全黑（F20260902swft 已记录），
拿不到真实效果图。

## 方案：渲染器自己产出效果图（离屏渲染）

不走截图，走**离屏渲染**：渲染端本来就是一个 NSView 的 draw(_:)，把 OtterView 放进
NSBitmapImageRep 上下文逐帧导出 PNG——**同一份代码，Touch Bar 上和 GIF 里画的一模一样**，
所见即生产所得。这比截图更优：不依赖屏幕权限、不依赖 bar 活跃状态、可自由选择态与时长。

## 实现

`--render-demo <outdir>` 模式（main.swift DemoRenderer）：

- 六态场景：等你(3条·好idea蒸馏) / 干活(4场4獭) / 睡觉 / 混合 / 离线 / 非主进程
- 每态 2.4s @ 12fps = 28 帧，共 168 帧 PNG
- 画布 560×60（黑底）：左侧徽章（OtterView 本体）+ 右侧系统控制条模拟（esc/亮度/音量
  的半透明 SF Symbol，还原真实 bar 观感）
- 不碰 Touch Bar、不读 model 文件——纯物料生产模式

GIF 合成（ffmpeg，不入仓库脚本，记录于此）：每态 12fps 顺序拼接，
`scale=840:90 lanczos + palettegen/paletteuse(64色 bayer)`，产物 ~79KB。

## 变更清单

- `scripts/otterbar/swift/main.swift`：+DemoRenderer（~90 行）
- `docs/images/touchbar-otter.gif`：六态轮播演示（README 主图之一）
- `docs/images/touchbar-otter-states.png`：六态静态总览（纵向拼接，取各态第 12 帧）
- `README.md` / `README.en.md`：三图区扩四图，图注更新

## 验证

| 项 | 方法 | 结果 |
|---|---|---|
| 帧内容正确性 | 像素统计抽样：等你态琥珀环呼吸 0↔142 像素起伏（1.7s 周期符合设计）、干活态青色 133px、离线态全灰无彩色 | ✅ |
| 帧数/完整性 | 6 场景 × 28 帧 = 168 PNG 全落盘 | ✅ |
| 渲染端生产行为无扰动 | --render-demo 独立分支，不碰 Touch Bar/model；生产进程未重启 | ✅ |
| README 渲染 | 双语两文件语法核对（图片路径相对引用） | ✅ |
| 观感 | 搭档肉眼验收 | ⏳ |

## 已知限制

- demo 右侧系统控制条是模拟绘制（SF Symbol 半透明灰），非系统原生条截图——观感高度还原但非像素级一致
- GIF 12fps 与生产动画帧率一致，但 GIF 色板 64 色 + bayer 抖动，实机观感更平滑
