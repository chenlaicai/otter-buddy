#!/usr/bin/env node
/**
 * 检视闭环机械闸：唯一判定器——「当前 head 是否持有有效独立检视通过回执」。
 *
 * 第一性原理：检视结论是对特定 commit 的证书。任何 push（新 commit）都让被审对象
 * 更换，旧证书必须自动失效；断环的本质 = 新 head 静默继承了旧 head 的通过叙事。
 * 本判定器把「变更 → 证书失效」变成可机械判定的状态不变量，被两道闸消费：
 *   - 后闸：merge_pr 工具执行前 fail-closed 调用（合入点物理拦截）
 *   - 前闸：CI 在 pull_request 时调用（断环在呈拍板前即红，不等到合入才爆炸）
 *
 * 闭环谓词（四条同时成立，机械锚点全部来自 gh 服务端数据，不依赖作者自报）：
 *   1. head 覆盖   —— 存在 review.commit.oid === headRefOid（检视覆盖了当前版本）
 *   2. 通过语义   —— 「## 审查结论」段含通过/闭环结论词，且不含「需要修改」
 *   3. 处置确认   —— 覆盖回执含「上轮处置确认」段或逐条处置核实语义（空段即断环）
 *   4. 审查者署名 —— 覆盖回执含审查者名号（reviewer- / ## 审查者 / 检视獭）
 *
 * 结论判定限定在「## 审查结论」段：不得对整篇回执做通过/未通过子串匹配——
 * 「上轮处置确认」段必然枚举上一轮「需要修改」的发现，整篇匹配会把合法 delta 复核
 * 回执误拒为 needs_changes。
 *
 * docs-only 豁免：diff 全部落在 docs/ 或仓根标准文档时豁免（不要求检视回执），
 * 与 check-pr-evidence 的豁免集合同源——纯文档改动不改变系统行为面。
 *
 * 已知局限（第一版，详见特性文档「设计取舍」节）：独立检视的真证据
 * 是 yield 检视派工 trace（DB 侧），脚本拿不到——「审查者署名」是脚本能判的最硬
 * 代理，署名真实性与「回执语义真实」由对抗审视 抽样兜底（与 check-pr-evidence
 * 同构：机械闸不判真实，判结构；真实归检视獭）。
 *
 * 退出码：0 闭环（含 docs-only 豁免）/ 1 断环 / 2 拒判（数据不足或查询失败——fail-closed 同态）。
 * 用法：
 *   node scripts/check-pr-review-closure.mjs --pr-number <n> [--base <ref>]    调 gh 拉数据（默认 base origin/main）
 *   node scripts/check-pr-review-closure.mjs --json-file <path>                读本地 JSON（CI/测试注入，跳过 docs-only）
 * 环境变量：GH_TOKEN（CI 拉 gh 用，本地已登录可省略）。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 通过结论词（「## 审查结论」段内） */
