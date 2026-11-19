/**
 * PR 呈递拍板机械闸（卡片决策载体缺位事故的处置）。
 *
 * 事故锚：大獭呈递 PR 请拍板时只给一段 md 文本 + 「待你一句话」卡，
 * 无 PR 号锚点、无可点开的 PR、无授权按钮——搭档同一诉求 20 分钟内三次索取「pr卡片」。
 * 根因是纯提示词自律零成本回退（与裸链独占段回退同族）：yield 只校验「先 speak 再 yield」，
 * 不校验汇报内容里有没有决策载体。
 *
 * 双闸设计（守卫总则：明确拦、不明确放通——宁漏勿误）：
 * - 辅闸（speak 落库前）：单条 body 命中 [PR 引用 + 纯请求措辞（或指代自足缺位）] 且无任何
 *   html-card 围栏 → 拒绝落库指导补卡。纯请求措辞表刻意不含「可以合入」等评价措辞——
 *   独立检视獭的检视报告（「检视通过，可以合入」）常态无卡，收进来会误拦非呈递方；
 *   评价措辞只在主闸的 yield-to-user 上下文里才算请求。
 * - 主闸（yield to user 前）：本回合 speak 累计 + yield reason 命中 [PR 引用 + 请求措辞（宽表）]
 *   且累计 speak 中无可执行提交路径的决策卡 → 拒绝交棒指导补决策卡。
 *   yield to user 本身是「请搭档行动」的结构信号，与请求措辞共现才拦——检视獭 yield 回大獭不触发。
 *
 * 授权按钮判定取「结构化可执行路径在场」：script 块内（清 JS 注释/字符串后）的
 * otterCard.submit( 调用，或事件处理器属性（onclick 等）里的调用——注释掉的、
 * 字符串里的、code/pre/textarea 展示的、data-* 数据属性里的都不算
 * （空壳卡绕过两轮对抗实证：无语法上下文的子串判定不可靠）。
 * summary 文案（建议「<PR号>合入」，merge_pr 合法授权源）是模板纪律，机械层只管
 * 「有没有可执行的提交路径」，不管措辞。
 */

/** PR 引用：GitHub #N（issue/PR 共号域——呈递语境 #N 泛指待拍板对象，通报 issue 完成同样该出卡）
 *  或 pull URL。#N 从三位数起（本仓号域已到四位数，三位下限防「第 2 步 #2」类误配）。 */
const PR_REFERENCE_RE = /#\d{3,}|github\.com\/[^\s)]+\/pull\/\d+/;

/** 中文否定前缀：与请求措辞就近组合出现时该请求词不算请求。
 *  双字/多字否定词（不是/不用/不需要……）整词入表；含「不」的前缀统一加后行断言
 *  (?<![要若或])——「要不X」「要不要X」「若不X」「或不X」是建议/疑问语气词组不是否定
 *  （「要不请你拍板」是真实请求，两轮对抗实证双向边界：穷举短语不可收敛，
 *  收敛的是前缀词表 + 语气词组保护）。请求词与否定词之间隔实义字
 *  （「不阻塞，可以合入」）不构成否定——肯定语义保留。 */
const NEGATION_PREFIXES = [
  "不是", "并非", "没有", "无需", "无须", "不用", "不需要", "没必要", "暂无", "不再", "不要", "并不", "毫不",
  "不", "无", "非", "没", "别", "勿", "莫",
];

/** 「不」系前缀的语气词组保护断言（要不/要不要/若不/或不 X = 建议语气非否定）。 */
const MOOD_GUARD = "(?<![要若或])";

/** 过去式/完成态剔除：已发生的合入与授权陈述不是请求。 */
const COMPLETED_PATTERNS: RegExp[] = [
  /已(?:经)?(?:合入|合并|授权|批准|merge|squash)/gi,
];

/** 主闸请求措辞（宽表——仅在 yield to user 上下文生效）。
 *  每词都是「请求搭档决策」的明确措辞：拍板/授权/一句话/合入/合并请求五族。 */
const YIELD_REQUEST_PHRASES: string[] = [
  // 拍板族
  "待拍板", "待你拍板", "等你拍板", "请拍板", "请你拍板", "拍板吧",
  // 授权族
  "待授权", "待你授权", "等你授权", "请授权", "请你授权", "待批复", "请批复", "请你批复",
  // 一句话族（事故原话形态）
  "待你一句话", "等你一句话",
  // 合入请求族（呈递待拍的高频措辞）
  "可以合入", "可以合了", "可合入", "待合入", "请合入", "请你合入", "等你合入",
  "要不要合入", "是否合入", "能否合入", "批准合入", "合入许可", "可以 merge", "可以merge",
  // 合并族（与合入同义的高频变体）
  "可以合并", "可以合并了", "待合并", "请合并", "要不要合并", "是否合并", "能否合并", "批准合并", "等你合并",
];

