#!/usr/bin/env node
/**
 * 测试弱化防线（F20261013crit，吸收 F20261012acpt T2 意图并机械化）。
 *
 * 语义：PR diff 中测试路径（tests/ 目录、*.test.*、*.spec.*）或验收装置文件
 * （criteria/ 三件套、闸/lint 脚本、检视规程、CI 工作流、git hooks）出现删除行时，
 * 要求 PR body 含「## 测试改动声明」段且带「方向：收紧|放宽」字段；放宽必须附非空理由。
 * 不判语义（好坏留给检视獭），只机械判：声明存在 + 方向字段 + 放宽理由非空。
 *
 * 触发口径取严：任何删除行即触发（不按「删>增」的净删除口径——净额口径漏「删 2 加 2 空断言」
 * 的零净弱化，见特性文档设计取舍段）。
 *
 * 退出码：0 通过 / 1 违规（弱化无声明、放宽无理由、有删除行但无 PR body 可核）。
 * 用法：node scripts/check-pr-tests.mjs [--base <ref>] [--pr-body-file <path>]
 * PR body 来源：--pr-body-file 或环境变量 PR_BODY（CI pull_request 事件注入）。
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const TEST_PATH_RE = /(^tests\/)|(\.test\.[^/]+$)|(\.spec\.[^/]+$)/;

/**
 * 验收装置文件（闸本体）——放宽/删除验收装置与删测试同级，必须声明显形。
 * 射程：criteria/ 件套（含 lock/waivers/registry）、闸与 lint 脚本、检视规程、CI 工作流、git hooks。
 */
const VERIFY_APPARATUS_RE =
  /(^criteria\/)|(^scripts\/(check|lint)-[^/]*\.mjs$)|(^\.githooks\/)|(^\.github\/workflows\/)|(^\.pi\/skills\/adversarial-review\/)/;

export function isTestPath(p) {
  return TEST_PATH_RE.test(p);
}

export function isVerifyApparatusPath(p) {
  return VERIFY_APPARATUS_RE.test(p);
}

/** git diff --numstat 行解析：`added\tdeleted\t<path>`；改名形态 `old => new` / `dir/{a => b}.ts` */
export function parseNumstat(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const added = m[1] === "-" ? 0 : Number(m[1]);
    const deleted = m[2] === "-" ? 0 : Number(m[2]);
    let raw = m[3];
    // 展开 git 的 `{old => new}` 简写与 `old => new` 双路径
    const brace = raw.match(/\{([^}]*=>[^}]*)\}/);
    let oldPath = null;
    if (brace) {
      const [a, b] = brace[1].split("=>").map((s) => s.trim());
      oldPath = raw.replace(brace[0], a);
      raw = raw.replace(brace[0], b);
    } else if (raw.includes(" => ")) {
      const [a, b] = raw.split(" => ").map((s) => s.trim());
      oldPath = a;
      raw = b;
    }
    out.push({ path: raw, oldPath, added, deleted });
  }
  return out;
}

/** 「## 测试改动声明」段判定：声明存在 + 方向字段（收紧|放宽）+ 放宽时理由非空 */
export function checkDeclaration(body) {
  const lines = String(body ?? "").split("\n");
  const start = lines.findIndex((l) => /^##\s*测试改动声明\s*$/.test(l.trim()));
  if (start < 0) {
    return { ok: false, reason: "PR body 缺少「## 测试改动声明」段（测试改动含删除行时必填）" };
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start, end).join("\n");
  const dir = section.match(/方向\s*[:：]\s*(收紧|放宽)/);
  if (!dir) {
    return { ok: false, reason: "声明段缺「方向：收紧」或「方向：放宽」字段（或方向值不合法）" };
  }
  if (dir[1] === "放宽") {
    const reason = section.match(/理由\s*[:：]\s*(\S.*)/);
    if (!reason) {
      return { ok: false, reason: "方向=放宽必须附非空理由（「理由：<为什么放宽不致弱化>」）" };
    }
  }
  return { ok: true };
}

function parseArgs(argv) {
  const args = { base: "origin/main", bodyFile: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") args.base = argv[++i];
    else if (a === "--pr-body-file") args.bodyFile = argv[++i];
    else {
      console.error(`未知参数：${a}`);
      process.exit(1);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  let diff;
  try {
    diff = execFileSync("git", ["diff", "--numstat", "-M", `${args.base}...HEAD`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    console.error(`[check-pr-tests] git diff 失败（base=${args.base}）：${e.stderr || e.message}`);
    process.exit(1);
  }

  const files = parseNumstat(diff);
  const triggering = files.filter(
    (f) =>
      (isTestPath(f.path) ||
        isVerifyApparatusPath(f.path) ||
        (f.oldPath && (isTestPath(f.oldPath) || isVerifyApparatusPath(f.oldPath)))) &&
      f.deleted > 0,
  );
  if (triggering.length === 0) {
    console.log("[check-pr-tests] OK（测试/验收装置路径无删除行，无需声明）");
    process.exit(0);
  }
  console.log(`[check-pr-tests] 测试/验收装置路径出现删除行 ${triggering.length} 个文件：`);
  for (const f of triggering) {
    const kind = isVerifyApparatusPath(f.path) ? "验收装置" : "测试";
    console.log(`  - [${kind}] ${f.path}（-${f.deleted} / +${f.added}）`);
  }

  let body = null;
  if (args.bodyFile) {
    body = fs.readFileSync(path.resolve(args.bodyFile), "utf8");
  } else if ("PR_BODY" in process.env) {
    body = process.env.PR_BODY ?? "";
  }
  if (body === null) {
    console.error(
      "[check-pr-tests] ✗ 测试/验收装置改动含删除行但无 PR body 可核——CI 需注入 PR_BODY 环境变量或传 --pr-body-file（fail-closed，不放行）",
    );
    process.exit(1);
  }

  const result = checkDeclaration(body);
  if (!result.ok) {
    console.error(`[check-pr-tests] ✗ ${result.reason}`);
    console.error(`
修复参考（PR body 追加）：
## 测试改动声明
方向：收紧   # 或 放宽
理由：删除的是重复/失效断言，覆盖不变   # 方向=放宽时必填
（验收装置文件（criteria/ 件套/闸脚本/检视规程/CI/hooks）的删改同样在此闸射程）
`);
    process.exit(1);
  }
  console.log("[check-pr-tests] OK（测试/验收装置改动声明已登记）");
  process.exit(0);
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main();
}
