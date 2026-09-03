---
id: F20260903caramel
title: "palette 扩 CARAMEL-700 深阶 token：regressed 严重档色对齐观澜 §3.4"
summary: CARAMEL 阶补 700（#6B4924）补齐「严重/回退」深档，palette.ts 与 globals.css 双源同步；regressed 回卷弧、CHAIN_STATE_META 色义、筛选 chip 文本色升 700，ChainDetailDrawer 三个失效 class（caramel-50/100/700 无定义）全部修复（大獭拍板：浅底档搭同 PR 顺手补齐）。
created: 2026-09-02
created_in_conversation: 7c6e78b5-6fdc-462e-9383-4d96cf95dcd7
change_type: fix
modules:
  - web/src/pages/health
  - web/src/styles
tags:
  - health
  - design-token
  - swimlane
  - ui
status: final
capability_test: "n/a: 纯视觉 token 改动，无 LLM 行为变化；色值锁定由既有单元测试断言（SwimlaneTimeline.test.tsx），并附 mock 数据视觉截图验证（DOM stroke=#6B4924 取证）"
intent:
  problem: "n/a——本改动是纯视觉 token 对齐，不涉及 LLM 行为、prompt 或 agent 能力，无 intent 验证可做。理由：色值是设计纪律的确定性映射（观澜 §3.4 色彩语义表），正确性由单元测试断言 + 视觉截图覆盖，不存在概率性行为。"
  expected_effect: "「严重/回退」类元素统一用 caramel-700 深档，跨文档色值 gap 消除；regressed 与 stalled 的视觉层级拉开（700 vs 500），与四态严重度排序（regressed 最高）一致"
  verify_by:
    type: capability_test
  effect_window: 0d
---

# palette 扩 CARAMEL-700 深阶 token（Issue #691）

## 背景与动机

观澜视觉方案 §3.4 色彩语义表规定「严重 / 复发 / 回退」用 `caramel-700`（深阶），但 palette 的 CARAMEL 阶只造到 600。PR #687（F20260901swim）实现 regressed 回卷标记时以 CARAMEL[600]（#8F6234）近似，留下跨文档色值 gap（issue #691 跟踪）。

大獭已拍板：**直接补 CARAMEL[700] 数值阶，不新增 danger 语义 token**——避免「什么算 danger」的归类争论。

## 色值推算

视觉方案未给 700 的 hex，按 CARAMEL 现有梯度外推并复核两阶趋势：

| 阶 | hex | 亮度(L*近似) | 相邻步长 |
|---|---|---|---|
| 300 | #E8B98E | 高 | — |
| 400 | #D9A57B | ↑ | ΔR-15 ΔG-20 ΔB-19 |
| 500 | #C9956B | ↑ | ΔR-16 ΔG-16 ΔB-16 |
| 600 | #8F6234 | ↓ | ΔR-58 ΔG-51 ΔB-55（进入深档步长跳大） |
| **700** | **#6B4924** | ↓↓ | ΔR-36 ΔG-25 ΔB-16（保持 600 的深档步长量级，偏暖不减） |

- 深档（600→700）步长显著大于浅档（300→500），这是 600 已经建立的既有趋势；
- 700 保持「R 降最多、B 降最少」的暖棕色相偏移，与 600→700 的 caramel 语义（越深越接近烘焦色）一致；
- 对白底对比度实测 8.07:1（600 为 5.30:1，WCAG 复算验证），满足「深阶警示可读性」（初稿声称 8.2:1/6.3:1 为估算值，检视纠正）。

## 方案

**token 定义（双源同步，两处都要加）**：

1. `web/src/pages/health/palette.ts` — `CARAMEL` 常量补 `700: '#6B4924'`
2. `web/src/styles/globals.css` — `@theme` 补 `--color-caramel-700` 变量；同 commit 追补浅底档 `--color-caramel-50: #FBF7F4` / `--color-caramel-100: #F7EDE3`（由 300 阶 #E8B98E ≈ HSL(29°,47%,73%) 反向外推：同色相/饱和度、亮度拉到 97%/93% 的浅底，100 档配 text-caramel-700 对比度实测 6.98:1）——修复 ChainDetailDrawer 徽章 `bg-caramel-100/50` 自 #687 起静默失效的问题（大獭拍板搭同 PR 顺手修）

