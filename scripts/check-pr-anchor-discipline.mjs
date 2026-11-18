#!/usr/bin/env node
/**
 * 注释编号禁绝闸：非特性文档的代码注释里不允许出现任何编号。
 *
 * 规则（搭档拍板）：特性编号（字母+8位日期+后缀形态）、检视轮次编号（中文动作词短语 /
 * round/轮形态 / 单字母序号）、issue 编号（井号+数字）一律禁止。
 * 判据一句话——注释 why 用文字直接写清楚，编号是「跳去别处」的指针，没必要。
 *
 * 检测口径：PR 新增行 only（防复发）；存量分批整改由本特性链逐批清理。
 * 排除：特性文档目录（编号的家）、dist 产物、生成文件、纯 JSON、markdown。
 *
 * 注释识别（词法状态机，跳过字符串字面量）：TS/JS 系（行注释、块注释含跨行、模板字符串
 * 与表达式）、YAML/Shell/Python/Toml（井号注释：仅行首或空白后的 #；Python 三引号字符串
 * 跨行跳过）、HTML（<!-- --> 跨行）、CSS/SCSS（块注释符号，跨行）。
 *
 * 行号定位：diff 新增行按新文件行号回查「全文词法标注」——跨 hunk 的块注释体内行也能判。
 * 读取失败 fail-closed：受支持的代码文件读不到即拒判，绝不静默放行。
 * 退出码：0 无违规（含纯删除变更）/ 1 违规 / 2 拒判（diff 完全为空或读取失败）。
 * 用法：node scripts/check-pr-anchor-discipline.mjs --base <ref> [--diff-file <path>]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";

/** 排除路径。 */
export function isExcludedPath(p) {
  if (/^docs\/features\//.test(p)) return true;
  if (/(^|\/)dist\//.test(p) || /(^|\/)node_modules\//.test(p)) return true;
  if (/\.d\.ts$/.test(p)) return true;
  if (/\.json$/.test(p)) return true;
  if (/\.md$/.test(p)) return true;
  return false;
}

/** 井号注释语言（# 是注释导引符）。 */
export function isHashCommentLang(p) {
  return /\.(ya?ml|sh|py|toml)$/.test(p);
}

/** HTML 语言（<!-- -->）。 */
export function isHtmlLang(p) {
  return /\.html?$/.test(p);
}

/** CSS 系语言（斜杠星块注释，无行注释）。 */
export function isCssLikeLang(p) {
  return /\.(css|scss|sass|less)$/.test(p);
}

/** 支持的代码注释语言（用于判定是否可建立注释状态）。 */
export function isSupportedCodePath(p) {
  if (isHashCommentLang(p) || isHtmlLang(p) || isCssLikeLang(p)) return true;
  return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(p);
}

/** 特性编号：[FR] + 8 位日期 +（可选连字符）+ 4-10 位字母数字后缀。 */
export const FID_RE = /[FR]\d{8}-?[a-z0-9]{4,10}/g;

/** issue 编号：井号+十六进制字符序列；3/6/8 位视为十六进制色值豁免，其余为 issue 编号。 */
const ISSUE_CAND_RE = /\B#([0-9a-fA-F]+)\b/g;

/** 技术词豁免表：单字母+数字中的高置信技术词（芯片代际 / 存储桶 / 纸张规格）。 */
const TECH_TOKEN_RE = /\b(?:M[0-9]{1,2}|S3|A[1-4])\b/;

/** 检视轮次编号形态（过程编号）。 */
export const DISPOSITION_RES = [
  /** 中文动作词 × 处置词 × 序号 */
  /(?:审视|检视|复审|快审|终核|评审)\s*(?:修复|处置|发现|建议)\s*[0-9]+/g,
  /** round 形态 */
  /round[- ]?[0-9]+/gi,
  /** 第 N 轮 */
  /第\s*[0-9]+\s*轮/g,
  /** 检视/审视/复审/评审轮次 N */
  /(?:检视|审视|复审|评审)轮次\s*[0-9]+/g,
  /** 单字母序号紧跟处置语境（字符类与处置词共现） */
  /\b[SMNARr][0-9]{1,2}\s*(?:修复|处置|发现|建议|复核|确认|配套)/g,
  /** 发现/建议/严重 N 紧跟处置词 */
  /(?:发现|建议|严重)\s*[0-9]+\s*(?:处置|修复|配套|建议)/g,
];

/** 对一段注释文本收集违规编号。 */
export function collectAnchorViolations(commentText) {
  const out = [];
  const push = (token, kind) => out.push({ token, kind });

  for (const m of commentText.matchAll(FID_RE)) push(m[0], "特性编号");

  // issue 编号：色值（3/6/8 位 hex）豁免
  ISSUE_CAND_RE.lastIndex = 0;
  for (const m of commentText.matchAll(ISSUE_CAND_RE)) {
    const hex = m[1];
    if (hex.length === 3 || hex.length === 6 || hex.length === 8) continue;
    push(m[0], "issue 编号");
  }

  for (const re of DISPOSITION_RES) {
    re.lastIndex = 0;
    for (const m of commentText.matchAll(re)) push(m[0], "轮次编号");
  }

  // 孤立单字母序号仍禁，但高置信技术词（芯片代际 / 存储桶 / 纸张规格）豁免
  TECH_TOKEN_RE.lastIndex = 0;
  const singleRe = /\b[SMNAR][0-9]{1,2}\b/g;
  for (const m of commentText.matchAll(singleRe)) {
    if (TECH_TOKEN_RE.test(m[0])) continue;
    // 去重：已由处置语境正则收录的，避免重复
    if (out.some((v) => v.kind === "轮次编号" && v.token === m[0])) continue;
    push(m[0], "轮次编号");
  }

  return out;
}

/**
 * TS/JS 系行内扫描：返回 { comment, opensBlock }。comment 为行内所有注释片段拼接。
 * 状态机处理：单双引号、模板字符串及其 ${expr} 表达式（brace 深度）、行注释、单行块注释
 * （只取到闭合标记为止，其后的代码继续按状态扫描）。
 */
export function scanTsLine(line) {
  const comments = [];
  let state = "normal";
  let depth = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    const next = line[i + 1];
    if (state === "normal") {
      if (ch === "'") state = "single";
      else if (ch === '"') state = "double";
      else if (ch === "`") state = "template";
      else if (ch === "/" && next === "/") {
        comments.push(line.slice(i));
        break;
      } else if (ch === "/" && next === "*") {
        const end = line.indexOf("*/", i + 2);
        if (end < 0) {
          comments.push(line.slice(i));
          return { comment: comments.join(" "), opensBlock: true };
        }
        comments.push(line.slice(i, end + 2));
        i = end + 1;
      }
    } else if (state === "single") {
      if (ch === "\\") i += 1;
      else if (ch === "'") state = "normal";
    } else if (state === "double") {
      if (ch === "\\") i += 1;
      else if (ch === '"') state = "normal";
    } else if (state === "template") {
      if (ch === "\\") i += 1;
      else if (ch === "`") state = "normal";
      else if (ch === "$" && next === "{") { state = "expr"; depth = 0; i += 1; }
    } else if (state === "expr") {
      if (ch === "'") state = "exprSingle";
      else if (ch === '"') state = "exprDouble";
      else if (ch === "`") state = "exprTemplate";
      else if (ch === "{") depth += 1;
      else if (ch === "}") { if (depth === 0) state = "template"; else depth -= 1; }
    } else if (state === "exprSingle") {
      if (ch === "\\") i += 1;
      else if (ch === "'") state = "expr";
    } else if (state === "exprDouble") {
      if (ch === "\\") i += 1;
      else if (ch === '"') state = "expr";
    } else if (state === "exprTemplate") {
      if (ch === "\\") i += 1;
      else if (ch === "`") state = "expr";
    }
    i += 1;
  }
  return { comment: comments.length ? comments.join(" ") : null, opensBlock: false };
}

/** Hash 语言行内扫描：跳过引号字符串后找 #（仅行首或空白后的 # 才作注释，避免裸 URL 误伤）。 */
export function scanHashLine(line) {
  let state = "normal";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (state === "normal") {
      if (ch === "'") state = "single";
      else if (ch === '"') state = "double";
      else if (ch === "#") {
        const prev = i === 0 ? " " : line[i - 1];
        if (prev === " " || prev === "\t") return { comment: line.slice(i) };
      }
    } else if (state === "single") {
      if (ch === "\\") i += 1;
      else if (ch === "'") state = "normal";
    } else if (state === "double") {
      if (ch === "\\") i += 1;
      else if (ch === '"') state = "normal";
    }
  }
  return { comment: null };
}

