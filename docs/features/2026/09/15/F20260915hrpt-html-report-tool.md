---
id: F20260915hrpt
title: html-report 工具：议题汇报卡基建
change_type: feature
created: 2026-09-15
created_in_conversation: ee07dc1b-b195-4595-9b53-d927ec020f97
summary: 新增 html-report 议题汇报卡类型（64KB/1张/默认展开），支持完整议题汇报文档（问题/根因/方案/选项对比），配套 get_html_report_contract 工具和模型路由机制
modules:
  - api-contract/api/html-card.ts
  - src/interface-adapters/agent-runtime/tools/tool-helpers.ts
  - src/interface-adapters/agent-runtime/tools/html-report-contract-tool.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/frameworks/agent/session-helpers.ts
  - src/frameworks/agent/tool-builder.ts
  - src/frameworks/llm/model-pool.ts
  - src/usecases/ports/agent-tools.ts
  - src/usecases/ports/model-pool-like.ts
  - src/entities/conversation/message-body-projection.ts
  - web/src/lib/html-card.ts
  - web/src/lib/remark-html-card-index.ts
  - web/src/pages/conversation/HtmlCard.tsx
  - web/src/pages/conversation/MessageList.tsx
from: []
supersedes: []
intent:
  problem: "现有 html-card 8KB/2 张/默认折叠的限制，装不下「议题汇报文档」（问题/根因/方案/选项对比完整链路），导致大獭向搭档汇报时只能给碎片化小卡或纯文字，搭档需要的信息密度无法承载"
  expected_effect: "新增 html-report 工具，单卡 64KB、单消息 1 张、默认展开 3 秒层；maxTokens<131072 的模型自动降级 html-card；大獭可向搭档交付完整议题汇报文档"
  verify_by:
    type: capability_test
capability_test: tests/interface-adapters/html-report-validation.test.ts
---

# html-report 工具：议题汇报卡基建

## 背景

2026-09-15 搭档反馈：「说人话版本」反复看不懂（19 条「说人话」命中里搭档发 7 条全是求救），根因是**信息无分层 + 形式无契约**。搭档明确要的是「给领导汇报方案」那种**完整文档**：有图有表、有层次（3 秒/30 秒/完整版）、问题/根因/方案/选项齐全。

搭档拍板决策：
1. 默认展开（既然不会卡）
2. 体积上限 64KB，不够再加
3. html-report 作为**独立工具**使用（不嵌入 speak 描述），工具里写清约束由 LLM 自行判断
4. 先 PR1 基建再 PR2 规范

## 方案设计

### 新增 html-report 工具（与 html-card 并行不取代）

| 维度 | html-card | html-report |
|---|---|---|
| 体积上限 | 8 KB | **64 KB** |
| 单消息卡数 | 2 张 | **1 张** |
| 默认状态 | 折叠 | **展开** |
| 初始高度 | 240px | **600px**（clamp 4000px） |
| 用途 | 日常小卡、状态徽章 | 议题汇报、方案对比、复盘报告 |
| 模型路由 | 无 | **maxTokens<131072 自动降级 html-card** |

### 围栏语法

````
```html-report title="议题：XXX"
[3 秒层]
[30 秒层]
[完整版]
```
````

### 三层结构

- **3 秒层（执行摘要）**：问题一句话 + 推荐一句话 + 要搭档做什么
- **30 秒层（关键信息）**：问题/根因/方案/选项对比表 + 我的推荐
- **完整版（细节）**：案发现场/被否方案/风险/锚点，默认 `<details>` 折叠

### 模型路由策略

在 speak 工具校验层：生成 html-report 时查当前模型 maxTokens——
- < 131072 → 返回错误提示「当前模型输出预算不足，建议切换 K3/GLM-5/MiMo」，LLM 自行降级 html-card
- ≥ 131072 → 正常通过

## 改动范围

- `api-contract/api/html-card.ts`：新增 `HTML_REPORT_*` 常量（体积/张数/高度）
- `src/interface-adapters/agent-runtime/tools/tool-helpers.ts`：新增 `validateHtmlReport()` 校验函数
- `src/interface-adapters/agent-runtime/tools/html-card-contract-tool.ts`：新增 `get_html_report_contract` 工具描述
- `src/interface-adapters/agent-runtime/tools/tool-factory.ts`：注册新工具
- `web/src/lib/html-card.ts`：扩展围栏识别支持 html-report
- `web/src/lib/remark-html-card-index.ts`：同上
- `web/src/pages/conversation/HtmlCard.tsx`：支持 html-report 渲染（默认展开、不同徽标）
- `web/src/pages/conversation/MessageList.tsx`：识别 html-report 围栏走 HtmlCard

## 测试

- 单测：html-report 围栏解析、字节校验、单消息 1 张限制、模型路由降级
- 能力测试：golden gate 跑 prompt 层

## 非目标

- ❌ 不动现有 html-card 限制
- ❌ 不做多页 PPT 翻页
- ❌ 不改 CSP/sandbox 安全边界
- ❌ 不做图片上传/CDN
- ❌ 不做「自动检测议题类型套模板」——PR2 规范层的事

## 验证

（实现完成后填）

## 后续

- PR2：决策简报三层改造（decision-briefing.md 重写 + BIG_OTTER/SMALL_OTTER 触发条件 + 模板库）

## 验证

### 测试结果
- TypeScript 编译：✅ 通过
- ESLint 检查：✅ 通过（仅存量 warnings）
- 单元测试：✅ 68 tests passed
- 围栏解析测试：✅ 通过
- 字节校验测试（64KB）：✅ 通过
- 模型路由测试（maxTokens≥131072）：✅ 通过
- 契约工具测试：✅ 通过
- 消息投影测试：✅ 通过

### 最简实现检查
已过最简检查：本方案需要同时修改前后端，且需要新增工具注册、模型路由、消息投影等多处改动，无法用更少代码/文件达成同等效果。

### 截图证据
无视觉变更（本次改动为基础设施层，不涉及 UI 样式变更）。

### PR 链接
https://github.com/chenlaicai/otter-buddy/pull/955
