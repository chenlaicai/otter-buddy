/**
 * 命令结构模型（F20260928grv2，guard-v2-redesign）。
 *
 * 词法层 token 流 → 结构化命令模型（segments / argv / 重定向 / cd 链 / 递归载荷），
 * 全部判定层消费本模型而非原始文本（方案 §3.2「parse once, judge everywhere」）。
 *
 * 递归消费（方案 D2）：cmdsub/backtick/进程替换/bash -c 与 sh -c 载荷递归解析，
 * 深度上限 2（超过 → 载荷不可知，判定层保守拦）；heredoc 裸定界符体按危险通道
 * 递归（引号定界=绝对数据）。
 */
/* eslint-disable max-lines-per-function, max-statements, complexity, max-depth */

import { lex, type Token, type Word } from "./command-lexer";

// ────────────────────────────── 类型 ──────────────────────────────

export interface RedirTarget {
  op: string;          // > >> 2> &> >| <> < << <<< &>>
  target: string | null; // evaluated 目标词；null=不可求值（$VAR 目标等）
}

export interface Segment {
  /** argv[0] 求值结果（null=不可求值/无词） */
  argv0: string | null;
  /** 求值后的参数词（含 argv0 之外的词；不可求值词为 null 占位） */
  args: Array<string | null>;
  /** 原始词对象（保 span/parts 供细判定层用） */
  words: Word[];
  /** 段内重定向（含 fd 前缀） */
  redirects: RedirTarget[];
  /** 赋值前缀 W=/path（Ad1：独立段表示——赋值不进 args） */
  assignments: Array<{ name: string; value: string | null }>;
  /** 本段是子 shell 组（(...) 包裹） */
  subshell: boolean;
  /** 段间连接符（上游段→本段）：&& || ; | & \n 或 ""（首段） */
  joiner: string;
}

export interface Payload {
  /** 载荷词元（供文案/诊断） */
  raw: string;
  /** 递归解析的子模型（null=深度超限/不可解析——判定层保守处理） */
  model: CommandModel | null;
  /** 载荷种类 */
  kind: "cmdsub" | "backtick" | "bash-c" | "procsub" | "heredoc-bare" | "heredoc-quoted";
  depth: number;
}

export interface CommandModel {
  segments: Segment[];
  payloads: Payload[];
  parseOk: boolean;    // 词法层 + 递归层全成功
  issues: string[];
}

// ────────────────────────────── 常量 ──────────────────────────────

/** 段连接符操作符集合 */
const JOINERS = new Set(["&&", "||", ";", "|", "&", "\n", ";&", ";;", ";;&", "|&"]);

/** 重定向操作符（含 fd 前缀形态判别：op 形如 "2>" "2>&1" ">" ">>" "&>" 等） */
function isRedirOp(op: string): boolean {
  const bare = op.replace(/^[0-9]+/, "");
  return [">", ">>", "<", "<<", "<<<", "&>", "&>>", ">|", "<>", ">&", "<&"].includes(bare)
    || (op.startsWith("2>") || op.startsWith("1>") || op.startsWith("0<"));
}

/** bash -c / sh -c 载荷识别（方案 D5 矩阵 #8/#10） */
const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
/** 脚本载荷解释器（one-liner 执行通道） */
const SCRIPT_RUNNERS = new Set(["python", "python3", "node", "perl", "ruby", "osascript"]);

/** cmdsub 递归深度上限（D2/S2：≤2 层，超限=载荷不可知） */
const MAX_DEPTH = 2;

// ────────────────────────────── 解析 ──────────────────────────────

