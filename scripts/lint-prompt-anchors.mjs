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
 *
 * 已知限制（审视发现 6/10，记录在案不阻塞）：stripTsComments 不解析正则字面量——
 * description 字符串内若含形如 /\d\// 的正则字面量，可能误吞其后内容致漏检；
 * name: 属性关闭状态机存在跨行窗口。当前注入面 description 全为纯文本，零实际漏检；
 * 若未来引入含正则字面量的 description，须先升级扫描器（用 TS parser 替代手写状态机）。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const ANCHOR_RE = /F20\d{6}[a-z0-9]{4}|#\d{3,}\b/g; // F+8位日期+4随机缀；issue 号不限位数（防年份到期静默失效）

/** #1089：hex 色值假阳性修复——色值（#000/#1a1a1a）与 issue 号（#419/#1089）结构同形，
 * 只能靠上下文判别：色值总伴随 CSS 语境词出现在匹配点之前（solid #000 / 底 #0a0a0a / 色块 #FFD400）。
 * 判别器宁漏放不误拦：漏放（真 issue 号恰好前文有 CSS 词）由白名单兑底，误拦（合法色值被拦）
 * 直接阻塞合法 commit（F20260921vsds 提交现场：词典色值 #000 被拦三道）。 */
const CSS_CONTEXT_RE = /(?:solid|shadow|gradient|background|color|border|fill|stroke|色|底|块|线条?)/i;

/** 判别单个 #\d{3,} 命中是否为 hex 色值（带上下文）：匹配点前 24 字符内含 CSS 语境词即视为色值。
 * 伪 3 位/6 位 hex 同形（#fff 与 #123 同合法），结构无法区分，只认上下文。 */
function isHexColorHit(line, hit) {
  const idx = line.indexOf(hit);
  if (idx < 0) return false;
  const before = line.slice(Math.max(0, idx - 24), idx);
  return CSS_CONTEXT_RE.test(before);
}
const WHITELIST_FILE = "scripts/prompt-anchor-whitelist.txt";
const WHITELIST_MAX = 10;

/** 扫描范围：默认 staged（pre-commit）；--full 全树注入面（CI 二道防线——staged-only 在 CI 空转，且存量变化永不再扫） */
const FULL_MODE = process.argv.includes("--full");
function stagedFiles() {
  try {
    if (FULL_MODE) {
      const out = execFileSync("git", ["-c", "core.quotepath=off", "ls-files"], { encoding: "utf8" }).trim();
      return out ? out.split("\n") : [];
    }
    const out = execFileSync("git", ["-c", "core.quotepath=off", "diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
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
    /^src\/.*\/tools\.ts$/.test(path) ||
    // 运行时注入模板（FALLBACK_PROMPT 类常量直拼进任务 body = 注入面）
    path === "src/usecases/scheduler/scheduler-service.ts"
  );
}

/** 白名单条目格式：path:linenum 或 path:linenum:token（token=该行应含的锚点原文）。
 *  带 token 时行内容失配（上游编辑致豁免静默转移）→ 视为失效并报 error，不 fail-open */
function loadWhitelist() {
  if (!existsSync(WHITELIST_FILE)) return [];
  return readFileSync(WHITELIST_FILE, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const parts = l.split(":");
      return { path: parts[0], line: parts[1], token: parts.slice(2).join(":") || null };
    });
}

function matchWhitelist(whitelist, path, lineNum, lineContent) {
  for (const w of whitelist) {
    if (w.path !== path) continue;
    if (w.line !== "*" && Number(w.line) !== lineNum) continue;
    if (w.token && !lineContent.includes(w.token)) return { stale: w };
    return { hit: w };
  }
  return null;
}

const files = stagedFiles();
if (!files) {
  console.log("[lint-prompt-anchors] 环境异常（无法取 staged 列表），宽松放行");
  process.exit(2);
}

const targets = files.filter(isInjectionSurface);
const whitelist = loadWhitelist();

if (whitelist.length > WHITELIST_MAX) {
  console.error(
    `[lint-prompt-anchors] 白名单超限：${whitelist.length} 条 > 上限 ${WHITELIST_MAX}。` +
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
const staleEntries = [];
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
    if (hits) {
      // #1089：滤掉带 CSS 语境的 hex 色值命中（F 编号不受影响——它无色值同形问题）
      const anchorHits = hits.filter((h) => h.startsWith("F20") || !isHexColorHit(line, h));
      if (anchorHits.length === 0) continue;
      const m = matchWhitelist(whitelist, file, i + 1, line);
      if (m?.stale) staleEntries.push({ file, line: i + 1, entry: m.stale });
      else if (!m?.hit) violations.push({ file, line: i + 1, hits: anchorHits });
    }
  }
}

if (staleEntries.length > 0) {
  console.error("[lint-prompt-anchors] 白名单条目失配（行内容已变，豁免失效——请核实后更新或删除条目）：");
  for (const s of staleEntries) console.error(`  ${s.file}:${s.line}  条目 token=${s.entry.token}`);
  process.exit(1);
}

if (violations.length === 0) {
  console.log(`[lint-prompt-anchors] 通过（扫描注入面文件 ${targets.length} 个（${FULL_MODE ? "全树" : "staged"} 模式），白名单 ${whitelist.length}/${WHITELIST_MAX}）`);
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
