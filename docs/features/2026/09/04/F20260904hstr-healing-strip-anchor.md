---
id: F20260904hstr
title: healing 报告剥离正则误吞正文：锚定协议块开头标记修复
summary: 正文提及 healing 标签字样的消息被 stripHealingReport 整段剥离入库（正文+卡片丢失）。修复：parse/strip 正则锚定 [issues]/[no_issue] 开头标记，删除反引号反向归一化，补防吞测试。
change_type: fix
capability_test: "n/a: 纯解析器单元测试覆盖（tests/usecases/healing/healing-report-parser.test.ts 26 用例）"
created_in_conversation: de5bcf98-7a4b-4e2e-9475-835359da0bd7
tags: [healing, parser, regression, speak]
modules:
  - src/usecases/healing/healing-report-parser.ts
  - tests/usecases/healing/healing-report-parser.test.ts
created_at: 2026-09-04
---

# healing 报告剥离正则误吞正文：锚定协议块开头标记修复

## 背景

2026-09-04 对话现场：大獭发言正文提及自愈协议（溯源行含行内代码引用 healing 标签字样），UI 上正文被截断只剩溯源行前半段。查证 DB 确认**消息入库时即被剥离**，非 UI 渲染问题——本对话 seq=2 消息正文 + HTML 卡片全部丢失。

用户目击两次（同对话内第二次现场），确认是系统性缺陷而非偶发。

## 根因

`src/usecases/healing/healing-report-parser.ts` 两处缺陷叠加：

1. **stripHealingReport 误吞**：旧正则 `<healing>[\s\S]*?</healing>` 从正文**首次出现的标签字样**起非贪婪匹配到文末闭合。正文引用标签名（聊自愈系统必然提及）即触发，中间所有正文被剥掉。调用链：healing-tools.ts:16（speak 工具入库前清洗）。
2. **parseHealingReport 反引号归一化加重触发**：`.replace(/`<healing>`/gi, '<healing>')` 把行内代码引用反向还原成裸标签参与匹配——LLM 按规范用反引号引用协议名也照样触发。该行本意是容忍 LLM 打标记时手滑加反引号，代价是正文引用变成地雷。

巧合：被吞区间恰好含 no_issue 字样，解析返回空，未产生脏 healing_events 数据。

## 修复

协议规定真正的报告块开头必然紧跟 `[issues]` 或 `[no_issue]` 标记——以此为锚：

- **parseHealingReport**：匹配正则改为 `<healing>\s*\[(issues|no.?issues?)\]([\s\S]*?)<\/healing>`，只认协议块；删除反引号反向归一化（反引号包裹 = 正文引用，不是报告）；`[issues]` 缺 `[/issues]` 闭合视为残缺块不解析
- **stripHealingReport**：同样锚定开头标记，只剥协议块
- 保留：转义归一化（`\<` → `<`，LLM 手滑加转义仍能解析）、大小写不敏感、`[no issue]` 空格变体

## 测试

26 用例全绿（原 19 + 新 7）：

- 新增：正文裸写标签字样不触发 / 正文引用+文末真块只解析真块 / 残缺块（缺 `[/issues]`）不解析 / strip 对应三场景 + `[no issue]` 变体剥离
- 修改：原「handles backtick-wrapped tags」测试意图翻转——反引号包裹现在明确**不**作为报告处理（原测试锁的是被删的归一化行为）
- 全量 healing 相关 77 用例（4 文件）无回归

## 影响

- 修复后正文可自由提及协议标签名（含行内代码引用），不再丢内容
- 行为变化：反引号包裹的报告块不再被解析——按协议正确格式（裸标签）打报告不受影响
- 本对话是高频触发场景（聊自愈系统必然提及标签），修复具即时价值

## 验证

- `npx vitest run tests/usecases/healing/healing-report-parser.test.ts` → 26 passed
- `npx vitest run tests/usecases/healing/ tests/interface-adapters/speak-tool.test.ts` → 77 passed
- 已过最简检查：零新增依赖、改动限于一个解析器文件 + 测试，无更简实现空间（锚定标记是协议语义的最小修复）
