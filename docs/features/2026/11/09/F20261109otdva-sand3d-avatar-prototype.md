---
id: F20261109otdva
title: 用 sand3d 生成可交互的大獭 3D 头像原型
change_type: feature
summary: 用 sand3d 生成保留红围巾识别点的陶偶风大獭，在独立页面支持拖动、眨眼、点头和挥爪，保留 SVG 回退。
capability_test: "n/a: 代码化建模与前端确定性渲染，不涉及 LLM 运行时行为"
intent:
  problem: "现有大獭只有静态 SVG，搭档需要先看到真实 3D 头像效果再决定是否吸收 sand3d"
  expected_effect: "独立预览页加载 sand3d 生成的 GLB，支持拖动旋转、眨眼、点头、挥爪及窄屏展示，WebGL 不可用时保留 2D 兜底"
  verify_by:
    type: behavior_check
created_at: 2026-11-09
created_in_conversation: 98bd9fdd-8e28-4de8-b782-b59f46e733dd
causal_links: []
tags: [avatar, 3d, sand3d, threejs]
modules: [web/src/pages/avatar, web/public/avatars, scripts/avatar]
---

# 用 sand3d 生成可交互的大獭 3D 头像原型

## 目标与非目标

搭档 2026-11-09 原话「你能不能先搭建一个出来我看看效果？」。本特性是独立实验页 `/avatar/3d`，不是 Muse 数字人复刻，也不改变现有对话头像。目标是让搭档直接看到真实 3D 模型，而不是一张渲染图冒充模型。

- 保留大獭 SVG 的雾蓝灰、奶油色嘴套、红围巾等识别点，造型走哑光软陶风；头、耳、身体与四肢必须形成相连轮廓。
- sand3d 源码生成网格和材质；Three.js 只负责真实 GLB 显示、节点动画与拖动旋转。
- 不接对话状态、语音识别、实时口型、人物骨骼或网格编辑后台。

## 设计取舍与边界

- 单一中心辐射结构：头像是唯一主视觉；文字介绍与少量动作控制退居两侧，不做产品营销三卡。
- 以现有头像风格为参考，不走通用紫色渐变/赛博风。初版陶偶经搭档判读为「好恐怖」，已明确打回；返修版改为小眼睛、单片浅嘴套、小身体与哑光材质，不把技术可渲染等同于审美通过。
- 预览页独立路由且无 TopBar；其余页面继续由既有 AppLayout/TopBar 承载。路由挂载时只为本页解除桌面工作台 min-width。
- GLB 的毫米单位统一换算为浏览器场景单位；关节保留在导出节点中，头部使用 `nod` 节点，眼部用节点缩放完成原型眨眼。
- 新增能力不赋予新决策者：页面只让用户控制本次预览，不自动把 sand3d 产物接入用户头像；渲染失败保留现有 SVG。

## 机制识别与预算

机制检查点：新增 `/avatar/3d` 页面入口、GLB 静态文件及本地渲染生命周期，但没有新配置、定时任务、后台进程、跨模块服务调用或持久化用户状态。头部/眼部状态仅驻留内存，刷新即恢复。该原型新增展示功能，不改写现有功能分支或数据契约；以 `narrow-fix` 提交（新增展示功能而非既有 bug 修复），不宣称新持久化机制。

维护债：需要随视觉调整维护生成脚本与 GLB，Three.js 增加一个路由级 chunk；头像真正产品化时才需要统一模型约定、动作生命周期与全局头像回退。本原型不承担这些后续机制。

## 实现

- `scripts/avatar/generate_otter.py`：sand3d 1.6.3 参数化生成真实闭合网格、材质与关节，导出 `web/public/avatars/otter-3d.glb`。
- `web/src/pages/avatar/OtterScene.tsx`：懒加载 Three.js 渲染；基于 GLB 的头部节点和独立眼球节点执行动作；组件卸载时取消动画帧、释放 GPU 资源和 DOM。
- `web/src/pages/avatar/avatar-motion.ts`：以经过时间计算动作，避免按帧数造成不同刷新率下速度不同；支持 reduced-motion。
- 原型页动作可重复触发，「回到自在」恢复表情和动作，不刷新页面；挥爪通过独立 paw 节点的抬起与转动实现。

