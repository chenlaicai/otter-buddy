---
id: F20261027nmbf
title: "「新消息 N 条」浮窗计数僵死与点击不可达修复"
summary: "两个叠加 bug：①输入覆盖层（F20261015inpd absolute bottom-0 z-10）叠在浮窗（bottom-4 z-10）上方，同 z 值 DOM 序后来居上，透明区域吞掉命中测试——按钮点不到（#1535 同族）；②浮窗计数清零仅「点浮窗/发言」两路，均要求按钮可点，按钮被遮后计数僵死——左栏未读红点已被聚焦 ack（F20260921urdo）消掉，浮窗仍挂「新消息1条」。修法：浮窗随覆盖层实高抬升、z-20 与矮视口钳位；floating→pinned 转换和切会话幂等清零。"
change_type: fix
capability_test: "n/a: 纯前端滚动/布局修复，无 prompt/LLM 行为改动"
created_in_conversation: 3995c48d-499a-4c2d-b04f-e3581a3d3e28
created_at: 2026-10-27T15:30:00+08:00
causal_links:
  from: [F20261015inpd, F20261016inbs, F20261008scpg, F20260921urdo]
tags: [web, conversation, scroll, unread-count, overlay, z-index, hit-test]
modules: [web/src/pages/conversation/MessageList.tsx, web/src/pages/conversation/ChatView.tsx, web/src/pages/conversation/index.tsx]
---

# 「新消息 N 条」浮窗计数僵死与点击不可达修复

## 预注册（动手前冻结）

- 预期根因方向：浮窗计数清零路径断裂 + 按钮被输入覆盖层遮挡（几何/层叠问题，非数据问题——左栏红点正常消散证明服务端已读链路健康）
- 验证标准：代码中找到「计数只增不清的具体路径缺口」与「覆盖层与浮窗的 z/bottom 几何冲突」双证据
- 反例方向：若浮窗计数源自服务端未读数（与红点同源），则应查数据链路而非前端 UI——实际排除：`newMessagesCount` 是 index.tsx:74 纯前端本地 state

**预期命中**：双假设均成立（见下），未反转。

## 问题现象

搭档报告（2026-10-27，附截图两箭头）：左侧栏对话已无未读红点，但中间栏底部仍挂「新消息 1 条」浮窗，且点击无反应。

## 根因分析（双 bug 叠加）

### Bug 1：按钮被输入覆盖层遮挡——点击不可达

- `ChatView.tsx` 输入覆盖层：`absolute bottom-0 left-0 right-0 z-10`（F20261015inpd，2026-10-15 起）
- `MessageList.tsx` 浮窗：`absolute bottom-4 left-1/2 -translate-x-1/2 z-10`（历史位置，覆盖层落地时未同步迁移）
- 两者同 z-10，DOM 序覆盖层在后 → 层叠后来居上。浮窗 bottom-4（16px）恰落在覆盖层（输入框实高 ≥72px）内部 → 命中测试被覆盖层吞掉，点击不可达
- 这是 #1535（卡片预览按钮被覆盖层吞点击）同族问题：覆盖层透明区域照吃命中测试

### Bug 2：计数清零路径全断——僵死

`newMessagesCount`（index.tsx:74，纯前端本地 state）的清零入口仅两个：

| 入口 | 位置 | 前提 |
|---|---|---|
| 点浮窗 | index.tsx handleJumpToBottom（经 MessageList 按钮 onClick） | 按钮可点 ← Bug 1 断 |
| 用户发言 | index.tsx handleSend 内 setNewMessagesCount(0) | 用户主动发言 |

而左栏未读红点是**服务端**权威计数，F20260921urdo「聚焦即已读」会在窗口聚焦时自动 ack——红点正常消散、浮窗本地计数无人清——两者状态分裂，浮窗挂到刷新/发言才消失。

流式新消息（entry.stream.delta 增量）不触发计数（只有完整 entry.user/entry.speak 计数），故僵死值一般是小数目（如「1 条」）。

## 修复方案（修法决策树①：既有语义内修）

两处均为既有机制内补缺，无新增常驻机制：复用 `bottomSpacerPx` 测量链和 scroll-pin 状态机的 floating→pinned 转换沿；`onPinnedToBottom` 是组件回调 prop，沿用 `onJumpToBottom` 同型签名。