/** CSS 系行内扫描：仅块注释。 */
export function scanCssLine(line) {
  const comments = [];
  let i = 0;
  while (i < line.length) {
    const open = line.indexOf("/*", i);
    if (open < 0) break;
    const end = line.indexOf("*/", open + 2);
    if (end < 0) {
      comments.push(line.slice(open));
      return { comment: comments.join(" "), opensBlock: true };
    }
    comments.push(line.slice(open, end + 2));
    i = end + 2;
  }
  return { comment: comments.length ? comments.join(" ") : null, opensBlock: false };
}

/** 全文词法标注：返回行号(1 基) → 该行注释文本（跨行块注释体内行也标为注释）。 */
export function annotateFile(content, path) {
  const lines = content.split("\n");
  const out = new Array(lines.length).fill(null);
  const isHtml = isHtmlLang(path);
  const isHash = isHashCommentLang(path);
  const isCss = isCssLikeLang(path);

  let inBlock = false;
  let blockKind = null; // "ts" | "html" | "css" | "pyTriple"
  let pyTripleQuote = null; // """ or '''

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (inBlock) {
      out[li] = line;
      if (blockKind === "ts" || blockKind === "css") {
        if (line.indexOf("*/") >= 0) inBlock = false;
      } else if (blockKind === "html") {
        if (line.indexOf("-->") >= 0) inBlock = false;
      } else if (blockKind === "pyTriple") {
        if (line.indexOf(pyTripleQuote) >= 0) inBlock = false;
      }
      continue;
    }
    if (isHtml) {
      const open = line.indexOf("<!--");
      if (open >= 0) {
        out[li] = line.slice(open);
        if (line.indexOf("-->", open + 4) < 0) { inBlock = true; blockKind = "html"; }
      }
      continue;
    }
    if (isCss) {
      const { comment, opensBlock } = scanCssLine(line);
      if (comment) out[li] = comment;
      if (opensBlock) { inBlock = true; blockKind = "css"; }
      continue;
    }
    if (isHash) {
      // Python 三引号字符串跨行：正文非注释；闭合后继续扫
      if (pyTripleQuote) {
        const endIdx = line.indexOf(pyTripleQuote);
        if (endIdx >= 0) {
          const { comment } = scanHashLine(line.slice(endIdx + 3));
          if (comment) out[li] = comment;
          pyTripleQuote = null;
        }
        continue;
      }
      const tripleMatch = line.match(/"""|'''/);
      if (tripleMatch) {
        const q = tripleMatch[1] ?? tripleMatch[0];
        const after = line.slice((tripleMatch.index ?? 0) + 3);
        if (after.includes(q)) {
          const closeIdx = after.indexOf(q) + 3;
          const { comment } = scanHashLine(line.slice((tripleMatch.index ?? 0) + 3 + closeIdx));
          if (comment) out[li] = comment;
        } else {
          pyTripleQuote = q;
          const { comment } = scanHashLine(line.slice(0, tripleMatch.index ?? 0));
          if (comment) out[li] = comment;
        }
        continue;
      }
      const { comment } = scanHashLine(line);
      if (comment) out[li] = comment;
      continue;
    }
    // TS/JS 系
    const { comment, opensBlock } = scanTsLine(line);
    if (comment) out[li] = comment;
    if (opensBlock) { inBlock = true; blockKind = "ts"; }
  }
  return out;
}

/** 解码 Git C 风格引号路径（\ooo 八进制字节序列按 UTF-8 还原）。失败抛错。 */
export function decodeCQuotedPath(s) {
  let latin1 = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      if (/[0-7]/.test(s[i + 1])) {
        const m = s.slice(i + 1, i + 4).match(/^[0-7]{1,3}/);
        if (!m) throw new Error("bad octal escape");
        latin1 += String.fromCharCode(parseInt(m[0], 8));
        i += m[0].length;
      } else if (s[i + 1] !== undefined) {
        latin1 += s[i + 1];
        i += 1;
      } else {
        throw new Error("trailing backslash");
      }
    } else {
      if (ch.charCodeAt(0) > 0x7f) throw new Error("unexpected non-ascii in quoted path");
      latin1 += ch;
    }
  }
  return Buffer.from(latin1, "latin1").toString("utf8");
}

/** 解析 unified diff（--unified=0）新增行。带引号路径（中文等）解码；无法识别的文件头抛错。 */
export function parseDiffAddedLines(diffText) {
  const out = [];
  const files = new Set();
  let path = null;
  let newLine = 0;
  let seenHunk = false;
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const rest = raw.slice(4);
      if (rest.startsWith('"')) {
        const end = rest.lastIndexOf('"');
        if (end <= 0) throw new Error(`无法解析带引号文件头：${raw}`);
        path = decodeCQuotedPath(rest.slice(1, end));
      } else {
        path = rest;
      }
      if (path.startsWith("b/")) path = path.slice(2);
      else if (path.startsWith("a/")) path = path.slice(2);
      files.add(path);
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    if (raw.startsWith("@@")) {
      seenHunk = true;
      const m = raw.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      newLine = m ? Number(m[1]) : 0;
      continue;
    }
    if (path == null) continue;
    if (raw.startsWith("+")) {
      out.push({ path, line: newLine, content: raw.slice(1) });
      newLine += 1;
    } else if (raw.startsWith("-")) {
      // 删除行不推进新文件行号
    } else {
      newLine += 1;
    }
  }
  return { added: out, files: [...files], diffNonEmpty: seenHunk || files.length > 0 };
}

/** 默认读 HEAD 版本文件内容（与 git diff origin/main...HEAD 的行号同源；工作区脏时不错位）。 */
function readHeadFile(p) {
  return execFileSync("git", ["show", `HEAD:${p}`], { encoding: "utf8", timeout: 30_000 });
}

/**
 * 对 diff 全量判定。readFileFn 用于按新文件行号读全文；测试注入。
 * 受支持的代码文件读取失败时抛错（fail-closed，由调用方转 exit 2）。
 */
export function checkDiff(diffText, readFileFn = readHeadFile) {
  const { added, diffNonEmpty } = parseDiffAddedLines(diffText);
  if (!diffNonEmpty) return { addedTotal: 0, diffNonEmpty: false, violations: [] };

  const cache = new Map();
  const annotate = (p) => {
    if (cache.has(p)) return cache.get(p);
    let ann;
    try {
      ann = annotateFile(readFileFn(p), p);
    } catch (err) {
      throw new Error(`读取文件失败（fail-closed）：${p} —— ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    cache.set(p, ann);
    return ann;
  };

  const violations = [];
  for (const { path, line, content } of added) {
    if (isExcludedPath(path) || !isSupportedCodePath(path)) continue;
    const ann = annotate(path);
    const commentText = ann[line - 1] ?? null;
    if (!commentText) continue;
    for (const v of collectAnchorViolations(commentText)) {
      violations.push({ path, line, content: content.trim(), ...v });
    }
  }
  return { addedTotal: added.length, diffNonEmpty: true, violations };
}

function main() {
  const args = process.argv.slice(2);
  let base = "origin/main";
  let diffFile = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base") base = args[++i];
    else if (args[i] === "--diff-file") diffFile = args[++i];
  }

  let diffText;
  try {
    diffText = diffFile
      ? readFileSync(diffFile, "utf8")
      : execFileSync("git", ["diff", "--unified=0", `${base}...HEAD`], {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 1024 * 1024 * 64,
        });
  } catch (err) {
    console.error(`[check-pr-anchor-discipline] 获取 diff 失败（拒判，fail-closed）：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }

  let result;
  try {
    result = checkDiff(diffText);
  } catch (err) {
    console.error(`[check-pr-anchor-discipline] 判定失败（拒判，fail-closed）：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }

  if (!result.diffNonEmpty) {
    console.error("[check-pr-anchor-discipline] 空判定面（diff 无变更）——拒判不作「无违规」放行");
    process.exitCode = 2;
    return;
  }
  if (result.violations.length === 0) {
    if (result.addedTotal === 0) {
      console.log("✅ 注释编号禁绝：纯删除变更（无新增行），无可检测对象，放行");
    } else {
      console.log("✅ 注释编号禁绝：新增注释行无特性/轮次/issue 编号");
    }
    process.exitCode = 0;
    return;
  }
  console.log(`❌ 注释编号禁绝：新增注释行夹带编号 ${result.violations.length} 处（非特性文档注释不允许出现任何编号）：`);
  for (const v of result.violations) {
    console.log(`   - ${v.path}:${v.line}  [${v.kind}] ${v.token}  ← ${v.content}`);
  }
  process.exitCode = 1;
}

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