---
id: F20260825hcpg
title: html-card 主动引导归位与体积预算扩容
summary: |
  海獭呼叫用户时几乎总用 md、卡片不出的两层根因修复：①正向判断标准在 F20260728htar 历次压缩中失传（只移出未移入），本次归位 speak description（场景锚+正文卡片搭配+反例）；②单卡 4KB 中文实容仅 ~1300 汉字，扩到 8KB，CARD_MAX_BYTES 落位 api-contract 单一真相源。多獭讨论裁决（kimi/mimo/大獭）：单点归位不加 SYSTEM.md 副锚（工具 description 每请求注入，pi-ai 源码验证）、场景锚+反例划界、不搞频控、不加 magic word。
change_type: prompt
status: implemented
tags: [html-card, speak, tool-description, prompt, llm-behavior]
modules:
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/interface-adapters/agent-runtime/tools/html-card-contract-tool.ts
  - api-contract/api/html-card.ts
  - web/src/lib/html-card.ts
  - web/src/pages/conversation/HtmlCard.tsx
from: [F20260728htar, F20260810ka23, F20260804hcob]
supersedes: []
capability_test: tests/capability/html-card-proactive.capability.test.ts
created_in_conversation: 096693e2-e3f2-4a19-b2cd-640ae6ca132a
---

# html-card 主动引导归位与体积预算扩容

## 背景

搭档反馈：html-card 机制完备，但海獭呼叫用户时几乎总用 md，方案展示/设计思路等场景卡片不出。多獭讨论（kimi 架构视角 / mimo 行为机制视角 / 大獭裁决）定位两层根因：

1. **正向引导失传**：F20260728htar L81 原设计 speak description 含判断标准（可独立交付物 / 结构化明显增益 / 用户可能迭代导出；反例：短回答、代码片段、简单列表），在历次 description 压缩中丢失，references/html-card-rules.md 从未创建（F20260810 Part B 的拆分只做了"移出"未做"移入"）。现存文案全是防御性 GOTCHA，零正向激励。
2. **体积预算过紧**：单卡 4KB 是 LLM 单次响应 max output tokens 内的生成安全预算（超限→截断→重试→整段生成两遍），但按 UTF-8 字节计，中文每字 3 字节，4KB 实容 ~1300 汉字，扣除样式结构后内容容量过低，抑制出卡意愿。

## 决策记录（多獭讨论裁决）

| 分歧 | kimi | mimo | 终裁（大獭） | 依据 |
|------|------|------|------|------|
| 引导位置 | speak description 单点 | SYSTEM.md 副锚 | **speak description 单点，不加副锚** | mimo 前提「description 非每回合必达」经 pi-ai 源码验证不成立：工具 description 随每次 LLM 请求 tools 参数全量注入（anthropic-messages.js:755 params.tools / :995 convertTools），决策时刻已在上下文中 |
| 触发表述 | 抽象标准+场景示例 | 场景白名单 | **场景锚+反例划界**（后经 mimo 修正达成共识：白名单退化成字面匹配） | LLM 分类判断可靠，概率判断不可靠 |
| 频控 | 反例即频控 | 撤回频控主张 | **一句话点破**：「每条都出卡等于没出卡」 | 机械计数规则 LLM 执行差 |
| magic word 纠偏 | 不加 | 倾向回执反馈 | **不加** | 即时会话指令响应已够，避免关键词通胀 |
| 防拆分重演 | — | 版本注释 | **代码注释**（非 description 内注释） | description 内 HTML 注释白耗 token |

## 变更

### 变更 1：speak description 正向引导归位（tool-factory.ts）

新增 TIP 段（+~140 字符，总 641 / 上限 800）：

> TIP: 面向搭档的方案对比、设计思路、排查结论、结构化数据——正文先写 1-2 句结论，html-card 卡片放结构化详情，搭档更直观；短问答、代码片段、简单列表用 md。每条都出卡等于没出卡。

设计意图：
- **场景锚**（方案对比/设计思路/排查结论/结构化数据）做决策锚点，覆盖 F20260728 原判断标准的主要面
- **正文+卡片搭配**（正文 1-2 句结论）解决折叠态首屏只有标题的体验问题——搭档先看到结论，想深入再展开
- **反例**（短问答/代码片段/简单列表用 md）+「每条都出卡等于没出卡」防矫枉过正，对齐 F20260724「非每次都出」验收意图
- 同时补齐 F20260810 五元素结构中 speak description 缺失的 When 元素
- 代码注释标注历史（F20260728htar L81 失传归位）+ 勿再移出警告（含 pi-ai 注入机制依据），防拆分模式重演

### 变更 2：体积预算 4KB→8KB

- `api-contract/api/html-card.ts`：`CARD_MAX_BYTES` 落位单一真相源（对齐 Issue #360 的 `CARD_MAX_PER_MESSAGE` 模式），值 4096→8192
- `web/src/lib/html-card.ts`：本地常量改为从 `@contract/api/html-card` 转发（消除双源）
- `HtmlCard.tsx`：超限徽章文案插值绑定 `CARD_MAX_BYTES / 1024`（消硬编码）
- `html-card-contract-tool.ts`：契约文案两处改为常量插值（文案与常量无法再漂移）
- speak description 内 ≤8KB 同步更新

扩容依据：2 卡 × 8KB + 正文 ≈ 6-9K token 输出，在池内模型（kimi/mimo/glm）长输出能力内；真截断由重试机制自愈，代价是慢一拍而非错误。超限无硬拦截（服务端不拒、前端仅提示），预算本质是生成安全线。

### 变更 3：测试

- `web/src/lib/html-card.test.ts`：常量断言 4096→8192
- `tests/interface-adapters/html-card-tool.test.ts`：新增正向判断标准断言（场景锚四关键词 / 正文先写 / 用 md / 每条都出卡等于没出卡）——原测试声称覆盖"判断标准"但未断言（失传旁证），本次补齐

## 验收标准

- [x] 自动化：vitest 全绿（speak-tool 37 + html-card-tool 12 + web html-card 11），tsc 无错
- [x] description 641 字符 ≤ 800 上限
- [x] **能力测试（真系统 + 真 LLM，mimo-v2.5-pro）**：`html-card-proactive.capability.test.ts` 方案对比场景 3 次采样 2 次主动出卡（#1/#2 均为「正文 1-2 句结论 + ` ```html-card ` 卡片放详情」搭配，正是引导文案教的写法；#3 用 md 表格未出卡——符合「非每次都出」健康口径）。证明正向引导归位真实改变了 LLM 行为（从「几乎不出卡」→「方案场景 2/3 出卡」）
- [ ] 人工：后续 1-2 周观察海獭在方案/对比类请求下自主出卡率（沿用 F20260724 验收口径）
- [ ] 若引导后仍不出卡，评估 mimo 备选方案（SYSTEM.md 分层锚）

## 已知限制

- 8KB 预算对超长中文内容（>2600 汉字）仍需拆卡或分次 speak——这是生成安全约束，非存储限制
- 各模型 max output tokens 具体上限未逐一核实（8KB 是安全估计，非实测边界）
