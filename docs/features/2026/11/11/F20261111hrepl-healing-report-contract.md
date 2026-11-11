---
id: F20261111hrepl
title: healing 模型可见协议与解析契约对齐
summary: 兼容真实 JSON 单对象上报，非法协议块响亮反馈，代码围栏讲解示例不再误落账；统一 SYSTEM 与 speak 工具提示，并显式分类 runtime_status_mismatch。
change_type: fix
capability_test: "n/a: 确定性文本解析、工具回执与仓储调用，由 A 类执行级回归验证，无 LLM 参与"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
created_at: 2026-11-11
intent:
  problem: "生产 speak 使用 JSON 单对象 healing 块时被解析器静默忽略；代码围栏中的合法 YAML 讲解示例反而落账，模型可见示例与生产解析契约相互矛盾。"
  expected_effect: "围栏外 YAML 列表与 JSON 单对象均可控落账并剥离；缺必填字段、闭合标记或 JSON 非法时 speak 返回可操作错误且不创建 entry；围栏内示例保留且零落账；runtime_status_mismatch 归入环境侧。"
  verify_by:
    type: behavior_check
causal_links:
  - F20260904hstr
  - F20261110hjfnx
tags: [healing, parser, speak, error-feedback, regression]
modules:
  - src/usecases/healing/healing-report-parser.ts
  - src/interface-adapters/agent-runtime/tools/healing-tools.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/entities/healing/healing-event.ts
---

# healing 模型可见协议与解析契约对齐

## 问题与预注册

- **X（预期根因）**：解析器只接受 `[issues]` + `- type:` + `[/issues]`，而现场与文档出现 JSON 单对象；解析失败没有 `invalidBlocks` 或工具错误回执，且 strip 不区分代码围栏。
- **Y（成立证据）**：原始消息 `d08860a8-30c2-4578-86b9-711486a51494` 的 JSON 块解析结果为 `hasIssues=false`；讲解示例曾生成 high 事件 `cac5c4e0-7430-4eac-88ab-bf67687ac24c`。
- **Z（反例方向）**：若原始块位于代码围栏内、缺少上报载荷，或仓储已落账，则不应按真实漏报修复。

Issue #1842 的原始消息、解析器实跑与反向误落账事件支持 X。本 PR 只修上报协议与解析链，不扩到原 UI 状态投影问题。

## 设计取舍

### 统一契约

模型可见协议与执行解析统一为两类：

1. 围栏外 `<healing>[issues] ... [/issues]</healing>` YAML-like 列表，保留既有合法行为。
2. 围栏外 `<healing>{"type":"...","description":"..."}</healing>` JSON 单对象，兼容本次真实现场；`severity` 缺省 low，`suggestion` 可选，未知 type 仍归 other。

行内代码与代码围栏都是讲解保护域：其中 YAML/JSON 示例不解析、不剥离；既有精确 `no_issue` 围栏控制块仍按旧契约剥离。围栏关闭必须匹配开栏字符且长度不短于开栏，四反引号嵌套三反引号、波浪围栏内反引号均不会提前退出保护域。正文仅提及 `<healing>` 字样和非协议 JSON 示例不触发上报。

### 候选路径

- **采用：显式双形态兼容 + 非法块原子阻断**。真实 JSON 现场可以落账；任一非法协议块使整个 speak 返回错误，不创建 entry、不调用 `repo.create`、不 enqueue high alert。
- **否决：只改文档，强制 YAML**。能把文档与旧解析器对齐，但本次及后续 JSON 上报仍要靠模型重写，无法直接兼容已发生的形态。
- **否决：接受任意 JSON/数组或任意正文中的 healing 字样**。会把讲解示例和上下文引用重新变成真实事件，扩大误吞与误报面。
- **否决：非法块仍发出正文，只记录日志**。模型看不到失败，会继续误以为已上报，不满足“响亮反馈”。

### 非法块边界

