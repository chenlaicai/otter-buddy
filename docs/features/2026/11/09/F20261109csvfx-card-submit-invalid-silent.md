---
id: F20261109csvfx
title: 卡片按钮无效 payload 静默无反应：校验失败改为节流反馈，安全拒绝保持 fail-closed
change_type: fix
capability_test: web/e2e/input-fixed-split-visual.spec.ts
intent:
  problem: "HTML 卡片按钮点击完全无反应——payload 缺 summary 被前端校验拒绝后静默 return，搭档看不到任何反馈（11-09 议题卡实证）"
  expected_effect: "无效 payload 点击后出现『卡片提交被拒绝』toast（per-card 3s 冷却防骚扰）；合法 payload 预览/确认/回执链路不变；伪造 source 等安全拒绝仍零反馈"
  verify_by:
    type: behavior_check
created_at: 2026-11-09
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
tags: [web, card, ux, bugfix]
modules:
  - web/src/pages/conversation/hooks/useCardBridge.ts
  - web/src/pages/conversation/hooks/useCardBridge.test.tsx
  - web/e2e/input-fixed-split-visual.spec.ts
causal_links:
  from:
    - F20260728htar
    - F20261016pcov
summary: |
  搭档 11-09 10:39 报告「我点击按钮无反应」。现场：大獭 10:30 议题卡按钮
  otterCard.submit({choice,label}) 缺契约必填的 summary → useCardBridge 校验拒绝后
  静默 return（修复前 :122），点击零反馈。真实浏览器复现确认 onclick→桥→postMessage
  链路完好（父页收到 card:submit、payload 无 summary、console 零错误），拒绝点恰在
  校验分支。窄修：仅该分支加 per-card 3s 冷却的 toast 反馈；伪造 source/节流/已关闭/
  已回复等安全与闸门拒绝保持 fail-closed 静默；预览闸门不放开。
---

# 卡片按钮无效 payload 静默无反应（F20261109csvfx）

## 1. 背景与问题现象

搭档 chen 2026-11-09 10:39 原话：「按根治来（题外话，我点击按钮无反应，难道是bug？）」。

现场：大獭 10:30:01 发出的 L2 议题卡（对话 entry `e45c43c5-0be9-4369-96a8-706db561f5df`，seq 1128，`importance="high"` 默认展开）操作区三个按钮：

```html
<button onclick="otterCard.submit({choice:'persistent-queue',label:'按根治方案实施'})">按根治方案实施</button>
<button class="alt" onclick="otterCard.submit({choice:'discuss',label:'先讨论方案'})">先讨论方案</button>
<button class="alt" onclick="otterCard.submit({choice:'defer',label:'暂不处理'})">暂不处理</button>
```

搭档点击后**无任何反应**：无预览、无提示、无报错——L2 拍板通道对该卡完全失效。

## 2. 预注册（troubleshooting 步骤 1，动手前冻结）

- **预期根因方向 X**：按钮 payload `{choice,label}` 缺契约必填的 `summary` → `validateCardSubmitPayload` 拒绝 → `useCardBridge` 校验失败分支静默 `return`（修复前 `web/src/pages/conversation/hooks/useCardBridge.ts:122`）→ 预览不出现 = 点击无反应。
- **验证标准 Y**：真实浏览器按该卡原样复现——父页 message 探针捕到 `card:submit`（点击链路活着）、预览不出现、无任何反馈；同卡合法 payload（summary 形状）预览出现且确认后回执 POST 到达。
- **最强反例 Z（出现即放弃 X）**：postMessage 根本没发出 / source 白名单拒绝 / iframe 沙盒阻止 onclick 脚本 / 预览已出现但被遮挡不可见。

**预期 vs 实际：命中**（无偏离）——Z 全部被排除，见 §3 证据链。

## 3. 根因分析（证据链）