**修 A（几何）**：浮窗 bottom 从写死 `bottom-4` 改为随 `bottomSpacerPx + 16` 联动——与底部衬垫（输入覆盖层实高，ChatView ResizeObserver 实测透传）联动，常规空间悬于覆盖层上方 16px；z-10 → z-20 脱离同层竞争。矮视口用原生 CSS `clamp(8px, bottomSpacerPx+16, calc(100%-44px))` 钳住上沿，避免覆盖层接近消息区高度时把按钮顶出可见区域；44px = 按钮高 36px + 顶边距 8px，不新增尺寸状态/observer。

**修 B（清零）**：handleScroll 回锚分支（nearBottom）补 floating→pinned 转换检测并调 `onPinnedToBottom?.()`，index.tsx 侧 `setNewMessagesCount(0)`。父层 setter 天然幂等，转换沿不再依赖 `newMessagesCount` 的 props 快照，避免新消息 setState 与 scroll 交错时旧快照吞掉清零信号。清零放在独立 `[activeId]` effect：SPA 切会话清空旧计数，同会话过程明细导致详情加载 effect 重跑时不得误清。

语义：滚回底部=新消息已在眼前，等同已读（与 F20260921urdo 聚焦 ack 同哲学）；仅 floating→pinned 转换触发，pinned 保持的重复 scroll 不打。

## 验证（失败证据链）

**修复前红**（git stash 源文件后跑，2 失败 / 28 通过）：

```
× F20261027nmbf 几何：浮窗 bottom = 衬垫高+16，抬升到输入覆盖层上方（修复前 bottom 僵 16px 被覆盖） 13ms
× F20261027nmbf 回锚清零：floating 滚回底部（nearBottom）→ 触发 onPinnedToBottom 清零回调 8ms
```

**修复后绿**：

```
✓ MessageList.test.tsx：30/30——bottom 读取 --badge-bottom 原生钳位变量，z-20 保持；
  floating→pinned 清零；计数 prop 为旧快照 0 时仍发清零回调；pinned 保持不重复
✓ index.spa-nav.test.tsx：A 会话 floating 收到真实 SSE 形态发言 → 新消息 1 条；
  同组件路由切到 B → B 消息正常渲染且 A 徽标消失
✓ 全量 web：786/786（77 文件），tsc --noEmit 零错误
```

**真实浏览器（Playwright + 隔离 Vite，非 jsdom）**：`input-fixed-split-visual.spec.ts` 11/11。新增两条用例先上翻进入 floating，再释放一条真实 SSE `entry.speak`，不手工插按钮或伪造 DOM 几何：

| 场景 | 行为断言 | 视觉证据 |
|---|---|---|
| 900×700 常规窗口 | 浮窗底高于覆盖层顶至少 15px；中心 `elementFromPoint` 命中按钮；真点击后回底、徽标消失 | `web/test-results/nmbf-11a-normal.png` |
| 640×260 + 大输入覆盖层 | 消息区 123px；首选 bottom 120px > 触顶线 79px，计算 bottom 钳到 79px；顶/中/底均命中；真点击清零 | `web/test-results/nmbf-11b-short.png` |

**Clamp 判别性对照**：同用例临时将 `--badge-bottom` 改为无 clamp 的 `104+16=120px`，得到按钮顶 91px < 消息区顶 124px、`computedBottom=120` 且顶/中/底命中失败，断言按预期红；恢复 clamp 后为顶 132px、bottom 79px、三点命中全绿。失败日志 `/tmp/otter-1662-clamp-negative.log`。

触顶态的空间取舍：极端高度下覆盖层与完整按钮可能几何重叠，优先保证按钮完整留在消息区；z-20 保证按钮而非覆盖层命中，不宣称此时仍有 16px 间距。常规窗口的「底高于覆盖层顶至少 15px」保持硬断言。

既有 9 条输入边界/卡片预览/大卡片回归同批全绿，未以新增用例替代旧用例。

**测试形态备注**：mount 时「切换会话重置状态」effect 置 pinRef=true，回锚用例需在 instrumentRW 后手动置 floating 再 fireScroll。jsdom 不接受直接 `clamp()` 声明，产品用 CSS 自定义属性承载原生公式，`bottom: var(--badge-bottom)`；几何正确性以真实浏览器的矩形、命中与截图为准，不以 jsdom 的样式计算冒充布局证据。

