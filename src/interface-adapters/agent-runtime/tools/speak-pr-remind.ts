import type { ToolContext } from "@usecases/ports/agent-tools";

/**
 * PR 呈递三件套第三步机械守卫（执行层结构化提醒）。
 *
 * 失效层分析（搭档 2026-11-19 裁决「完整重做」的依据）：呈递回退期间规则双层在场
 * （BIG_OTTER.md 六形态段 + speak 工具描述每轮注入），失效不在规则层——在执行层：
 * speak（裸链独占段）与 create_linked_resource（登记）是两个分离的工具调用，中间
 * 无结构化耦合，第三步漏掉无即时反馈。本守卫把「漏了」从「靠检视獭碰巧查台账」
 * 变成「speak 回执当场顶回」。
 *
 * 检测口径：只认 PR URL 独占段（行首行尾仅 URL）——与 unfurl 规则同口径，独占段
 * 是明确的呈递意图；句中夹带/表格内引用不触发（那是提及不是呈递，误伤会侵蚀
 * 提醒信任）。台账匹配按尾号（pull/<n>）宽松比对（owner/repo 大小写、组织更名
 * 不影响）。best-effort：检测本身失败不阻断发言（发言已落库，提醒是增益不是闸）。
 */
const STANDALONE_PR_URL_RE = /^[ \t]*https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)[ \t]*$/gm;
const PR_NUMBER_KEY_RE = /\/pull\/(\d+)$/;

/** 提取 body 中独占一段的 GitHub PR URL（去重，保持出现顺序）。 */
export function extractStandalonePrUrls(body: string): string[] {
  const urls: string[] = [];
  for (const m of body.matchAll(STANDALONE_PR_URL_RE)) {
    const url = m[0].trim();
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

/**
 * 检测独占段 PR 是否已登记产物台账，未登记的返回提醒文本（已齐/无 PR 段返回 null）。
 * 提醒不代替登记：PR 类型登记须带 groupId（特性文档编号），只有 agent 知道——
 * 机械层只顶回「你漏了」，不猜「该填什么」。
 */
export async function remindUnregisteredPrs(ctx: ToolContext, body: string): Promise<string | null> {
  const urls = extractStandalonePrUrls(body);
  if (urls.length === 0) return null;
  const resources = await ctx.client.resource.list(ctx.conversationId, { resourceType: "pr" });
  const registered = new Set(
    resources
      .map((r) => r.url?.match(PR_NUMBER_KEY_RE)?.[1])
      .filter((n): n is string => !!n),
  );
  const missing = urls.filter((u) => !registered.has(u.match(PR_NUMBER_KEY_RE)![1]!));
  if (missing.length === 0) return null;
  const labels = missing.map((u) => `PR #${u.match(PR_NUMBER_KEY_RE)![1]}`).join("、");
  return (
    `[提醒] 检测到 PR 呈递独占段（${labels}）但产物台账无对应 pr 登记——三件套第三步缺席。` +
    `请补 create_linked_resource（resourceType=pr，须带 groupId=特性文档编号），` +
    `否则时间轴缺摘要卡且呈递链路不完整。`
  );
}