/** token 流 → segments。括号组展开为 subshell 段。 */
function buildSegments(tokens: Token[], text: string): { segments: Segment[]; subshellPayloads: Payload[] } {
  const segments: Segment[] = [];
  const subshellPayloads: Payload[] = [];
  let cur: Segment = emptySegment("");
  let i = 0;

  function emptySegment(joiner: string): Segment {
    return { argv0: null, args: [], words: [], redirects: [], assignments: [], subshell: false, joiner };
  }

  function flushSegment(nextJoiner: string): void {
    // 赋值前缀拆分：词形 NAME=value 且位于词流前部 → assignment
    finalizeAssignments(cur);
    if (cur.words.length > 0 || cur.redirects.length > 0 || cur.assignments.length > 0 || cur.subshell) {
      cur.argv0 = cur.words[0]?.evaluated ?? null;
      segments.push(cur);
    }
    cur = emptySegment(nextJoiner);
  }

  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === "word") {
      cur.words.push(t.word!);
      i++;
      continue;
    }
    if (t.type === "op") {
      const op = t.op!;
      if (op === "(") {
        // 子 shell 组：收集到匹配 )，组内文本递归为 payload + 展开为段
        const inner = collectParenBody(tokens, i, text);
        // 括号前的段先落盘（joiner=即将到来的连接符语义：组首段继承当前 pending joiner）
        const pendingJoiner = cur.joiner;
        const hasContent = cur.words.length > 0 || cur.redirects.length > 0 || cur.assignments.length > 0;
        if (hasContent) {
          finalizeAssignments(cur);
          cur.argv0 = cur.words[0]?.evaluated ?? null;
          cur.args = cur.words.slice(1).map(w => w.evaluated);
          segments.push(cur);
        }
        if (inner.model) {
          // 组内 segments 就地展开（首段继承括号前 joiner；后续段保留组内 joiner）
          inner.model.segments.forEach((seg, idx) => {
            const s = { ...seg, subshell: true, joiner: idx === 0 ? pendingJoiner : seg.joiner };
            segments.push(s);
          });
          subshellPayloads.push(...inner.model.payloads);
        } else {
          subshellPayloads.push({ raw: inner.raw, model: null, kind: "procsub", depth: 1 });
        }
        i = inner.nextIdx;
        continue;
      }
      if (op === ")") { i++; continue; } // 已在 collectParenBody 消费（防御）
      if (JOINERS.has(op)) {
        flushSegment(op);
        i++;
        continue;
      }
      if (isRedirOp(op)) {
        // 重定向目标=下一 word（若有）
        const nextT = tokens[i + 1];
        let target: string | null = null;
        if (nextT && nextT.type === "word") {
          target = nextT.word!.evaluated;
          i++; // 消费目标词
        }
        cur.redirects.push({ op, target });
        i++;
        continue;
      }
      // 其他操作符（防御：不该到这里）——当作段分隔
      flushSegment(op);
      i++;
      continue;
    }
    if (t.type === "heredoc") {
      // heredoc 载荷在模型层统一收集（见 collectPayloads）——这里不处理
      i++;
      continue;
    }
    if (t.type === "comment") { i++; continue; }
    i++;
  }
  flushSegment("");
  return { segments, subshellPayloads };
}

/** 从 tokens[start]（= "("）收集到匹配 ")"，返回组内文本与递归模型 */
function collectParenBody(tokens: Token[], start: number, text: string): { raw: string; model: CommandModel | null; nextIdx: number } {
  let depth = 0;
  let j = start;
  let openSpan = -1;
  let closeSpan = -1;
  while (j < tokens.length) {
    const t = tokens[j];
    if (t.type === "op" && t.op === "(") {
      if (depth === 0) openSpan = t.span.start;
      depth++;
    } else if (t.type === "op" && t.op === ")") {
      depth--;
      if (depth === 0) { closeSpan = t.span.end; break; }
    }
    j++;
  }
  if (closeSpan === -1) {
    // 未闭合：剩余全部当组体（词法层应已 fail，这里防御）
    return { raw: text.slice(tokens[start].span.start), model: null, nextIdx: tokens.length };
  }
  const raw = text.slice(openSpan + 1, closeSpan - 1);
  const model = parseOnce(raw, 1);
  return { raw, model, nextIdx: j + 1 };
}

/** 赋值前缀拆分（Ad1）：词流前部 NAME=value 形态词 → assignments */
function finalizeAssignments(seg: Segment): void {
  // 只有在 argv0 位置之前的连续 NAME=value 词才是赋值前缀；
  // 词流中间的 NAME=value（如 env 风格）也按前缀处理（env VAR=1 cmd 的语义近似）
  while (seg.words.length > 0) {
    const w = seg.words[0];
    const m = matchAssignment(w);
    if (m && seg.argv0 === null) {
      seg.assignments.push(m);
      seg.words = seg.words.slice(1);
    } else {
      break;
    }
  }
}

function matchAssignment(w: Word): { name: string; value: string | null } | null {
  if (w.evaluated === null) return null;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(w.evaluated);
  if (!m) return null;
  return { name: m[1], value: m[2] === "" ? "" : m[2] };
}

// ────────────────────────────── 载荷收集与递归 ──────────────────────────────

