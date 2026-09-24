/**
 * bash 守卫内嵌文本脱敏（#858，F20260914ectx）。
 *
 * 背景：守卫对「文本提及」与「执行意图」不区分——--body 参数值、引号内任何含
 * 进程终止族词元的合法文本（issue 正文、review 报告、源码引用、测试字符串）与
 * 真实终止命令被同一正则命中。#858 现场 13 起：检视獭 gh pr review --body 引
 * skill 文本被拦（对抗审视流程在守卫层断裂）、heredoc 写 issue 正文被拦、
 * 本特性开发中实现者 2 次被拦（调试命令内联测试字符串）。
 *
 * 方案：扫描前脱敏——只把「引号内多词文本」中的敏感词元替换为等长占位符 X，
 * 命令位判定在脱敏文本上跑。安全性论证：
 * - 引号外词元零触碰（replace 只作用于引号段）——真实 kill 42877 不受影响；
 * - 危险通道整体跳过脱敏（保守）：bash -c 'kill N' / pipe-to-shell / 脚本
 *   one-liner / heredoc——这些通道的引号内是执行内容不是纯数据；
 * - 单词全引号（'kill' 42877）不匹配 QUOTED_TEXT（要求含非词字符）——该形态
 *   由 #850 normalizeForDetection 归一化路径处理，两条路径不冲突；
 * - 脱敏只影响拦截判定；withDiagnostics 仍扫原命令（回显真实命中点）。
 *
 * heredoc 不在本层覆盖（跨行正文脱敏收益低、边界复杂）——issue 建议的 skill 层
 * body-file 模板是其正道（.pi/skills 同 PR 修改）。
 */

/** 与 bash-safety-guard 检测词表同口径的敏感词元（等长替换用）
 *  F20260916gtlr：补 otter-buddy\.sh——#970 守卫新增 SERVICE_SCRIPT_KILL 词元时未同步本表，
 *  引号数据文本（如 grep 'otter-buddy.sh restart' README.md）被路径限定判定误拦。 */
const SENSITIVE_TOKENS: RegExp[] = [
  /\bkill\b/gi,
  /\bskill\b/gi,
  /\bpkill\b/gi,
  /\bkillall\b/gi,
  /\bkillall5\b/gi,
  /\bpgrep\b/gi,
  /\beval\b/gi,
  /\.otter-buddy\.pid/g,
  /otter-buddy\.sh/gi,
  // F20260922pmgd：gh pr merge 词元——守卫新增 PR 合入拦截时同步本表（与 otter-buddy.sh
  // 同型教训 #970：新增守卫词元不同步脱敏表 → 引号数据文本被误拦）
  /gh\s+pr\s+merge/gi,
  /\/pulls\/\d+\/merge\b/gi,
  /\/repos\/[^\s/]+\/[^\s/]+\/merges\b/gi,
];

/**
 * 引号内「多词文本」——含至少一个非词字符（空格/中文/标点），排除 'k' 这类
 * 单词全引号（那是 #850 归一化的领地）。非贪婪成对匹配，不跨行。
 * #923 处置重构：单引号段与双引号段分开处理——shell 语义上单引号内是 100%
 * 字面量（$() / 反引号都不展开），有资格无条件脱敏；双引号内 $() / 反引号
 * 会展开（是执行），命中即整体跳过脱敏。
 */
const SINGLE_QUOTED_TEXT = /'[^'\n]*[^\w'\n][^'\n]*'/g;
const DOUBLE_QUOTED_TEXT = /"[^"\n]*[^\w"\n][^"\n]*"/g;

/** F20260923qbsw：语法剥离专用跨行引号对（shell 引号可跨行；与词元脱敏的
 *  单行多词 QUOTED_TEXT 分工不同，见 stripQuotedTextSpans 注释） */
const SYNTAX_SINGLE_QUOTED = /'[^']*'/g;
const SYNTAX_DOUBLE_QUOTED = /"[^"]*"/g;