YAML 任一条目缺 `type` / `description` 会使整个块非法（不过滤坏条目后继续落账）；字段只认独立行，值文本中的 `type:` / `description:` 不冒充必填字段。JSON 缺 `type`、合法协议 type 缺 `description`、JSON parse 失败、JSON 数组、缺 `[/issues]` 或缺 `</healing>` 也均返回可操作错误。`stripHealingReport` 直接处理缺 `</healing>` 的文本时仍保留原文，延续防止误吞正文的旧保护；正常 speak 路径会在 strip 前阻断该非法块。

`runtime_status_mismatch` 新增为显式 error type，并列入环境侧分类：它描述 UI/调度状态投影与真实运行态不一致，不归为獭能力退化。其他未知类型维持 other 兜底。

### 机制识别检查点

本期新增一种受控输入兼容形态和一个 error type 枚举，命中“消息格式/枚举”检查点；未新增持久化字段、配置、后台任务、跨模块调用或新生产模块。解析、拦截与 speak 仍沿用既有调用链，因此按既有协议缺陷做 `narrow-fix`，不引入新状态机或通用模板引擎。

代价是模型可见协议保留两种形态，而非单一形态；换来对真实现场的受控兼容。非法块会阻断整条 speak，而不是部分发出，这是一致性优先的有意行为变化。

## 验收标准

| 场景 | 预期结果 |
|---|---|
| 原始 JSON 单对象 | 解析为 `runtime_status_mismatch`，调用 `repo.create`，正文剥离协议块且保留前文 |
| R5 YAML 与 JSON 正例 | 两种形态均执行级解析成功 |
| 行内代码/围栏内 YAML/JSON 示例（含嵌套异型围栏） | 零落账，strip 后示例仍在 |
| 缺 type / description、JSON 数组、非法 JSON | `invalidBlocks` 非空，speak 返回 isError，entry 与 repo.create 均为零 |
| 缺 `[/issues]` 或 `</healing>` | 返回具体闭合错误，不静默忽略 |
| 合法 + 非法块混合 | 整体原子阻断，不发生部分落账 |
| 既有正文引用、no_issue、合法 YAML | 行为不回归 |
| 未知 type / severity | type 归 other，severity 归 low |

## Verification

### 失败用例证据（bugfix）

修复前执行 `npx vitest run tests/usecases/healing/healing-report-parser.test.ts tests/interface-adapters/agent-runtime/tools/healing-intercept.test.ts`：新增现场回归共 **8 failed**（parser 5、intercept 3）。JSON 现场 `hasIssues=false`，围栏 YAML 示例 `hasIssues=true` 且 strip 剥空示例，缺 type 与缺 `[/issues]` 没有 `invalidBlocks`，合法 JSON 的 `repo.create` 调用为 0。

### 验证记录

- 接管后补齐缺 `description`、JSON 数组和缺 `</healing>` 四类边界回归；初轮聚焦套件为 **5 文件、67/67 passed**。
- 独立对抗检视第一轮复现 YAML 必填字段、嵌套围栏与行内代码 3 项严重缺口；新增反例红测 **6 failed** 后修复，并补混合行内示例+真上报、description 反引号与 YAML 原子拦截回归。
- 第二轮 delta 复现值文本字段名绕过：新增 parser 2 条 + speak 1 条红测（**3 failed**）后，字段提取改为行锚定；另补合法多行 description 正向回归。最终聚焦 **5 文件、80/80 passed**。
- 两轮处置后 `npm test`（含 pretest 全量 ESLint）：**460 文件、5920/5920 passed，0 failed，0 skipped**。
- `npm run build` 通过；rebase 最新 `origin/main` 后再次执行聚焦 **67/67 passed** 与 build 通过。
- 存量漏报不做批量补记：历史原文虽可逐个重放，但无法可靠界定所有漏报集合，也不能还原未落账事件的真实台账元数据。本 PR 不伪造历史时间或现场；已知的原 UI 状态问题应另行排查，不借本修复自动制造历史事件。
