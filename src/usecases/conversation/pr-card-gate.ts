/**
 * PR 呈递拍板机械闸（卡片决策载体缺位事故的合并处置）。
 *
 * 事故锚：大獭呈递 PR 请拍板时只给一段 md 文本 + 「待你一句话」卡，
 * 无 PR 号锚点、无可点开的 PR、无授权按钮——搭档 20 分钟内三次索取「pr卡片」。
 * 根因是纯提示词自律零成本回退（与裸链独占段回退同族）：yield 只校验「先 speak 再 yield」，
 * 不校验汇报内容里有没有决策载体。
 *
 * 双闸设计（守卫总则：明确拦、不明确放通——宁漏勿误）：
 * - 辅闸（speak 落库前）：单条 body 同时命中 [PR 引用] + [纯请求措辞] 且无任何 html-card 围栏 → 拒绝落库指导补卡。
 *   纯请求措辞表刻意不含「可以合入」等评价措辞——独立检视獭的检视报告（「检视通过，可以合入」）
 *   常态无卡，收进来会误拦非呈递方；评价措辞只在主闸的 yield-to-user 上下文里才算请求。
 * - 主闸（yield to user 前）：本回合 speak 累计 + yield reason 命中 [PR 引用] + [请求措辞（宽表）]
 *   且累计 speak 中无含 otterCard.submit 的 html-card 围栏（决策卡）→ 拒绝交棒指导补决策卡。
 *   yield to user 本身是「请搭档行动」的结构信号，与请求措辞共现才拦——检视獭 yield 回大獭不触发。
 *
 * 授权按钮判定取「围栏内容含 otterCard.submit」（提交唯一通道）——summary 文案
 * （建议 `<PR号>合入`，merge_pr 合法授权源）是模板纪律，机械层只管「有没有按钮」，不管措辞。
 */

/** 双闸共用的拒绝话术：给足模板让补卡一次到位（机械层自带教育，prompt 层失守时的兜底）。 */
const PR_CARD_GATE_REJECTION = [
  "[错误] 本条呈递命中「PR 待拍板」形态（含 PR 引用与拍板请求措辞），但缺少带授权按钮的决策卡——搭档需要一张不读正文即可拍板的卡（#1952：20 分钟三次索取 pr卡片 的事故形态）。请补齐后重发：",
  "1. 决策卡（html-card 围栏）：title 写「<PR号> <一句话结论>」（折叠态唯一可见行）；卡内字段：PR 状态（OPEN·CI·head）、一句话改动、验证证据（CI job/测试数）、检视结论（回执覆盖的 commit）、合入后动作；",
  "2. 授权按钮：卡片脚本内 otterCard.submit({ summary: '<PR号>合入', data: { pr: <PR号> } })——summary 固定格式，搭档点按即成为 merge_pr 的合法授权源；",
  "3. 正文仍写 1-2 句结论 + PR URL 裸写独占一段（unfurl 预览卡）。",
  "本闸为机械校验：请求拍板的呈递缺决策卡即拦，补卡重发即放行；若本条并非呈递待拍板（如历史通报），调整措辞避开请求词即可。",
].join("\n");

/** PR 引用：GitHub #N（issue/PR 共号域——呈递语境 #N 泛指待拍板对象，通报 issue 完成同样该出卡）
 *  或 pull URL。#N 从三位数起（本仓号域已到四位数，三位下限防「第 2 步 #2」类误配）。 */
const PR_REFERENCE_RE = /#\d{3,}|github\.com\/[^\s)]+\/pull\/\d+/;

/** 否定/过去式剔除：命中片段先从文本移除再做请求词匹配。
 *  「A 已合入，B 可以合入」——剔除「已合入」后「可以合入」仍命中（呈递在途）；
 *  「检视未过，不建议合入」——剔除后无请求词，不拦。
 *  剔除按片段不按整句，天然支持同回合多 PR 多状态混排。 */
const NEGATION_PATTERNS: RegExp[] = [
  /不(?:建议|能|可|宜|宜于)合入/g,
  /(?<!要)不要合入/g,
  /别合入/g,
  /勿合入/g,
  /暂不(?:合入|合并|merge)/gi,
  /无法合入/g,
  /拒绝合入/g,
  /已(?:经)?(?:合入|授权|批准|merge|squash|合并)/gi,
];