const PASS_RE = /(通过|闭环|复核确认|至此闭合|均已处置|全部落实)/;
/** 未通过结论词（「## 审查结论」段内，优先于 PASS_RE 判定） */
const FAIL_RE = /(需要修改|存在以下问题|request[ _-]?changes)/i;
/** PASS 负向排除（防「未通过/没有通过/未闭环」等否定式误受） */
const PASS_NEG_RE = /(未通过|没有通过|不通过|尚未通过|未闭环|未均已处置|未全部落实)/;
/** 审查者署名（防 self-PASS——字符串在场，真实性由 抽样兜底） */
const REVIEWER_RE = /(##\s*审查者|reviewer-[\w-]+|检视獭)/;
/** 处置确认段/逐条核实语义（上轮处置确认——空段即断环） */
const DISPOSITION_RE = /(##\s*(上轮处置确认|处置确认|发现处置|逐条处置核实)|逐条(核实|处置|确认)|处置核实|均已处置|全部(正确|处置|落实))/;

/** 提取指定二级标题段（标题到下一个 ## 或文末；标题行允许带后缀）。 */
export function extractSection(body, titlePattern) {
  const re = new RegExp(`^##\\s*${titlePattern}[^\\n]*$`, "mi");
  const m = body.match(re);
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(/^##\s/m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** docs-only 豁免集合（与 check-pr-evidence isDocOnlyPath 同源） */
export function isDocOnlyPath(p) {
  if (/^docs\//.test(p)) return true;
  return !p.includes("/") && /^(README|CONTRIBUTING|SECURITY|CHANGELOG)[A-Za-z0-9._-]*\.md$/.test(p);
}

/** diff 路径是否全部 docs-only（空 diff 视为拒判，由调用方处理） */
export function isDocOnlyDiff(paths) {
  if (paths.length === 0) return false;
  return paths.every((p) => isDocOnlyPath(p));
}

/**
 * 纯判定函数（可单测）——闭环谓词四条件，结论判定限定「## 审查结论」段。
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

  // 2. 通过语义：仅判定「## 审查结论」段（不整篇匹配，避免上轮处置确认的「需要修改」误伤）
  const conclusion = extractSection(body, "审查结论");
  if (!conclusion) {
    reasons.push("覆盖 head 的回执无「## 审查结论」段——结论段是判定器可解析输入，缺失即断环");
    return { ok: false, status: "no_conclusion", reasons };
  }
  if (FAIL_RE.test(conclusion)) {
    reasons.push("覆盖 head 的回执「审查结论」段为「需要修改 / 存在以下问题」——发现未处置，不能视作闭环");
    return { ok: false, status: "needs_changes", reasons };
  }
  if (PASS_NEG_RE.test(conclusion)) {
    reasons.push("覆盖 head 的回执「审查结论」段含否定式（未通过 / 不通过 / 未闭环等）——不能视作通过");
    return { ok: false, status: "neg_pass", reasons };
  }
  if (!PASS_RE.test(conclusion)) {
    reasons.push("覆盖 head 的回执「审查结论」段无通过/闭环结论词（通过（delta 复核）/ 闭环 / 复核确认）");
    return { ok: false, status: "no_pass_semantics", reasons };
  }

  // 3. 处置确认：上轮发现的处置核实语义在场（对整篇 body 匹配）
  if (!DISPOSITION_RE.test(body)) {
    reasons.push("覆盖 head 的回执无「上轮处置确认」段或逐条处置核实语义——发现处置无回执，空段即断环");
    return { ok: false, status: "no_disposition", reasons };
  }

  // 4. 审查者署名：挡住「无署名」的 self-PASS（字符串在场是脚本能判的最硬代理，真实性由 B9 兜底）
  if (!REVIEWER_RE.test(body)) {
    reasons.push("覆盖 head 的回执无审查者署名（## 审查者 / reviewer- 名号）——无署名回执不构成独立检视");
    return { ok: false, status: "no_reviewer", reasons };
  }

  return { ok: true, status: "closed", reasons: [] };
}

/** 从 gh CLI 拉 PR 数据（headRefOid / baseRefName / reviews）。查询失败抛错——调用方 fail-closed。 */
export function fetchPrReviewData(prNumber) {
  const stdout = execFileSync(
    "gh",
    ["pr", "view", String(prNumber), "--json", "headRefOid,baseRefName,author,reviews"],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

/** --pr-number 模式下判断 docs-only：git diff base...head --name-only 全 docs/ 即豁免。 */
export function fetchChangedPaths(baseRef, headRefOid) {
  const stdout = execFileSync(
    "git",
    ["diff", `${baseRef}...${headRefOid}`, "--name-only"],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
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
      // docs-only 豁免：diff 全 docs/ 或仓根文档 → 直接闭环（纯文档不改行为面）
      const baseIdx = argv.indexOf("--base");
      const baseRef = baseIdx >= 0 ? argv[baseIdx + 1] : "origin/main";
      const headRefOid = pr?.headRefOid;
      if (headRefOid && baseRef) {
        try {
          const paths = fetchChangedPaths(baseRef, headRefOid);
          if (isDocOnlyDiff(paths)) {
            console.log("✅ docs-only 豁免：diff 全部为 docs/ 或仓根文档，无需检视回执");
            process.exitCode = 0;
            return;
          }
        } catch (err) {
          // diff 失败（未 fetch base 等）不豁免——fail-closed 继续走 review 判定
          console.error(`[check-pr-review-closure] 警告：diff 判断失败，跳过 docs-only 豁免：${err instanceof Error ? err.message : String(err)}`);
        }
      }
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
    console.log("✅ 检视闭环：当前 head 持有有效独立检视通过回执（覆盖 + 结论段通过 + 处置确认 + 审查者署名）");
    process.exitCode = 0;
  } else {
    console.log(`❌ 检视断环（status=${result.status}）：`);
    for (const r of result.reasons) console.log(`   - ${r}`);
    process.exitCode = 1;
  }
}

/** 直接执行判定：realpath 双端解析 symlink 后比较——macOS /tmp→/private/tmp 等
 *  symlink 路径下 import.meta.url 与 argv[1] 字符串形态不同，若用字符串比对会失配致 main() 不跑，
 *  静默 exit 0 假绿（对 fail-closed 安全闸是最坏失败模态）。realpath 后两端口都在真实路径，
 *  相对/绝对/symlink 调用均能正确触发 CLI；被 import 单测时 process.argv[1] 是 vitest 入口，
 *  realpath 不同 → 不跑 main。 */
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

// 直接执行时跑 CLI（被 import 单测时不触发）
if (isMainModule()) {
  main();
}
