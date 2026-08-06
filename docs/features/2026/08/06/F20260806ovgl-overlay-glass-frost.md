---
id: F20260806ovgl
title: overlay-glass-frost
doc_type: feature

summary: |
  弹层恢复磨砂玻璃材质：可读性从堆不透明度改为 blur/saturate/scrim 三件套，
  --overlay-bg 96%/93% 实色 → 77%/67% + 暖色渐变染（治纯透发灰），
  blur 48px saturate 220%，scrim 0.36/8px；参数经搭档在交互效果图中拍板。
  顺手收敛玻璃滑杆范围口径不一（四个代码位置统一 0.45~1.0，issue #166）。

causal_links:
  from:
    - F20260805dmux   # L3 弹层可读性目标的上游（本特性改写其「近实底」实现路径，保留其对比度目标）
    - F20260724glas   # 玻璃材质 4 层级体系的上游（本特性恢复其 L3 磨砂玻璃定位）
  to: []

status: development
change_type: fix
tags: [web, ux, glass, css]
modules:
  - web/src/styles/globals.css
  - web/src/pages/settings/index.tsx
---

# F20260806ovgl: 弹层磨砂玻璃材质修复

## 问题描述

1. F20260805dmux 修弹窗对比度时把 `--overlay-bg` 定死为 96%/93% 不透明度，弹窗退化为实色白纸，丢失玻璃体系（F20260724glas）的 L3 材质。
2. 搭档反馈弹窗视觉偏灰，且期望更透。
3. （顺手，issue #166）玻璃透明度滑杆范围口径不一：globals.css 注释、index.html 与 settings.html 两处入口预载 clamp 均为 0.45~1.0，仅 settings/index.tsx 为 0.6~1.0。

## 根因分析

### 根因 1：可读性修复押错了旋钮

两次修复都在"不透明度"这唯一旋钮上摇摆：66%/53% 太透、聊天区灰色渗入发灰 → 96%/93% 可读但玻璃感尽失。磨砂玻璃的可读性其实由三件套承担——**blur 打散底层结构 + saturate 放大透入色彩 + scrim 加深分离层级**；不透明度只需落在中间带，不是主要承重件。

### 根因 2：弹层是玻璃体系里唯一没有色染的层

偏灰是四层叠加的产物：弹层身后是灰白聊天区（极光色团集中在画布四角与边缘）→ scrim 整体压暗 → 高斯模糊本质是"平均器"，把残余颜色搅成灰白 → 再盖一层纯白 = 浅灰。

气泡不灰，是因为气泡玻璃叠了 14~18% 身份色染（`--otter-tint`），玻璃自带颜色；弹层无色染，只能透什么算什么。因此正确解法是**暖色渐变染**（与气泡同一设计语言），而不是把不透明度拉回去——纯降透明度只会透上来更多灰。

### 根因 3（issue #166）：滑杆范围三处失同步

玻璃体系落地时 CSS 注释与两处入口预载脚本（index.html / settings.html）按 0.45 实现，设置页组件写成 0.6，后续无人对齐。

## 方案与变更

| 位置 | 旧值 | 新值 |
|------|------|------|
| `--overlay-bg` | 96%/93% 纯白渐变 | 双层：暖色渐变染（焦糖 0.20 → 0.06 → 青 0.12）+ 77%/67% 暖白渐变 |
| `--overlay-blur` | blur(40px) saturate(180%) | blur(48px) saturate(220%) |
| `--scrim` | rgba(28,22,16,0.30) | rgba(38,28,20,0.36)（微暖加深） |
| `--scrim-blur` | blur(6px) | blur(8px) |
| `settings/index.tsx` | 滑杆 min 60 / clamp 0.6 | min 45 / clamp 0.45（与 CSS 注释、预载脚本统一） |

不变：`prefers-reduced-transparency` 实色兜底完整覆盖双层背景；`--overlay-bg` 不随 glass-t 系数缩放的例外（F20260805dmux）；index.html 与 settings.html 两处预载脚本本即 0.45，未改动；`.glass-overlay` 全部消费者（modal / 右键菜单 / @自动补全）统一获得新材质，符合 L3 单一材质定位。

## 对比度核算（经检视獭独立验算）

最坏情况取画布最深点（teal 色团叠渐带）：
- modal（有 scrim 0.36 托底）：正文 ≈ **9.3:1**
- 右键菜单 / @自动补全（无 scrim）：正文 ≈ **10.3:1**
- 次级文字（stone-600）：≈ 5.2:1

全部超 WCAG AAA（正文 7:1 / 次级 4.5:1）。

## 决策记录

- **77%/67% + 暖色染**：搭档在 html-card 交互效果图（现状对比 + 透亮度滑杆 0.68~0.92 + 暖色染开关）中实时预览后拍板，卡片回执 `{top:0.77, bottom:0.67, tint:true, blur:48px, saturate:220, scrim:0.36, scrimBlur:8px}`。
- **滑杆统一 0.45**：四个代码位置中三处（CSS 权威注释、两处入口预载脚本）原本即 0.45，浅色画布 + blur 下 0.45 下限可读性仍成立（最坏 ~8:1）；settings 页为离群值，向其收敛。搭档指示 #166 在本 PR 边界内顺手修复，不另开 issue。

## 对抗审视记录

第 1 轮（检视獭）：代码本体核验全部通过（数值与拍板回执逐项吻合、双层背景堆叠顺序正确、reduced-transparency 兜底有效、消费者无副作用、对比度验算成立）；命中 2 处同文件注释失同步（头部性能预算 40px→48px、scrim 注释 6px→8px），均已修复；#166 呈搭档裁决后按指示纳入本 PR。

第 2 轮（增量复审：滑杆统一 + 特性文档，另一位检视獭 fresh eyes）：代码 delta 全部通过（无 0.6/60 残留、取值序列 45~100 共 12 档合理、旧 localStorage 0.5~0.6 值行为反而改善——显示值与应用值从不一致变为一致、第 1 轮注释修复验证属实）；命中 4 个问题，全部处置：

- 【重要】特性文档 frontmatter 缺 causal_links/status/change_type/tags/modules → 已补齐，并回填 dmux 的 causal_links.to（决策反转链不再断链）
- 【建议】对抗审视记录缺第 2 轮 → 本节即是
- 【建议】「三处口径」枚举漏 settings.html 预载脚本 → 已修正为四个代码位置
- 【建议】离网 localStorage 值（非 5 倍数）致 label 与滑块拇指错位（预存根因，delta 使其延伸至 0.45~0.6 区间）→ 与审查者共识不修改：label 如实反映已应用值优于吸附归一（吸附会造成显示值≠应用值的新不一致），且触发需手动改 localStorage，滑杆自身只写网格值

流程改进（审查者建议，已采纳）：特性文档自 checklist 增加「frontmatter 对照最近一份特性文档」一条。

## 测试

- `npm run build`（tsc + vite）通过；web 9 文件 87 用例全绿
- 视觉效果经搭档在交互效果图中预览拍板；合入后肉眼复核：弹窗边缘可见模糊色光透入、正文清晰