/** 主闸请求措辞（宽表——仅在 yield to user 上下文生效）。
 *  每词都是「请求搭档决策」的明确措辞：拍板/授权/一句话/合入请求四族。 */
const YIELD_REQUEST_PHRASES: string[] = [
  // 拍板族
  "待拍板", "待你拍板", "等你拍板", "请拍板", "拍板吧",
  // 授权族
  "待授权", "待你授权", "等你授权", "请授权", "待批复", "请批复",
  // 一句话族（08:43 事故原话形态）
  "待你一句话", "等你一句话",
  // 合入请求族（呈递待拍的高频措辞）
  "可以合入", "可以合了", "可合入", "待合入", "请合入", "等你合入",
  "要不要合入", "是否合入", "能否合入", "批准合入", "合入许可", "可以 merge", "可以merge",
];

/** 辅闸请求措辞（窄表——speak 单条、无 yield 上下文，只收纯请求措辞）。
 *  刻意排除「可以合入」等评价措辞：独立检视獭的检视报告（「检视通过，可以合入，无阻塞项」）
 *  常态无卡，speak 侧收进来会把检视回呈也拦掉——评价语义只在 yield-to-user 上下文才算请求。 */
const SPEAK_REQUEST_PHRASES: string[] = [
  "待拍板", "待你拍板", "等你拍板", "请拍板", "拍板吧",
  "待授权", "待你授权", "等你授权", "请授权", "待批复", "请批复",
  "待你一句话", "等你一句话",
];

/** 剔除否定/过去式片段后的干净文本（词匹配的前提）。 */
function stripNegations(text: string): string {
  let cleaned = text;
  for (const re of NEGATION_PATTERNS) {
    cleaned = cleaned.replace(re, "");
  }
  return cleaned;
}

/** 文本是否含 PR 引用（#N 或 pull URL）。 */
export function hasPrReference(text: string): boolean {
  return PR_REFERENCE_RE.test(text);
}

/** 主闸判定：文本（剔除否定后）是否含请求拍板措辞（宽表）。 */
export function hasDecisionRequestWide(text: string): boolean {
  const cleaned = stripNegations(text);
  return YIELD_REQUEST_PHRASES.some((p) => cleaned.includes(p));
}

/** 辅闸判定：文本（剔除否定后）是否含纯请求拍板措辞（窄表）。 */
export function hasDecisionRequestNarrow(text: string): boolean {
  const cleaned = stripNegations(text);
  return SPEAK_REQUEST_PHRASES.some((p) => cleaned.includes(p));
}

/**
 * 决策卡在场判定：任一 speak body 的 html-card 围栏内容含 otterCard.submit。
 * 围栏收集复用 tool-helpers 的 remark 管线（嵌套围栏口径与体积测量同源）——
 * 为避免 interface-adapters → usecases 反向依赖，此处注入围栏值收集函数而非直接 import。
 */
export function decisionCardPresent(speakBodies: string[], collectFenceValues: (body: string) => string[]): boolean {
  return speakBodies.some((body) =>
    collectFenceValues(body).some((fence) => fence.includes("otterCard.submit")),
  );
}

/** 辅闸：speak 落库前检查。返回拒绝理由（含补卡模板），null 放行。
 *  触发 = body 含 PR 引用 + 纯请求措辞 + 无任何 html-card 围栏。 */
export function checkSpeakGate(body: string, hasCardFences: (body: string) => boolean): string | null {
  if (!hasPrReference(body)) return null;
  if (!hasDecisionRequestNarrow(body)) return null;
  if (hasCardFences(body)) return null;
  return PR_CARD_GATE_REJECTION;
}

/** 主闸：yield to user 前检查。返回拒绝理由，null 放行。
 *  触发 = 本回合呈递面（speak 累计 + yield reason）含 PR 引用 + 宽表请求措辞，
 *  且累计 speak 无含 otterCard.submit 的决策卡。 */
export function checkYieldGate(
  speakBodies: string[],
  yieldReason: string | undefined,
  collectFenceValues: (body: string) => string[],
): string | null {
  const surface = [...speakBodies, yieldReason ?? ""].join("\n");
  if (!hasPrReference(surface)) return null;
  if (!hasDecisionRequestWide(surface)) return null;
  if (decisionCardPresent(speakBodies, collectFenceValues)) return null;
  return PR_CARD_GATE_REJECTION;
}
