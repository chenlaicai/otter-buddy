/**
 * stripTsComments：剥离 TS 源码中的注释（行注释+块注释），保留字符串字面量。
 *
 * 从 lint-prompt-anchors.mjs 抽出（#1128 修复）：修复前手写状态机不识别正则字面量，
 * /["']/ 内的引号被当字符串起始 → 后续真注释不再剥离 → 注释内锚点被误报注入面
 * （PR #1126 踩坑现场：tool-factory.ts 被迫改用 RegExp 构造器规避）。
 *
 * 正则/除法区分启发式：正则字面量只能出现在表达式位置或语句位置——
 *   1. 本行行首（语句位）→ 正则
 *   2. 回溯前一个非空白字符（刻意穿注释边界取 token，对本判定语义近似成立——
 *      注释出现在 `/` 与前一 token 之间时，`/` 位置性质由前一 token 决定，见 ⑤ 声明）
 *   3. `)` 结尾 → 回溯平衡括号，`(` 前是控制流关键字（if/while/for/switch/catch）→ 正则；
 *      否则除法
 *   4. 操作数结尾（`]`/闭引号/普通标识符/数字）→ 除法
 *   5. 表达式关键字（return/typeof 等）结尾 → 正则
 *   6. 其余（运算符/开括号/逗号/分号/`}`/文件头）→ 正则
 *
 * 误判自愈：正则态内遇 `\n`（真正则不跨行）或 EOF 未闭合 → 回填区间**完整原文**，
 * 不重扫——重扫会让区间内裸引号触发字符串态错位、后续状态永久卡死（检视发现①）。
 * 回填原文保证区间内锚点仍被下游扫描覆盖（宁误报不漏检）。
 */

/** 这些关键字后跟 `/` 时是表达式位置（正则），不是二元除法 */
const REGEX_POSITION_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "case", "do", "else", "yield", "await", "throw",
]);

/** `)` 后跟 `/` 时：`(` 前是这些控制流关键字 → 语句位正则（`if (x) /re/`） */
const CONTROL_FLOW_KEYWORDS = new Set([
  "if", "while", "for", "switch", "catch", "with",
]);

const IDENT_CHAR = /[a-zA-Z0-9_$]/;

/** 回溯 src[..i) 找最后一个非空白字符位置，无则 -1。
 *  块注释感知（#1291）：遇块注释结束符跳过对应起始区间（块注释=token 间空白，
 *  对除法/正则判定无贡献）。跳过失败（未闭合/伪闭合）不整体投降，退化为
 *  修复前行为（不穿注释）——块注释误判是误报方向，自愈回填兜底。
 *  取到的末字符仍可能落在行注释内（行注释必在行尾，前一个 token 必在同行，
 *  对判定无影响）。改动此处前先跑 tests/scripts/strip-ts-comments*.test.ts。 */
function lastNonWhitespace(src, i) {
  for (let j = i - 1; j >= 0; j--) {
    const c = src[j];
    // 块注释结束符（*/，回溯视角先遇到第二个字符 /）：回溯找其起始 /*
    // 跳过字符串/正则内伪 */（引号奇偶感知，与 matchingOpenParen 同型）
    if (c === "/" && src[j - 1] === "*") {
      let k = j - 2;
      while (k >= 1 && !(src[k] === "*" && src[k - 1] === "/")) k--;
      if (k < 1) return j; // 跳过失败退化：落在 / 上（修复前行为，自愈兜底）
      j = k - 1; // for 循环 j-- 后落在 /* 之前
      if (j < 0) return -1;
      continue;
    }
    if (!/\s/.test(c)) return j;
  }
  return -1;
}

/** src[i] 的 `/` 是否本行第一个非空白字符（语句位：行首正则如 `/re/.test(x)`）。
 *  块注释感知（#1291）：遇换行时检查——若 `/` 与上一代码 token 之间存在块注释，
 *  则该 `/` 实为续行除法（块注释=token 间空白，subtotal 后接跨行块注释再接
 *  行首除法的 / 接在 subtotal 表达式后）→ 非语句位。纯换行无块注释时维持既有
 *  赌注（检视发现③：行首 `/` 默认正则——启发式取舍，本函数不改变）。
 *  块注释回溯跳过逻辑遇块注释结束符跳对应起始符。 */
