#!/usr/bin/env node
/**
 * 注释编号禁绝闸：非特性文档的代码注释里不允许出现任何编号。
 *
 * 规则（搭档拍板）：特性编号（字母+8位日期+后缀形态）、检视轮次编号（中文动作词短语 /
 * round/轮形态 / 单字母序号）、issue 编号（井号+字母数字，色值不豁免）一律禁止。
 * 判据一句话——注释 why 用文字直接写清楚，编号是「跳去别处」的指针，没必要。
 *
 * 检测口径：PR 新增行 only（防复发）；存量分批整改由本特性链逐批清理。
 * 排除：特性文档目录（编号的家）、dist 产物、生成文件、纯 JSON、markdown。
 *
 * 注释识别（语言专用扫描器，全文持续状态）：
 *   - TS/JS 系：TypeScript createScanner——模板字符串/表达式、跨行块注释、正则、字符串全部
 *     由编译器级词法保证，不重复实现语法
 *   - YAML：# 仅在行首或空白后作注释（裸 URL 内的井号不误伤）
 *   - Shell：# 仅在词首或控制运算符后作注释
 *   - Python/TOML：# 行内即注释（引号外），三引号字符串跨行跳过（仅正常代码位置触发）
 *   - HTML：<!-- --> 跨行；CSS：斜杠星块注释跨行；SCSS/SASS/LESS：另加 // 行注释；均跳过字符串
 *
 * 行号定位：diff 新增行按新文件行号回查「全文词法标注」。
 * 读取失败 fail-closed：受支持的代码文件读不到即拒判，绝不静默放行。
 * 退出码：0 无违规（含纯删除变更）/ 1 违规 / 2 拒判（diff 完全为空或读取失败）。
 * 用法：node scripts/check-pr-anchor-discipline.mjs --base <ref> [--diff-file <path>]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

/** CSS 系语言（块注释；scss/sass/less 另有 // 行注释）。 */
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

/** issue 编号：井号+字母数字。色值不豁免——注释里写色值改用文字表述。 */
const ISSUE_CAND_RE = /\B#([0-9a-zA-Z]+)\b/g;
const REGION_DIRECTIVE_RE = /^(?:end)?region$/i;

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

  // issue 编号：井号+字母数字，排除 region/endregion 折叠指令
  ISSUE_CAND_RE.lastIndex = 0;
  for (const m of commentText.matchAll(ISSUE_CAND_RE)) {
    if (REGION_DIRECTIVE_RE.test(m[1])) continue;
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
    if (out.some((v) => v.kind === "轮次编号" && v.token === m[0])) continue;
    push(m[0], "轮次编号");
  }

  return out;
}

function countLines(content, pos) {
  return content.slice(0, pos).split("\n").length;
}

/** TS/JS 系：TypeScript 编译器级词法扫描，返回每行注释文本（1 基）。 */
function annotateTs(content) {
  const out = new Array(content.split("\n").length).fill(null);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ false, ts.ScriptKind.TSX, content);
  let token;
  while ((token = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      const pos = scanner.getTokenPos();
      const text = scanner.getTokenText();
      const startLine = countLines(content, pos);
      const parts = text.split("\n");
      for (let i = 0; i < parts.length; i++) {
        const idx = startLine - 1 + i;
        out[idx] = out[idx] == null ? parts[i] : `${out[idx]} ${parts[i]}`;
      }
    }
  }
  return out;
}

/** YAML：# 仅在行首或空白后作注释；块标量（| 或 >）缩进正文是字符串非注释。 */
function annotateYaml(content) {
  const lines = content.split("\n");
  const out = new Array(lines.length).fill(null);
  let blockIndent = null; // 块标量正文的最小缩进（父键缩进 + 1）
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (blockIndent != null) {
      if (line.trim() === "") {
        continue;
      }
      const indent = line.match(/^\s*/)[0].length;
      if (indent > blockIndent) continue; // 正文，非注释
      blockIndent = null; // 缩进回到父级，块标量结束，继续正常扫描
    }
    let state = "normal";
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (state === "normal") {
        if (ch === "'") state = "single";
        else if (ch === '"') state = "double";
        else if (ch === "#") {
          const prev = j === 0 ? " " : line[j - 1];
          if (prev === " " || prev === "\t") {
            out[i] = line.slice(j);
            break;
          }
        }
      } else if (state === "single") {
        if (ch === "'") {
          if (line[j + 1] === "'") j += 1;
          else state = "normal";
        }
      } else if (state === "double") {
        if (ch === "\\") j += 1;
        else if (ch === '"') state = "normal";
      }
    }
    // 块标量标记：行尾的 | 或 >（可选 +-），且在注释外
    if (out[i] == null) {
      const m = line.match(/(?:^|:\s*|\?\s*)[|>][+-]?\s*$/);
      if (m) blockIndent = (line.match(/^\s*/) || [""])[0].length;
    }
  }
  return out;
}

/** Shell：# 仅在词首或控制运算符后作注释；heredoc 正文是数据非注释。 */
function annotateSh(content) {
  const lines = content.split("\n");
  const out = new Array(lines.length).fill(null);
  let heredocDelim = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (heredocDelim != null) {
      out[i] = null; // heredoc 正文
      if (line.trim() === heredocDelim) heredocDelim = null;
      continue;
    }
    let state = "normal";
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (state === "normal") {
        if (ch === "'") state = "single";
        else if (ch === '"') state = "double";
        else if (ch === "#") {
          const prev = j === 0 ? "" : line[j - 1];
          if (j === 0 || /\s|;|&|\||\(|\)/.test(prev)) {
            out[i] = line.slice(j);
            break;
          }
        }
      } else if (state === "single") {
        if (ch === "'") state = "normal";
      } else if (state === "double") {
        if (ch === "\\") j += 1;
        else if (ch === '"') state = "normal";
      }
    }
    if (out[i] == null) {
      const heredocM = line.match(/<<-?\s*(?:'([^']+)'|"([^"]+)"|(\w+))/);
      if (heredocM) heredocDelim = heredocM[1] || heredocM[2] || heredocM[3];
    }
  }
  return out;
}

