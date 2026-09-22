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

/** #923 处置 c：shell 执行载荷通道——命中时命令里的引号段是「要执行的命令」本体 */
const SHELL_PAYLOAD_CHANNEL = /\b(?:bash|sh|zsh)\s+-c\b|\|\s*(?:sh|bash|zsh)\b|\b(?:perl|ruby|python\d?)\s+.*(?:-e|-c)\s|<<</;

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