> tailwind v4 的 utility class 由 `@theme` 变量生成：只加 palette.ts 不加 globals.css，`text-caramel-700` 等 class 依然不生成。

**消费点同步（grep CARAMEL[600] / caramel-600 全量定位后逐个判断）**：

| 落点 | 判断 | 依据 |
|---|---|---|
| SwimlaneTimeline.tsx 回卷弧 stroke（issue 旧标 :159） | **600→700** | §3.2 明确「regressed 线中段 caramel-700 回卷箭头标记」 |
| chain-state-meta.ts `CHAIN_STATE_META.regressed.color` + `className`（旧标 :20） | **600→700** | regressed 是四态严重度最高档，§3.4「严重/回退」；文本色（筛选 chip）与图表色同步升，色义锁定 |
| SwimlaneTimeline.test.tsx 回卷弧断言（旧标 :100） | 同步 700 | 测试跟随实现；it 标题本就写着「caramel-700 深阶」（当时降级实现的遗留标记） |
| SwimlaneTimeline.test.tsx meta 色断言（旧标 :201） | 同步 700 | 同上 |
| RecurrenceCard bug 节点/徽章（CARAMEL[600]×3） | **不动** | §3.4 :118 明确复发卡徽章用 caramel-600 实心；「注意/中度热」档 |
| index.tsx:204 复发分区 ShieldAlert 图标 caramel-600 | **不动** | 分区标题图标是装饰性「注意」语义，非严重档元素 |
| StalledTail 旁注 fill CARAMEL[600] | **不动** | stalled 属「注意/停滞」档（§3.4 :184），且 stalled 的图表色是 CARAMEL[500]，旁注深一阶是既有层级设计 |
| 分类系列色 `CARAMEL[600]`（palette SERIES） | **不动** | 分类色槽位，与严重度语义无关 |

**行号漂移说明（issue 落点 vs 实际）**：issue 列的 5 处是 #687 时代标的；#720 四态迁移后实定位为——回卷弧 :151（原 :159）、弧标 fill 已不存在（原 :184，#720 后回卷弧 `fill="none"` 纯描边）、meta :23、测试 :94/:195。grep 全量复核后实际落点数与 issue 一致（5 处代码落点），无增减，但另发现 globals.css 这个 issue 未列出的 token 定义源（见 Discovered Issues）。

## 影响范围

- 视觉：regressed 回卷弧、泳道/筛选 chip 的「回退」文本色、抽屉 regressed 徽章文本色加深（#8F6234 → #6B4924）
- 无数据/接口/行为变化；无新增依赖
- globals.css 补变量后，ChainDetailDrawer 中三个原本静默失效的 class（`bg-caramel-100`/`bg-caramel-50`/`text-caramel-700`）开始生效——徽章背景色首次真正渲染（见 Discovered Issues #1）

## 取舍

- **补数值阶 vs 新增 danger 语义 token**：选前者（大獭拍板）。danger 语义 token 的收益是「语义不依赖色相」，但引入「哪些信号算 danger」的归类争论，且现有四态体系下 regressed 是唯一严重档，语义映射清晰
- **700 不入 SERIES 分类色**：分类色 8 槽已稳定，700 是严重度专用档，混入会破坏「跨图表色义锁定」

## 验证

- 单元测试：web 全套 `npm test` 46 文件 / 389 用例全绿（含更新后的 2 处色值断言；浅底档追补 commit 复跑仍全绿）
- 类型检查：`tsc --noEmit` 0 error
- 视觉验证：mock 数据（独立端口 5273 vite + 3001 mock API，验证后进程自灭）造一条 regressed 链，截图确认泳道回卷弧渲染、DOM 取证 `path.swim-regressed-mark` stroke = `#6B4924`（精确匹配 CARAMEL[700]）；浅底档复验：打开链详情抽屉，「质量回退」徽章 computedStyle bg=`rgb(247,237,227)`（caramel-100）+ color=`rgb(107,73,36)`（caramel-700），浅底深字完整生效
- 自检基线：改动前主仓同套测试既有基线（46/389 全绿），无 pre-existing 声明，无需 stash 复跑

## 后续

- 视觉方案 §3.4 的「bug_recurrence 卡徽章归 700 档」与 :118「复发卡徽章 caramel-600 实心」存在文档内矛盾——本 PR 按 :118 实现维持 600，矛盾交 issue 跟踪（见 PR Discovered Issues）
