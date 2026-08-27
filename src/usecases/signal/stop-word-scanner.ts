/**
 * L2「停下」安全词扫描（F20260826mwrd C3，母方案 Part 6）。
 *
 * 设计要点（母方案 L143-151 + 取舍表 L198）：
 * - 显式字符类匹配，不用分词——分词结果随词典漂移，安全词检测不挂在概率性 NLP 上
 * - 不硬拦：只产出 reminder 文本，LLM 语境确认后执行——保留判断力防误伤
 *   （讨论/引用「停下」一词是真实场景，硬拦必炸；失效方向安全：漏报=退化纯 L1 prompt 检测）
 *
 * 匹配定义（实现层明确化，母方案审视发现 3 修订 + 母方案例句校准）：
 * 1. 消息去除首尾标点/空白后与「停下」完全相等（「停下」「停下。」「 停下！」命中）
 * 2. 「停下」作为片段出现，且后侧为硬边界（标点/空白/emoji/消息尾）：
 *    「快停下」「都停下。」命中——副词修饰的命令形态；
 *    「停下手头工作」不命中——后侧是文字（动词短语粘连，非独立成词）。
 *    前侧不设硬边界要求：中文命令形态「快/都/给我停下」前侧恒为文字，
 *    前侧误报（如「这个词叫停下」）由 LLM 语境确认兑底（不硬拦的设计意图）。
 */

/** 安全词表（母方案取舍：冻结 2 词，新需求先走信号通道验证） */
const STOP_WORDS = ['停下'] as const;

/**
 * 硬边界字符类（后侧判定用）：标点（中西文）、空白、emoji、组合记号、格式控制字符。
 * emoji 判定用 Unicode 扩展区段（\p{Extended_Pictographic}），需 u flag。
 * 组合记号（\p{Mn}\p{Mc}）与格式控制（\p{Cf}）归入边界类（F20260827c3hr 审视建议 2）：
 * 零宽/变体字符（VS16、ZWSP、ZWNJ、组合重音符）是 emoji 键盘与复制粘贴的
 * 常见夹带，用户不可见、不构成词义——按边界处理收窄漏报面（漏报方向安全：
 * 退化纯 L1，但 L2 的存在价值是保底，失效面该收窄）。
 */
const HARD_BOUNDARY_CHAR_RE = /[\p{P}\p{Zs}\s\p{Extended_Pictographic}\p{Mn}\p{Mc}\p{Cf}]/u;

/** trim 字符类 = 硬边界类减去 emoji（emoji 是内容的一部分，不剥——F20260827c3hr 审视发现 1） */
const TRIM_CHAR_RE = /[\p{P}\p{Zs}\s\p{Mn}\p{Mc}\p{Cf}]/u;

function trimPunctuationAndSpace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && TRIM_CHAR_RE.test(text[start])) start++;
  while (end > start && TRIM_CHAR_RE.test(text[end - 1])) end--;
  return text.slice(start, end);
}

export interface StopWordScanResult {
  /** 命中的安全词（去重后） */
  matched: string[];
  /** 注入给 LLM 的 reminder 文本；未命中为 null */
  reminder: string | null;
}

/** reminder 文本（SYSTEM.md Magic Words「停下」条目的执行引导） */
function buildReminder(matched: string[]): string {
  return `[L2 安全词检测] 用户消息命中安全词「${matched.join('」「')}」（形态：后侧为硬边界）。`
    + '请确认这是安全指令还是讨论/引用：\n'
    + '- 若是指令：立即按 SYSTEM.md Magic Words 执行——停止当前所有动作（不发新工具调用、不写新文件），'
    + '如场上有运行中小獭，用 halt_otter 对其打标，然后等搭档指示；\n'
    + '- 若是讨论/引用（如「这个词叫停下」）：正常对话，不触发急停。\n'
    + '失效方向说明：漏报（变体未命中）时退化为纯 L1 prompt 检测，与现状等价，无新增风险。';
}

/**
 * 扫描用户消息是否命中安全词（独立成词形态）。
 *
 * @param message 用户消息原文（不预处理——reminder 语境判断交给 LLM，扫描只管形态匹配）
 */
export function scanStopWords(message: string): StopWordScanResult {
  if (!message) return { matched: [], reminder: null };

  const matched = new Set<string>();
  for (const word of STOP_WORDS) {
    // 形态 1：去首尾标点/空白后与安全词完全相等
    if (trimPunctuationAndSpace(message) === word) {
      matched.add(word);
      continue;
    }
    // 形态 2：片段出现且后侧为硬边界（标点/空白/emoji/消息尾）
    let idx = message.indexOf(word);
    while (idx !== -1) {
      const afterIdx = idx + word.length;
      const after = afterIdx < message.length ? message[afterIdx] : '';
      if (after === '' || HARD_BOUNDARY_CHAR_RE.test(after)) {
        matched.add(word);
        break;
      }
      idx = message.indexOf(word, idx + 1);
    }
  }

  if (matched.size === 0) return { matched: [], reminder: null };
  return { matched: [...matched], reminder: buildReminder([...matched]) };
}
