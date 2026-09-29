---
id: F20260929ahgt
title: html-card 高度全自动化：移除 agent 高度管理（data-height / otterCard.resize 退役），初始 100px + 桥 ResizeObserver 双向跟随
summary: "搭档拍板终态方案：高度不归 agent 管。机制层改动——iframe 初始高度固定 CARD_MIN_HEIGHT(100) + CSS 过渡消解跳变；桥 resize clamp 下限解开为 1 且上报只测 body.scrollHeight（去掉 documentElement 自指污染源，解开单向棘轮，可撑可缩）；otterCard.resize API 与 data-height 解析移除；写卡契约高度段整段删除。"
change_type: feature
capability_test: "n/a: web 渲染管线行为变更，capability 层无对应场景；验证走宿主管线仿真实验（playwright 复刻 HtmlCard srcdoc 组装 + 桥 + useCardBridge 消费）+ web 单测（card-bridge.test.ts 5 通过）"
created: 2026-09-29
created_in_conversation: 80128ebf-52ed-4c98-8e0a-2f804cb1bcbf
intent:
  problem: "html-card 底部大面积空白——实测 10/10 卡 data-height 系统性高估（最大 497px），且回正是单向棘轮（写大永久残留）；agent 估不准高度（写卡时内容未渲染），旋钮交到 agent 手里等于给估不准的值赋予永久副作用"
  expected_effect: "agent 写卡零高度负担（契约高度段删除）；卡片展开后高度精确等于内容真实高度，底部空白归零；内容变矮时高度可缩回（棘轮解开）"
  verify_by:
    type: behavior_check
modules:
  - web/src/pages/conversation/HtmlCard.tsx
  - web/src/pages/conversation/hooks/useCardBridge.ts
  - web/src/lib/card-bridge.ts
  - web/src/lib/card-bridge.test.ts
  - api-contract/api/html-card.ts
  - src/interface-adapters/agent-runtime/tools/html-card-contract-tool.ts
  - .pi/skills/review-protocol/references/templates/decision-briefing-card.md
  - .pi/skills/review-protocol/references/templates/option-comparison-card.md
  - .pi/skills/review-protocol/references/templates/retrospective-card.md
  - .pi/skills/visual-design/references/web/toolchain.md
  - prompts/identity/BIG_OTTER.md
from:
  - F20260916hcel
supersedes_prompt_fix: F20260929hdhc
tags:
  - html-card
  - web
  - mechanism-simplification
---

# html-card 高度全自动化

## 背景

html-card 底部空白问题的发展链（本对话 80128ebf 全程）：

1. 搭档报「页面最下方老有一大截空白」→ 排查确认高度契约问题
2. 实测当日全量卡（headless Chromium）：**10/10 张 `data-height` 系统性高估**，最大浪费 497px
3. 先走 prompt 纠偏路线（PR #1212，F20260929hdhc），对抗审视中检视獭仿真实验发现**回正是单向棘轮**（只涨不缩）——写大的空白永久残留
4. 搭档点破：「不要让 agent 管高度，软件自动 1px 起步自动撑大不就行了，为什么要搞这么复杂」→ 拍板关闭 #1212，转向机制层终态方案

**设计动机的历史软肋**（为什么当初留了 data-height 旋钮）：唯一理由是展开跳变——从默认高度撑到几千 px 时消息流抖动。但收益代价不对等：跳变是几百毫秒体感问题，写错高度是永久空白；且 agent 写卡时内容未渲染，估算全靠猜。跳变问题由 CSS transition 消解（本特性一并实现），不需要 agent 参与。

## 方案设计

**核心判断：棘轮的根因不是「clamp 下限 100」，是 `documentElement.scrollHeight` 自指污染**——已撑大的 iframe 里 `documentElement.scrollHeight ≥ clientHeight`（clientHeight = iframe 当前高度），`Math.max(body, documentElement)` 恒 ≥ 当前高度。只测 `body.scrollHeight`（标准流中与视口解耦，等于内容高度）即可让 ResizeObserver 双向跟随。

四处机制改动：

1. **HtmlCard.tsx**：移除 `data-height` 解析（旧卡的该属性成为无害冗余），初始高度固定 `CARD_MIN_HEIGHT`（100px，小起步防跳变过量）；iframe className 加 `transition-[height] duration-200 ease-out` 平滑过渡
2. **useCardBridge.ts**：resize clamp 从 `[CARD_MIN_HEIGHT, CARD_MAX_HEIGHT]` 改为 `[1, CARD_MAX_HEIGHT]`——上限保留防失控，下限解开让缩回生效
3. **card-bridge.ts**：①`report()` 只测 `body.scrollHeight`（去掉 documentElement 项）；②移除 `otterCard.resize` API——agent 高度干预通道关闭
4. **契约/prompt 面**（6 处）：写卡契约「高度自适应 API」整节删除，语法骨架段高度行替换为一句「高度全自动，不归你管」；三张简报卡模板删 `data-height` 示例与自检项；toolchain 高度条目改为「不要写」；BIG_OTTER 黑话表同步

**取舍**：
- 否「保留 data-height 作为可选优化」：旋钮存在一天，agent 就会去拧（实测 10/10 高估证明估不准），终态必须删除而非降级
- 否「父页跨域测量」：iframe sandbox 无 allow-same-origin，父页摸不到内部 DOM，本就不可行；桥内测量是唯一通道
- body-only 上报的边角：卡片用 `html{height:100%}` 撑满布局时 body 可能不足内容高——但 token CSS 未设 html 高度，写卡契约也不鼓励视口相对布局；若未来遇到，ResizeObserver 对 body 的观察仍会在内容溢出时触发（overflow 内容计入 body.scrollHeight）

## 负面向验收条目

**本次变更破坏/移除的旧契约**：
- `data-height` 属性失效（存量卡上的该属性静默失效——无害，它本就是提示值）
- `otterCard.resize(height)` API 移除——存量卡脚本若调用会报 TypeError（`otterCard.resize is not a function`）。**影响评估**：resize 调用失败只抛脚本错，不影响卡片渲染与 submit（桥 resize 上报独立于 otterCard 对象）；且高度从此自动管理，存量卡的 resize 调用本就是多余的。实测存量 12 张卡无一张调用 otterCard.resize（扫描今日全量卡源码确认）

## Verification

- **宿主管线仿真实验**（playwright，复刻 srcdoc 组装 + 新桥 + useCardBridge clamp 逻辑；脚本 `/tmp/otter-auto-height-verify.mjs` 可复跑）：
  - 12 张今日真实卡从 100px 起步全部精确收敛到内容真实高度（854/2948/341/1445/413/544/1182/635/830/1436/1119/916px）
  - **缩回测试**：800px 内容→iframe 824px；内容改 50px→iframe 缩回 74px（50+24 padding）——棘轮解开
- **web 单测**：card-bridge.test.ts 5 通过（resize API 移除断言更新）
- **tsc**：后端 + web 双端通过
- **Golden Gate**：本次涉及 prompt 面（契约高度段删除），按 code-implementation 步骤 6 需跑 capability gate（见 PR Verification 节结果）
- 已过最简实现检查：机制改动共 4 处、净删代码，无新依赖