## 视觉质检

结构为中心辐射：单一头像主视觉，两侧低密度文字/操作；不是模板三卡。风格用雾蓝灰、奶油白和围巾红的有限色板，衬线标题与等宽辅助标签区分层级。

搭档否定初版后，实际截图逐轮暴露了真正的几何根因：sand3d `sphere(name, d)` 接收直径且原点位于球底，旧辅助函数却按球心/半径放置，导致耳、脚和面部部件系统性分离；眼部 pivot 又重复扣除了固定偏移。返修版统一以半径参数和真实球心放置，头部只保留一个关节坐标系，并去掉 ceramic 默认 clearcoat 带来的玻璃/塑料高光。生成时施加一次细分以柔化轮廓。

当前桌面正面/侧面与手机截图均显示完整相连的小身体、小眼睛、单片浅嘴套和红围巾；挥爪使用肩部 pivot 加相对静止位的绝对偏移，验证截图取动作前段而非结束后的静止帧。仍属于程序化软陶角色，不宣称手工精修或已达到 Muse 级数字人；新版审美仍需搭档判读。

## 验收标准

| 场景 | 操作 | 预期 |
|---|---|---|
| 真实模型加载 | 浏览器访问 `/avatar/3d`，等待动作按钮可用 | canvas 显示大獭，GLB 请求 200，控制台无错误；截图非空白 |
| 交互 | 拖动模型，点击点头/眨眼/挥爪与好奇 | 模型角度改变，头部/眼睛/爪子发生可见变化，按钮可重复操作 |
| 窄屏 | 375–390px 宽打开页面 | 页面宽度等于视口，头像不裁耳，动作按钮可触达 |
| 加载失败 | 阻断 GLB 或 WebGL 初始化 | 显示现有 datu.svg 和说明，不出现永久空白 |
| 不影响旧页面 | 打开 `/conversation` | TopBar 与桌面最小宽度保持原样 |
| 动作函数 | `npm test --prefix web -- src/pages/avatar/avatar-motion.test.ts` | 动作从静止开始/结束、眨眼窗口与时长断言通过 |

视觉质量（可爱程度、是否延续大獭气质）为搭档人工判读；真机截图只证明渲染与布局，不替代审美验收。

## 验证

- 生成环境：CPython 3.11 + bpy 4.5.15 + sand3d 1.6.3（commit `84c980a523adcb0474420ed4e3990681d403dce3`）；生成命令及版本随脚本记录。
- `npm run build`、`npm run build --prefix web`、`npm run lint:intent`、`npm run lint:capability` 均通过（存量文档 warning 未新增）。
- `npm test --prefix web -- src/pages/avatar/avatar-motion.test.ts`：1 文件、3 用例通过。
- 真 Chromium 1440×1000 与 390×844 渲染通过，动作/拖动/回退按钮已操作，无 page/console error；手机页面宽 390px、无横向溢出，回退页 datu.svg 实际显示，离开后 `/conversation` 恢复 1024px 和 TopBar。截图存对话工作区 `designs/avatar-3d/`。
- 造型返修后再次跑同一浏览器检查：正面/侧面不再散架，桌面与手机提示不遮脚，375×667 可滚动且按钮可达；`wave-250.png` 独立记录挥爪前段抬爪。此处只主张几何、渲染和交互验证，不代替搭档审美验收。
- `sync_docs` 连续两次 errors=1，尚未取得文档入库成功证据；不把已登记 file 产物冒充已入库。
- 最简检查：复用现有 React/Vite 路由，GLB 不做 OBJ 纹理绕路；只增加 Three.js 渲染依赖。未把 Blender/bpy 或外部 CDN 变成运行时依赖。
- 本轮未删除或替换现有头像机制，负向检查聚焦旧页面不变与 WebGL 失败回退。
