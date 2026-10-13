#!/usr/bin/env node
/**
 * 断言证据锚点轻量规则（F20261013crit，吸收 F20261012acpt T1 报告侧意图；ratchet 起步）。
 *
 * 规则：验证/Verification 类章节中的验证性断言（「通过/已验证/全绿」类）必须带机器锚点
 * （file:line / 命令引用 / 文档 ID / issue 号 / 代码或文档路径）；有断言、全章节零锚点 → warn。
 *
 * 范围：本次改动的 docs/features 文档 + PR body（env PR_BODY）——责任面是本 PR 改的文档，
 * 全树存量误报不属本 PR 修复义务。分级：warn 起步（不阻断），先积累观测基线，
 * 复盘点收紧为 fail 或接 date-bombs 式基线守恒（见特性文档设计取舍段）。
 *
 * 退出码：0（warn 不阻断）。用法：node scripts/lint-evidence-anchors.mjs [--base <ref>]
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/** 验证性断言：结论词出现在行内（宁宽不漏——warn 级，误报成本低） */
const ASSERTION_RE = /通过|已验证|全绿|绿|已修复|\bPASS\b|\bpass(?:ed|ing)?\b/i;

/** 机器锚点形态（任一命中即算有锚点） */
const ANCHOR_RES = [
  /\b\S+\.[a-z]{1,5}:\d+/i, // file:line
  /[FR]20\d{6}[a-z0-9]{4}/, // 文档 ID
  /#\d{2,}\b/, // issue 号
  /`[^`\n]*(?:npm|node|npx|gh|git|bash|sh)[^`\n]*`/, // 命令引用
  /(?:^|[\s`(])(?:scripts|src|tests|docs|prompts|\.pi)\/[\w./-]+/, // 代码/文档路径
];

export function isAssertionLine(line) {
  return ASSERTION_RE.test(line);
}

export function hasAnchor(text) {
  return ANCHOR_RES.some((re) => re.test(text));
}

/**
 * 验证类章节提取（层级感知）：标题含 验证/验收/Verification/测试结果 即入章，
 * 章节延伸到下一个同级或更高级标题为止。
 */
export function findVerificationSections(markdown) {
  const lines = markdown.split("\n");
  const sections = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const level = m[1].length;
      if (cur && level <= cur.level) {
        sections.push(cur);
        cur = null;
      }
      if (/验证|验收|Verification|测试结果/i.test(m[2])) {
        cur = { heading: m[2].trim(), level, lines: [], startLine: i + 1 };
      }
      continue;
    }
    if (cur) cur.lines.push({ text: lines[i], line: i + 1 });
  }
  if (cur) sections.push(cur);
  return sections;
}

/** 检测一段 markdown：验证性断言存在但全章节零锚点 → warn 条目 */
export function checkText(text) {
  const warnings = [];
  for (const sec of findVerificationSections(text)) {
    const assertions = sec.lines.filter((l) => isAssertionLine(l.text));
    if (assertions.length === 0) continue;
    const bodyText = sec.lines.map((l) => l.text).join("\n");
    if (hasAnchor(bodyText) || hasAnchor(sec.heading)) continue;
    warnings.push({
      heading: sec.heading,
      startLine: sec.startLine,
      excerpt: assertions[0].text.trim().slice(0, 80),
      count: assertions.length,
    });
  }
  return warnings;
}

function main() {
  const argv = process.argv.slice(2);
  let base = "origin/main";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") base = argv[++i];
    else {
      console.error(`未知参数：${argv[i]}`);
      process.exit(1);
    }
  }

  const targets = [];
  try {
    const diff = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", "-M", `${base}...HEAD`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const f of diff.split("\n")) {
      if (f.startsWith("docs/features/") && f.endsWith(".md")) targets.push(f);
    }
  } catch {
    // 非 git 环境宽松放行（与 lint 家族环境异常口径一致）
    console.log("[lint:evidence-anchors] 环境异常（无法取 diff），宽松放行");
    process.exit(0);
  }

  let warnCount = 0;
  for (const rel of targets) {
    const text = fs.readFileSync(path.resolve(rel), "utf8");
    for (const w of checkText(text)) {
      warnCount++;
      console.warn(`⚠ ${rel}:${w.startLine}「${w.heading}」验证性断言无机器锚点（${w.count} 处）：「${w.excerpt}…」`);
    }
  }
  if ("PR_BODY" in process.env) {
    for (const w of checkText(String(process.env.PR_BODY ?? ""))) {
      warnCount++;
      console.warn(`⚠ PR body「${w.heading}」验证性断言无机器锚点（${w.count} 处）：「${w.excerpt}…」`);
    }
  }

  if (warnCount === 0) {
    console.log(`[lint:evidence-anchors] OK（扫描 ${targets.length} 个文档 + PR body）`);
  } else {
    console.log(
      `[lint:evidence-anchors] ${warnCount} warnings（ratchet 起步不阻断）——验证性断言请附锚点：file:line / 命令+实际输出 / 文档 ID / issue 号`,
    );
  }
  process.exit(0);
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main();
}
