/**
 * 每日 AI 雷达的确定性分拣与输出契约（零 IO 纯函数）。
 * 真相源文档：scripts/radar/README.md
 */

// 关键字表：scripts/radar/README.md「HN 粗筛正则」节（改动需同步）
export const HN_KEYWORDS =
  /\b(AI|AGI|LLM|LLMs|GPT|Claude|Gemini|OpenAI|Anthropic|agent|agents|agentic|MCP|RAG|inference|prompt|reasoning|fine-?tun\w*|diffusion|transformer|tokenizer|embedding|vector database|copilot|cursor)\b/i;

/** HN 单条响应转为原始条目；非 AI 粗筛与无效响应返回 null。 */
export function selectHackerNewsItem(item, id) {
  if (!item || !item.title || !HN_KEYWORDS.test(item.title)) return null;
  return {
    title: item.title,
    url: item.url || `https://news.ycombinator.com/item?id=${id}`,
    score: item.score,
    comments: item.descendants || 0,
  };
}

export function sortHackerNewsItems(items) {
  return items.sort((a, b) => b.score - a.score);
}

export function sortGitHubItems(items) {
  return items.sort((a, b) => b.stars - a.stars);
}

/** Anthropic HTML 的 slug 顺序即页面首次出现顺序；重复链接只保留首次。 */
export function extractAnthropicSlugs(html) {
  return [...new Set((html.match(/href="\/news\/[a-z0-9-]+"/g) || []).map((s) => s.slice(12, -1)))];
}

export function selectAnthropicItems(html) {
  return extractAnthropicSlugs(html).slice(0, 10).map((slug) => ({
    slug,
    url: `https://www.anthropic.com/news/${slug}`,
  }));
}

export function assembleRawResult({ date, generatedAt, hackernews, github, anthropic }) {
  return {
    date,
    generatedAt,
    sources: { hackernews, github, anthropic },
  };
}

/** stdout 是 LLM 分拣层的输入契约：只改展示会改变下游可见信息。 */
export function formatRadarSummary({ result, outputPath }) {
  const { date, sources } = result;
  const hn = sources.hackernews;
  const gh = sources.github;
  const an = sources.anthropic;
  const lines = [
    `=== AI 雷达原始数据 ${date} ===`,
    `[HN] ${hn.items.length} 条 AI 相关（错误: ${hn.error || '无'}）`,
    ...hn.items.slice(0, 15).map((i) => `  [${i.score}分/${i.comments}评论] ${i.title} | ${i.url}`),
    `[GitHub] ${gh.items.length} 个近7天新项目（错误: ${gh.error || '无'}）`,
    ...gh.items.slice(0, 15).map((i) => `  [${i.stars}★ ${i.topic}] ${i.repo} — ${(i.desc || '').slice(0, 80)}`),
    `[Anthropic] ${an.items.length} 篇（错误: ${an.error || '无'}）`,
    ...an.items.map((i) => `  ${i.slug}`),
    `\n原始数据已落盘: ${outputPath}`,
  ];
  return `${lines.join('\n')}\n`;
}
