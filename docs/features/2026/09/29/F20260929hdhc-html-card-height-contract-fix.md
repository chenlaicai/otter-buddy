---
id: F20260929hdhc
title: html-card 高度契约纠偏：data-height 语义从「预估内容高度」改为「首帧临时高度，宁小勿大」
summary: "实测当日 10/10 张 html-card 的 data-height 系统性高估内容真实高度（最大浪费 497px），根因是契约措辞诱发「宁可多留」的保守写法。本改动只调 prompt 注入面措辞：data-height 明确为首帧临时高度（ResizeObserver 自动回正），按内容下限写、估不准不写。不动渲染机制。"
change_type: prompt
capability_test: "n/a: 纯契约/prompt 措辞纠偏，无代码行为变更；渲染机制（HtmlCard.tsx clamp + card-bridge ResizeObserver 回正）本身未动"
created: 2026-09-29
created_in_conversation: 80128ebf-52ed-4c98-8e0a-2f804cb1bcbf
intent:
  trigger: "搭档指令：动手（2026-09-29 10:01，指 html-card 底部空白排查后的契约纠偏方案）"
  purpose: 消除 html-card 底部大面积空白——实测 10/10 卡 data-height 系统性高估，把契约措辞从「内容多时应显式调高」纠偏为「首帧语义 + 单向棘轮警示 + 宁小勿大」
modules:
  - src/interface-adapters/agent-runtime/tools/html-card-contract-tool.ts
  - .pi/skills/review-protocol/references/templates/decision-briefing-card.md
  - .pi/skills/visual-design/references/web/toolchain.md
from:
  - F20260916hcel
tags:
  - html-card
  - prompt-contract
---

# html-card 高度契约纠偏

## 背景与实证

搭档反馈「页面最下方老有一大截空白」。排查（troubleshooting 流程，预注册方向命中）确认是高度契约问题，不是渲染 bug：

- **机制**：iframe 初始高度取 `data-height` 声明值（缺省 240px，clamp [100,4000]，HtmlCard.tsx:57-63）；獭发的卡注入桥脚本后 ResizeObserver 会上报 `max(body.scrollHeight, documentElement.scrollHeight)`（card-bridge.ts:11-24 → useCardBridge.ts:102-110）。**关键语义：回正是单向棘轮（只涨不缩）**——iframe 处于声明高度时 `documentElement.scrollHeight ≥ clientHeight`，上报值恒 ≥ 当前高度，高度收敛到 `max(声明值, 内容高度)`：**写大的部分永久残留为底部空白**（直到页面刷新），写小/省略则自动撑高到精确内容高度。检视方仿真实验复核（`/tmp/otter-review-correction.mjs` 可复跑）：d3503a87 声明起步残留 336px vs 240 起步精确回正；cd5acb2c 残留 214px vs 精确回正；e9d6bf00 残留 6px vs 精确回正。
- **实证**（2026-09-29 当日全量 10 张卡，headless Chromium 实测渲染高度）：

| 卡 | data-height | 实测 | 浪费 |
|---|---|---|---|
| e9d6bf00 保真图 | 860 | 830 | 30 |
| d3503a87 AI 雷达 | 3400 | 2903 | **497** |
| cd5acb2c | 560 | 317 | 243 |
| 8c2425a2 | 1500 | 1421 | 79 |
| 9f4b59a6 | 520 | 389 | 131 |
| 4943ca58 | 720 | 520 | 200 |
| 69a70e53 终审卡 | 1250 | 1137 | 113 |
| b998682c | 640 | 611 | 29 |
| 92b98a2b:0 | 980 | 769 | 211 |
| 92b98a2b:1 | 1500 | 1302 | 198 |

**10/10 系统性高估**——契约旧措辞「内容多时应显式调高」（decision-briefing-card.md）直接诱发「宁可多留」的保守写法，空白量与卡片大小正相关。

## 改动内容（修法决策树①：既有机制语义内补 prompt 约束，narrow-fix）

渲染机制不动，只改注入面措辞：

1. **html-card-contract-tool.ts**（獭写卡前必读的契约本体）：
   - 语法骨架段：补充机制准确语义「ResizeObserver 自动撑高到内容真实高度，但回正是单向棘轮（只涨不缩）——写大的部分永久残留为底部空白」；加「宁小勿大」警示（附实测数据，强调空白不会自己消失）；「估不准就不写（240px 起步会自动撑到精确高度）」。
   - 高度自适应 API 段：静态声明段同步补单向棘轮语义 + 「按内容预估下限写，宁小勿大」。
2. **decision-briefing-card.md**：模板第 6 条从「内容多时应显式调高」反转为「按内容下限声明，单向棘轮写大永久残留，估不准就不写」；自检清单末条从「内容多时已调高度？」改为「按下限写的还是合理省略了？」。
3. **toolchain.md**（visual-design 卡工具链）：高度声明首选省略，要控制首帧才按下限写。

不改：`BIG_OTTER.md` 黑话翻译表第 139 行（用户向的人话解释，非獭写卡指令，当前措辞未诱发高估）。

## 影响范围

- 仅 prompt 注入面文本，无运行时行为变更；存量卡不受影响（历史消息的 data-height 已固化）。
- 预期效果：新卡的声明高度回归内容真实高度附近，底部空白消失；写小的代价仅展开瞬间一次自动回正。

## 取舍

- **否掉方案 B（机制层：父页 load 后主动测量/双向回正）**：能让写大的卡也缩回，但要动渲染管线（涉及 srcdoc 跨域测量或桥脚本语义变更），而契约措辞纠偏后「写大」路径已被「宁小勿大+永久残留警示」封堵——收益边际，过度设计。若未来实测发现措辞纠偏后仍有高估惯性，可重启本方案。
- 措辞里保留实测数据（「10/10 高估，最大 497px」）是有意为之：给写卡獭具体数字锚点比抽象规则更有约束力。

## Verification

- bugfix 证据链：修复前实测数据见上表（10 张卡全量高估，脚本 `/tmp/otter-height-final.mjs` 可复跑）；修复后为 prompt 措辞，无运行时断言可测——验证方式为下次出卡观察声明值是否回归下限。
- `npx tsc --noEmit` 通过（契约文本嵌在 TS 模板字符串中，确认语法未破坏）。
- Golden Gate: n/a——纯 prompt 措辞纠偏无新增 golden 场景；CI golden-selftest 通过（run 36511121581），无 per-PR 门控记录属设计内状态。
