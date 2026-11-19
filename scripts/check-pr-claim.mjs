#!/usr/bin/env node
/**
 * issue 认领闸（CI 前闸）：PR 引用的 issue 必须持有 otter-claim 认领，且认领的
 * worktree F-ID 与 PR head 分支 F-ID 一致——无认领开工 = 红，他线认领 = 红。
 *
 * 第一性原理（认领闸特性文档）：跨对话协调是系统层约束，住在 skill 文本里靠注意力
 * 自律必然被跳过（跨对话双呈实证：前世执行了任务同向的两问、跳过收益
 * 外部的认领动作）。本闸把「认领存在性」从自觉变成 CI 阻断——与 review-closure 闸
 * 同模式（机械闸判结构不判真实，证书真实性由认领评论的对话签名 + 审视兜底）。
 *
 * 判定（pull_request 事件）：
 *   1. 提取工作对象 issue 号：closes 族（含 issue URL 形态）优先，无 closes 族时
 *      裸井号引用兜底（提取语义详见 extractIssueNumbers）
 *   2. 无 issue 引用 → 放行（非 issue 驱动的改动不适用认领协议）
 *   3. docs-only PR → 放行（豁免集合 import check-pr-evidence 单一真相源，三闸同源）
 *   4. issue 评论搜 otter-claim 注释（otter-claim-release 撤销）：
 *      - 零有效认领 → 红（提示先发认领评论）
 *      - 有效认领存在但 worktree 字段的 F-ID ≠ PR 分支 F-ID → 红（他线认领）
 *   5. 匹配 → 绿
 *
 * 退出码：0 通过/豁免 · 1 违规（红）· 2 拒判（数据不足或查询失败——fail-closed 同态）
 * 用法：
 *   node scripts/check-pr-claim.mjs --pr-number <n> [--json-file <path>]（CI 注入）
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isDocOnlyPath } from "./check-pr-evidence.mjs";

/** 分支名/worktree 名中的 F-ID（F + 日期 + 5 位小写字母数字（首位字母））。 */
export function featureId(text) {
  const m = /F\d{8}[a-z][a-z0-9]{4}/.exec(text ?? "");
  return m ? m[0] : null;
}

/**
 * 从 PR title/body 提取「本 PR 工作对象」issue 号（两级语义）。
 *
 * 1. closes 族优先：close(s|d)/closing/fix(e[sd]|ing)/resolve(s|d)/resolving
 *    + 井号数字或完整 issue URL（GitHub 平台支持的两种关闭引用形态）。存在 closes 族
 *    时工作对象 = closes 族集合——其余裸井号引用是叙述性引用（历史事故复盘、关联工作
 *    交叉引用），不计为必须认领的对象（本 PR 自身实证：概述段历史事故引用
 *    实证：历史事故引用被误当工作对象误拦，kimi检视獭-1954 BLOCK-1a）。
 * 2. 无 closes 族时裸井号引用全部兜底计为工作对象（覆盖「修复＋井号数字」不写 closes 的惯用
 *    形态）。此时叙述性引用无法与工作对象机械区分，属已知边界：风险已被规避（工作对象
 *    用 closes 族显式声明即永不触发）。URL 形态若不加 closes 动词同样不计（kimi检视獭-1954
 *    BLOCK-1b：裸 URL 引用视为叙述，双闸一致）。
 */
