#!/usr/bin/env node
/**
 * 存量注释编号清理器：删除代码注释里的特性/轮次/issue 编号，保留 why 文字。
 *
 * 与判定器（check-pr-anchor-discipline.mjs）共用同一套注释词法（annotateFileSegments）
 * 与同一套违规识别（collectAnchorViolationsWithIndex）——判定器认为违规的 token，本工具
 * 在注释内精确删除；两处不可能漂移。
 *
 * 删除口径：
 *   - 特性编号（字母+日期+后缀）、issue 编号（井号+数字）：删整个 token + 其后分隔符（冒号/空格/斜杠等）
 *   - 轮次编号：纯序号，或中文动作词+数字形态，整删；ASCII 序号+中文语境词只删序号留正文
 *   - 注释引导符后的连续空白压成单空格
 *   - 迭代删除：删完一轮后再收集，直到不再产生新违规（防止删中间 token 后前后文拼出新编号形态）
 *
 * 用法：
 *   node scripts/clean-comment-anchors.mjs --dry-run [paths...]   只打印，不写
 *   node scripts/clean-comment-anchors.mjs [paths...]             实际写入（默认全部受支持文件）
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  annotateFileSegments,
  collectAnchorViolationsWithIndex,
  isSupportedCodePath,
  isExcludedPath,
} from "./check-pr-anchor-discipline.mjs";

/** 编号与正文之间的分隔符 run（不含连字符/斜杠——它们可能是正文负号、路径）。 */
const SEP_RE = /^[\s：:、，,。→]+/;

/**
 * 清理一段注释文本。返回 { text, removed }——removed 为该段删除的违规 token 列表（统计用）。
 * 迭代执行：删除一轮后再收集，直到无违规，防止相邻 token 删除后拼出新编号形态。
 */
export function cleanCommentText(text) {
  let cur = text;
  const removedAll = [];
  for (let round = 0; round < 20; round++) {
    const violations = collectAnchorViolationsWithIndex(cur);
    if (violations.length === 0) break;
    const out = deleteOneRound(cur, violations);
    if (out.text === cur) break; // 不再变化，停止
    cur = out.text;
    removedAll.push(...out.removed);
  }
  return { text: cur, removed: removedAll };
}