| 环节 | 锚点 | 结论 |
|---|---|---|
| 按钮 payload 形状 | 对话 entry `e45c43c5…` @2026-11-09 10:30:01 | `{choice,label}`，**无 summary** |
| 桥原样透传 | `web/src/lib/card-bridge.ts:31-32`（`parent.postMessage({type:'card:submit',…payload})`） | 链路不动 payload |
| 校验要求 summary | `web/src/lib/html-card.ts:116-117`（`summary 不能为空`） | 该 payload 必拒 |
| **拒绝后静默** | 修复前 `web/src/pages/conversation/hooks/useCardBridge.ts:122` `if (!validateCardSubmitPayload(data.payload).ok) return` | **根因：作者错误类拒绝零反馈** |
| 契约告知层 | `src/interface-adapters/agent-runtime/tools/html-card-contract-tool.ts:75-79`（示例含 `summary: '…' // ≤500 字符`） | 契约本身正确 |
| 真实浏览器复现 | 本 PR e2e 用例 9 修复前运行（证据 JSON + 截图，见 §8） | 父页收到 `card:submit` payload `{choice:'persistent-queue',label:'按根治方案实施'}`、`consoleErrors: []`、`previewVisible: false`、feedback 不可见 → 断言失败于「卡片提交被拒绝」= bug 现场 |

**因果链**：卡片作者未按契约写 `summary`（临场自造形状）→ 校验正确拒绝（安全闸门，预览需要 summary 作人类可读摘要）→ **拒绝路径静默** → 搭档看到的全部现象就是「点了没反应」。契约拒绝本身是对的，错在把拒绝做成了不可见。

## 4. 派工线索独立核验（大獭线索，非已核实根因）

1. ✅ **确认**：按钮代码与 payload 形状（见 §1，`get_message` 原文取证）。
2. ✅ **确认**：`CARD_SUBMIT_SCRIPT` 原样透传（`card-bridge.ts:31-32`）。
3. ✅ **确认**：`validateCardSubmitPayload` 要求 summary + `useCardBridge` 静默 return（§3 表）。
4. ❌ **证伪**：「`get_html_card_contract` 工具说明错误声称 payload 可以是任意 JSON」——不成立。工具 `description`（`html-card-contract-tool.ts:134`）只说「获取完整写作契约」；契约正文示例（`:75-79`）明确 `summary` 必填 ≤500 字符、`data` ≤2KB；全仓 grep「任意 JSON」零命中。三个模板（`decision-briefing-card.md:85-87`、`option-comparison-card.md:62-65`、`retrospective-card.md:72-73`）全部示范 `{summary,data}` 形状。**错误形状来自卡片作者临场写法，告知层无缺陷**——故本 PR 不改契约文本（被否方案见 §7）。
5. ✅ **确认并排除**：沙盒/脚本故障方向（Z）——真实浏览器点击后父页收到 `card:submit`、`consoleErrors: []`，onclick→桥→postMessage 全链完好。

## 5. 修法决策树判定

**机制识别检查点（七项逐项）**：

- □ 新增配置字段/枚举/开关 — 无
- □ 新增状态生命周期 — 无：`lastFeedbackRef` 是与既有 `lastSubmitRef`/`lastResizeRef` 同构的**运行时节流时间戳**（清单排除条款「纯运行时临时分支不算」），不落 DB/配置/文件，刷新即失
- □ 新增定时任务/后台进程 — 无
- □ 新增信号类型/消息格式 — 无（不改 postMessage 格式）
- □ 新增持久化存储 — 无
- □ 新增决策分支（被记住并影响后续）— 无（同上，纯运行时临时）
- □ 新增跨模块调用路径 — 无（`showToast` 为本 hook 既有依赖）

全部未命中（命中候选均为清单明示排除的运行时临时态）→ **走修法决策树① 既有机制语义内修（缺啥补啥）** → `Modification-Class: narrow-fix`。既有机制 = 「卡片提交校验闸门 + toast 反馈通道 + per-card 节流模式」，缺的只是「校验失败时走一次反馈」。

## 6. 实现

