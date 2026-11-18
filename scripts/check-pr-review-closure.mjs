#!/usr/bin/env node
/**
 * 检视闭环机械闸（F20261118rvcls）：唯一判定器——「当前 head 是否持有有效独立检视通过回执」。
 *
 * 第一性原理：检视结论是对特定 commit 的证书。任何 push（新 commit）都让被审对象
 * 更换，旧证书必须自动失效；断环的本质 = 新 head 静默继承了旧 head 的通过叙事。
 * 本判定器把「变更 → 证书失效」变成可机械判定的状态不变量，被两道闸消费：
 *   - 后闸：merge_pr 工具执行前 fail-closed 调用（合入点物理拦截）
 *   - 前闸：CI 在 pull_request 时调用（断环在呈拍板前即红，不等到合入才爆炸）
 *
 * 闭环谓词（四条同时成立，机械锚点全部来自 gh 服务端数据，不依赖作者自报）：
 *   1. head 覆盖   —— 存在 review.commit.oid === headRefOid（检视覆盖了当前版本）
 *   2. 通过语义   —— 覆盖回执含通过/闭环结论词，且不含「需要修改」
 *   3. 处置确认   —— 覆盖回执含「上轮处置确认」段或逐条处置核实语义（空段即断环）
 *   4. 审查者署名 —— 覆盖回执含审查者名号（reviewer- / ## 审查者 / 检视獭），
 *                    挡住作者自己 post 一句 PASS 的 self-review
 *
 * 已知局限（第一版，F20261118rvcls 特性文档「设计取舍」节）：独立检视的真证据
 * 是 yield 检视派工 trace（DB 侧），脚本拿不到——「审查者署名」是脚本能判的最硬
 * 代理，署名真实性与「回执语义真实」由对抗审视 B9 抽样兜底（与 check-pr-evidence
 * 同构：机械闸不判真实，判结构；真实归检视獭 B9）。
 *
 * 退出码：0 闭环 / 1 断环 / 2 拒判（数据不足或查询失败——fail-closed 同态）。
 * 用法：
 *   node scripts/check-pr-review-closure.mjs --pr-number <n>    调 gh pr view 拉数据
 *   node scripts/check-pr-review-closure.mjs --json-file <path> 读本地 JSON（CI/测试注入）
 * 环境变量：GH_TOKEN（CI 拉 gh 用，本地已登录可省略）。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** 通过结论词（覆盖回执） */