/** 单轮删除：按违规位置从后往前删除。 */
function deleteOneRound(text, violations) {
  // 去重（同一 token 可能被多个正则命中）
  const seen = new Set();
  const uniq = violations.filter((v) => {
    const k = `${v.start}:${v.end}:${v.kind}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  uniq.sort((a, b) => b.start - a.start);

  const marks = [];
  const removed = [];
  for (const v of uniq) {
    let s = v.start;
    let e = v.end;
    let fullDelete = true;
    if (v.kind === "轮次编号") {
      // ASCII 序号 + 中文语境词（S1 修复）：只删序号与紧跟空白，保留中文正文
      const core = v.token.match(/^[SMNARr][0-9]{1,2}/);
      if (core && /[\u4e00-\u9fff]/.test(v.token.slice(core[0].length))) {
        const trailingWs = v.token.slice(core[0].length).match(/^\s*/)[0];
        e = v.start + core[0].length + trailingWs.length;
        fullDelete = false;
      }
    }
    if (v.kind === "issue 编号") {
      // 编号前的 issue/PR 引用语一并删除（词边界：要求是独立词，不截断 tissue 等）
      const prefix = text.slice(0, s);
      const pm = prefix.match(/(issue|Issue|PR|pr)\s*$/);
      if (pm) {
        const beforeIdx = s - pm[0].length - 1;
        const beforeCh = beforeIdx < 0 ? null : text[beforeIdx];
        if (beforeIdx < 0 || !/[A-Za-z]/.test(beforeCh)) {
          s -= pm[0].length;
        }
      }
      // 斜杠连接的 issue 列表（#N/#N/...）：后续数字项一并删除
      const tail = text.slice(e).match(/^(\/\s*[0-9]+)+/);
      if (tail) e += tail[0].length;
    }
    if (fullDelete) {
      const sep = text.slice(e).match(SEP_RE);
      if (sep) e += sep[0].length;
    }
    // 括号内内容删空时连空括号一起删（不全局删空括号，避免误伤 $() 等合法空括号）
    const swallow = swallowEmptyPair(text, s, e);
    if (swallow) {
      s = swallow.s;
      e = swallow.e;
    }
    marks.push([s, e]);
    removed.push(v.token);
  }

  // 合并重叠区间（相邻也算重叠，避免重复删除）
  const merged = [];
  for (const [s, e] of marks) {
    if (merged.length && merged[merged.length - 1][0] <= e) {
      const prev = merged[merged.length - 1];
      prev[0] = Math.min(prev[0], s);
      prev[1] = Math.max(prev[1], e);
    } else {
      merged.push([s, e]);
    }
  }

  let result = "";
  let prev = 0;
  merged.sort((a, b) => a[0] - b[0]);
  for (const [s, e] of merged) {
    if (s < prev) continue;
    result += text.slice(prev, s);
    prev = e;
  }
  result += text.slice(prev);
  return { text: tidyComment(result), removed };
}

/** 删除区间左右正好被成对括号包住（括号内即被删内容）时，返回吞括号后的区间。 */
function swallowEmptyPair(text, s, e) {
  if (s <= 0 || e >= text.length) return null;
  const close = text[s - 1] === "（" ? "）" : text[s - 1] === "(" ? ")" : text[s - 1] === "【" ? "】" : null;
  if (close && text[e] === close) return { s: s - 1, e: e + 1 };
  return null;
}

/** 注释引导符后的连续空白压成单空格，并清理删空后暴露的孤立冒号。 */
function tidyComment(text) {
  let t = text
    .replace(/^(#+)\s+/, "$1 ")
    .replace(/^(\/\/!?)\s+/, "$1 ")
    .replace(/^(\/\*+)\s+/, "$1 ")
    .replace(/^(\s*\*)\s+/, "$1 ")
    .replace(/\s+(\*+\/)$/, " $1");
  // 删空后暴露的孤立冒号/顿号（仅限注释引导符后）
  t = t.replace(/^((?:\/\/!?|#+|\/\*+|\*)\s*)[：:、]\s*/, "$1");
  // 双井号编号清单删除后残留的孤立斜杠（仅当后面是空白/中文，不误伤 /tmp 路径）
  t = t.replace(/^((?:\/\/!?|#+|\/\*+|\*)\s*)\/(?=\s|[\u4e00-\u9fff])/, "$1");
  return t;
}

/** 收集一个文件里的所有删除操作（按行、按段）。返回 [{line, start, end, before, after, removed}]。 */
function collectEdits(content, path) {
  const segs = annotateFileSegments(content, path);
  // 按行分组
  const byLine = new Map();
  for (const seg of segs) {
    if (!byLine.has(seg.line)) byLine.set(seg.line, []);
    byLine.get(seg.line).push(seg);
  }
  const edits = [];
  for (const [line, lineSegs] of byLine) {
    // 段按 start 降序处理，避免 offset 漂移
    const sorted = [...lineSegs].sort((a, b) => b.start - a.start);
    for (const seg of sorted) {
      const before = seg.text;
      const { text, removed } = cleanCommentText(before);
      if (text !== before) {
        edits.push({ line, start: seg.start, end: seg.end, before, after: text, removed });
      }
    }
  }
  // 恢复升序输出（供人读）
  edits.sort((a, b) => a.line - b.line || a.start - b.start);
  return edits;
}

/** 把 edits 应用到文件内容。 */
function applyEdits(content, edits) {
  const lines = content.split("\n");
  // 按行分组，行内按 start 降序
  const byLine = new Map();
  for (const e of edits) {
    if (!byLine.has(e.line)) byLine.set(e.line, []);
    byLine.get(e.line).push(e);
  }
  for (const [line, lineEdits] of byLine) {
    let t = lines[line];
    const sorted = [...lineEdits].sort((a, b) => b.start - a.start);
    for (const e of sorted) {
      t = t.slice(0, e.start) + e.after + t.slice(e.end);
    }
    lines[line] = t;
  }
  return lines.join("\n");
}

function listFiles() {
  const out = execFileSync("git", ["ls-files"], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 * 16 });
  return out.trim().split("\n").filter((f) => f);
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const explicit = args.filter((a) => a !== "--dry-run");
  const files = explicit.length ? explicit : listFiles();
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

  let touchedFiles = 0;
  let totalRemoved = 0;
  const samples = [];
  for (const f of files) {
    if (!isSupportedCodePath(f) || isExcludedPath(f)) continue;
    let content;
    try {
      content = readFileSync(`${root}/${f}`, "utf8");
    } catch {
      continue;
    }
    const edits = collectEdits(content, f);
    if (edits.length === 0) continue;
    touchedFiles += 1;
    let removed = 0;
    for (const e of edits) removed += e.removed.length;
    totalRemoved += removed;

    if (!dryRun) {
      writeFileSync(`${root}/${f}`, applyEdits(content, edits), "utf8");
    }
    for (const e of edits.slice(0, 3)) {
      if (samples.length < 120) samples.push(`${f}:${e.line + 1}\n  - ${e.before.trim()}\n  + ${e.after.trim()}`);
    }
  }

  console.log(`[clean-comment-anchors] ${dryRun ? "DRY-RUN " : ""}touched files: ${touchedFiles}, removed tokens: ${totalRemoved}`);
  if (samples.length) {
    console.log("\n抽样（前 120 条）：");
    console.log(samples.join("\n"));
  }
}

/** 直接执行保护：仅当作为 CLI 入口时执行（import 模块不产生写副作用）。 */
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