/** 全词扫描：cmdsub/backtick part + bash -c 载荷 + heredoc 体 → 递归 payload */
function collectPayloads(tokens: Token[], text: string, depth: number): { payloads: Payload[]; parseOk: boolean } {
  const payloads: Payload[] = [];
  let parseOk = true;

  for (const t of tokens) {
    if (t.type === "word") {
      for (const p of t.word!.parts) {
        if (p.type === "cmdsub") {
          if (depth >= MAX_DEPTH) {
            payloads.push({ raw: p.text, model: null, kind: "cmdsub", depth });
            parseOk = false; // 深度超限=载荷不可知（D2：保守，判定层兜底）
          } else {
            const sub = parseOnce(p.text, depth + 1);
            payloads.push({ raw: p.text, model: sub, kind: "cmdsub", depth: depth + 1 });
            if (!sub.parseOk) parseOk = false;
          }
        }
      }
      continue;
    }
    if (t.type === "heredoc") {
      const hd = t.heredoc!;
      if (hd.bodySpan) {
        const body = text.slice(hd.bodySpan.start, hd.bodySpan.end);
        // 引号定界=绝对数据（不递归）；裸定界=可展开危险通道（递归）
        if (!hd.delimQuoted) {
          if (depth >= MAX_DEPTH) {
            payloads.push({ raw: body, model: null, kind: "heredoc-bare", depth });
            parseOk = false;
          } else {
            const sub = parseOnce(body, depth + 1);
            payloads.push({ raw: body, model: sub, kind: "heredoc-bare", depth: depth + 1 });
            if (!sub.parseOk) parseOk = false;
          }
        } else {
          payloads.push({ raw: body, model: null, kind: "heredoc-quoted", depth });
        }
      } else {
        parseOk = false; // 未闭合 heredoc（词法层已 fail，双重保险）
      }
      continue;
    }
    // 进程替换 <( ) >( )：词法层把它们归入 op/( ) 序列——由 buildSegments 的括号路径处理
  }
  // bash -c 载荷（段级）：在 buildSegments 后由上层补充——见 parseOnce
  return { payloads, parseOk };
}

/** 词是否是解释器载荷调用（bash -c 'cmd' / python -c 'code'）→ 返回载荷文本 */
function matchInterpreterPayload(argv0: string | null, args: Array<string | null>, words: Word[]): { raw: string; kind: Payload["kind"] } | null {
  if (argv0 === null) return null;
  const bare = argv0.split("/").pop() ?? argv0;
  if (SHELL_INTERPRETERS.has(bare)) {
    // bash -c 'payload'：-c 后第一个词（引号内）是载荷
    // args[0]=argv0 之外首个参数？注意：Segment.args 含除 argv0 外全部词
    const flagIdx = words.findIndex((w, idx) => idx > 0 && w.evaluated === "-c");
    if (flagIdx >= 0 && words[flagIdx + 1]) {
      return { raw: words[flagIdx + 1].parts.map(p => p.type === "lit" || p.type === "escape" ? p.text : "").join("") || words[flagIdx + 1].evaluated || "", kind: "bash-c" };
    }
    // bash file.sh（无 -c）：脚本文件形态（V2 白名单新拦项 U5——判定层处理，模型只记录 argv）
    return null;
    }
  if (SCRIPT_RUNNERS.has(bare)) {
    const flagIdx = words.findIndex((w, idx) => idx > 0 && (w.evaluated === "-c" || w.evaluated === "-e"));
    if (flagIdx >= 0 && words[flagIdx + 1]) {
      return { raw: words[flagIdx + 1].evaluated ?? "", kind: "cmdsub" };
    }
  }
  return null;
}

// ────────────────────────────── 主入口 ──────────────────────────────

/** parse once：词法 + 分段 + 载荷递归 → CommandModel。depth 内部用。 */
export function parseOnce(text: string, depth = 0): CommandModel {
  const lexed = lex(text);
  const issues = [...lexed.issues];
  let parseOk = lexed.parseOk;

  const { segments, subshellPayloads } = buildSegments(lexed.tokens, text);
  const collected = collectPayloads(lexed.tokens, text, depth);
  if (!collected.parseOk) parseOk = false;
  issues.push(...collected.payloads.filter(p => p.model === null && p.kind !== "heredoc-quoted").map(p => `payload-unparseable:${p.kind}`));

  // bash -c / 脚本解释器载荷：段级补充递归
  const payloads = [...collected.payloads, ...subshellPayloads];
  for (const seg of segments) {
    const interp = matchInterpreterPayload(seg.argv0, seg.args, seg.words);
    if (interp) {
      if (depth >= MAX_DEPTH) {
        payloads.push({ raw: interp.raw, model: null, kind: interp.kind, depth });
        parseOk = false;
      } else {
        const sub = parseOnce(interp.raw, depth + 1);
        payloads.push({ raw: interp.raw, model: sub, kind: interp.kind, depth: depth + 1 });
        if (!sub.parseOk) parseOk = false;
      }
    }
    // args 填充
    seg.args = seg.words.slice(1).map(w => w.evaluated);
  }

  return { segments, payloads, parseOk, issues };
}
