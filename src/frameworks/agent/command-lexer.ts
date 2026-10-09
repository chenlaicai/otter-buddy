/**
 * bash 命令词法层（F20260928grv2，guard-v2-redesign）。
 *
 * 设计：单遍 O(n) 手写状态机，字符流 → Word（含 WordPart 展开结构）+ 操作符 token
 * + heredoc 体 span。方案：guard-redesign-proposal.md §3.1-3.2（D1 自写词法层决策：
 * 热路径依赖纯净；需求是词法级安全语义非完整 AST）。
 *
 * 失败语义（D3 分层 fail-closed）：未闭合引号 / $( / 反引号 / heredoc → parseOk=false，
 * 判定层走词元级兜底。词法层不递归——cmdsub/backtick/进程替换/bash -c 载荷只记载荷
 * 文本（part.text），递归消费与深度控制（≤2 层）在模型层（command-model.ts）。
 *
 * eslint 复杂度豁免：单遍状态机是本模块的本质形态（分段拆分会在扫描器间引入
 * 大量共享游标状态，得不偿失；见方案 D1 取舍）。呑例与 kill-segment-finder 同类。
 */
/* eslint-disable max-lines-per-function, max-statements, complexity, max-depth */

export type PartType = "lit" | "var" | "cmdsub" | "arith" | "escape" | "hex" | "unknown";
export type QuoteCtx = false | "single" | "double";

/** 词内最小结构单元。text=原文片段（var 含 $ 前缀原文；cmdsub/arithmetic 为载荷文本）。 */
export interface WordPart {
  type: PartType;
  text: string;
  quoted: QuoteCtx;
}

export interface Span { start: number; end: number; }

/** 词（shell word）。evaluated=全部 parts 可静态求值时的拼接字面量；含任何展开 → null。 */
export interface Word {
  span: Span;
  parts: WordPart[];
  evaluated: string | null;
}

export interface HeredocToken {
  op: string;              // << | <<-
  delim: string;
  delimQuoted: boolean;    // <<'EOF' / <<"EOF" → 体绝对数据；裸 delim 体可展开
  bodySpan: Span | null;   // null = 未闭合（parseOk=false）
}

export type TokType = "word" | "op" | "comment" | "heredoc";

export interface Token {
  type: TokType;
  span: Span;
  word?: Word;             // type=word
  op?: string;             // type=op（含 fd 前缀形态 "2>&1" 等）
  text?: string;           // type=comment
  heredoc?: HeredocToken;  // type=heredoc
}

export interface LexResult {
  tokens: Token[];
  parseOk: boolean;
  issues: string[];
}

/** D6 防御：输入上限（超限截断 + parseOk=false，判定层走兜底） */
const MAX_INPUT = 1_000_000;

/** S4 防碎片爆炸：单词 part 数上限（引号塔形态 27 万碎片 part 的对象分配热点）。
 *  超限 → 尾部折叠为单 unknown part + fail（词不可信 → 判定层走 V1 兑底链，
 *  保守侧不回退；正常命令词 part 数 < 10，恶意形态不受影响）。 */
const MAX_PARTS_PER_WORD = 256;

const OP_CHARS = new Set(["|", "&", ";", "(", ")", "<", ">"]);

function isWordStart(tokens: Token[]): boolean {
  if (tokens.length === 0) return true;
  const last = tokens[tokens.length - 1];
  return last.type !== "word"; // word 后出现 # 属于词内（echo a#b），不构成注释
}

/** 词内特殊字符（断词）：空白/操作符/引号/转义/展开起始 */
function breaksWord(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "'" || c === '"'
    || c === "\\" || c === "$" || c === "`" || OP_CHARS.has(c);
}

/** escape part 静态求值：\c → c（bash 引用语义）；\newline → 空串。hex 不在此求值（保守）。 */
function evalEscape(raw: string): string {
  if (raw.length === 2 && raw[1] !== "\n") return raw[1];
  return "";
}

/** Word.evaluated：全部 parts 为 lit/escape → 拼接值；否则 null（不可静态求值）。
 *  S4 性能：拼接用数组+单次 join（27 万碎片 part 的逐个 += 是 O(n²) 字符拷贝，
 *  引号塔形态 528KB 实测 52ms → join 后归 O(n)）。 */
function evalWord(parts: WordPart[]): string | null {
  const out: string[] = [];
  for (const p of parts) {
    if (p.type === "lit") out.push(p.text);
    else if (p.type === "escape") out.push(evalEscape(p.text));
    else return null; // var/cmdsub/arith/hex/unknown → 展开不可静态求值
  }
  return out.join("");
}

