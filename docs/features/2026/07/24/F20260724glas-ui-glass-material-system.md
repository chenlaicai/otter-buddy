---
id: F20260724glas
title: ui-glass-material-system
doc_type: feature

summary: |
  UI 玻璃材质体系重设计：底部=极光画布（深底高饱和色团+对角渐带+噪点），
  画布之上全层玻璃（L0 顶栏→L1 面板→L2 气泡卡片→L3 弹层），材质全部
  CSS token 化。--glass-t 全局系数 + 设置页滑杆实时调节透明度。
  气泡体系统一为用户/水獭同款"侧边色条+玻璃+身份色染"。
  经 3 轮设计评审 + 2 轮 PR 对抗检视收敛；术语统一（关键资源）；
  顺手修 MPA 导航 404；CI 补 web 构建关卡。

causal_links:
  from:
    - F20260724tsrr

status: draft
change_type: feature
tags: [ui, glass, design-system, css, tokens, accessibility, terminology, ci]
modules:
  - web/src/styles/
  - web/src/components/
  - web/src/pages/
  - .github/workflows/

created_at: 2026-07-24
---

# F20260724glas UI 玻璃材质体系重设计

## 背景

原 UI 想做苹果玻璃拟态但效果不佳，根因是"半透明白盒子"：白色半透明背景 + 白色边框放在米色背景上，对比度低、无材质感；且顶栏/面板/气泡/输入框全用同一材质，没有纵深。

目标（用户亲定的材质哲学）：**底部 = 极光画布；画布之上的一切都是浮起的玻璃**——包括聊天气泡。

## 核心设计决策

### 1. 底部画布

- 深底（#E7DDCF）+ 高饱和色团（alpha 0.55~0.65）+ 115° 对角渐带 + 2% 噪点防色带
- 关键认知：**玻璃感不取决于玻璃本身的 alpha，取决于玻璃后面有没有可辨认的色彩结构**。太平的色团被 blur 糊成无信息浅色，怎么调 alpha 都像调色；色团要高饱和、高色相差、位置让每块玻璃横跨多个色区
- 画布深下去，白玻璃才"亮"出来，边界/高光/折射靠底色反差托出

### 2. 四层玻璃（透明度梯度 + 投影高度分层）

| 层 | 类 | 用途 | 材质 |
|----|----|------|------|
| L0 | .glass-strong | 顶栏（浮起圆角条） | blur 28px saturate(200%)，最透 |
| L1 | .glass / .glass-input | 侧栏、输入框 | blur 24px，高投影 |
| L2 | .glass-card / .bubble-* | 气泡、卡片 | --bubble-blur 16px saturate(140%) |
| L3 | .glass-overlay + .scrim | Modal/菜单/toast | 最透 + blur 40px，scrim 6px 柔化 |

- 嵌套激活态（.conv-active/.nav-pill-active）退化为半透纯色，不叠玻璃（玻璃叠玻璃 = muddy + 双倍付费）
- 边缘规则：1px 高光 + 深色接触线成对出现，任何背景上边缘读感一致

### 3. 气泡身份色体系

- 用户与水獭同款语言：侧边色条 + 玻璃 + 身份色染（color-mix 14~18%），互为镜像（用户色条在右）
- 每只水獭色调不同（--otter-tint 内联注入），一眼区分是谁在说
- 用户身份色用中性石灰系（#8B7E72），避免与 o1 品牌棕撞色
- 流式进行中：bubble-live 身份色外发光 + 过程面板流光（prefers-reduced-motion 下关闭）
- 圆角矩形（曾做不对称尖角，用户评审后去除）

### 4. --glass-t 透明度系数

- 所有玻璃 token 用 `rgb(... / calc(N% * var(--glass-t)))` 缩放
- 设置页滑杆 60~100% 实时调节，localStorage 持久化，4 个 HTML 入口预加载脚本防闪烁（值钳制防脏数据）
- 下限 60%：极值下 chrome 文字对比度会失守

## 工程约束（评审收敛产物）

- **对比度**：用户气泡深字浅玻璃 ~10:1；水獭名字色 600 系 ≥4.5:1；focus 实色环 #97734C ≥3:1；ink-3 #5F5447 + 画布色光晕（骑饱和色团仍可读）
- **性能预算**：L2 blur 16px 去 saturate（第二个 filter 函数开销近翻倍）；content-visibility 视口外剔除（**底部 3 行豁免**——滚动锚定 scrollTop=scrollHeight 依赖底部真实高度，估算高度会停错位置）；背景静止；禁 will-change
- **无障碍红线**：prefers-reduced-transparency 全退化实色（仅 Chromium 119+ 支持该媒体查询），白边换深色接触线 + 投影加强，层级仍成立
- **token 化**：材质全部 CSS 变量，reduced 兜底只改变量；--edge-hi 等 box-shadow 列表片段禁用 none 占位（会使整条声明非法），用全透明阴影

## 术语统一（关键资源）

后端已是统一产物模型（单一 LinkedResourceDTO，resourceType 区分 fact/url/pr/file），前端残留旧概念。本特性将右栏「关键事实」「链接资源」两栏合并为「关键资源」单栏，清理全部用户可见旧称（toast/弹窗标题/记忆页提示），mappers 注新旧词映射。machine name（create_linked_resource 工具、linked_resources 表）有意保留。

## 顺手修复

- MPA 导航 404：serveStatic 无路由重写，TopBar/左栏/「前往设置」链接改为 /xxx.html 实际路径；删除互相矛盾的死代码 web/server.ts
- CI 新增 web 构建步骤（npm --prefix web ci && build）——此前 web 代码无任何 CI 关卡

## 未覆盖 / Follow-up

- 深色模式：组件内散布 light-only Tailwind 类（bg-white/text-stone-*），需独立的组件级改造轮次，token 体系已留位
- 玻璃叠玻璃按钮 hover 死类清理（hover:bg-white/50 赢不了未分层类）
- o3/o5 焦糖撞名（上游遗留）、preload 脚本抽外链（未来 CSP）
- mockups/ 低保真原型（v1→v2.3 过程稿）实现完成后已移除，设计决策以本文档为准