## 影响范围

- 浮窗几何：常规空间仅在 bottomSpacerPx>0（输入覆盖层存在）时视觉位置变化；矮视口优先保留可见顶边距，退化时与覆盖层间距可小于 16px，但不裁切按钮
- 回锚清零：用户滚回底部即清计数——语义增强，无破坏性（计数本就该在「已看到」时清）；转换沿不读计数 props 快照，仅多发幂等 `set(0)`
- 切会话：进入新会话清空上一会话的本地浮窗计数；清零只依赖 activeId，不随过程明细/详情加载重跑；旧会话缓存消息仍按既有机制保留
- 不影响：服务端已读游标、左栏红点、scroll-pin 状态机其余转换（floating 保持、脱锚路径零改动）

## 初轮对抗检视处置（检视獭-1662 / mimo-pro）

| # | 分级 | 更好/更差判断 | 终态 |
|---|---|---|---|
| 1 计数 props 快照吞回锚清零 | 建议 | 改更好：去掉无收益的门，set(0) 幂等且消除交错盲区 | 已修 `MessageList.tsx`；补旧快照 0 + floating→pinned 回归 |
| 2 「无计数不打」测试语义失真 | 建议 | 改更好：pinned 保持防重触发已有相邻用例覆盖，本用例改为验证真实竞态 | 已修测试，不弱化原防重断言 |
| 3 切会话计数泄漏 | 建议 | 改更好：恢复状态归属；独立 activeId effect 避免同会话副作用 | 已修 `index.tsx`；补同会话过程明细保持 + A→B 清零回归 |
| 4 文档机制检查点绝对化 + 已退役 entry.complete | 建议 | 改更好：按原指认点订正，审计口径与实现一致 | 已修根因/修复方案；表述为无新增常驻机制，计数入口只列 user/speak |
| 5 矮视口顶部裁切 + 缺真实几何验证 | 建议 | 改更好：原生 clamp 消除遮挡→裁切的换病 | 已修；新增绑定态数值与三点命中断言，并做撤 clamp 失败对照 |

Discovered Issues：无新增 issue；全部为本 PR 强关联发现，当场修复。

## Delta 复核追加处置（检视獭-1662 / mimo-pro）

| 项 | 终态 |
|---|---|
| 原发现 4 回执先于实物 | 已核实回执失实，本次以实际文档 diff 为准，不沿用旧完成声明；机制检查点与 entry.complete 两处已落地 |
| D-1 同会话过程明细误清 | 新回归在未修代码红（切换后新消息 1 条消失）；清零拆独立 `[activeId]` effect 后同用例转绿，切 B 仍清零 |
| D-2 360px 用例可能非绑定态 | 改为 640×260 并断言首选值>触顶线、实际值=触顶线；无 clamp 对照红、恢复绿，实测数值见上 |

## 验收标准（可机械复核）

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 回锚与快照竞态 | `npx vitest run src/pages/conversation/MessageList.test.tsx` | 30/30 PASS；含旧计数快照仍清零、pinned 保持不重复 |
| SPA 切会话与同会话重载 | `npx vitest run src/pages/conversation/index.spa-nav.test.tsx` | A 出现浮窗，过程明细切换后仍在；切到 B 后无浮窗且渲染 B 消息 |
| 常规/矮视口真实几何 | `E2E_BASE_URL=<隔离Vite地址> npx playwright test e2e/input-fixed-split-visual.spec.ts --grep '11a|11b'` | 2/2 PASS：真实矩形、命中、点击清零、截图均通过 |
| 输入区既有回归 | 同 spec 全文件 | 11/11 PASS；既有 9 条不退化 |
| 全量 web | `npm test && npx tsc --noEmit`（web 目录） | 786/786 PASS，类型检查零错误 |
| 生产构建 | `npm run build`（web 目录） | 构建成功；只有既有 chunk 体积/动态导入提示，无错误 |

## 预期 vs 实际对照

预期命中：根因双假设（遮挡 + 清零路径断）均在代码中实证，修复后搭档报告的两个症状（点不到、僵死挂条）分别被修 A/修 B 对应消除。
