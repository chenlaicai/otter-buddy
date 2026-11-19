#!/usr/bin/env node
/**
 * 断言契约方向闸：open issue「验证断言」段方向 lint（搭档 2026-11-19 指令落地，出处见特性文档）。
 *
 * 断言契约（F20261116 方向语义 + 本特性机械闸）：断言必须是「问题还在判据」——
 * 什么条件满足 = 问题仍未解决 / 修复未兑现。好结果方向断言（「修复后 X 不再发生」
 * 「覆盖率 ≥80%」）在回查窗口只能 ⚠️ 空转（11-15/11-18 两轮同因 ⚠️ 实证），
 * 修复时点从 D+30 提前到 D+0：每日 issue 任务跑本脚本，当天以作者身份机械取反改写
 * （改写协议见 prompts/scheduled/regression-verify.md 方向修复协议）。
 *
 * 判定为准入初筛（启发式关键词），终判在回查窗口；启发式偏保守——
 * 判 problem-ok 要求命中问题侧标记且不命中好结果侧强标记。
 *
 * 用法：node scripts/lint-issue-assertions.mjs [--limit N]
 * 退出码：0=全部合规或无断言；1=存在好结果方向/方向不明（供 CI/任务作闸）；2=gh 不可用。
 */

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

/** 问题还在方向标记：断言含其一即视为作者写的是「条件满足=问题仍在」 */
const PROBLEM_MARKERS = [
  "仍", "还在", "继续", "持续", "依旧", "复现",
  "未下降", "未修复", "未兑现", "未解决", "未落地", "零命中", "必现拒绝", "必现静默", "必现失败",
];

/** 好结果方向强标记：与问题侧并存时以好结果侧为准（复合断言保守判好结果，交人工取反）。
 *  注：不含裸 ≤/≥ 运算符——「仍 ≥ 基线」是问题侧表述（基准线以上=问题还在），
 *  纯阈值好结果断言（如「≤1 条/周」无其他好结果词）落 unclear 同样进改写路径，不漏。 */
const GOOD_STRONG_MARKERS = [
  "修复后", "修复合入后", "不再", "能正常", "可正常", "应成功", "应出现", "应为 0", "为 0", "为0",
  "下降", "提高", "覆盖率", "通过率", "成功率", "只触发一次", "零新增", "应包含", "归零",
];

const META_LINE_PREFIXES = ["- 检查方式", "- 到期", "- 数据源", "- 关闭标准"];

/** 从 issue body 提取「验证断言」段；无段或段首标暂不验证返回 null */
export function extractAssertionSection(body) {
  if (!body) return null;
  const m = body.match(/^##\s*验证断言\s*$/m);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = body.slice(start);
  const next = rest.match(/^##\s/m);
  const section = (next ? rest.slice(0, next.index) : rest).trim();
  if (!section) return null;
  if (/^暂不验证/.test(section)) return null; // 纯决策/容器型：规范允许，回查跳过
  return section;
}

/** 方向分类：problem-ok / good-direction / unclear。
 *  否定形态先剥离再扫好结果词（「未下降」含「下降」子串，不剥离会误判好结果）；
 *  剥离后仍同时命中两侧 → 保守判 good-direction 交人工取向。 */
export function classifyAssertionDirection(section) {
  const substance = section
    .split("\n")
    .filter((line) => !META_LINE_PREFIXES.some((p) => line.trimStart().startsWith(p)))
    .join(" ")
    // 改写标注块（【YYYY-MM-DD lint/回查改写：…】）是溯源信息非断言语义——标注内嵌的
    // 原文引用可能含好结果词，剥离后再扫（改写后复扫实证）
    .replace(/【[^】]*改写：[^】]*】/g, "");
  const goodScan = ["未下降", "未提高", "未修复", "未兑现", "未解决", "未落地", "未归零"]
    .reduce((s, neg) => s.replaceAll(neg, ""), substance);
  const good = GOOD_STRONG_MARKERS.some((k) => goodScan.includes(k));
  const problem = PROBLEM_MARKERS.some((k) => substance.includes(k));
  if (good) return "good-direction";
  if (problem) return "problem-ok";
  return "unclear";
}

function listOpenIssues(limit) {
  const res = spawnSync("gh", ["issue", "list", "--state", "open", "--limit", String(limit), "--json", "number,title,body"], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    console.error(`[lint-issue-assertions] gh issue list 失败（exit ${res.status}）：${(res.stderr || "").slice(0, 200)}`);
    process.exit(2);
  }
  return JSON.parse(res.stdout);
}

function main() {
  const limitArg = process.argv.find((a) => a === "--limit");
  const limit = limitArg ? Number(process.argv[process.argv.indexOf(limitArg) + 1] || 200) : 200;
  const issues = listOpenIssues(limit);
  const flagged = [];
  let scanned = 0;
  let noAssertion = 0;
  for (const issue of issues) {
    const section = extractAssertionSection(issue.body);
    if (!section) {
      noAssertion += 1;
      continue;
    }
    scanned += 1;
    const verdict = classifyAssertionDirection(section);
    if (verdict !== "problem-ok") {
      flagged.push({ number: issue.number, verdict, excerpt: section.split("\n")[0].slice(0, 100) });
    }
  }
  for (const f of flagged) {
    console.log(`#${f.number} [${f.verdict}] ${f.excerpt}`);
  }
  console.log(`[lint-issue-assertions] open ${issues.length} | 含断言 ${scanned} | 无断言 ${noAssertion} | 待改写 ${flagged.length}`);
  if (flagged.length > 0) {
    console.log("[lint-issue-assertions] 好结果方向/方向不明 → 按 regression-verify.md 方向修复协议当日改写");
    process.exit(1);
  }
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1] || "")).href;
  } catch {
    return false;
  }
})();
if (isMain) main();
