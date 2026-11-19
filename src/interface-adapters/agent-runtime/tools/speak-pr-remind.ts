import type { ToolContext } from "@usecases/ports/agent-tools";
import { scanBareUrls } from "@usecases/conversation/send-entry-unfurl-scan";

/**
 * PR 呈递三件套机械守卫（执行层结构化检测，yield 边界复核）。
 *
 * 失效层分析：呈递回退期间规则双层在场（身份提示词 + 每轮注入的工具描述），
 * 失效不在规则层——speak（第二步）与 create_linked_resource（第三步）是分离
 * 工具调用，漏登记无即时反馈。守卫把检测锚在 **yield 边界**（回合自然完成点）：
 * speak 时记录本回合出现过的 PR URL（任意形态），yield 时复核台账——正确流程
 * （speak→登记→yield）静默放行；缺席拒绝顶回。拒绝/放行按缺口快照比对：
 * 缺口与上次拒绝时完全相同（零进展 = 确认仅提及的刻意出口）才放行，防死循环；
 * 部分修复（缺口减少）继续拒绝直至清零，封堵多 PR 混合缺口的假闭环。
 *
 * 检测口径两层：强信号 = 独占段 PR URL（复用 unfurl 真扫描器 scanBareUrls，
 * 口径天然一致）；弱信号 = 句中/markdown 链接形态（原事故现场——只覆盖独占段
 * 会对「句中夹带/仅摘要卡」沉默，弱信号层补盲，提醒话术区分呈递/提及）。
 * 台账比对按完整路径归一（owner/repo 小写 + pull/<n>）——按尾号比对会跨仓库
 * 同号吞提醒。
 *
 * 两条不变量（yield 复核，检视补第二条——否则「补登记后放行但裸链
 * 仍缺席」构成假闭环，原事故两类现场依旧无 unfurl）：
 * 一、强信号 URL 必须已登记（第三步）；
 * 二、确认呈递的 PR——本回合 pr 登记过（registered）或弱信号已在台账——
 * speak 中必须有裸链独占段（第二步）：句中夹带/仅摘要卡不触发 unfurl 卡。
 * fact 类型含 PR URL 属错误类型使用（原事故形态一入口）：登记时回执引导改
 * pr 类型（须带 groupId），引导修正后进入不变量二闭环。
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
  ctx.turnPrUrls = { strong: mergedStrong, weak: mergedWeak, registered: ctx.turnPrUrls?.registered ?? [] };
}

/** 登记侧记录：create_linked_resource 成功登记 pr 类型时并入回合寄存器（确认呈递信号）。 */
export function recordRegisteredPr(ctx: ToolContext, url: string): void {
  if (!prIdentity(url)) return;
  const prev = ctx.turnPrUrls ?? { strong: [], weak: [], registered: [] };
  if (!prev.registered.some((u) => prIdentity(u) === prIdentity(url))) {
    prev.registered = [...prev.registered, url];
  }
  ctx.turnPrUrls = prev;
}

/** fact 类型含 GitHub PR URL → 引导改 pr 类型（原事故形态一的登记侧入口：
 *  摘要卡 fact 不构成呈递登记，机械层引导修正后由 yield 不变量二收口）。 */
