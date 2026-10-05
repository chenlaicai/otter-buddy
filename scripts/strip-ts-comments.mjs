/**
 * stripTsComments：剥离 TS 源码中的注释（行注释+块注释），保留字符串字面量。
 *
 * 从 lint-prompt-anchors.mjs 抽出（#1128 修复）：修复前手写状态机不识别正则字面量，
 * /["']/ 内的引号被当字符串起始 → 后续真注释不再剥离 → 注释内锚点被误报注入面
 * （PR #1126 踩坑现场：tool-factory.ts 被迫改用 RegExp 构造器规避）。
 *
 * 正则/除法区分启发式：正则字面量只能出现在表达式位置——回溯前一个非空白字符，
 * 是操作数结尾（标识符/数字/`)`/`]`/闭引号，关键字除外）则 `/` 为除法，否则为正则。
 * 正则状态内遇 `\n`（真正则不跨行）视为误判，回退按除法重扫——误判只损失扫描精度，
 * 不产生状态错乱。
 */

/** 这些关键字后跟 `/` 时是表达式位置（正则），不是二元除法 */
const REGEX_POSITION_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "case", "do", "else", "yield", "await", "throw",
]);

const IDENT_CHAR = /[a-zA-Z0-9_$]/;

/** 回溯 src[..i) 找最后一个非空白字符位置，无则 -1 */
function lastNonWhitespace(src, i) {
  for (let j = i - 1; j >= 0; j--) {
    if (!/\s/.test(src[j])) return j;
  }
  return -1;
}

/** src[i] 是 `/` 时判定：它是正则字面量起始还是除法运算符 */
function isRegexStart(src, i) {
  const p = lastNonWhitespace(src, i);
  if (p === -1) return true; // 文件头
  const c = src[p];
  // 操作数结尾 → 除法（`a / b`、`(x+y)/2`、`arr[0]/2`、`"s"/n`）
  if (c === ")" || c === "]" || c === '"' || c === "'" || c === "`") return false;
  if (IDENT_CHAR.test(c)) {
    // 提取完整 word：关键字（return /re/）→ 正则；普通标识符/数字（a / b）→ 除法
    let start = p;
    while (start > 0 && IDENT_CHAR.test(src[start - 1])) start--;
    const word = src.slice(start, p + 1);
    return REGEX_POSITION_KEYWORDS.has(word);
  }
  // `}` 块结束→新语句位置（正则更可能：`{} /re/.test()`）；其余运算符/开括号/逗号/分号/行首→正则
  return true;
}

/**
 * 剥离 TS 源码注释，保留字符串与正则字面量本体（保行号：被剥的换行以 \n 回填）。
 * 状态机：code / 字符串(' " `) / 行注释 / 块注释 / 正则（含字符类）。
 */
export function stripTsComments(src) {
  let out = "";
  let i = 0;
  let inStr = null; // ' " `
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") { out += next ?? ""; i += 2; continue; }
      if (c === inStr) inStr = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; out += c; i++; continue; }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n"; // 保行号
        i++;
      }
      i += 2;
      continue;
    }
    if (c === "/" && isRegexStart(src, i)) {
      // 正则字面量：内容原样保留（锚点扫描仍覆盖正则体内具体编号）；字符类 [..] 内 / 不终止
      const start = i;
      i++; // 过起始 /
      let inClass = false;
      let closed = false;
      while (i < src.length) {
        const rc = src[i];
        if (rc === "\\") { i += 2; continue; }
        if (rc === "\n") break; // 真正则不跨行 → 之前是误判，走自愈回退
        if (rc === "[") inClass = true;
        else if (rc === "]") inClass = false;
        else if (rc === "/" && !inClass) { i++; closed = true; break; }
        i++;
      }
      if (!closed && src[i] === "\n") {
        // 遇 \n 误判自愈：真正则不跨行 → 该 / 实为除法，回退重扫，行内后续正常识别
        i = start + 1;
        out += "/";
        continue;
      }
      if (!closed) break; // 源码耗尽（未闭合=语法错误源码），放弃剩余
      out += src.slice(start, i); // 正则本体（含两侧 / 与 flags 前止）原样保留
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