function isLineStart(src, i) {
  // 跨行回溯：遇块注释结束符跳到其起始符之前（区间内 \n 不构成语句边界）；
  // 遇块注释外的 \n 时看上一行：若上一行只有空白/注释（无代码 token），继续回溯
  // （注释行与空行不产生 token，/ 的性质由更前面的代码决定）；若上一行有代码，
  // 则：跨过块注释 → 续行除法（#1291 修复目标）；纯换行 → 维持行首赌注（检视发现③）
  let sawBlockComment = false;
  let j = i - 1;
  while (j >= 0) {
    const c = src[j];
    if (c === "/" && src[j - 1] === "*") {
      // 块注释结束：跳到起始 /* 之前（区间内 \n 不算语句边界）
      let k = j - 2;
      while (k >= 1 && !(src[k] === "*" && src[k - 1] === "/")) k--;
      if (k < 1) return true; // 跳过失败退化：维持行首赌注（修复前行为）
      sawBlockComment = true;
      j = k - 1;
      continue;
    }
    if (c === "\n") {
      // 检查上一行（j-1 往前到上一个 \n）是否只有空白/块注释
      let k = j - 1;
      let sawC = false;
      while (k >= 0 && src[k] !== "\n") {
        const cc = src[k];
        if (cc === "/" && src[k - 1] === "*") {
          let m = k - 2;
          while (m >= 1 && !(src[m] === "*" && src[m - 1] === "/")) m--;
          if (m < 1) { sawC = true; break; } // 跳不过去当代码处理（保守）
          sawBlockComment = true; // 行内遇到块注释也置位外层标记（#1291 现场形态）
          k = m - 1;
          continue;
        }
        if (!/\s/.test(cc)) { sawC = true; break; }
        k--;
      }
      if (sawC) {
        // 上一行有代码：块注释介入 → 除法；纯换行 → 行首赌注（③）
        return !sawBlockComment;
      }
      // 上一行纯空白/注释：不产生 token，继续回溯（这个 \n 不是边界）
      j = k;
      continue;
    }
    if (!/\s/.test(c)) return false; // 同行有前置代码 token → 非行首
    j--;
  }
  return true; // 到文件头无代码 token → 语句位（与修复前一致）
}

/** 从闭括号位 p 反向回溯平衡 `(`，返回其位置；不平衡/越界返回 -1。
 *  对字符串/模板字面量内的括号免疫（检视獭-1282glm 严重①）：`if (s.includes("(")) /re/`
 *  的字符串内 `(` 会污染朴素平衡计数，使回溯找到错误的开括号 → 语句位正则误判为除法
 *  → 正则体内 `//` 被当行注释吞行尾锚点（漏检方向，无自愈兜底——自愈只挂在正则态）。
 *  反向扫描遇闭引号时跳过对应开引号区间（转义感知——前导 `\` 奇偶判定，
 *  `endsWith("\"")` 的假开引号不错位，检视獭-1282glm 严重②盲区①）。
 *  跳过失败（未闭合/正则内引号无配对）不整体投降，降级回朴素平衡计数
 *  （回归修复前行为——`['()] ` 成对括号本可正确，投降比朴素更糟，严重②盲区②）。
 *  启发式仍不处理：注释内括号（穿注释是设计取舍，见 lastNonWhitespace 声明）
 *  与正则内括号（`(/[(]/)`）——后者遗留形态由特性文档「残留」节声明。 */
