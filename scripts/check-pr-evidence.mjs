#!/usr/bin/env node
/**
 * 证据化交付机械闸（F20261028evpkg，落地 R20261028hacab 综合框架 A 项）。
 *
 * 语义：PR diff 非纯文档（改系统状态的交付）时，PR body 必须含
 * 「## Rollback」段（非占位内容）与证据分层声明（含「机器锚点」或「证据分层声明」字样）。
 * 纯 docs/ 与仓根纯文档（README/CONTRIBUTING/SECURITY/CHANGELOG）豁免——防全量稀释。
 * 不判语义（证据质量留给异体审 B9），只机械判：触发 + Rollback 段非空 + 分层声明存在。
 * 半机械标注：本闸只护「字段存在」，不护「内容真实」——后者由对抗审视 B9 抽样锚点复验护。
 *
 * 退出码：0 通过 / 1 违规（触发但缺 Rollback/缺分层声明/无可核 PR body）/ 2 拒判（diff 为空）。
 * 用法：node scripts/check-pr-evidence.mjs [--base <ref>] [--pr-body-file <path>]
 * PR body 来源：--pr-body-file 或环境变量 PR_BODY（CI pull_request 事件注入）。
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** 纯文档路径（豁免证据包）：docs/ 全树 + 仓根纯文档 */
const DOC_ONLY_RE = /(^docs\/)|(^README)|(^CONTRIBUTING)|(^SECURITY\.md$)|(^CHANGELOG)|(\.md$)/;
/** 不按扩展名豁免的目录：.pi/（SYSTEM.md/skill 是行为契约不是纯文档）与 .github/（模板/CI） */
const CONTRACT_DIR_RE = /^(\.pi\/|\.github\/)/;

export function isDocOnlyPath(p) {
  if (CONTRACT_DIR_RE.test(p)) return false;
  return DOC_ONLY_RE.test(p);
}

/** git diff --name-only 输出解析（含改名 `{old => new}` 简写展开为新路径） */
export function parseChangedPaths(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const raw = line.trim();
    if (!raw) continue;
    const brace = raw.match(/\{([^}]*=>[^}]*)\}/);
    let p = raw;
    if (brace) {
      const [a, b] = brace[1].split("=>").map((s) => s.trim());
      p = raw.replace(/\{[^}]*\}/, b || a);
    }
    out.push(p);
  }
  return out;
}

/** 提取指定二级标题段的正文（## 标题 到下一个 ## 或文末） */
export function extractSection(body, titlePattern) {
  const re = new RegExp(`^##\\s*${titlePattern}\\s*$`, "mi");
  const m = body.match(re);
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(/^##\s/m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** 段内是否有实质内容（排除空与「-」「—」占位行） */
export function hasSubstance(sectionText) {
  return sectionText
    .split("\n")
    .some((l) => l.trim() && !/^[-—–]{1,3}$/.test(l.trim()));
}

function fail(msg) {
  console.error(`❌ [check-pr-evidence] ${msg}`);
  process.exit(1);
}

function main() {
  const argv = process.argv.slice(2);
  let base = "origin/main";
  const baseIdx = argv.indexOf("--base");
  if (baseIdx !== -1 && argv[baseIdx + 1]) base = argv[baseIdx + 1];
  const fileIdx = argv.indexOf("--pr-body-file");
  const bodyFile = fileIdx !== -1 ? argv[fileIdx + 1] : null;

  let diffText = "";
  try {
    diffText = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
      encoding: "utf8",
    });
  } catch {
    fail(`无法取得 git diff（base=${base}）`);
  }

  const paths = parseChangedPaths(diffText);
  if (paths.length === 0) {
    console.error("⚠️ [check-pr-evidence] diff 为空，拒判（M-0f8cf262 口径）");
    process.exit(2);
  }

  const triggers = paths.filter((p) => !isDocOnlyPath(p));
  if (triggers.length === 0) {
    console.log(`✅ [check-pr-evidence] 纯文档交付（${paths.length} 个文件），证据包豁免`);
    return;
  }

  let prBody = process.env.PR_BODY || "";
  if (bodyFile) {
    prBody = fs.readFileSync(path.resolve(bodyFile), "utf8");
  }
  if (!prBody.trim()) {
    fail(
      `改系统状态的交付（${triggers.length} 个非文档文件，如 ${triggers[0]}）但无可核 PR body——证据包无法核验`,
    );
  }

  const rollback = extractSection(prBody, "Rollback");
  if (rollback === null) fail("PR body 缺「## Rollback」段");
  if (!hasSubstance(rollback)) fail("「## Rollback」段为空或仅占位符——写明回滚方式");

  const hasLayering =
    prBody.includes("证据分层声明") || prBody.includes("机器锚点");
  if (!hasLayering) {
    fail("PR body 缺证据分层声明（须含「证据分层声明」或「机器锚点」，机器锚点与 agent 陈述分开列）");
  }

  console.log(
    `✅ [check-pr-evidence] Rollback 段与证据分层声明就位（触发文件 ${triggers.length} 个；内容真实性由异体审 B9 核验）`,
  );
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  main();
}