/** 辅闸请求措辞（窄表——speak 单条、无 yield 上下文，只收纯请求措辞）。
 *  刻意排除「可以合入」等评价措辞：独立检视獭的检视报告（「检视通过，可以合入，无阻塞项」）
 *  常态无卡，speak 侧收进来会把检视回呈也拦掉——评价语义只在 yield-to-user 上下文才算请求。 */
const SPEAK_REQUEST_PHRASES: string[] = [
  "待拍板", "待你拍板", "等你拍板", "请拍板", "请你拍板", "拍板吧",
  "待授权", "待你授权", "等你授权", "请授权", "请你授权", "待批复", "请批复", "请你批复",
  "待你一句话", "等你一句话",
];

/** 指代自足缺位（issue 补充现场实证样本：把决策载体指回上一条，搭档必须回翻才知道按哪个键）。
 *  本条消息用指代语引卡片且本条无卡 = 决策节点不复述载体。
 *  引号豁免：『卡片在上一条』/「卡片在上一条」带引号的是引用反模式字面量（修复通报/测试
 *  说明），不是真实指代——匹配前先剔引号内文本（对抗检视实证：讨论该判据自身的发言被误拦）。 */
const DEFERRED_CARD_RE = /(卡片?|决策卡)\s*(在|见)\s*(上|前一?条|前文|文|面|前面)/;

