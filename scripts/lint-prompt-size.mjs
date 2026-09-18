#!/usr/bin/env node
/**
 * F20260917pbgg: 定时任务 prompt 模板体积预算闸（issue #1030 根治层A）。
 *
 * 背景：daily-health-check.md 23 天增长 4.6 倍（4479B → 20607B）超出 DB CHECK
 * 约束 length(body) <= 10000（schema.ts scheduled_tasks.body），同步脚本失败、
 * 启动对账静默降级，DB 跑三周前旧版——git 真相源与运行时副本脱钩。根因是
 * 修 bug 默认落点「往 prompt 加一段规则」的纯加法沉淀（18 次 PR +185/-24 行），
 * 且 lint/CI/review 三层均无体积维度。
 *
 * 规则：
 *   1. prompts/scheduled/*.md 体积（frontmatter 剥离后）> WARN_BYTES 输出警告
 *   2. > BUDGET_BYTES（与 DB CHECK 同口径 10000）exit 1——CI 阻断
 *   3. 允许 per-file override：frontmatter `budget_bytes: <n>` 显式声明更高预算
 *      （须在特性文档记录理由，review checklist 会核对）
 *
 * 退出码：0 通过 / 1 超预算。体积按 Buffer.byteLength（UTF-8 字节，与 sqlite
 * length() 语义不同——sqlite length(TEXT) 计字符数，故阈值同步约束配置见下）
 *
 * 体积口径注意：DB CHECK length(body) <= 10000 计的是 sqlite 字符数（UTF-8 下
 * 即码点数），本 lint 计的是字节。字符数 ≤ 字节数（中文 1 字符 3 字节），字节
 * 口径更严，不会漏放行任何会超 DB 约束的文件——护栏取严侧，安全方向正确。
 *
 * 用法：node scripts/lint-prompt-size.mjs [--dir <dir>]
 */
import { readdirSync, readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

/** 预算上限（字节）。与 DB CHECK 同数字但口径更严（字节 ≥ 字符）。 */
const BUDGET_BYTES = 10000;
/** 警告线（字节）：预算的 80%，触线提示增量纪律（加 X 减 X）。 */
const WARN_BYTES = 8000;

const args = process.argv.slice(2);
let dirIdx = args.indexOf("--dir");
const templateDir = dirIdx !== -1 ? resolve(args[dirIdx + 1]) : join(repoRoot, "prompts", "scheduled");

/** 剥离 frontmatter 后的 body 字节与字符数（与 update-scheduled-task-body.mjs 同则） */
function stripFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n/);
  return m ? content.slice(m[0].length) : content;
}

/** frontmatter 里的 per-file budget_bytes override（无则 null） */
function extractBudgetOverride(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const b = m[1].match(/^budget_bytes:\s*(\d+)\s*$/m);
  return b ? Number(b[1]) : null;
}

let files;
try {
  files = readdirSync(templateDir).filter((f) => f.endsWith(".md"));
} catch {
  console.error(`lint-prompt-size: 模板目录不可读（${templateDir}）`);
  process.exit(2);
}

let violations = 0;
let warns = 0;
const perFile = [];

for (const file of files) {
  const content = readFileSync(join(templateDir, file), "utf8");
  const body = stripFrontmatter(content);
  const bytes = Buffer.byteLength(body, "utf8");
  const chars = body.length; // sqlite length() 语义（码点数近似）
  const override = extractBudgetOverride(content);
  const budget = override ?? BUDGET_BYTES;
  const warnLine = override ?? WARN_BYTES;

  if (bytes > budget) {
    violations += 1;
    console.error(
      `✗ ${file}: ${bytes}B（${chars} 字符）超预算 ${budget}B${override ? "（per-file override）" : ""}——先出清再合入（加 X 减 X 增量纪律，见 F20260917pbgg）`,
    );
  } else if (bytes > warnLine) {
    warns += 1;
    console.warn(`⚠ ${file}: ${bytes}B 触警告线 ${warnLine}B——增量纪律：再增须等量出清`);
  }
  perFile.push(`${file}: ${bytes}B`);
}

console.log(`prompt 体积预算闸：${files.length} 个模板，${violations} 超预算 / ${warns} 警告`);
if (process.env.VERBOSE) perFile.forEach((l) => console.log(`  ${l}`));

process.exit(violations > 0 ? 1 : 0);