| 文件 | 变更 |
|---|---|
| `web/src/pages/conversation/hooks/useCardBridge.ts` | +`REJECT_FEEDBACK_THROTTLE_MS=3000`；+`lastFeedbackRef`；校验失败分支改为：3s（per-card）冷却内 `showToast('卡片提交被拒绝（<error>），请让水獭按契约重发卡片', 'error')` 后 `return`。**仅此分支**——伪造 source（`useCardBridge.ts:97-99`）、submit 节流、已关闭、已回复、预览单槽位等拒绝全部保持原静默 |
| `web/src/pages/conversation/hooks/useCardBridge.test.tsx` | +5 用例（缺 summary 反馈、3s 冷却节流、超限反馈、伪造 source 静默、已回复静默） |
| `web/e2e/input-fixed-split-visual.spec.ts` | +2 用例（真实浏览器：无效 payload 点击→反馈+闸门不放开；合法 payload 预览→确认→回执 POST 回归）+ 证据落盘 |

安全面不变式：反馈只在**已通过 source 白名单 + cardId 匹配 + submit 节流 + 未关闭 + 未回复**之后的校验失败分支触发——脚本无法借反馈探测注册表状态；反馈文案拼接的 `validation.error` 是 `validateCardSubmitPayload` 内静态字符串（`html-card.ts:113-128`），非用户可控输入，React 文本节点渲染无注入面。

## 7. 设计取舍（被否方案）

- **放开校验接受 `{choice,label}` / `label` 作 summary 别名** — 否决：回执体 `buildCardReplyBody(summary,…)` 与预览闸门语义都以 summary 为搭档过目的人类可读摘要；字段别名会永久双 schema（两套形状并存、契约漂移）。派工验收明确「无效不被放开」。
- **契约工具文本加「缺 summary 会静默失败」警示** — 否决：契约示例已含正确形状、speak description 已强制「写卡前必调」，告知层无缺陷（§4 线索 4 证伪）；prompt 行为语义改动须跑锚点重放评审，成本与边际收益不匹配。机械反馈闸（本 PR）才是治本——它让任何形状错误**当场可见**。
- **安全类拒绝（伪造 source/节流/已关闭/已回复）也给反馈** — 否决：安全拒绝必须 fail-closed 静默；给反馈等于给脚本开注册表状态侧信道 + 骚扰面（派工验收「安全/伪造 source 仍 fail-closed」）。
- **每卡只反馈一次** — 否决：toast 存活仅 2.5s，错过即永久静默，重复点击又「无反应」= 复活原 bug；3s 冷却既不与下一条叠影，又允许重试再提示，脚本骚扰上界 1 条/3s/卡。

## 8. 验证

### 失败用例证据（bugfix，troubleshooting 步骤 5a 固化——先失败后修复）

**修复前（同一测试，未改断言）**：

- 单测 `npx vitest run src/pages/conversation/hooks/useCardBridge.test.tsx`（worktree web/）：
  `Test Files 1 failed` · `Tests 3 failed | 19 passed (22)`
  - `缺 summary 的现场 payload → 反馈 toast + 仍无预览`：`AssertionError: expected "vi.fn()" to be called with arguments: [ StringContaining "卡片提交被拒绝", 'error' ]`
  - `反馈节流（per-card 3s）…`：`expected "vi.fn()" to be called 1 times, but got 0 times`
  - `超限 summary 同样反馈（不静默）`：同上 toHaveBeenCalled 失败
- 真实浏览器 `E2E_BASE_URL=http://localhost:3116 npx playwright test e2e/input-fixed-split-visual.spec.ts --grep "F20261109csvfx.*9"`（vite dev 隔离实例）：用例 9 失败于 `expect(getByText('卡片提交被拒绝')).toBeVisible()`（element not found）；**其前的断言全部通过**——`父页应收到 card:submit` PASS（探针捕获 `payload:{choice:'persistent-queue',label:'按根治方案实施'}`）、`预览 toBeHidden` PASS、`consoleErrors: []`。
- 复现步骤：①worktree web/ 起 `npx vite --port 3116 --strictPort`；②`E2E_BASE_URL=http://localhost:3116 npx playwright test e2e/input-fixed-split-visual.spec.ts --grep F20261109csvfx`。修复前现象截图/JSON：对话工作区 `csvf-evidence/csvf-1-before-fix.png`、`csvf-evidence-before-fix.json`（`phase: before-fix, feedbackVisible: false`）。