/** Python：# 行内即注释（引号外）；三引号字符串跨行跳过（仅正常代码位置触发）。 */
function annotatePython(content) {
  return annotatePyOrToml(content, /* tomlLiteral */ false);
}

/** TOML：# 行内即注释（引号外）；单引号 literal string 不转义反斜杠，三引号跨行跳过。 */
function annotateToml(content) {
  return annotatePyOrToml(content, /* tomlLiteral */ true);
}

/**
 * Python/TOML 共用：# 行内即注释（引号外）；三引号字符串跨行跳过（仅正常代码位置触发）。
 * tomlLiteral=true 时单引号字符串不把反斜杠当转义（TOML literal string 规则）。
 */
function annotatePyOrToml(content, tomlLiteral) {
  const lines = content.split("\n");
  const out = new Array(lines.length).fill(null);
  let inTriple = null; // 三引号定界符（""" 或 '''）
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let j = 0;
    if (inTriple) {
      const close = line.indexOf(inTriple);
      if (close < 0) continue; // 整行在三引号字符串内
      j = close + 3;
      inTriple = null;
    }
    let state = "normal";
    for (; j < line.length; j++) {
      const ch = line[j];
      if (state === "normal") {
        if ((ch === '"' || ch === "'") && line.startsWith(ch + ch + ch, j)) {
          const triple = ch + ch + ch;
          const rest = line.slice(j + 3);
          const closeInLine = rest.indexOf(triple);
          if (closeInLine >= 0) {
            j = j + 3 + closeInLine + 2; // 跳到闭合后
          } else {
            inTriple = triple;
            break; // 三引号 opener 之前无注释
          }
        } else if (ch === '"') state = "double";
        else if (ch === "'") state = "single";
        else if (ch === "#") {
          out[i] = line.slice(j);
          break;
        }
      } else if (state === "double") {
        if (ch === "\\") j += 1;
        else if (ch === '"') state = "normal";
      } else if (state === "single") {
        if (!tomlLiteral && ch === "\\") j += 1;
        else if (ch === "'") state = "normal";
      }
    }
  }
  return out;
}

/** HTML：<!-- --> 跨行。 */
function annotateHtml(content) {
  const lines = content.split("\n");
  const out = new Array(lines.length).fill(null);
  let inComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inComment) {
      out[i] = line;
      if (line.indexOf("-->") >= 0) inComment = false;
      continue;
    }
    const open = line.indexOf("<!--");
    if (open >= 0) {
      out[i] = line.slice(open);
      if (line.indexOf("-->", open + 4) < 0) inComment = true;
    }
  }
  return out;
}

/** CSS 系：斜杠星块注释跨行 + 引号字符串跳过；scss/sass/less 另加 // 行注释（URL scheme 的 // 不误判）。 */
function annotateCss(content, allowLineComment) {
  const lines = content.split("\n");
  const out = new Array(lines.length).fill(null);
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const comments = [];
    let state = "normal";
    let j = 0;
    if (inBlock) {
      const close = line.indexOf("*/");
      if (close < 0) {
        out[i] = line;
        continue;
      }
      comments.push(line.slice(0, close + 2));
      j = close + 2; // 闭合后继续扫描代码
      inBlock = false;
    }
    for (; j < line.length; j++) {
      const ch = line[j];
      const next = line[j + 1];
      if (state === "normal") {
        if (ch === "'") state = "single";
        else if (ch === '"') state = "double";
        else if (ch === "/" && next === "*") {
          const end = line.indexOf("*/", j + 2);
          if (end < 0) {
            comments.push(line.slice(j));
            inBlock = true;
            break;
          }
          comments.push(line.slice(j, end + 2));
          j = end + 1;
        } else if (allowLineComment && ch === "/" && next === "/") {
          // 行注释：URL scheme 的 //（前一个字符是冒号）不是注释
          const prev = j === 0 ? "" : line[j - 1];
          if (prev !== ":") {
            comments.push(line.slice(j));
            break;
          }
        }
      } else if (state === "single") {
        if (ch === "\\") j += 1;
        else if (ch === "'") state = "normal";
      } else if (state === "double") {
        if (ch === "\\") j += 1;
        else if (ch === '"') state = "normal";
      }
    }
    if (comments.length) out[i] = comments.join(" ");
  }
  return out;
}

/** 全文词法标注：返回行号(1 基) → 该行注释文本（跨行块注释体内行也标为注释）。 */
export function annotateFile(content, path) {
  if (isHtmlLang(path)) return annotateHtml(content);
  if (isCssLikeLang(path)) return annotateCss(content, /\.(scss|sass|less)$/.test(path));
  if (isHashCommentLang(path)) {
    if (/\.ya?ml$/.test(path)) return annotateYaml(content);
    if (/\.sh$/.test(path)) return annotateSh(content);
    if (/\.toml$/.test(path)) return annotateToml(content);
    return annotatePython(content);
  }
  return annotateTs(content);
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