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
 *   且累计 speak 中无含提交信号的决策卡（弱字样） → 拒绝交棒指导补决策卡。
 *   yield to user 本身是「请搭档行动」的结构信号，与请求措辞共现才拦——检视獭 yield 回大獭不触发。
 *
 * 授权按钮判定取**弱信号**（三轮对抗实证后的架构收窄）：剔除语法稳定的展示区
 * （HTML 注释/code/pre/textarea）后围栏内含 otterCard.submit 字样。JS 语义级判定
 * （script 解析/注释字符串清理/事件白名单）不可收敛，空壳形态（JS 内嵌伪调用、
 * 纯文本字样）机械不可证明，放通记已知边界——闸的主目标是拦「卡片整体缺位」，
 * 卡片质量由模板纪律与独立检视兜底，运行时真相由卡片回执事后可证。
 * summary 文案（建议「<PR号>合入」，merge_pr 合法授权源）是模板纪律，机械层不管措辞。
 */

/** PR 引用：GitHub 井号加数字形态（issue 与 PR 共号域——呈递语境该形态泛指待拍板对象，
 *  通报 issue 完成同样该出卡）或 pull URL。数字从三位数起（本仓号域已到四位数，
 *  三位下限防「第 2 步」这类两位数的误配）。 */
const PR_REFERENCE_RE = /#\d{3,}|github\.com\/[^\s)]+\/pull\/\d+/;

/** 中文否定前缀：与请求措辞就近组合出现时该请求词不算请求。
 *  **错误代价结构分层（终态，四轮实证）**：辅闸误拦 = 正常发言说不出话（最高代价）
 *  → 扩展表（含单字「不」，宁多剔，漏拦由主闸兜底）；主闸误拦仅要求补卡（低代价）
 *  → 基础表（无单字「不」——它是语气歧义根源：要不/何不/不得不 X 是真实请求，
 *  若不需要/或不用又是否定，断言特例三轮实证打不收敛）。
 *  请求词与否定词之间允许 0-2 字封闭集副词窗（再/先/都/也/就/还/且/而——
 *  「无需再等你拍板」）；隔实义字（「不阻塞，可以合入」）不构成否定，肯定语义保留。 */
const NEGATION_PREFIXES_BASE = [
  "不是", "并非", "没有", "无需", "无须", "不用", "不需要", "没必要", "不建议", "不能", "不许", "不应", "不得", "不必", "暂无", "暂不", "不再", "不要", "不予", "并不", "毫不",
  "无", "非", "没", "别", "勿", "莫",
];
/** 辅闸（speak 落库前）专用：追加单字「不」。错误代价结构不对称——辅闸误拦 = 正常
 *  发言说不出话（最高代价），辅闸漏拦还有主闸兜底；所以辅闸宁可多剔（漏拦方向），
 *  单字「不」的语气歧义（要不/何不请你拍板被误剔）在此层可接受，主闸仍会拦住真实请求。 */
const NEGATION_PREFIXES_NARROW = [...NEGATION_PREFIXES_BASE, "不"];

/** 否定词与请求词之间的封闭集副词窗（0-2 字）。 */
const ADVERB_WINDOW = "[再先都也就还且而]{0,2}";

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

/** 引号包裹文本（中文单双书名引号/弯单引号 + 英文单双引号 + 反引号）——指代判据的引用豁免用。
 *  三轮对抗实证：反引号 `…`（行内代码）与技术通报的 ‘…’/'…' 形态漏豁免。 */
