#!/usr/bin/env node
/**
 * 注释编号禁绝闸：非特性文档的代码注释里不允许出现任何编号。
 *
 * 规则（搭档拍板）：特性编号（字母+8位日期+后缀形态）、检视轮次编号（单字母序号 / 中文动作词+序号 等
 * 含序号的短语）、issue 编号（井号+数字）一律禁止。判据一句话——注释 why 用文字直接写清楚，
 * 编号是「跳去别处」的指针，没必要。
 *
 * 检测口径：PR 新增行 only（防复发）；存量的分批整改由本特性链逐批清理，不绑每次开发。
 * 排除：特性文档目录（编号的家）、dist 产物、锁文件与生成文件、纯 JSON（无注释语法）、markdown（另行规范）。
 * 注释识别：TS/JS 系（//、块注释、块注释 body 行的导引符前缀）；YAML/Shell/Python/Toml 的井号注释。
 *
 * 注：本文件自身遵守本规则——规则描述不写编号示例；正则模式字符串是代码字面量，不属注释。
 *
 * 退出码：0 无违规 / 1 违规（列出 文件:行 → 编号类型）/ 2 拒判（diff 为空——空判定面不放行）。
 * 用法：node scripts/check-pr-anchor-discipline.mjs --base <ref> [--diff-file <path>]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 排除路径：特性文档、dist 产物、锁文件、生成文件、纯 JSON、markdown。 */
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

/** 提取一行内的注释文本；无注释返回 null。TS/JS 块注释 body 行的导引符前缀视为注释。 */
export function extractCommentText(line, hashLang) {
  if (hashLang) {
    const i = line.indexOf("#");
    return i >= 0 ? line.slice(i) : null;
  }
  const lineIdx = line.indexOf("//");
  if (lineIdx >= 0) return line.slice(lineIdx);
  if (/^\s*\*/.test(line)) return line;
  const blockOpen = line.indexOf("/*");
  if (blockOpen >= 0) return line.slice(blockOpen);
  const blockClose = line.indexOf("*/");
  if (blockClose >= 0) return line;
  return null;
}

/** 特性编号：[FR] + 8 位日期 +（可选连字符）+ 4-10 位字母数字后缀。兼容历史识别形态。 */
export const FID_RE = /[FR]\d{8}-?[a-z0-9]{4,10}/g;

/** issue 编号：# 后跟数字（#region 等指令无数字不命中；#fff 十六进制无纯数字不命中）。 */
export const ISSUE_ANCHOR_RE = /\B#\d+\b/g;

/** 检视轮次编号形态（过程编号，均含序号）。仅对注释文本运行，误伤面由边界收紧控制。 */
export const DISPOSITION_RES = [
  /** 单字母 + 1-2 位数字令牌（边界收紧，MP3/H264 等正常词不命中） */
  /\b[SMNAR]\d{1,2}\b/g,
  /** 中文动作词 × 处置词 × 序号 */
  /(?:审视|检视|复审|快审|终核|评审)\s*(?:修复|处置|发现|建议)\s*[0-9⑤-⑩RNSM]+/g,
  /** 发现/建议/严重 N 紧跟 处置词 */
  /(?:发现|建议|严重)\s*\d+\s*(?:处置|修复|配套|建议)/g,
];

/** 对一段注释文本收集违规编号。 */
export function collectAnchorViolations(commentText) {
  let out = [];
  const run = (re, kind) => {
    re.lastIndex = 0;
    for (const m of commentText.matchAll(re)) out.push({ token: m[0], kind });
  };
  run(FID_RE, "特性编号");
  run(ISSUE_ANCHOR_RE, "issue 编号");
  for (const re of DISPOSITION_RES) run(re, "轮次编号");
  return out;
}

/** 解析 unified diff（--unified=0）的新增行。 */
export function parseDiffAddedLines(diffText) {
  const out = [];
  let path = null;
  let newLine = 0;
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("+++ b/")) {
      path = raw.slice(6);
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = raw.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      newLine = m ? Number(m[1]) : 0;
      continue;
    }
    if (path == null) continue;
    if (raw.startsWith("+")) {
      // +++ 文件头已在上面拦截，此处都是新增行
      out.push({ path, line: newLine, content: raw.slice(1) });
      newLine += 1;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      // 删除行不推进新文件行号
    } else if (!raw.startsWith("---")) {
      // 上下文行（--unified>0 时出现）推进新文件行号
      newLine += 1;
    }
  }
  return out;
}

/** 对 diff 新增行全量判定。 */
export function checkDiff(diffText) {
  const added = parseDiffAddedLines(diffText);
  const violations = [];
  for (const { path, line, content } of added) {
    if (isExcludedPath(path)) continue;
    const commentText = extractCommentText(content, isHashCommentLang(path));
    if (!commentText) continue;
    for (const v of collectAnchorViolations(commentText)) {
      violations.push({ path, line, content: content.trim(), ...v });
    }
  }
  return { addedTotal: added.length, violations };
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

  const { addedTotal, violations } = checkDiff(diffText);
  if (addedTotal === 0) {
    console.error("[check-pr-anchor-discipline] 空判定面（diff 无新增行）——拒判不作「无违规」放行");
    process.exitCode = 2;
    return;
  }
  if (violations.length === 0) {
    console.log("✅ 注释编号禁绝：新增注释行无特性/轮次/issue 编号");
    process.exitCode = 0;
    return;
  }
  console.log(`❌ 注释编号禁绝：新增注释行夹带编号 ${violations.length} 处（非特性文档注释不允许出现任何编号）：`);
  for (const v of violations) {
    console.log(`   - ${v.path}:${v.line}  [${v.kind}] ${v.token}  ← ${v.content}`);
  }
  process.exitCode = 1;
}

/** 直接执行判定：realpath 双端解析 symlink 后比较（macOS /tmp→/private/tmp 下字符串比对会失配致静默 exit 0 假绿）。 */
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