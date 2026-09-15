import type { AgentTool } from "@usecases/ports/agent-tools";
import { textResponse } from "@usecases/ports/agent-tools";
import { HTML_REPORT_MAX_BYTES, HTML_REPORT_MAX_PER_MESSAGE, HTML_REPORT_MIN_MAX_TOKENS } from "@contract/api/html-card";

/** html-report 议题汇报卡完整写作契约（F20260915hrpt）。
 * 按需披露：speak description 只带最小骨架，写汇报卡前必须调本工具取回完整契约。 */
export const HTML_REPORT_CONTRACT = `# 议题汇报卡（html-report）写作契约

⚠️ **硬性限制**：单卡 ≤${HTML_REPORT_MAX_BYTES / 1024}KB，单消息最多 ${HTML_REPORT_MAX_PER_MESSAGE} 张。需要 maxTokens ≥ ${HTML_REPORT_MIN_MAX_TOKENS} 的模型（K3/GLM-5/MiMo）。

## 语法骨架

\`\`\`html-report title="议题：XXX · 等你拍板"
<!-- 自包含 HTML 片段：内联 <style> + 结构 + 内联 <script>（可选） -->
\`\`\`

- title 属性必填，用双引号；用户看到的是报告标题
- 【强制】围栏必须完整写进 speak 的 body 参数：写在 speak 之外的不会进入消息

## 三层结构

### 3 秒层（执行摘要，默认展开）
\`\`\`html
<section class="executive-summary">
  <h2>一句话结论</h2>
  <p>要搭档做什么（拍板/知晓/选择）</p>
</section>
\`\`\`

### 30 秒层（关键信息，默认展开）
\`\`\`html
<section class="key-info">
  <h3>问题是什么</h3>
  <h3>根因分析</h3>
  <h3>方案选项</h3>
  <table class="options-table">...</table>
  <h3>我的推荐 + 理由</h3>
</section>
\`\`\`

### 完整版（细节，默认折叠）
\`\`\`html
<details class="full-details">
  <summary>完整版（案发现场 / 数据 / 被否方案 / 风险）</summary>
  ...
</details>
\`\`\`

## 样式变量

卡片渲染时已注入设计 token，直接用 var() 引用：
- 主色阶（水獭棕）：var(--otter-50) … var(--otter-900)
- 强调色（青）：var(--teal-300)、var(--teal-400)、var(--teal-500)、var(--teal-600)
- 暖色点缀（焦糖）：var(--caramel-400)、var(--caramel-500)
- 冷色点缀（薰衣草）：var(--lavender-400)、var(--lavender-500)
- 语义色：var(--paper)、var(--ink)、var(--ink-3)、var(--line)

## 交互 API（收集用户输入）

\`\`\`js
otterCard.submit({
  summary: '选择了方案 B（沙箱 iframe），预算上限 3 天',  // 人类可读摘要，≤500 字符
  data: { choice: 'B', budget_days: 3 }                  // JSON 序列化 ≤2KB
})
\`\`\`

## 禁用清单

- <a href> 外链
- <meta http-equiv="refresh">
- location.* 赋值、location.reload()
- document.write
- <form action> 指向外部
- 任何外网请求（CSP 阻断）

## 体积预算

${HTML_REPORT_MAX_BYTES / 1024}KB ≈ 21K 汉字。复杂议题可在 30 秒层精简，完整版用折叠区承载细节。
`;

/**
 * get_html_report_contract：返回 html-report 议题汇报卡完整写作契约。
 */
export function createGetHtmlReportContractTool(): AgentTool {
  return {
    name: "get_html_report_contract",
    description: `获取议题汇报卡（html-report）的完整写作契约（三层结构/样式变量/交互 API/禁用清单）. When: 准备写 \`\`\`html-report\`\`\` 议题汇报卡前必须调用（speak description 只含最小骨架，完整规则在本工具返回值里）. Output: 契约全文. GOTCHA: html-report 单卡 ≤${HTML_REPORT_MAX_BYTES / 1024}KB、单消息 ≤${HTML_REPORT_MAX_PER_MESSAGE} 张；写在 speak 之外的不会进入消息.`,
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async () => textResponse(HTML_REPORT_CONTRACT),
  };
}
