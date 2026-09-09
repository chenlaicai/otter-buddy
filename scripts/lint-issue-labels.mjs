#!/usr/bin/env node
/**
 * F20260907itri: Issue 看板合规审计脚本（事后审计型，不卡生成）。
 *
 * 扫描 open issue 的标签与标题合规性，输出不合规清单 + 大盘统计。
 * 规范单源：prompts/scheduled/daily-health-check.md「issue 产出规范」节——改标签体系时同步该文件
 * 与 prompts/scheduled/每日-issue-处理.md。（SYSTEM.md R2 只留一行行为层兜底，F20260909sentr）
 *
 * 规则：
 *   1. type 必有且仅 1 个：bug / enhancement / tech-debt / question
 *   2. priority 必有且仅 1 个：P0 / P1 / P2
 *   3. 非法标签：已废弃标签（phase-* 等）出现即报
 *   4. 标题格式：`[模块] 摘要`；模块位出现与标签重复的淘汰前缀（daily-review /
 *      tech-debt / bug / rhi）即报（模块型前缀如 signal-protocol 不限定枚举）
 *
 * 用法：
 *   node scripts/lint-issue-labels.mjs                # 审计输出 + 大盘统计
 *   node scripts/lint-issue-labels.mjs --fix-suggest  # 追加建议标签（不执行修改）
 *
 * 退出码：0 全合规或仅 --fix-suggest / 1 有违规 / 2 gh CLI 不可用（调用方标注不静默跳过）。
 * 依赖：gh CLI（已认证）。
 */
import { execSync } from "node:child_process";

const TYPES = ["bug", "enhancement", "tech-debt", "question"];
const PRIORITIES = ["P0", "P1", "P2"];
const DEPRECATED = [
  "phase-0", "phase-1", "phase-2", "phase-3",
  "good first issue", "help wanted", "documentation", "invalid",
];
const ALLOWED_EXTRA = ["daily-review", "agent-evolution", "observability", "duplicate", "wontfix"];
const DEPRECATED_TITLE_PREFIXES = ["daily-review", "tech-debt", "bug", "rhi"];

const args = process.argv.slice(2);
const fixSuggest = args.includes("--fix-suggest");

/** gh 不可用时退出码 2，调用方标注「lint 不可用」，不静默跳过 */
function fetchOpenIssues() {
  try {
    const raw = execSync(
      `gh issue list --state open --limit 300 --json number,title,labels,updatedAt`,
      { encoding: "utf8", timeout: 60_000 },
    );
    return JSON.parse(raw);
  } catch (err) {
    console.error(`lint 不可用：gh CLI 调用失败（${err.message.split("\n")[0]}）`);
    process.exit(2);
  }
}

function lintIssue(issue) {
  const labels = issue.labels.map((l) => l.name);
  const problems = [];
  const suggestions = [];

  const types = labels.filter((l) => TYPES.includes(l));
  const prios = labels.filter((l) => PRIORITIES.includes(l));
  const deprecated = labels.filter((l) => DEPRECATED.includes(l));
  const illegal = labels.filter(
    (l) => !TYPES.includes(l) && !PRIORITIES.includes(l) && !ALLOWED_EXTRA.includes(l) && !DEPRECATED.includes(l),
  );

  if (types.length === 0) problems.push("缺 type 标签");
  if (types.length > 1) problems.push(`type 多于 1 个: ${types.join(",")}`);
  if (prios.length === 0) problems.push("缺 priority 标签");
  if (prios.length > 1) problems.push(`priority 多于 1 个: ${prios.join(",")}`);
  if (deprecated.length) problems.push(`含废弃标签: ${deprecated.join(",")}`);
  if (illegal.length) problems.push(`未知标签: ${illegal.join(",")}`);

  const m = issue.title.match(/^\[([^\]]+)\]/);
  if (!m) {
    problems.push("标题非 [模块] 摘要 格式");
  } else if (DEPRECATED_TITLE_PREFIXES.includes(m[1].toLowerCase().trim())) {
    problems.push(`标题模块位用了淘汰前缀 [${m[1]}]（信息应由标签承载）`);
  }

  if (fixSuggest && (types.length === 0 || prios.length === 0 || m === null)) {
    const guessType = guessTypeByTitle(issue.title, types);
    if (types.length === 0 && guessType) suggestions.push(`--add-label ${guessType}`);
    if (prios.length === 0) suggestions.push(`--add-label P?（P0=正确性/数据安全 P1=本周 P2=等排期）`);
    if (!m) suggestions.push(`标题改 [模块] 摘要`);
  }
  return { problems, suggestions };
}

/** 标题启发式猜 type——仅建议，不自动执行。优先级：bug（强症状词）→ enhancement（新能力动词）→ tech-debt（改造动词）→ question 兜底 */
function guessTypeByTitle(title, existing) {
  if (existing.length) return null;
  const t = title.toLowerCase();
  if (/(静默|丢|失败|错|漏|崩|悬置|无告警|异常|误拦|报错|炸弹|中断)/.test(t)) return "bug";
  if (/(接入|新增|支持|建设)/.test(t)) return "enhancement";
  if (/(优化|重构|改进|enhance|统一|收口)/.test(t)) return "tech-debt";
  if (/(方案|悬置待拍板|讨论|评估|待分析)/.test(t)) return "question";
  return null;
}

const issues = fetchOpenIssues();
if (issues.length === 0) {
  console.log("✓ 无 open issue，无需审计");
  process.exit(0);
}
const violations = [];
const dash = { bug: 0, enhancement: 0, "tech-debt": 0, question: 0, P0: 0, P1: 0, P2: 0, "daily-review": 0 };
let noLabel = 0;

for (const it of issues) {
  const labels = it.labels.map((l) => l.name);
  if (labels.length === 0) noLabel++;
  for (const t of TYPES) if (labels.includes(t)) dash[t]++;
  for (const p of PRIORITIES) if (labels.includes(p)) dash[p]++;
  if (labels.includes("daily-review")) dash["daily-review"]++;

  const { problems, suggestions } = lintIssue(it);
  if (problems.length) {
    violations.push({ n: it.number, title: it.title, problems, suggestions });
  }
}

console.log(`扫描 open issue ${issues.length} 条，不合规 ${violations.length} 条（${issues.length ? Math.round((violations.length / issues.length) * 100) : 0}%）\n`);
if (violations.length) {
  for (const v of violations) {
    console.log(`#${v.n} ${v.title.slice(0, 60)}`);
    for (const p of v.problems) console.log(`  ✗ ${p}`);
    if (fixSuggest && v.suggestions.length) for (const s of v.suggestions) console.log(`  → 建议: ${s}`);
  }
}
console.log(`\nissue 大盘：open ${issues.length} | bug:${dash.bug} enhancement:${dash.enhancement} tech-debt:${dash["tech-debt"]} question:${dash.question} | P0:${dash.P0} P1:${dash.P1} P2:${dash.P2} | daily-review:${dash["daily-review"]} | 无标签:${noLabel}（目标 <5%）`);

const incompleteRate = issues.length ? violations.length / issues.length : 0;
if (incompleteRate > 0.05) console.log(`⚠ 标签不完整率 ${Math.round(incompleteRate * 100)}% > 5%，日报标红`);
process.exit(violations.length && !fixSuggest ? 1 : 0);
