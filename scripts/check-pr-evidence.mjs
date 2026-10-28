#!/usr/bin/env node
/**
 * 证据化交付机械闸（F20261028evpkg，落地 R20261028hacab 综合框架 A 项）。
 *
 * 语义：PR diff 非纯文档（改系统状态的交付）时，PR body 必须含
 * 「## Rollback」段（实质内容，非占位）与「## 证据分层声明」段（机器锚点层与
 * agent 陈述层两层字段齐全，或显式声明「无」）。豁免集合精确化：仅 docs/ 全树
 * 与仓根标准文档（README/CONTRIBUTING/SECURITY/CHANGELOG 系 .md）——
 * prompts/、.pi/、.github/ 等运行时契约/行为面按扩展名一律不豁免。
 * 不判语义（证据质量留给异体审 B9），只机械判：触发 + Rollback 实质 + 分层两层。
 * 半机械标注：本闸只护「字段存在与两层结构」，不护「内容真实」——后者由
 * 对抗审视 B9 抽样锚点复验护。
 *
 * 退出码：0 通过 / 1 违规 / 2 拒判（diff 为空，M-0f8cf262 口径）。
 * 用法：node scripts/check-pr-evidence.mjs [--base <ref>] [--pr-body-file <path>]
 * PR body 来源：--pr-body-file 或环境变量 PR_BODY（CI pull_request 事件注入）。
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** 豁免目录（纯叙述文档树） */
const DOC_TREE_RE = /^docs\//;
/** 豁免的仓根标准文档（锚定单层路径，防 README.ts 之类误放） */
const ROOT_DOC_RE =
  /^(README|CONTRIBUTING|SECURITY|CHANGELOG)[A-Za-z0-9._-]*\.md$/;

export function isDocOnlyPath(p) {
  if (DOC_TREE_RE.test(p)) return true;
  // 仓根白名单只认单层路径（不含 /），且必须 .md 结尾
  return !p.includes("/") && ROOT_DOC_RE.test(p);
}

/** git diff --name-only -z 输出解析（NUL 分裂，天然免疫 C-style quote） */
export function parseChangedPaths(text) {
  return text.split("\0").map((s) => s.trim()).filter(Boolean);
}

/** 提取指定二级标题段的正文（## 标题 到下一个 ## 或文末）；标题行允许带括号等后缀（兼容 PR 模板实际格式） */
export function extractSection(body, titlePattern) {
  const re = new RegExp(`^##\\s*${titlePattern}[^\\n]*$`, "mi");
  const m = body.match(re);
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(/^##\s/m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** 占位词：模板说明/待填标记不算实质内容（精确行级匹配，防误杀合法句——D1b：「Remove the feature flag…」是合法回滚说明） */
const PLACEHOLDER_RE = /^(tbd|todo|n\/a|none|待定|待补[充写]?|占位)[.!。]?$/i;
/** PR 模板原句残留（长特征串精确匹配，不做动词前缀匹配——前缀匹配曾误杀合法内容开头） */
const TEMPLATE_PROSE_MARKERS = [
  "how to roll this back",
  "describe the intent",
  "explain the motivation",
  "user-visible or system-level impact",
];

/** 段内是否有实质内容（排除空白、占位词、模板原句残留、单字符占位行） */
export function hasSubstance(sectionText) {
  return sectionText.split("\n").some((l) => {
    const t = l.trim().toLowerCase();
    if (!t) return false;
    if (/^[-—–]{1,3}$/.test(t)) return false;
    if (PLACEHOLDER_RE.test(t)) return false;
    if (TEMPLATE_PROSE_MARKERS.some((m) => t.includes(m))) return false;
    return true;
  });
}

/**
 * 证据分层声明段判定（S3 修复 + D1a 收紧）：限定在「## 证据分层声明」段内，
 * 非文档交付必须两层字段齐全——「机器锚点」层与「agent 陈述」层标识均出现
 * （层内容各自可为「无」）。D1a：trigger=true 场景不接受「无（纯文档豁免）」类
 * 全无声明——纯文档豁免在路径判定层已完成，不走 body 检查。
 * 返回错误列表（空 = 通过）。
 */
export function checkEvidenceLayering(prBody) {
  const section = extractSection(prBody, "证据分层声明");
  if (section === null) {
    return ["PR body 缺「## 证据分层声明」段（在 Summary 里提关键词不算，必须是独立段）"];
  }
  if (!hasSubstance(section)) {
    return ["「## 证据分层声明」段为空或仅占位——写明两层证据或层内显式「无」"];
  }
  const errors = [];
  const hasAnchorLayer = section.includes("机器锚点");
  const hasStatementLayer = section.includes("agent 陈述") || section.includes("未复验");
  if (!hasAnchorLayer) {
    errors.push("证据分层声明段缺「机器锚点」层（层内容可为「无」但层标识必须在；纯文档豁免在路径层已判定，不走 body）");
  }
  if (!hasStatementLayer) {
    errors.push("证据分层声明段缺「agent 陈述」层（层内容可为「无」但层标识必须在）");
  }
  return errors;
}

/** Rollback 段判定：存在 + 实质内容 */
export function checkRollback(prBody) {
  const section = extractSection(prBody, "Rollback");
  if (section === null) return ["PR body 缺「## Rollback」段"];
  if (!hasSubstance(section)) {
    return ["「## Rollback」段为空/仅占位（TBD 等）/模板说明残留——写明回滚方式"];
  }
  return [];
}

/** 核心判定（供单测复用）：triggers=false 时不检查 body */
export function checkEvidenceBody(prBody, { trigger }) {
  if (!trigger) return [];
  if (!prBody.trim()) return ["改系统状态的交付但无可核 PR body——证据包无法核验"];
  return [...checkRollback(prBody), ...checkEvidenceLayering(prBody)];
}

function fail(lines) {
  for (const l of lines) console.error(`❌ [check-pr-evidence] ${l}`);
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
    // -z：NUL 分隔，免疫 core.quotepath 对非 ASCII 路径的 C-style quote（S4 修复）
    diffText = execFileSync("git", ["diff", "--name-only", "-z", `${base}...HEAD`], {
      encoding: "utf8",
    });
  } catch {
    fail([`无法取得 git diff（base=${base}）`]);
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

  const errors = checkEvidenceBody(prBody, { trigger: true });
  if (errors.length > 0) fail(errors);

  console.log(
    `✅ [check-pr-evidence] Rollback 实质内容与证据分层两层就位（触发文件 ${triggers.length} 个；内容真实性由异体审 B9 核验）`,
  );
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  main();
}