export function factPrUrlHint(params: { content?: unknown; url?: unknown }): string | null {
  const text = `${params.content ?? ""} ${params.url ?? ""}`;
  const m = text.match(GITHUB_PR_URL_RE);
  return m ? (
    "[提醒] 检测到 fact 内容含 GitHub PR 链接——PR 呈递登记应用 resourceType=pr（须带 groupId=特性文档编号），" +
    "fact 摘要卡不构成呈递登记且不触发 unfurl；本条 fact 已创建，如它是 PR 呈递请补 pr 类型登记并以裸链独占段 speak 呈递。"
  ) : null;
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

/** yield 复核判定：拒绝顶回（附完整缺口回执）；放行时 remind 非空 = 零进展留声
 *  （缺口与上次拒绝完全相同仍放行的刻意出口，防死循环但不静默）。 */
export type YieldPrVerdict = { pass: true; remind?: string } | { pass: false; remind: string };

/**
 * yield 边界复核：回合寄存器中的 PR URL 按两不变量复核。
 * 拒绝/放行按 **缺口快照比对** 判定（替代「同回合二次无条件放行」——
 * 多 PR 混合缺口按回执部分修复后，剩余缺口会被无条件放行构成假闭环）：
 * - 缺口空 → 放行；
 * - 缺口与上次拒绝时完全相同（零进展：agent 收到完整回执后未做任何修复，
 *   即「确认仅提及」的刻意出口，防死循环）→ 放行但留声（remind 附缺口清单）；
 * - 其余（首次 / 缺口有增减 = agent 在响应回执或制造新违反）→ 拒绝并附
 *   **完整**缺口回执（多 PR × 两不变量全列，不因一类存在而吞掉另一类）。
 */
export async function verifyTurnPrsOnYield(ctx: ToolContext): Promise<YieldPrVerdict> {
  const recorded = ctx.turnPrUrls ?? { strong: [], weak: [], registered: [] };
  if (recorded.strong.length === 0 && recorded.weak.length === 0 && recorded.registered.length === 0) {
    return { pass: true };
  }
  const registeredDb = await registeredPrIdentities(ctx);
  const gaps = collectInvariantGaps(recorded, registeredDb);
  if (gaps === null) return { pass: true };
  const snapshot = serializeInvariantGaps(gaps);
  if ((ctx.turnYieldPrGapSnapshot ?? null) === snapshot) {
    return { pass: true, remind: buildRemindText(gaps, { zeroProgressPass: true }) };
  }
  ctx.turnYieldPrGapSnapshot = snapshot;
  ctx.turnYieldPrRemindCount = (ctx.turnYieldPrRemindCount ?? 0) + 1;
  return { pass: false, remind: buildRemindText(gaps) };
}

/** 缺口集合序列化（identity 排序后拼接）：回合内快照比对用——比较「缺口集合是否
 *  变化」而非拒绝计数：修复使缺口减少、新 speak/登记使缺口增加都算变化，
 *  部分修复不再被无条件放行吞掉剩余缺口。 */
function serializeInvariantGaps(gaps: {
  missingRegistration: string[];
  presentedWithoutBareUrl: string[];
  weakUnregistered: string[];
}): string {
  const join = (us: string[]) => us.map((u) => prIdentity(u)).sort().join(",");
  return `m:${join(gaps.missingRegistration)}|p:${join(gaps.presentedWithoutBareUrl)}|w:${join(gaps.weakUnregistered)}`;
}

/** 两不变量的缺口收集（纯函数）：违反任一返回缺口三元组，全满足返回 null。 */
function collectInvariantGaps(
  recorded: { strong: string[]; weak: string[]; registered: string[] },
  registeredDb: Set<string>,
): { missingRegistration: string[]; presentedWithoutBareUrl: string[]; weakUnregistered: string[] } | null {
  // 不变量一：强信号（裸链独占段=呈递意图明确）必须已登记——第三步缺席顶回。
  const missingRegistration = recorded.strong.filter((u) => !registeredDb.has(prIdentity(u)!));
  // 不变量二：确认呈递的 PR（本回合登记过 / 弱信号已在台账）speak 必须有裸链独占段
  // ——句中夹带/仅登记不触发 unfurl，原事故两类现场的假闭环封堵。
  const strongIds = new Set(recorded.strong.map((u) => prIdentity(u)));
  const weakRegistered = recorded.weak.filter((u) => registeredDb.has(prIdentity(u)!));
  const presentedWithoutBareUrl = [...recorded.registered, ...weakRegistered]
    .filter((u) => !strongIds.has(prIdentity(u)))
    .filter(dedupByIdentity());
  // 弱信号未登记：呈递/提及不明——拒绝并给双出路（补齐三件套 or 确认提及再 yield）。
  const weakUnregistered = recorded.weak.filter((u) => !registeredDb.has(prIdentity(u)!));
  if (missingRegistration.length === 0 && presentedWithoutBareUrl.length === 0 && weakUnregistered.length === 0) {
    return null;
  }
  return { missingRegistration, presentedWithoutBareUrl, weakUnregistered };
}

function dedupByIdentity(): (u: string, i: number, arr: string[]) => boolean {
  return (u, i, arr) => arr.findIndex((x) => prIdentity(x) === prIdentity(u)) === i;
}

/** 回执话术：**完整列出全部缺口**（多 PR × 两不变量逐类成段，不因一类存在而
 * early-return 吞掉另一类——发现：混合缺口只报第一类，agent 按回执修复
 *  后另一类被二次放行静默吞掉）。零进展放行变体开头声明「视为确认放行」并留声。 */
function buildRemindText(
  gaps: {
    missingRegistration: string[];
    presentedWithoutBareUrl: string[];
    weakUnregistered: string[];
  },
  opts: { zeroProgressPass?: boolean } = {},
): string {
  const { missingRegistration, presentedWithoutBareUrl, weakUnregistered } = gaps;
  const label = (u: string) => u.replace(/^https?:\/\/github\.com\//, "");
  const sections: string[] = [];
  if (missingRegistration.length > 0) {
    sections.push(
      `[第三步缺席] PR 独占段（${missingRegistration.map(label).join("、")}）在产物台账无对应 pr 登记——` +
      `请补 create_linked_resource（resourceType=pr，须带 groupId=特性文档编号）。`,
    );
  }
  if (presentedWithoutBareUrl.length > 0) {
    sections.push(
      `[无裸链独占段] 已确认呈递的 PR（${presentedWithoutBareUrl.map(label).join("、")}）在本回合 speak 中无裸链独占段——` +
      `句中夹带或仅登记都不触发 unfurl 预览卡，搭档看不到 PR 卡片；` +
      `请以 URL 裸写独占一段补一条 speak 呈递。`,
    );
  }
  if (weakUnregistered.length > 0) {
    sections.push(
      `[呈递/提及不明] PR 链接（${weakUnregistered.map(label).join("、")}，非独占段形态）且台账无 pr 登记——` +
      `若为呈递请补齐独占段 speak + pr 登记；若只是提及可放行。`,
    );
  }
  if (opts.zeroProgressPass) {
    return (
      `[呈递三件套] 与上次 yield 时缺口完全相同，视为确认放行（仅提及/不修复）。仍存缺口供知悉：` +
      sections.join(" ")
    );
  }
  return (
    `[呈递三件套未齐] ${sections.join(" ")}请补齐后重新 yield；` +
    `若确认不构成呈递，直接重新 yield 一次即放行。`
  );
}