const PASS_RE = /(通过|闭环|复核确认|至此闭合|均已处置|全部落实)/;
/** 未通过结论词（覆盖回执，优先于 PASS_RE 判定） */
const FAIL_RE = /(需要修改|存在以下问题|request[ _-]?changes)/i;
/** 审查者署名（防 self-PASS） */
const REVIEWER_RE = /(##\s*审查者|reviewer-[\w-]+|检视獭)/;
/** 处置确认段/逐条核实语义（上轮处置确认——空段即断环） */
const DISPOSITION_RE = /(##\s*(上轮处置确认|处置确认|发现处置|逐条处置核实)|逐条(核实|处置|确认)|处置核实|均已处置|全部(正确|处置|落实))/;

/**
 * 纯判定函数（可单测）——闭环谓词四条件。
 * @param {{headRefOid?: string|null, author?: {login?: string}|null, reviews?: Array<{commit?: {oid?: string|null}|null, body?: string|null, state?: string|null, author?: {login?: string}|null}>}} pr
 * @returns {{ok: boolean, status: string, reasons: string[]}}
 */
export function checkReviewClosure(pr) {
  const reasons = [];
  const headRefOid = pr?.headRefOid ?? null;
  const reviews = Array.isArray(pr?.reviews) ? pr.reviews : [];

  if (!headRefOid) {
    reasons.push("无法取得 PR headRefOid（数据不完整）");
    return { ok: false, status: "undeterminable", reasons };
  }
  if (reviews.length === 0) {
    reasons.push("PR 无任何 review 记录——从未走过独立检视");
    return { ok: false, status: "no_review", reasons };
  }

  // 1. head 覆盖：检视覆盖了当前版本（commit.oid === headRefOid）
  const covering = reviews.filter((r) => r?.commit?.oid === headRefOid);
  if (covering.length === 0) {
    const lastOid = reviews.at(-1)?.commit?.oid;
    reasons.push(
      `当前 head ${headRefOid.slice(0, 7)} 无检视覆盖——最近一条 review 覆盖停在 ${lastOid ? lastOid.slice(0, 7) : "未知"}，` +
        "检视通过后 head 又前移（新增 commit），旧证书已失效，需补 delta 复核",
    );
    return { ok: false, status: "head_not_covered", reasons };
  }

  // 覆盖 head 的最后一条回执（多次覆盖取最新语义）
  const last = covering.at(-1);
  const body = String(last?.body ?? "");
  const head = body.slice(0, 1200); // 结论词/署名/处置段都在前部

  // 2. 通过语义：先查失败结论词（优先），再查通过结论词
  if (FAIL_RE.test(head)) {
    reasons.push("覆盖 head 的回执结论为「需要修改 / 存在以下问题」——发现未处置，不能视作闭环");
    return { ok: false, status: "needs_changes", reasons };
  }
  if (!PASS_RE.test(head)) {
    reasons.push("覆盖 head 的回执无通过/闭环结论词（通过（delta 复核）/ 闭环 / 复核确认）");
    return { ok: false, status: "no_pass_semantics", reasons };
  }

  // 3. 处置确认：上轮发现的处置核实语义在场
  if (!DISPOSITION_RE.test(body)) {
    reasons.push("覆盖 head 的回执无「上轮处置确认」段或逐条处置核实语义——发现处置无回执，空段即断环");
    return { ok: false, status: "no_disposition", reasons };
  }

  // 4. 审查者署名：挡住作者 self-review
  if (!REVIEWER_RE.test(body)) {
    reasons.push("覆盖 head 的回执无审查者署名（## 审查者 / reviewer- 名号）——无法确认独立检视，self-PASS 不构成回执");
    return { ok: false, status: "no_reviewer", reasons };
  }

  return { ok: true, status: "closed", reasons: [] };
}

/** 从 gh CLI 拉 PR 数据（headRefOid / reviews）。查询失败抛错——调用方 fail-closed。 */
export function fetchPrReviewData(prNumber) {
  const stdout = execFileSync(
    "gh",
    ["pr", "view", String(prNumber), "--json", "headRefOid,author,reviews"],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

/** CLI 入口：--pr-number / --json-file；退出码 0/1/2。 */
export function main(argv = process.argv.slice(2)) {
  const prNumberIdx = argv.indexOf("--pr-number");
  const jsonFileIdx = argv.indexOf("--json-file");
  let pr;
  try {
    if (prNumberIdx >= 0) {
      const prNumber = argv[prNumberIdx + 1];
      if (!prNumber) {
        console.error("[check-pr-review-closure] --pr-number 缺参数");
        process.exitCode = 2;
        return;
      }
      pr = fetchPrReviewData(prNumber);
    } else if (jsonFileIdx >= 0) {
      const file = argv[jsonFileIdx + 1];
      if (!file) {
        console.error("[check-pr-review-closure] --json-file 缺参数");
        process.exitCode = 2;
        return;
      }
      pr = JSON.parse(readFileSync(file, "utf8"));
    } else {
      console.error("[check-pr-review-closure] 用法：--pr-number <n> 或 --json-file <path>");
      process.exitCode = 2;
      return;
    }
  } catch (err) {
    console.error(`[check-pr-review-closure] 拉取 PR 数据失败（拒判，fail-closed）：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }

  const result = checkReviewClosure(pr);
  if (result.ok) {
    console.log("✅ 检视闭环：当前 head 持有有效独立检视通过回执（覆盖 + 通过语义 + 处置确认 + 审查者署名）");
    process.exitCode = 0;
  } else {
    console.log(`❌ 检视断环（status=${result.status}）：`);
    for (const r of result.reasons) console.log(`   - ${r}`);
    process.exitCode = 1;
  }
}

// 直接执行时跑 CLI（被 import 单测时不触发）
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