function matchingOpenParen(src, p) {
  // 朴素平衡计数（fallback：引号跳过失败时回归修复前行为）
  const naive = () => {
    let d = 0;
    for (let j = p; j >= 0; j--) {
      const c = src[j];
      if (c === ")") d++;
      else if (c === "(") {
        d--;
        if (d === 0) return j;
      }
    }
    return -1;
  };
  let depth = 0;
  for (let j = p; j >= 0; j--) {
    const c = src[j];
    if (c === '"' || c === "'" || c === "`") {
      // 闭引号：继续反向找其开引号（转义感知——前导 \ 奇数才算转义），跳过整个字面量
      let k = j - 1;
      while (k >= 0) {
        if (src[k] === "\\") { k--; continue; } // 反向扫描：\ 转义的是 k+1（已扫过），自身 k-- 跳过即可（检视獭严重③：`k -= 2` 会跳过 k+1 反向已扫过位，致 `"\\("` 开引号在 \ 右邻时被跳过）
        if (src[k] === c) { // 落到引号：数前导 \ 奇偶——奇数=被转义的假引号，偶数=真边界（严重③ H1：`"(\""` 的假闭引号不配对）
          let bs = 0, m = k - 1;
          while (m >= 0 && src[m] === "\\") { bs++; m--; }
          if (bs % 2 === 0) break;
          k--; continue;
        }
        k--;
      }
      if (k < 0) return naive(); // 未闭合字面量（语法错误源码）或正则内引号无配对 → 降级朴素计数
      j = k; // for 循环 j-- 后落在开引号之前
      continue;
    }
    if (c === ")") depth++;
    else if (c === "(") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** src[i] 是 `/` 时判定：它是正则字面量起始还是除法运算符 */
function isRegexStart(src, i) {
  if (isLineStart(src, i)) return true; // ③ 行首语句位正则
  const p = lastNonWhitespace(src, i);
  if (p === -1) return true; // 文件头（理论上 isLineStart 已覆盖，防御性保留）
  const c = src[p];
  if (c === ")") {
    // ② 闭括号：回溯平衡 `(`，其前是控制流关键字 → 语句位正则；否则除法
    const open = matchingOpenParen(src, p);
    if (open > 0) {
      let wEnd = open - 1;
      // 跳过 `(` 与关键字间空白
      while (wEnd >= 0 && /\s/.test(src[wEnd])) wEnd--;
      let wStart = wEnd;
      while (wStart > 0 && IDENT_CHAR.test(src[wStart - 1])) wStart--;
      const word = src.slice(wStart, wEnd + 1);
      if (CONTROL_FLOW_KEYWORDS.has(word)) return true;
    }
    return false; // `(x+y)/2` 等除法
  }
  // 操作数结尾 → 除法（`arr[0]/2`、`"s"/n`）
  if (c === "]" || c === '"' || c === "'" || c === "`") return false;
  if (IDENT_CHAR.test(c)) {
    // 提取完整 word：表达式关键字（return /re/）→ 正则；普通标识符/数字（a / b）→ 除法
    let start = p;
    while (start > 0 && IDENT_CHAR.test(src[start - 1])) start--;
    const word = src.slice(start, p + 1);
    return REGEX_POSITION_KEYWORDS.has(word);
  }
  // `}` 块结束→新语句位置（正则更可能：`{} /re/.test()`）；其余运算符/开括号/逗号/分号→正则
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
        if (rc === "\n") break; // 真正则不跨行 → 误判，走自愈回填
        if (rc === "[") inClass = true;
        else if (rc === "]") inClass = false;
        else if (rc === "/" && !inClass) { i++; closed = true; break; }
        i++;
      }
      if (!closed) {
        // 误判自愈（含 EOF 未闭合）：回填区间完整原文，不重扫——重扫会让区间内
        // 裸引号触发字符串态错位致后续状态卡死（检视发现①）。原文保留=锚点扫描
        // 仍覆盖区间内容（宁误报不漏检）。EOF 未闭合同时告警（守卫工具不可静默丢内容）。
        if (i >= src.length) {
          console.error(
            `[lint-prompt-anchors] 警告：${src.slice(start, i).length} 字符疑似未闭合正则字面量` +
              `（语法错误源码或启发式边界），原文保留并继续扫描`
          );
        }
        out += src.slice(start, i);
        continue;
      }
      out += src.slice(start, i); // 正则本体（含两侧 / 与 flags 前止）原样保留
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