/** F20260924gfpn：heredoc 载荷整体剥离（等长空格替换）。
 *  9/23 台账实证：《issue处理》连环拦中 python3 - <<EOF 的载荷体（测试用例文本，含 kill
 *  字样）被当真实终止命令——cmdLevel「脚本 one-liner + kill + 数字」在原文上命中载荷内数据。
 *  语义：heredoc 定界行之后到闭合行为止是 python/node 的 stdin 数据（非 shell 语法），
 *  对 shell 层判定（kill 词元/重定向）是数据 → 整体剥离。
 *  安全红线（fail-closed）：
 *  - 定界符带引号（<<'EOF' / <<"EOF"）→ 无展开无危险，剥。
 *  - 定界符裸名且命令行含 $()/反引号/${} → 载荷内有 shell 展开（危险通道）→ 不剥，保守拦。
 *  - 找不到闭合行（未闭合 heredoc）→ 不剥，fail-closed。
 *  与 SHELL_PAYLOAD_CHANNEL 的关系：hasExecutionChannel 对 python heredoc 命令整体跳过脱敏
 *  （现状保守路径），本函数供「需要语法基准的判定」在调用点选择使用。
 */
const HEREDOC_OPEN = /<<\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/g;

export function stripHeredocPayloads(command: string): string {
  // 定界符带引号（无展开）→ 无条件可剥
  if (/<<\s*['"][A-Za-z_][A-Za-z0-9_]*['"]/.test(command)) {
    return blankHeredocBody(command);
  }
  // 裸定界符：命令行有展开特征时载荷可能含 $(...)（危险通道）→ 保守不剥
  const outsideHeredoc = command.replace(HEREDOC_OPEN, "");
  if (/\$\(|`|\$\{/.test(outsideHeredoc)) return command;
  return blankHeredocBody(command);
}

/** 逐处 heredoc 剥载荷体（闭合行缺失 → 原样返回该处起全部，fail-closed） */
function blankHeredocBody(command: string): string {
  HEREDOC_OPEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  let out = "";
  let cursor = 0;
  while ((m = HEREDOC_OPEN.exec(command)) !== null) {
    const openLineEnd = command.indexOf("\n", m.index);
    if (openLineEnd === -1) break; // 无换行（单行 <<EOF 后无体）——无需剥
    // 定界符必须独占一行（行首可选空白 + 词 + 行尾）才算闭合
    const closerRe = new RegExp(`^[ \\t]*${m[1]}[ \\t]*$`, "gm");
    closerRe.lastIndex = openLineEnd + 1;
    const close = closerRe.exec(command);
    if (!close) {
      // 未闭合 heredoc：fail-closed——该处起不剥（含危险载荷），跳出
      break;
    }
    out += command.slice(cursor, openLineEnd + 1);
    out += " ".repeat(close.index - (openLineEnd + 1)); // 载荷体等长空格
    cursor = close.index;
    HEREDOC_OPEN.lastIndex = cursor + close[0].length;
  }
  if (cursor === 0) return command;
  return out + command.slice(cursor);
}

/** #923 处置 c：shell 执行载荷通道——命中时命令里的引号段是「要执行的命令」本体 */
const SHELL_PAYLOAD_CHANNEL = /\b(?:bash|sh|zsh)\s+-c\b|\|\s*(?:sh|bash|zsh)\b|\b(?:perl|ruby|python\d?)\s+.*(?:-e|-c)\s|\bnode\s+.*(?:-e|--eval)\s|<<</;

/**
 * F20260923glay：脚本 one-liner 通道（python/perl/ruby -c|-e、node -e|--eval）——
 * 文档性常量：脚本载荷与 shell 载荷的分层语义说明（shell 载荷引号内是 shell 代码须保留原文，
 * 脚本载荷字符串字面量是数据可剥离）。当前实现已内联进 stripQuotedTextSpans 的载荷段定位
 * 逻辑（审视严重 1 修正后不再用通道整体分类），保留此常量供 kill 检测等调用方对齐口径。
 */
const _SCRIPT_ONELINER_CHANNEL_DOC = /\b(?:perl|ruby|python\d?)\s+.*(?:-e|-c)\s|\bnode\s+.*(?:-e|--eval)\s/;

/** 文本中是否含敏感词元（重置 lastIndex 防全局正则状态泄漏） */
function containsSensitiveToken(text: string): boolean {
  return SENSITIVE_TOKENS.some(re => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

/** 引号内文本段脱敏：词元等长替换为 X（保持位置/长度稳定，命令结构不变形） */
function sanitizeSegment(segment: string): string {
  let out = segment;
  for (const re of SENSITIVE_TOKENS) {
    out = out.replace(re, m => "X".repeat(m.length));
  }
  return out;
}

/** 危险通道检测：引号内是执行内容（非纯数据）的形态，禁止脱敏。
 * #923 检视建议 1 修复：双引号内的 $() / 反引号 / ${...} 是 shell 真实展开
 * （执行）——存在即整体跳过脱敏。单引号内的这些形态是字面文本（永不展开），
 * 不在此判定范围（单引号段无条件可脱敏，shell 语义背书）。 */
function hasExecutionChannel(command: string): boolean {
  if (/\b(?:bash|sh|zsh)\s+-c\b/.test(command)) return true; // shell -c 内嵌执行
  if (/\|\s*(?:sh|bash|zsh)\b/.test(command)) return true; // 管道进 shell
  if (/\b(?:perl|ruby|python\d?)\s+.*(?:-e|-c)\s/.test(command)) return true; // 脚本 one-liner
  if (/<<</.test(command)) return true; // heredoc（skill 层 body-file 是正道）
  // 展开特征检查范围：单引号段之外（双引号段 + 裸露部分）——单引号内永不展开
  const outsideSingle = command.replace(SINGLE_QUOTED_TEXT, "");
  if (/\$\(/.test(outsideSingle)) return true; // 命令替换
  if (/`/.test(outsideSingle)) return true; // 反引号命令替换
  if (/\$\{[^}]*\}/.test(outsideSingle)) return true; // ${...} 参数展开（展开语义保守归通道）
  return false;
}

/**
 * 剥除空引号对（'' / ""——shell 无操作，与守卫 normalizeForDetection 同语义）。
 * Why 必须在引号段识别前做：`p''k...` 的空引号对会制造假引号边界，
 * QUOTED_TEXT 把 `k... -f "xxx/ma'` 跨界误判为数据段，脱敏反而吞掉命令位词元
 * （#858 开发中实测回归：#844 撞名拦截用例被误放行）。
 */
function stripEmptyQuotePairs(command: string): string {
  return command.replace(/''/g, "").replace(/""/g, "");
}

/**
 * 判定：命令是否「引号内含敏感词元的纯数据操作」（可安全脱敏判定）。
 * 全过才 true：① 引号内多词文本存在 ② 其中含敏感词元 ③ 无危险通道。
 * 判定基准：剥除空引号对后的文本（假引号边界防御，见 stripEmptyQuotePairs）。
 */
export function shouldSanitizeForScan(command: string): boolean {
  const basis = stripEmptyQuotePairs(command);
  SINGLE_QUOTED_TEXT.lastIndex = 0;
  DOUBLE_QUOTED_TEXT.lastIndex = 0;
  const singleMatches = basis.match(SINGLE_QUOTED_TEXT) ?? [];
  const doubleMatches = basis.match(DOUBLE_QUOTED_TEXT) ?? [];
  if (singleMatches.length === 0 && doubleMatches.length === 0) return false;
  // #923 处置 c：shell 执行载荷通道（bash -c / pipe-to-shell / 脚本 one-liner /
  // heredoc）存在时，单引号是其载荷容器（引号内是要执行的命令，不是数据）——
  // 一律不脱敏，回到保守路径。此判定先行，无载荷通道时才谈引号分治。
  if (SHELL_PAYLOAD_CHANNEL.test(basis)) return false;
  if (singleMatches.some(containsSensitiveToken)) return true; // 单引号段 100% 字面量，命中即够
  if (doubleMatches.some(containsSensitiveToken) && !hasExecutionChannel(basis)) return true;
  return false;
}

/**
 * 扫描前脱敏：仅替换引号内文本段的敏感词元，引号外零触碰。
 * 输入先剥空引号对（假边界防御）；返回文本仅用于拦截判定，不用于回显。
 * 调用方应先过 shouldSanitizeForScan（本函数不做预检，供测试直接使用）。
 */
export function sanitizeQuotedText(command: string): string {
  const basis = stripEmptyQuotePairs(command);
  SINGLE_QUOTED_TEXT.lastIndex = 0;
  DOUBLE_QUOTED_TEXT.lastIndex = 0;
  return basis.replace(SINGLE_QUOTED_TEXT, sanitizeSegment).replace(DOUBLE_QUOTED_TEXT, sanitizeSegment);
}

/**
 * F20260923qbsw：引号段整段剥离为等长空格——供「shell 语法形态判定」（重定向/
 * 复合切断）在扫描前剥掉数据段。
 *
 * 背景（#984 循环拦截事故）：checkMainCheckoutWrite 的 REDIRECT_PATTERN 与
 * hasRealCdSegment 的「无 & / |」检查是文本级引号盲全文扫描——
 * `gh issue comment --body '... --> ...'`（HTML 注释/markdown 表格）被误判为
 * 重定向写主仓，连拦 3 次中断獭回合（healing 4d692fb6/e671f577）。
 *
 * 与 sanitizeQuotedText 的分工：脱敏只替换「敏感词元」、保留其余文本（服务词元
 * 判定）；本函数整段抹除引号内容（服务 shell 语法判定——引号内是数据，
 * 不参与 shell 语法）。
 *
 * 与 sanitizeQuotedText 同哲学：危险通道（bash -c / heredoc / 反引号）不脱敏
 * 不剥离——单引号是其载荷容器，载荷内的重定向/复合是真实语法，必须可见。
 * 因此本函数在 SHELL_PAYLOAD_CHANNEL 命中时原样返回输入。
 *
 * F20260923glay 分层修正：脚本 one-liner（python/node -c|-e）不再是剥离禁区——
 * 载荷是 python/node 代码，其中字符串字面量是数据（'...' / "..." / f'...'），
 * 剥离不影响 kill 检测（kill 调用词元在调用位不在字符串里）。shell 载荷
 * （bash -c / 管道进 shell / heredoc）仍整体保留原文（引号内是 shell 代码）。
 * 9/23 实证：python3 -c "print(a > b)" / node -e 分析脚本批量被重定向判定误拦
 * （今日 93 次 BLOCKED 中疑似误拦 51 次，主要形态即此）。
 */
export function stripQuotedTextSpans(command: string): string {
  const basis = stripEmptyQuotePairs(command);
  SYNTAX_SINGLE_QUOTED.lastIndex = 0;
  SYNTAX_DOUBLE_QUOTED.lastIndex = 0;
  const blank = (m: string): string => " ".repeat(m.length);

  // F20260923glay 分层 + 审视严重 1 修正：shell 载荷段（bash -c / 管道进 shell / heredoc）
  // 整段保留原文（引号内是 shell 代码）；其余（常规命令 + 脚本 one-liner 载荷）照常剥离。
  // 整条命令全局分类会让混合命令（bash -c '...' && python3 -c "..."）中的 shell 载荷遁形，
  // 而按 &&/; 等分隔符切段又会切散跨分隔符的引号对（--body "a | b"）。
  // 取中：仅当命令含 shell 载荷通道时，先定位载荷段（bash -c 之后的引号段）保留，其余剥离。
  const hasShellPayload = /\b(?:bash|sh|zsh)\s+-c\b|\|\s*(?:sh|bash|zsh)\b|<<</.test(basis);
  if (!hasShellPayload) {
    return basis.replace(SYNTAX_SINGLE_QUOTED, blank).replace(SYNTAX_DOUBLE_QUOTED, blank);
  }
  // 含 shell 载荷：保留载荷引号段原文，剥离其余引号段。
  // 定位 bash -c 后的首个引号段为载荷容器（shell 语义：-c 后第一个参数即执行体）。
  const payloadMatch = /\b(?:bash|sh|zsh)\s+-c\s+(?:"([^"\\]*)"|'([^'\\]*)')/s.exec(basis);
  if (!payloadMatch) {
    // heredoc / 管道进 shell / 无法定位载荷容器 → 保守整体保留原文（现状语义）
    return command;
  }
  const payloadStart = payloadMatch.index;
  const payloadEnd = payloadMatch.index + payloadMatch[0].length;
  const before = basis.slice(0, payloadStart).replace(SYNTAX_SINGLE_QUOTED, blank).replace(SYNTAX_DOUBLE_QUOTED, blank);
  const payload = basis.slice(payloadStart, payloadEnd); // 载荷段保留原文
  const after = basis.slice(payloadEnd).replace(SYNTAX_SINGLE_QUOTED, blank).replace(SYNTAX_DOUBLE_QUOTED, blank);
  return before + payload + after;
}