/** 词法主入口。depth 由模型层递归时传入（此处仅透传到 issues 标注）。 */
export function lex(text: string): LexResult {
  const n = Math.min(text.length, MAX_INPUT);
  const truncated = text.length > MAX_INPUT;
  const tokens: Token[] = [];
  const issues: string[] = [];
  let parseOk = true;
  let i = 0;
  // 本行待吃体的 heredoc（遇 \n 消费）
  let pendingHeredocs: HeredocToken[] = [];

  const fail = (msg: string): void => { parseOk = false; issues.push(msg); };

  const pushOp = (op: string, start: number): void => {
    tokens.push({ type: "op", span: { start, end: i }, op });
  };

  // ── heredoc 体消费：从 pos 逐行找到「行（trim 左 tab 后）=== delim」的闭合行，
  //   扫描游标 i 跳过体内容（体是数据 token，不进词法流）──
  const consumeHeredocBodies = (): void => {
    for (const hd of pendingHeredocs) {
      let pos = i; // i 已越过触发消费的 \n
      let found = -1;
      while (pos <= n) {
        const lineEnd = text.indexOf("\n", pos);
        const line = text.slice(pos, lineEnd === -1 ? n : lineEnd);
        const trimmed = hd.op === "<<-" ? line.replace(/^\t+/, "") : line;
        if (trimmed === hd.delim) { found = pos; break; }
        if (lineEnd === -1) break;
        pos = lineEnd + 1;
      }
      if (found === -1) {
        hd.bodySpan = null;
        fail(`unclosed heredoc delim=${hd.delim}`);
        i = n; // 体不可信——剩余文本不再切词（保守：判定层走兜底）
      } else {
        hd.bodySpan = { start: i, end: found - 1 >= i ? found - 1 : i };
        const closeEnd = text.indexOf("\n", found);
        i = closeEnd === -1 ? n : closeEnd + 1; // 游标跳过体+闭合行
      }
    }
    pendingHeredocs = [];
  };

  // ── 展开扫描：$ 后的形态分发（quoted=当前引号上下文）──
  const scanExpansion = (quoted: QuoteCtx): void => {
    const start = i; // 指向 $
    const next = text[i + 1] ?? "";
    // $(( )) 算术展开
    if (next === "(" && text[i + 2] === "(") {
      let depth = 0;
      let j = i + 2;
      let closed = false;
      while (j < n) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")") {
          depth--;
          if (depth === 0 && text[j + 1] === ")") { j += 2; closed = true; break; }
          if (depth === 0) break; // $( ) 单闭——arith 未闭合
        }
        j++;
      }
      if (closed) {
        parts.push({ type: "arith", text: text.slice(start, j), quoted });
        i = j;
      } else {
        parts.push({ type: "unknown", text: text.slice(start, Math.min(n, start + 3)), quoted });
        fail(`unclosed arith @${start}`);
        i = Math.min(n, start + 3);
      }
      return;
    }
    // $( ) 命令替换（引号感知括号计数）
    if (next === "(") {
      const end = matchCmdSub(i + 1);
      if (end === -1) {
        parts.push({ type: "unknown", text: text.slice(start, n), quoted });
        fail(`unclosed cmdsub @${start}`);
        i = n;
      } else {
        parts.push({ type: "cmdsub", text: text.slice(i + 2, end), quoted }); // 载荷=去 $( )
        i = end + 1;
      }
      return;
    }
    // ${ ... } 参数展开
    if (next === "{") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
        if (depth === 0) break;
        j++;
      }
      if (depth === 0) {
        parts.push({ type: "var", text: text.slice(start, j + 1), quoted });
        i = j + 1;
      } else {
        parts.push({ type: "unknown", text: text.slice(start, n), quoted });
        fail(`unclosed brace expansion @${start}`);
        i = n;
      }
      return;
    }
    // $'...' ANSI-C 引用 / $"..." locale 引用 → unknown（含转义语义，不可静态求值）/ 按双引号处理
    if (next === "'") {
      const close = text.indexOf("'", i + 2);
      if (close === -1) {
        parts.push({ type: "unknown", text: text.slice(start, n), quoted });
        fail(`unclosed ANSI-C quote @${start}`);
        i = n;
      } else {
        parts.push({ type: "unknown", text: text.slice(start, close + 1), quoted });
        i = close + 1;
      }
      return;
    }
    if (next === '"') {
      // #1374（F20261009qdlq）raw-quote 回退：$" 形态歧义——bash 里 $ 后跟 " 有两种
      // 解释：① locale 引用 $"..."（词首，有配对闭引号）；② $ 正则锚定等字面量 + 词
      // 闭引号（grep "^npm|^$"——$ 是字面量，" 是外层双引号的闭合）。greedy indexOf
      // 把②误判为①的未闭合 → 连带外层引号 fail → parseOk=false → cd 豁免退化 4 连拦。
      // 回退仅在外层引号上下文（quoted="double"）生效：此时 $" 中的 " 定是外层闭合
      // （真 locale 引用不会出现在双引号内——$" 在双引号内无 locale 语义），按字面 $
      // 入 parts，" 留给外层引号扫描消费，不 fail。词首 $"（quoted=null）维持 locale
      // 处理不变——真 locale $"hello world" / 未闭合 $"abc 行为与修复前完全一致。
      if (quoted === "double") {
        parts.push({ type: "lit", text: "$", quoted });
        i++;
        return;
      }
      const close = text.indexOf('"', i + 2);
      if (close === -1) {
        parts.push({ type: "unknown", text: text.slice(start, n), quoted });
        fail(`unclosed locale quote @${start}`);
        i = n;
      } else {
        parts.push({ type: "unknown", text: text.slice(start, close + 1), quoted });
        i = close + 1;
      }
      return;
    }
    // $NAME / $0..$9（多位）/ 特殊单字符 $@ $* $$ $? $# $! $- $_
    if (/[A-Za-z_]/.test(next)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(text[j])) j++;
      parts.push({ type: "var", text: text.slice(start, j), quoted });
      i = j;
      return;
    }
    if (/[0-9]/.test(next)) {
      let j = i + 1;
      while (j < n && /[0-9]/.test(text[j])) j++;
      parts.push({ type: "var", text: text.slice(start, j), quoted });
      i = j;
      return;
    }
    if ("@*$?!#-_".includes(next)) {
      parts.push({ type: "var", text: text.slice(start, i + 2), quoted });
      i += 2;
      return;
    }
    // 裸 $（词尾/后跟断词符）：字面量
    parts.push({ type: "lit", text: "$", quoted });
    i++;
  };

  /** $( 载荷括号匹配：from= '(' 位置；引号感知；返回 ')' 位置或 -1 */
  const matchCmdSub = (from: number): number => {
    let depth = 0;
    let j = from;
    while (j < n) {
      const c = text[j];
      if (c === "'") { // 单引号内括号无意义
        const close = text.indexOf("'", j + 1);
        if (close === -1) return -1;
        j = close + 1;
        continue;
      }
      if (c === "\\") { j += 2; continue; }
      if (c === '"') { // 双引号内同样跳过（内部 \( \" 处理）
        j++;
        while (j < n && text[j] !== '"') {
          if (text[j] === "\\") j++;
          j++;
        }
        j++;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) return j;
      }
      j++;
    }
    return -1;
  };

  // 反引号命令替换（不支持嵌套；匹配下一个未转义 `）
  const scanBacktick = (quoted: QuoteCtx): void => {
    const start = i;
    const close = text.indexOf("`", i + 1);
    if (close === -1) {
      parts.push({ type: "unknown", text: text.slice(start, n), quoted });
      fail(`unclosed backtick @${start}`);
      i = n;
    } else {
      parts.push({ type: "cmdsub", text: text.slice(start + 1, close), quoted });
      i = close + 1;
    }
  };

  // ── 词扫描（当前 parts 数组由外层闭包提供）──
  let parts: WordPart[] = [];

  const scanWord = (): void => {
    const start = i;
    while (i < n) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || OP_CHARS.has(c)) break;
      if (c === "'") { // 单引号：纯字面，无任何转义/展开
        const s = i;
        i++;
        const close = text.indexOf("'", i);
        if (close === -1) {
          parts.push({ type: "unknown", text: text.slice(s, n), quoted: "single" });
          fail(`unclosed single quote @${s}`);
          i = n;
          break;
        }
        parts.push({ type: "lit", text: text.slice(s + 1, close), quoted: "single" });
        i = close + 1;
        continue;
      }
      if (c === '"') { // 双引号：内嵌 \$ \` \\ 转义 + $ 展开 + ` 展开
        const s = i;
        i++;
        let closed = false;
        while (i < n) {
          const dc = text[i];
          if (dc === '"') { closed = true; i++; break; }
          if (dc === "\\") {
            const e = i;
            i += 2;
            parts.push({ type: "escape", text: text.slice(e, Math.min(i, n)), quoted: "double" });
            continue;
          }
          if (dc === "$") { scanExpansion("double"); continue; }
          if (dc === "`") { scanBacktick("double"); continue; }
          const l = i;
          while (i < n && !"\"\\$`".includes(text[i])) i++;
          if (i > l) parts.push({ type: "lit", text: text.slice(l, i), quoted: "double" });
        }
        if (!closed) {
          parts.push({ type: "unknown", text: text.slice(s, n), quoted: "double" });
          fail(`unclosed double quote @${s}`);
        }
        continue;
      }
      if (c === "\\") {
        const e = i;
        // hex 形态 \xNN（任何引用上下文）：归 hex part 保守不求值——与现状
        // INDIRECT_PID_PATTERNS \\x 检测同方向（D5 矩阵 #2）。printf '\x6b' 的
        // 单引号内形态由双/单引号分支自行处理，此处是词内非引号上下文。
        if (text[i + 1] === "x" && /[0-9a-fA-F]/.test(text[i + 2] ?? "")) {
          const h = i;
          i += 2;
          while (i < n && /[0-9a-fA-F]/.test(text[i]) && i - h < 4) i++;
          parts.push({ type: "hex", text: text.slice(h, i), quoted: false });
          continue;
        }
        i += 2;
        parts.push({ type: "escape", text: text.slice(e, Math.min(i, n)), quoted: false });
        continue;
      }
      if (c === "$") { scanExpansion(false); continue; }
      if (c === "`") { scanBacktick(false); continue; }
      // fd 前缀重定向（词中间週到）：仅当当前 word 尚无任何 part（即本词就是数字开头）
      // 且数字后紧跟 >/</& ——例：grep pat 2>err 中「pat」扫描完后週到「2>」，此时
      // 「2」是新词首。直接把 fd 数字+重定向符作为 op 发出，避免「2」成为独立词。
      if (/[0-9]/.test(c) && parts.length === 0) {
        let j = i;
        while (j < n && /[0-9]/.test(text[j])) j++;
        const after = text[j] ?? "";
        if (after === ">" || after === "<") {
          // 回退：把这个数字+重定向符作为 op 处理（含 >&N 形态）
          const opStart = i;
          i = j;
          const two2 = text.slice(i, i + 2);
          if (two2 === ">&" && /[0-9]/.test(text[i + 2] ?? "")) {
            i += 2;
            while (i < n && /[0-9]/.test(text[i])) i++;
            tokens.push({ type: "op", span: { start: opStart, end: i }, op: text.slice(opStart, i) });
          } else {
            i++;
            tokens.push({ type: "op", span: { start: opStart, end: i }, op: text.slice(opStart, i) });
          }
          return; // 本词无 part，不发 word（数字已入 op）
        }
      }
      const l = i;
      while (i < n && !breaksWord(text[i])) i++;
      if (i > l) parts.push({ type: "lit", text: text.slice(l, i), quoted: false });
      else i++; // 防御：不可达（breaksWord 已覆盖所有断词符）
    }
    // S4 防碎片爆炸：超限尾部折叠为单 unknown part + fail（词不可信 → 判定走兑底）
    if (parts.length > MAX_PARTS_PER_WORD) {
      parts = [parts[0], { type: "unknown", text: `<+${parts.length - 1}-parts:${text.slice(start, Math.min(i, start + 24))}…>`, quoted: false }];
      fail(`word-parts-overflow @${start} (${parts.length})`);
    }
    const word: Word = { span: { start, end: i }, parts, evaluated: parts.length ? evalWord(parts) : null };
    tokens.push({ type: "word", span: word.span, word });
    parts = [];
  };

  // ── 操作符识别（最长匹配；fd 前缀数字重定向；heredoc 先于 << 形态判定）──
  const scanHeredoc = (op: string, start: number): void => {
    i += op.length;
    let delimQuoted = false;
    let j = i;
    while (j < n && (text[j] === " " || text[j] === "\t")) j++;
    const q = text[j] ?? "";
    if (q === "'" || q === '"') {
      delimQuoted = true;
      const close = text.indexOf(q, j + 1);
      if (close === -1) {
        fail(`unclosed heredoc delim quote @${j}`);
        i = n;
        return;
      }
      const delim = text.slice(j + 1, close);
      const hd: HeredocToken = { op, delim, delimQuoted, bodySpan: null };
      pendingHeredocs.push(hd);
      i = close + 1;
      tokens.push({ type: "heredoc", span: { start, end: i }, heredoc: hd });
      return;
    }
    let k = j;
    while (k < n && /[A-Za-z0-9_-]/.test(text[k])) k++;
    if (k === j) { fail(`heredoc missing delim @${start}`); pushOp(op, start); return; }
    const delim = text.slice(j, k);
    const hd: HeredocToken = { op, delim, delimQuoted, bodySpan: null };
    pendingHeredocs.push(hd);
    i = k;
    tokens.push({ type: "heredoc", span: { start, end: i }, heredoc: hd });
  };

  const scanOperator = (): void => {
    const start = i;
    // fd 前缀：词首位置数字紧邻 >/</&（grep 2>file / kill 42877 2>&1）。
    // 直接在分支内完成消费（含 >&N 形态），不依赖后续通用匹配（否则 fd 数字丢失）。
    if (/[0-9]/.test(text[i])) {
      let j = i;
      while (j < n && /[0-9]/.test(text[j])) j++;
      const after = text[j] ?? "";
      if ((after === ">" || after === "<") && j > i) {
        i = j;
        const t2 = text.slice(i, i + 2);
        if ((t2 === ">&" || t2 === "<&") && /[0-9]/.test(text[i + 2] ?? "")) {
          i += 2;
          while (i < n && /[0-9]/.test(text[i])) i++;
        } else if (t2 === ">>" || t2 === ">|" || t2 === "<>") {
          i += 2;
        } else {
          i++; // 单字符 > 或 <
        }
        tokens.push({ type: "op", span: { start, end: i }, op: text.slice(start, i) });
        return;
      }
      scanWord();
      return;
    }
    const two = text.slice(i, i + 2);
    const three = text.slice(i, i + 3);
    if (three === "<<<" || three === ";;&") { i += 3; pushOp(three, start); return; }
    if (three === "<<-") { scanHeredoc("<<-", start); return; }
    if (two === "<<") { scanHeredoc("<<", start); return; }
    if (two === "&&" || two === "||" || two === ";;" || two === ";&"
      || two === ">>" || two === ">&" || two === "&>" || two === "<&" || two === "<>" || two === ">|") {
      // &>> 双字符族
      if (two === "&>" && text[i + 2] === ">") { i += 3; pushOp("&>>", start); return; }
      i += 2;
      if ((two === ">&" || two === "<&") && /[0-9]/.test(text[i] ?? "")) {
        // >&1 / <&0 的 fd 目标并入 op token（fd 复制不是文件写）
        while (i < n && /[0-9]/.test(text[i])) i++;
        pushOp(text.slice(start, i), start);
        return;
      }
      pushOp(two, start);
      return;
    }
    // 单字符操作符：| & ; ( ) < >
    const one = text[i];
    if (one === "|" || one === "&" || one === ";" || one === "(" || one === ")" || one === "<" || one === ">") {
      i++;
      pushOp(one, start);
      return;
    }
    // 防御兜底（不可达：主循环已路由）
    scanWord();
  };

  // ── 主循环 ──
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "\n") {
      pushOp("\n", i);
      i++;
      if (pendingHeredocs.length > 0) consumeHeredocBodies();
      continue;
    }
    if (c === "#") {
      // # 在主循环入口处必是词首（词内 # 已被 lit 吸收）→ 一律注释
      // （shell 语义：词首 # 后整行是注释；echo a#b 的 # 在词内，走不到这里）
      const start = i;
      while (i < n && text[i] !== "\n") i++;
      tokens.push({ type: "comment", span: { start, end: i }, text: text.slice(start, i) });
      continue;
    }
    if (c === "(" || c === ")" || c === "|" || c === "&" || c === ";" || c === "<" || c === ">" || /[0-9]/.test(c)) {
      // ( 前邻接 word → 函数定义形态（name() { … }）——排除区，fail-closed（D2/r1-S1）
      if (c === "(" && isWordStart(tokens) === false) {
        fail(`function-definition paren @${i}`);
      }
      scanOperator();
      continue;
    }
    scanWord();
  }
  if (pendingHeredocs.length > 0) {
    // 文本结束仍未触发体消费（无换行）——尝试消费（体可为空/未闭合）
    for (const hd of pendingHeredocs) {
      hd.bodySpan = null;
      fail(`heredoc body missing @delim=${hd.delim}`);
    }
  }
  if (truncated) fail(`input truncated >${MAX_INPUT}`);
  return { tokens, parseOk, issues };
}