### 修复后对照

- 单测同命令：`Tests 22 passed (22)`（17 既有 + 5 新增，既有断言未改）。
- e2e 同命令（全文件）：`13 passed`——用例 9 反馈可见 PASS、用例 10 合法 payload 预览→确认→回执 PASS、既有 F20261016pcov 用例 7/8（合法 payload hit-test + 发送/拒绝）PASS、其余 6 个既有用例 PASS。
- 真实浏览器修复后证据：`csvf-evidence-after-fix.json`（`phase: after-fix, feedbackVisible: true`，与修复前**同一按钮同一 payload**）、`csvf-2-after-fix-toast.png`（toast「卡片提交被拒绝（summary 不能为空），请让水獭按契约重发卡片」在屏 + 预览不出现）。
- 关键元素 rect（before/after 同值，点击输入一致）：card `{x:318,y:344,w:483,h:180}`、iframe `{x:319,y:375,w:481,h:123}`（>100 展开态）、glass `{x:253,y:567,w:742,h:99}`、viewport `1280x720`。

### 全量与门禁

- web 全量 `npx vitest run`：`83 passed (83 files) · 851 passed`。
- `npx tsc --noEmit`（web）：0 错；根 `npm run lint`（eslint）：0 警告；`npm run build`（web tsc+vite）：成功。
- **pre-existing 声明（带证据）**：根 `npx vitest run` 有 1 失败 `tests/frameworks/agent/durable-runtime.test.ts > reopens after a real process SIGKILL…`——`git stash -u` 后 origin/main（8e562834）基线复跑**同样失败**（`1 failed | 13 passed`），与本 PR 无关（本 PR 仅动 web/ 三文件，不触 tests/frameworks）。
- **最简实现检查（已过）**：复用既有 toast 通道 + 既有节流模式，src 净增 17 行；无新依赖、无新组件、无新 API。阶梯：仓库已有实现（showToast + Map 节流）→ 未需 stdlib/新代码之外的建设。

### 验收标准（断言化）

| 场景 | 操作 | 预期结果 | 判据 |
|---|---|---|---|
| 无效 payload（缺 summary） | 真实浏览器点卡内按钮 | toast「卡片提交被拒绝」出现；预览不出现 | e2e 用例 9 `toBeVisible/toBeHidden` PASS |
| 合法 payload | 卡内 `otterCard.submit({summary,data})` | 预览出现→确认→回执 POST 含 `html-card-reply` | e2e 用例 10 PASS |
| 伪造 source / cardId 冒充 | registry 外 window 发 submit | 零反馈、零预览 | 单测「伪造 source…仍静默」PASS |
| 超限 summary / data | 501 字符 / 3KB payload | 拒绝 + 反馈，预览不出现 | 单测「超限 summary 同样反馈」+ 既有超限用例 PASS |
| 反馈节流 | 3s 内重复无效提交 | 仅 1 条 toast，越窗恢复，闸门恒不开 | 单测「反馈节流」PASS |
| 已回复卡 | 回执覆盖后再提交 | 零反馈（闸门语义不变） | 单测「已回复卡仍静默」PASS |

## 9. 风险与回滚

- **风险**：①恶意卡可用无效 payload 产生 ≤1 toast/3s/卡 的提示（有界；对照：既有「请先处理当前待确认的卡片提交」提示在 200ms submit 节流下上界 5/s，本反馈更窄）；②文案含静态 `validation.error`，无用户可控拼接。风险接受权归人。
- **回滚**：单 commit revert（`git revert`，核心改动仅 `useCardBridge.ts` 17 行）即回静默行为；无持久化、无迁移、无配置残留。