/** 引号包裹文本（中文单双书名引号 + 英文引号）——指代判据的引用豁免用。 */
const QUOTED_SPAN_RE = /[『「"'“][^』」"”]*[』」"”]/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 剔除否定组合与完成态：返回干净文本（词匹配的前提）。
 *  否定剔除按「否定前缀 + 请求词」组合删片段，不按整句——同回合多 PR 多状态混排
 *  天然支持（「A 已合入，B 可以合入」剔除后 B 的请求仍在）。
 *  含「不」的前缀带语气词组保护断言（见 NEGATION_PREFIXES 注释）。 */
function stripNegations(text: string, phrases: string[]): string {
  let cleaned = text;
  for (const phrase of phrases) {
    const escaped = escapeRegExp(phrase);
    for (const neg of NEGATION_PREFIXES) {
      const guard = neg.includes("不") ? MOOD_GUARD : "";
      cleaned = cleaned.replace(new RegExp(`${guard}${escapeRegExp(neg)}\\s*${escaped}`, "g"), "");
    }
  }
  for (const re of COMPLETED_PATTERNS) {
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
  const cleaned = stripNegations(text, YIELD_REQUEST_PHRASES);
  return YIELD_REQUEST_PHRASES.some((p) => cleaned.includes(p));
}

/** 辅闸判定：文本（剔除否定后）是否含纯请求拍板措辞（窄表）。 */
export function hasDecisionRequestNarrow(text: string): boolean {
  const cleaned = stripNegations(text, SPEAK_REQUEST_PHRASES);
  return SPEAK_REQUEST_PHRASES.some((p) => cleaned.includes(p));
}

/** 指代自足缺位判定：本条用指代语引卡（「卡片在上一条」形态）。
 *  引号豁免：先剔引号内文本再匹配——讨论/引用反模式字面量不算真实指代。 */
export function hasDeferredCardReference(text: string): boolean {
  return DEFERRED_CARD_RE.test(text.replace(QUOTED_SPAN_RE, ""));
}

/** script 块内清 JS 不可执行区：块注释 → 字符串（单双引号/模板串）→ 行注释。
 *  顺序保证：字符串里的 // 与 /* 不被行/块注释规则误截（字符串整段先走）。
 *  行注释 // 前非冒号即可（https:// 的冒号排除；空格/Tab 缩进属于命中——
 *  缩进行注释漏剔是对抗实证的绕过形态）。 */
function cleanScriptBlock(js: string): string {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "")
    .replace(/(^|[^:])\/\/[^\n]*/gm, "$1");
}

/** 事件处理器属性里的提交调用（onclick/oninput 等 on* 属性是 HTML 唯一合法的内联执行点；
 *  data-* 等非事件属性、文本节点裸字符串不是执行路径——对抗实证的绕过形态）。 */
const EVENT_ATTR_SUBMIT_RE = /on\w+\s*=\s*["'][^"']*otterCard\.submit\s*\(/i;

/** script 块提取（含 type 属性等形态）。 */
const SCRIPT_BLOCK_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

/** 结构化可执行提交路径判定：script 块内（清注释/字符串后）的调用，或事件属性里的调用。
 *  全区先剔除 HTML 注释与 code/pre/textarea 展示块。 */
function hasExecutableSubmit(fenceHtml: string): boolean {
  const displayStripped = fenceHtml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<code[\s\S]*?<\/code>/gi, "")
    .replace(/<pre[\s\S]*?<\/pre>/gi, "")
    .replace(/<textarea[\s\S]*?<\/textarea>/gi, "");
  if (EVENT_ATTR_SUBMIT_RE.test(displayStripped)) return true;
  SCRIPT_BLOCK_RE.lastIndex = 0;
  for (let m = SCRIPT_BLOCK_RE.exec(displayStripped); m !== null; m = SCRIPT_BLOCK_RE.exec(displayStripped)) {
    if (cleanScriptBlock(m[1]).includes("otterCard.submit(")) return true;
  }
  return false;
}

/**
 * 决策卡在场判定：任一 speak body 的 html-card 围栏内容含可执行提交路径。
 * 围栏收集复用 remark 管线（与体积测量同源）——为避免 usecases → interface-adapters
 * 反向依赖，此处注入围栏值收集函数而非直接 import。
 */
export function decisionCardPresent(speakBodies: string[], collectFenceValues: (body: string) => string[]): boolean {
  return speakBodies.some((body) =>
    collectFenceValues(body).some((fence) => hasExecutableSubmit(fence)),
  );
}

/**
 * 辅闸：speak 落库前检查。返回拒绝理由（含补卡模板），null 放行。
 * 触发 = body 含 PR 引用 + [纯请求措辞 或 指代自足缺位] + 无任何 html-card 围栏。
 * 指代分支双重防误伤（对抗实证：讨论该反模式自身的发言被误拦）：
 * ①引号豁免（hasDeferredCardReference 内剔引号内文本——『卡片在上一条』是引用非使用）；
 * ②决策语境门槛（须同条含宽表请求/评价措辞——纯讨论无请求词的修复通报放行）。 */
export function checkSpeakGate(body: string, hasCardFences: (body: string) => boolean): string | null {
  if (!hasPrReference(body)) return null;
  if (hasCardFences(body)) return null;
  const requestHit = hasDecisionRequestNarrow(body);
  const deferredMissing = hasDeferredCardReference(body) && hasDecisionRequestWide(body);
  if (!requestHit && !deferredMissing) return null;
  return deferredMissing && !requestHit
    ? DEFERRED_CARD_REJECTION
    : PR_CARD_GATE_REJECTION;
}

/** 主闸：yield to user 前检查。返回拒绝理由，null 放行。
 *  触发 = 本回合呈递面（speak 累计 + yield reason）含 PR 引用 + 宽表请求措辞，
 *  且累计 speak 无含可执行提交路径的决策卡。reason 面恒生效（yield 参数必在，
 *  fail-open 只覆盖 speak 累计缺失维度）。 */
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

/** 双闸共用的拒绝话术：给足模板让补卡一次到位（机械层自带教育，prompt 层失守时的兜底）。 */
const PR_CARD_GATE_REJECTION = [
  "[错误] 本条呈递命中「PR 待拍板」形态（含 PR 引用与拍板请求措辞），但缺少带授权按钮的决策卡——搭档需要一张不读正文即可拍板的卡（20 分钟三次索取 pr卡片 的事故形态）。请补齐后重发：",
  "1. 决策卡（html-card 围栏）：title 写「<PR号> <一句话结论>」（折叠态唯一可见行）；卡内字段：PR 状态（OPEN·CI·head）、一句话改动、验证证据（CI job/测试数）、检视结论（回执覆盖的 commit）、合入后动作；",
  "2. 授权按钮：卡片脚本内 otterCard.submit({ summary: '<PR号>合入', data: { pr: <PR号> } })——summary 固定格式，搭档点按即成为 merge_pr 的合法授权源；",
  "3. 正文仍写 1-2 句结论 + PR URL 裸写独占一段（unfurl 预览卡）。",
  "本闸为机械校验：请求拍板的呈递缺决策卡即拦，补卡重发即放行；若本条并非呈递待拍板（如历史通报），调整措辞避开请求词即可。",
].join("\n");

/** 指代自足缺位的拒绝话术：决策节点必须复述载体，不许把搭档指回上一条。 */
const DEFERRED_CARD_REJECTION = [
  "[错误] 本条用「卡片在上一条」式指代引决策载体，但本条自身无卡——决策节点不复述载体，搭档必须回翻才知道要按哪个键（决策载体缺位的事故形态之一）。请在本条直接重发带授权按钮的决策卡（otterCard.submit({ summary: '<PR号>合入' })），不要用指代语把载体指回历史消息。",
].join("\n");
