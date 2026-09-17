#!/usr/bin/env node
/**
 * prompt/skill/tool 锚点污染 gate（commit-time）。
 *
 * 规则：每轮注入面（.pi/SYSTEM.md、prompts/**、.pi/skills/**、src/**\/*ools*描述字面量）
 * 禁止写入 F 编号（F2026xxxx）与 issue 锚点（#123）——它们是出处/决策史，
 * 出处归特性文档 frontmatter causal_links 与 git 历史，不进每轮注入的 prompt。
 *
 * 豁免：白名单文件 scripts/prompt-anchor-whitelist.txt（每行一条 path:linenum 或
 * path:* 整体豁免），条目数硬上限 10——超限 error。白名单治理与判据见特性文档。
 *
 * 背景判据：内容对每轮行为的真实牵引力（删掉会改变行为吗）。
 * 教训段三要素（现象/后果/定位）不含编号要求——剥编号留现场，零牵引力损失。
 *
 * 退出码：0 通过 / 1 有违规 / 2 环境异常（宽松放行，不误伤）。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const ANCHOR_RE = /F2026\d{4}[a-z0-9]{4}|#\d{3,4}\b/g;
const WHITELIST_FILE = "scripts/prompt-anchor-whitelist.txt";
const WHITELIST_MAX = 10;

/** 扫描范围：staged 文件中属于注入面的 */
function stagedFiles() {
  try {
    const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
      encoding: "utf8",
    }).trim();
    return out ? out.split("\n") : [];
  } catch {
    return null; // 环境异常 → 宽松放行
  }
}

function isInjectionSurface(path) {
  return (
    path === ".pi/SYSTEM.md" ||
    path.startsWith("prompts/") ||
    (path.startsWith(".pi/skills/") && path.endsWith(".md")) ||
    /^src\/.*\/tools\/[^/]+\.ts$/.test(path) ||
    /^src\/.*\/tools\.ts$/.test(path)
  );
}

function loadWhitelist() {
  if (!existsSync(WHITELIST_FILE)) return new Set();
  const lines = readFileSync(WHITELIST_FILE, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  return new Set(lines);
}

function isWhitelisted(whitelist, path, lineNum) {
  return whitelist.has(`${path}:*`) || whitelist.has(`${path}:${lineNum}`);
}

const files = stagedFiles();
if (!files) {
  console.log("[lint-prompt-anchors] 环境异常（无法取 staged 列表），宽松放行");
  process.exit(2);
}

const targets = files.filter(isInjectionSurface);
const whitelist = loadWhitelist();

if (whitelist.size > WHITELIST_MAX) {
  console.error(
    `[lint-prompt-anchors] 白名单超限：${whitelist.size} 条 > 上限 ${WHITELIST_MAX}。` +
      `删旧才能加新——白名单只加不审 = gate 空转（治理判据见特性文档）`
  );
  process.exit(1);
}

/** 剥离 TS 源码中的注释（块注释+行注释），保留字符串字面量——锚点在注释里是合法的决策史归位 */
function stripTsComments(src) {
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
    out += c;
    i++;
  }
  return out;
}

const violations = [];
for (const file of targets) {
  if (!existsSync(file)) continue;
  let content = readFileSync(file, "utf8");
  if (file.endsWith(".ts")) content = stripTsComments(content);
  const lines = content.split("\n");
  let inDesc = file.endsWith(".ts") ? false : true; // md 文件全文扫
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (file.endsWith(".ts")) {
      if (/description\s*:/.test(line)) inDesc = true;
      if (!inDesc) continue;
      if (/^\s*(parameters|name)\s*:/.test(line)) inDesc = false;
    }
    const hits = line.match(ANCHOR_RE);
    if (hits && !isWhitelisted(whitelist, file, i + 1)) {
      violations.push({ file, line: i + 1, hits });
    }
  }
}

if (violations.length === 0) {
  console.log(`[lint-prompt-anchors] 通过（扫描注入面文件 ${targets.length} 个，白名单 ${whitelist.size}/${WHITELIST_MAX}）`);
  process.exit(0);
}

console.error("[lint-prompt-anchors] 发现注入面锚点（F 编号/issue 号）：");
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  ${v.hits.join(", ")}`);
}
console.error(`
判据：锚点是出处/决策史，不进每轮注入的 prompt——出处归特性文档 frontmatter
causal_links 与 git 历史。教训段三要素（现象/后果/定位）不需要编号 token。

处置（二选一）：
  1. 剥编号留内容：删掉锚点 token，保留行为指令/教训现场本体（推荐，零牵引力损失）
  2. 白名单豁免：确属「指令本身依赖编号语义」的出处型内容，写入
     ${WHITELIST_FILE}（格式 path:linenum，附评审理由注释，上限 ${WHITELIST_MAX} 条）
`);
process.exit(1);