const CLOSES_RE =
  /\b(?:close[sd]?|closing|fix(?:e[sd]|ing)?|resolve[sd]?|resolving)\s*:?\s*(?:#(\d+)|https?:\/\/(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+))/gi;

export function extractIssueNumbers(title, body) {
  const text = `${title}\n${body ?? ""}`;
  const closing = new Set();
  for (const m of text.matchAll(CLOSES_RE)) closing.add(Number(m[1] ?? m[2]));
  if (closing.size > 0) return [...closing].sort((a, b) => a - b);
  const bare = new Set();
  for (const m of text.matchAll(/#(\d+)/g)) bare.add(Number(m[1]));
  return [...bare].sort((a, b) => a - b);
}

/**
 * commit 侧工作对象提取：首行 #N（尾注惯例 `（#N）`/`(#N)`）+ 全文 closes 族；
 * body 裸 #N 不计（检视修复说明等叙述性引用——本 PR 首轮修复 commit 自身实证：
 * body 写「叙述 #1899 被误当工作对象」被兜底全提误拦）。与 CI 闸同文件同正则源。
 */
export function extractCommitIssueNumbers(message) {
  const firstLine = String(message).split("\n")[0] ?? "";
  const nums = new Set(extractIssueNumbers(firstLine, ""));
  for (const m of String(message).matchAll(CLOSES_RE)) nums.add(Number(m[1] ?? m[2]));
  return [...nums].sort((a, b) => a - b);
}

/** 解析 issue 评论里的 otter-claim / otter-claim-release 注释（release 撤销同对话认领）。 */
export function parseClaims(comments) {
  const claimRe = /<!--\s*otter-claim:\s*conversation=([^;\s>]+);\s*otter=([^;\s>]+);\s*worktree=([^;\s>]+);/g;
  const releaseRe = /<!--\s*otter-claim-release:\s*conversation=([^;\s>]+)\s*-->/g;
  const ordered = [...comments].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const state = new Map();
  for (const c of ordered) {
    for (const m of (c.body ?? "").matchAll(claimRe)) {
      state.set(m[1], { conversation: m[1], otter: m[2], worktree: m[3] });
    }
    for (const m of (c.body ?? "").matchAll(releaseRe)) {
      state.set(m[1], null);
    }
  }
  return [...state.values()].filter(Boolean);
}

/** 认领谓词（纯函数，测试入口）：pr + 各 issue 的评论列表。 */
export function checkClaim(pr, issuesComments) {
  const reasons = [];
  if ((pr.state ?? "OPEN") !== "OPEN") return { ok: true, status: "skipped_not_open", reasons: [] };
  const nonDocs = (pr.files ?? []).filter(f => !isDocOnlyPath(f.path));
  if (nonDocs.length === 0) return { ok: true, status: "exempt_docs_only", reasons: [] };
  const issueNums = extractIssueNumbers(pr.title, pr.body);
  if (issueNums.length === 0) return { ok: true, status: "no_issue_reference", reasons: [] };
  const branchFid = featureId(pr.headRefName);
  const claimsByIssue = {};
  for (const n of issueNums) {
    const claims = parseClaims(issuesComments[n] ?? []);
    claimsByIssue[n] = claims;
    if (claims.length === 0) {
      reasons.push(`issue #${n} 无有效 otter-claim 认领——开工前须按认领协议（worktree-isolation 步骤 2）发认领评论`);
    } else if (!branchFid || !claims.some(c => featureId(c.worktree) === branchFid)) {
      reasons.push(`issue #${n} 的认领（${claims.map(c => c.worktree).join(", ")}）与 PR 分支 ${pr.headRefName}${branchFid ? `（${branchFid}）` : "（无 F-ID）"} 不匹配——他线认领或分支命名不符`);
    }
  }
  if (reasons.length > 0) {
    const first = issueNums.find(n => (claimsByIssue[n] ?? []).length === 0);
    return {
      ok: false, status: "claim_missing_or_mismatch", reasons,
      hint: first != null
        ? `gh issue comment ${first} --body "🦦 认领 #${first}\\n<!-- otter-claim: conversation=<对话短ID>; otter=<名号>; worktree=<F-ID>; at=<ISO时间> -->\\n开工：<一句话任务>"`
        : undefined,
    };
  }
  return { ok: true, status: "claimed", reasons: [] };
}

function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--pr-number") args.prNumber = Number(process.argv[i + 1]);
    else if (process.argv[i] === "--json-file") args.jsonFile = process.argv[i + 1];
  }
  let pr;
  if (args.jsonFile) {
    pr = JSON.parse(readFileSync(args.jsonFile, "utf8"));
  } else {
    if (!args.prNumber) { console.error("用法: check-pr-claim.mjs --pr-number <n> | --json-file <path>"); process.exit(2); }
    try {
      pr = JSON.parse(execFileSync("gh", ["pr", "view", String(args.prNumber), "--json", "title,body,headRefName,files,state"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
    } catch (e) {
      console.error(`拒判：PR 查询失败（${String(e.message).split("\n")[0]}）`); process.exit(2);
    }
  }
  const issueNums = extractIssueNumbers(pr.title, pr.body);
  const issuesComments = {};
  for (const n of issueNums) {
    try {
      const raw = execFileSync("gh", ["issue", "view", String(n), "--json", "comments", "-q", ".comments"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      issuesComments[n] = JSON.parse(raw);
    } catch (e) {
      console.error(`拒判：issue #${n} 查询失败（${String(e.message).split("\n")[0]}）`); process.exit(2);
    }
  }
  const result = checkClaim(pr, issuesComments);
  if (result.status === "skipped_not_open") { console.log("✅ 认领闸：PR 非 OPEN，跳过"); process.exit(0); }
  if (result.status === "exempt_docs_only") { console.log("✅ 认领闸：docs-only PR 豁免"); process.exit(0); }
  if (result.status === "no_issue_reference") { console.log("✅ 认领闸：PR 未引用 issue（非 issue 驱动改动），放行"); process.exit(0); }
  if (!result.ok) {
    console.error(`❌ 认领闸（${result.status}）：`);
    for (const r of result.reasons) console.error(`   - ${r}`);
    if (result.hint) console.error(`   认领命令：${result.hint}`);
    process.exit(1);
  }
  console.log(`✅ 认领闸：${issueNums.map(n => `issue #${n}`).join("、")} 认领覆盖本分支`);
  process.exit(0);
}

if (process.argv[1]?.endsWith("check-pr-claim.mjs")) main();
