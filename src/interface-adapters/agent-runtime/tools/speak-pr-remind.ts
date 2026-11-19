import type { ToolContext } from "@usecases/ports/agent-tools";
import { scanBareUrls } from "@usecases/conversation/send-entry-unfurl-scan";

/**
 * PR 呈递三件套机械守卫（执行层结构化检测，yield 边界复核）。
 *
 * 失效层分析：呈递回退期间规则双层在场（身份提示词 + 每轮注入的工具描述），
 * 失效不在规则层——speak（第二步）与 create_linked_resource（第三步）是分离
 * 工具调用，漏登记无即时反馈。守卫把检测锚在 **yield 边界**（回合自然完成点）：
 * speak 时记录本回合出现过的 PR URL（任意形态），yield 时复核台账——正确流程
 * （speak→登记→yield）静默放行；漏登记首次拒绝顶回（agent 补登记或确认仅提及
 * 后再 yield，同回合二次放行防死循环）。
 *
 * 检测口径两层：强信号 = 独占段 PR URL（复用 unfurl 真扫描器 scanBareUrls，
 * 口径天然一致）；弱信号 = 句中/markdown 链接形态（原事故现场——只覆盖独占段
 * 会对「句中夹带/仅摘要卡」沉默，弱信号层补盲，提醒话术区分呈递/提及）。
 * 台账比对按完整路径归一（owner/repo 小写 + pull/<n>）——按尾号比对会跨仓库
 * 同号吞提醒。
 */
const GITHUB_PR_URL_RE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;

/** 完整路径归一键：owner/repo 小写归一 + PR 号（组织/仓库更名场景由登记时的新 URL 覆盖）。 */
function prIdentity(url: string): string | null {
  const m = url.match(GITHUB_PR_URL_RE.source);
  if (!m) return null;
  const [, owner, repo, num] = m;
  return `${owner!.toLowerCase()}/${repo!.toLowerCase()}/pull/${num}`;
}

/** 提取 body 中的 GitHub PR URL（强信号=unfurl 独占段口径；弱信号=任意位置形态），合并去重。 */
export function extractPrUrls(body: string): { strong: string[]; weak: string[] } {
  const strong = scanBareUrls(body).filter((u) => prIdentity(u));
  const strongIds = new Set(strong.map(prIdentity));
  const weak: string[] = [];
  for (const m of body.matchAll(GITHUB_PR_URL_RE)) {
    const url = m[0];
    const id = prIdentity(url);
    if (id && !strongIds.has(id) && !weak.some((u) => prIdentity(u) === id)) weak.push(url);
  }
  return { strong, weak };
}

/** speak 侧记录：把本回合 speak 中出现的 PR URL 分强/弱信号并入回合寄存器（yield 时复核）。
 *  同 URL 先后以两种形态出现时归入强信号（独占段是更强的呈递证据）。 */
export function recordTurnPrUrls(ctx: ToolContext, body: string): void {
  const { strong, weak } = extractPrUrls(body);
  if (strong.length === 0 && weak.length === 0) return;
  const mergeDedup = (a: string[], b: string[]): string[] => {
    const ids = new Set(a.map((u) => prIdentity(u)));
    return [...a, ...b.filter((u) => !ids.has(prIdentity(u)))];
  };
  const mergedStrong = mergeDedup(ctx.turnPrUrls?.strong ?? [], strong);
  const strongIds = new Set(mergedStrong.map((u) => prIdentity(u)));
  const mergedWeak = mergeDedup(ctx.turnPrUrls?.weak ?? [], weak).filter(
    (u) => !strongIds.has(prIdentity(u)),
  );
  ctx.turnPrUrls = { strong: mergedStrong, weak: mergedWeak };
}

/** 台账中已登记的 PR 身份集合（pr 类型，url 归一）。 */
export async function registeredPrIdentities(ctx: ToolContext): Promise<Set<string>> {
  const resources = await ctx.client.resource.list(ctx.conversationId, { resourceType: "pr" });
  return new Set(
    resources
      .map((r) => (r.url ? prIdentity(r.url) : null))
      .filter((id): id is string => !!id),
  );
}

/** yield 复核判定：放行（无记录/已齐/同回合已拒绝过）或首次拒绝顶回（含提醒话术）。 */
export type YieldPrVerdict = { pass: true; remind?: undefined } | { pass: false; remind: string };

/**
 * yield 边界复核：回合寄存器中的 PR URL 是否全部已登记。
 * 首次缺席 → 拒绝（强信号=独占段呈递，话术直指第三步；弱信号=可能只是提及，
 * 话术允许「确认仅提及后重新 yield」）。同回合已拒绝过一次
 * （turnYieldPrRemindCount ≥ 1）→ 放行（防死循环：提及场景 agent 无从补登记）。
 */
export async function verifyTurnPrsOnYield(ctx: ToolContext): Promise<YieldPrVerdict> {
  const recordedStrong = ctx.turnPrUrls?.strong ?? [];
  const recordedWeak = ctx.turnPrUrls?.weak ?? [];
  if (recordedStrong.length === 0 && recordedWeak.length === 0) return { pass: true };
  if ((ctx.turnYieldPrRemindCount ?? 0) >= 1) return { pass: true };
  const registered = await registeredPrIdentities(ctx);
  const missingStrong = recordedStrong.filter((u) => !registered.has(prIdentity(u)!));
  const missingWeak = recordedWeak.filter((u) => !registered.has(prIdentity(u)!));
  if (missingStrong.length === 0 && missingWeak.length === 0) return { pass: true };
  ctx.turnYieldPrRemindCount = (ctx.turnYieldPrRemindCount ?? 0) + 1;
  return { pass: false, remind: buildRemindText(missingStrong, missingWeak) };
}

/** 拒绝话术：强信号直指第三步缺席；仅弱信号区分呈递/提及两条出路。 */
function buildRemindText(missingStrong: string[], missingWeak: string[]): string {
  const label = (u: string) => u.replace(/^https?:\/\/github\.com\//, "");
  if (missingStrong.length > 0) {
    return (
      `[呈递三件套未齐] 本回合 speak 含 PR 独占段（${missingStrong.map(label).join("、")}）但产物台账无对应 pr 登记——` +
      `第三步缺席。请补 create_linked_resource（resourceType=pr，须带 groupId=特性文档编号）后重新 yield；` +
      `若确认本段不是呈递，直接重新 yield 一次即放行。`
    );
  }
  return (
    `[呈递三件套核查] 本回合 speak 出现 PR 链接（${missingWeak.map(label).join("、")}，非独占段形态）且台账无对应 pr 登记。` +
    `若这是 PR 呈递：呈递规范是 URL 裸写独占一段 + create_linked_resource 登记，请补齐后重新 yield；` +
    `若只是提及/引用：直接重新 yield 一次即放行。`
  );
}
