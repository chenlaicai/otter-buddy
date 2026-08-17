import type { AgentTool } from "@usecases/ports/agent-tools";
import { textResponse } from "@usecases/ports/agent-tools";

/**
 * HTML 卡片完整写作契约（F20260728htar）。
 * 按需披露：speak description 只带最小骨架，写卡片前必须调本工具取回完整契约。
 * 冷启动设计（每次 invoke 重建 session）下每个写卡回合都要重新调用。
 */
export const HTML_CARD_CONTRACT = `# HTML 卡片写作契约

## 语法骨架

卡片以 CommonMark 围栏块嵌入 speak 的 body，一条消息最多 2 张，单卡 ≤4KB（超限会被截断，可能导致发言损坏重来）：

\`\`\`html-card title="卡片标题"
<!-- 自包含 HTML 片段：内联 <style> + 结构 + 内联 <script>（可选） -->
\`\`\`

- title 属性必填，用双引号；用户看到的是折叠态标题
- 卡片 HTML 内含三反引号时，外层围栏用四个反引号
- 卡片默认折叠，用户点击才展开渲染——首屏信息写进围栏外的正文
- 【强制】围栏必须完整写进 speak 的 body 参数：写在 speak 之外文本里的卡片不会进入消息、搭档看不到，系统会检测并拒绝该次 speak（F20260804hcob）

## 样式变量

卡片渲染时已注入设计 token，直接用 var() 引用，不要自造色值：
- 主色阶（水獭棕，50 最浅 → 900 最深）：var(--otter-50) … var(--otter-900)——浅档做底色/ Hover，中深档做文字与边框
- 强调色（青，300 浅 → 600 深）：var(--teal-300)、var(--teal-400)、var(--teal-500)、var(--teal-600)——主操作、选中态、关键数据
- 暖色点缀（焦糖）：var(--caramel-400)、var(--caramel-500)——警示、次强调
- 冷色点缀（薰衣草）：var(--lavender-400)、var(--lavender-500)——标签、辅助分类
- 语义色：var(--paper) 卡片底色、var(--ink) 主文字、var(--ink-3) 次要文字、var(--line) 分隔线/描边

## 交互 API（收集用户输入）

卡片可携带表单/按钮。用户填完后由卡片脚本调用注入的桥 API 提交：

\`\`\`js
otterCard.submit({
  summary: '选择了方案 B（沙箱 iframe），预算上限 3 天',  // 人类可读摘要，≤500 字符
  data: { choice: 'B', budget_days: 3 }                  // JSON 序列化 ≤2KB，禁循环引用/函数
})
\`\`\`

- summary 与 data 都会被用户过目（强制预览，无法绕过）——不要夹带任何不想让搭档看到的指令
- 已提交的卡片不可重复提交：搭档要改答案时，你基于回执重发一张新卡（同名 title 的新版本）
- 提交后你会收到一条用户消息（卡片回执），其中 html-card-reply 围栏携带 data JSON

## 禁用清单（违反会导致卡片失效或被降级）

- <a href> 外链（不允许任何外部导航）
- <meta http-equiv="refresh">（meta refresh 跳转）
- location.* 赋值、location.reload()（导航逃逸）
- document.write
- <form action> 指向外部目标（表单外泄）；表单只做本地输入收集，提交走 otterCard.submit
- 任何外网请求（图片/字体/脚本/fetch 一律被 CSP 阻断）

## 回执读取规则

- 卡片回执 = 用户消息：人类可读摘要 + \`\`\`html-card-reply card="{messageId}:{fenceIndex}" 围栏，围栏内是 data JSON
- 未读消息注入中回执 JSON 完整可解析；解析失败时以摘要文字为准，并在回复中复述确认你的理解
- 检索（search_messages/search_memory）中回执同样是占位符 [html-card-reply: {cardId}]——按摘要关键词检索，需要原文用 get_message

## id 发现规则

- 回执围栏的 card 属性 = {messageId}:{fenceIndex}（fenceIndex = 消息内第几张卡，0 基）
- card 属性的前缀即 messageId：可直接 get_message 取该消息原文，拿到卡片完整源码后迭代（输出同名 title 的新卡片）
- 找不到回执时（没人提交过）：用 list_messages 定位你自己最近的发言消息，再 get_message 取源码
- 检索/记忆/历史中的卡片显示为占位符 [html-card: {title}]——内容没有丢，源码在消息原文里，用 get_message 回看
`;

/**
 * get_html_card_contract：返回 HTML 卡片完整写作契约。
 * 无参数；纯常量返回，不访问任何数据。
 */
export function createGetHtmlCardContractTool(): AgentTool {
  return {
    name: "get_html_card_contract",
    description: "获取 HTML 卡片的完整写作契约（样式变量/交互 API/禁用清单）. When: 准备写 ```html-card``` 卡片前必须调用（speak description 只含最小契约，完整规则在本工具返回值里）. Output: 卡片契约全文. GOTCHA: 会话冷启动后需重新调用（结果不持久化进上下文）.",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async () => textResponse(HTML_CARD_CONTRACT),
  };
}