const QUOTED_SPAN_RE = /[\u300E\u300C\u201C\u2018'"`][^\u300F\u300D\u201D\u2019'"`]*[\u300F\u300D\u201D\u2019'"`]/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 剔除否定组合与完成态：返回干净文本（词匹配的前提）。
 *  否定剔除按「否定前缀 + 副词窗 + 请求词」组合删片段，不按整句——同回合多 PR 多状态
 *  混排天然支持（「A 已合入，B 可以合入」剔除后 B 的请求仍在）。 */
function stripNegations(text: string, phrases: string[], negPrefixes: string[]): string {
  let cleaned = text;
  for (const phrase of phrases) {
    const escaped = escapeRegExp(phrase);
    for (const neg of negPrefixes) {
      cleaned = cleaned.replace(new RegExp(`${escapeRegExp(neg)}\\s*${ADVERB_WINDOW}\\s*${escaped}`, "g"), "");
    }
  }
  for (const re of COMPLETED_PATTERNS) {
    cleaned = cleaned.replace(re, "");
  }
  return cleaned;
}

/** 文本是否含 PR 引用（或 pull URL）。 */
export function hasPrReference(text: string): boolean {
  return PR_REFERENCE_RE.test(text);
}

/** 主闸判定：文本（剔除否定后）是否含请求拍板措辞（宽表）。基础否定表（无单字「不」）。 */
export function hasDecisionRequestWide(text: string): boolean {
  const cleaned = stripNegations(text, YIELD_REQUEST_PHRASES, NEGATION_PREFIXES_BASE);
  return YIELD_REQUEST_PHRASES.some((p) => cleaned.includes(p));
}

/** 辅闸判定：文本（剔除否定后）是否含纯请求拍板措辞（窄表）。扩展否定表（含单字「不」）。 */
export function hasDecisionRequestNarrow(text: string): boolean {
  const cleaned = stripNegations(text, SPEAK_REQUEST_PHRASES, NEGATION_PREFIXES_NARROW);
  return SPEAK_REQUEST_PHRASES.some((p) => cleaned.includes(p));
}

/** 辅闸指代分支的决策语境门槛：**宽表请求词面 + 辅闸否定表**——词面取宽（覆盖「可以合了」
 *  等评价措辞的事故形态），否定剔除必须与辅闸主分支同表（扩展表含单字「不」）。
 *  对抗实证（五轮）：门槛暗换主闸基础否定表会让窄表已正确剔除的否定句在指代分支
 *  被另一张表拦回（「不批准合入；卡片在上一条」被辅闸拒绝，违背分层原则）。 */
function hasDecisionContextNarrowNegation(text: string): boolean {
  const cleaned = stripNegations(text, YIELD_REQUEST_PHRASES, NEGATION_PREFIXES_NARROW);
  return YIELD_REQUEST_PHRASES.some((p) => cleaned.includes(p));
}

/** 指代自足缺位判定：本条用指代语引卡（「卡片在上一条」形态）。
 *  引号豁免：先剔引号内文本再匹配——讨论/引用反模式字面量不算真实指代。 */
export function hasDeferredCardReference(text: string): boolean {
  return DEFERRED_CARD_RE.test(text.replace(QUOTED_SPAN_RE, ""));
}

/** 决策卡提交按钮在场判定（弱信号，架构收窄终态）：
 *  剔除**语法稳定无嵌套歧义**的展示区（HTML 注释 / code / pre / textarea 块）后，
 *  围栏内含 otterCard.submit 字样。
 *
 *  为什么不做 JS 语义级判定（script 块解析/注释字符串清理/on* 事件白名单）：
 *  三轮对抗实证不可收敛——缩进注释/转义引号/非 JS script/伪事件属性/注释内 onclick
 *  每轮修完又冒新语法上下文反例，且真实写法（submit 与括号间空白/字符串内标记截断）
 *  反被误拒。用正则重写 HTML+JS parser 的路走不通（同族先例：通用 shell 语义建模
 *  四轮实证后收窄为固定模板）。按守卫总则（明确拦不明确放通）：「有卡但按钮是假的」
 *  的空壳形态机械不可证明，放通记边界——本闸的主目标是拦「卡片整体缺位」（事故
 *  本形态），卡片质量（按钮真实可按）由 get_html_card_contract 模板纪律与独立检视
 *  兜底，运行时真相由卡片回执（html-card-reply）事后可证。 */
function stripDisplayRegions(fenceHtml: string): string {
  return fenceHtml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<code[\s\S]*?<\/code>/gi, "")
    .replace(/<pre[\s\S]*?<\/pre>/gi, "")
    .replace(/<textarea[\s\S]*?<\/textarea>/gi, "");
}

function submitSignalPresent(fenceHtml: string): boolean {
  return stripDisplayRegions(fenceHtml).includes("otterCard.submit");
}

/** 残留披露信号（弱字样，与提交信号同层）：
 *  事故现场：卡片字段齐全、按钮在场，但「私聊名片缺邮箱」这类**没做完的通用字段**
 *  只在卡里写成一句旁注，按钮只有「合入」；搭档合入后才被追问出来。
 *  闸只认「卡里到底提没提残留」，不判残留的严重度（严重度由搭档判）。
 *  没有残留的卡写「无残留」即可——零残留也必须显式声明，省掉"是忘了写还是真没有"的歧义。
 *
 *  与提交信号的取词面不同：提交信号要认 onclick 属性里的 otterCard.submit，故只能剔展示区；
 *  残留披露要的是**搭档读得到的卡面文字**，因此额外剔掉三类「獭能写、搭档看不见/不算声明」的位置：
 *  - `<style>` / `<script>` 内容（样式与脚本不是卡面）；
 *  - `<button>` / `<a>` 元素整体（按钮文案如「带残留合入」不是披露，是个洞）；
 *  - 标签属性值（`title="残留"`、`aria-label` 之类藏在属性里）。
 *  已知边界（机械不可证明，记边界不假称托底）：`style="display:none"` 之类 CSS 隐藏、
 *  近义词规避（「遗留」「尚未覆盖」不被认作披露）、以及真正写没写对——由检视与卡片回执兜底。 */
const RESIDUAL_MARKERS = ["残留", "未完成项", "未处理项"];

/** 卡片可见文字：剔展示区 → 剔 style/script 块 → 剔按钮与链接元素 → 剔全部标签（含属性值）。 */
function visibleCardText(fenceHtml: string): string {
  return stripDisplayRegions(fenceHtml)
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<button[\s\S]*?<\/button>/gi, "")
    .replace(/<a[\s>][\s\S]*?<\/a>/gi, "")
    .replace(/<[^>]*>/g, "");
}

function residualSignalPresent(fenceHtml: string): boolean {
  const visible = visibleCardText(fenceHtml);
  return RESIDUAL_MARKERS.some((marker) => visible.includes(marker));
}

/**
 * 决策卡在场判定：任一 speak body 的 html-card 围栏内容含提交信号（弱字样）。
 * 围栏收集复用 remark 管线（与体积测量同源）——为避免 usecases → interface-adapters
 * 反向依赖，此处注入围栏值收集函数而非直接 import。
 */
export function decisionCardPresent(speakBodies: string[], collectFenceValues: (body: string) => string[]): boolean {
  return speakBodies.some((body) =>
    collectFenceValues(body).some((fence) => submitSignalPresent(fence)),
  );
}

/**
 * 残留披露在场判定：**同一张**决策卡（含提交信号）里必须出现残留披露字样——
 * 不许把「残留」写进另一张不做决策的卡里蒙混，也不许只写在正文（正文不是搭档拍板时看的载体）。
 */
export function residualDisclosurePresent(speakBodies: string[], collectFenceValues: (body: string) => string[]): boolean {
  return speakBodies.some((body) =>
    collectFenceValues(body).some((fence) => submitSignalPresent(fence) && residualSignalPresent(fence)),
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
  const deferredMissing = hasDeferredCardReference(body) && hasDecisionContextNarrowNegation(body);
  if (!requestHit && !deferredMissing) return null;
  return deferredMissing && !requestHit
    ? DEFERRED_CARD_REJECTION
    : PR_CARD_GATE_REJECTION;
}

/** 主闸：yield to user 前检查。返回拒绝理由，null 放行。
 *  触发 = 本回合呈递面（speak 累计 + yield reason）含 PR 引用 + 宽表请求措辞，
 *  且累计 speak 无含提交信号（弱字样）的决策卡。reason 面恒生效（yield 参数必在，
 *  fail-open 只覆盖 speak 累计缺失维度）。 */
export function checkYieldGate(
  speakBodies: string[],
  yieldReason: string | undefined,
  collectFenceValues: (body: string) => string[],
): string | null {
  const surface = [...speakBodies, yieldReason ?? ""].join("\n");
  if (!hasPrReference(surface)) return null;
  if (!hasDecisionRequestWide(surface)) return null;
  if (!decisionCardPresent(speakBodies, collectFenceValues)) return PR_CARD_GATE_REJECTION;
  // 卡有了还不够：卡里必须交代「还剩什么」——没有就写「无残留」。
  if (!residualDisclosurePresent(speakBodies, collectFenceValues)) return RESIDUAL_DISCLOSURE_REJECTION;
  return null;
}

/** 双闸共用的拒绝话术：给足模板让补卡一次到位（机械层自带教育，prompt 层失守时的兜底）。 */
const PR_CARD_GATE_REJECTION = [
  "[错误] 本条呈递命中「PR 待拍板」形态（含 PR 引用与拍板请求措辞），但缺少带授权按钮的决策卡——搭档需要一张不读正文即可拍板的卡（20 分钟三次索取 pr卡片 的事故形态）。请补齐后重发：",
  "1. 决策卡（html-card 围栏）：title 写「<PR号> <一句话结论>」（折叠态唯一可见行）；卡内字段：PR 状态（OPEN·CI·head）、一句话改动、验证证据（CI job/测试数）、检视结论（回执覆盖的 commit）、合入后动作、残留与后续（逐条标需要你介入/不需要，没有就写「无残留」）；",
  "2. 授权按钮：卡片脚本内 otterCard.submit({ summary: '<PR号>合入', data: { pr: <PR号> } })——summary 固定格式，搭档点按即成为 merge_pr 的合法授权源；",
  "3. 正文仍写 1-2 句结论 + PR URL 裸写独占一段（unfurl 预览卡）。",
  "本闸为机械校验：请求拍板的呈递缺决策卡即拦，补卡重发即放行；若本条并非呈递待拍板（如历史通报），调整措辞避开请求词即可。",
].join("\n");

/** 残留未披露的拒绝话术：
 *  「卡片整体缺位」修好之后出现的新洞——卡齐了、按钮有了，但没做完的部分没上卡，
 *  搭档在信息不全的前提下拍了拍板，事后才发现还缺能力。 */
const RESIDUAL_DISCLOSURE_REJECTION = [
  "[错误] 决策卡在场，但没有交代「还剩什么」——残留/后续事项未披露（事故形态：卡里只把能力缺口写成旁注、按钮只有「合入」，搭档合入后才追问出还没做）。请在**同一张决策卡**内补一节并把关键结论放进卡面：",
  "1. 「残留与后续」逐条列：未完成的能力缺口、未验证项、衍生单，每条标注「需要你介入」或「不需要你介入」，并给出选项（补齐再合 / 带残留合入 + 后续登记）；",
  "2. 确实没有残留就显式写「无残留」——不写不等于没有，闸不认沉默；",
  "3. 残留项同时登记待办（matter），未清不得宣称「本单彻底结束」。",
  "本闸只认卡内字样（弱信号），不判残留严重度：严重度由搭档判，不由獭判。",
].join("\n");

/** 指代自足缺位的拒绝话术：决策节点必须复述载体，不许把搭档指回上一条。 */
const DEFERRED_CARD_REJECTION = [
  "[错误] 本条用「卡片在上一条」式指代引决策载体，但本条自身无卡——决策节点不复述载体，搭档必须回翻才知道要按哪个键（决策载体缺位的事故形态之一）。请在本条直接重发带授权按钮的决策卡（otterCard.submit({ summary: '<PR号>合入' })），不要用指代语把载体指回历史消息。",
].join("\n");
