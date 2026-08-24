#!/usr/bin/env node
/**
 * F20260824ax376: PR 评估体系 - intent 字段校验脚本（commit-time gate）。
 *
 * 检查 F 文档 frontmatter 的 intent 字段，确保每次合入都有明确目标。
 * 依赖：pre-commit hook 已跑 `npm run check`（= build）产出 dist/。
 *
 * 退出码：0 通过 / 1 有违规。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const distRoot = pathToFileURL(path.join(root, "dist/src")).href;

if (!fs.existsSync(path.join(root, "dist/src/entities/document/frontmatter-validator.js"))) {
  console.error("[lint:intent] dist/ 未构建。请先 `npm run build`。");
  process.exit(1);
}

const { parseFrontmatterFromContent } =
  await import(distRoot + "/usecases/document/frontmatter-parse.js");

function walk(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

// Intent 字段校验规则
const INTENT_REQUIRED_CHANGE_TYPES = new Set(["feature"]);
const INTENT_RECOMMENDED_CHANGE_TYPES = new Set(["bugfix", "refactor"]);
const VALID_VERIFY_BY_TYPES = new Set(["metric_probe", "behavior_check", "human_judge"]);

function validateIntent(fm) {
  const errors = [];
  const warnings = [];

  // 检查 intent 字段是否存在
  if (!fm.intent || typeof fm.intent !== "object") {
    // 根据 change_type 决定是错误还是警告
    const changeType = fm.change_type;
    if (INTENT_REQUIRED_CHANGE_TYPES.has(changeType)) {
      // 存量文档只产生警告，不阻断 commit
      warnings.push(`Missing intent field for ${changeType}`);
    } else if (INTENT_RECOMMENDED_CHANGE_TYPES.has(changeType)) {
      warnings.push(`Recommended intent field for ${changeType}`);
    }
    return { errors, warnings };
  }

  const intent = fm.intent;

  // 检查 problem 字段
  if (!intent.problem || typeof intent.problem !== "string") {
    const changeType = fm.change_type;
    if (INTENT_REQUIRED_CHANGE_TYPES.has(changeType)) {
      errors.push("Missing intent.problem field");
    } else if (INTENT_RECOMMENDED_CHANGE_TYPES.has(changeType)) {
      warnings.push("Recommended intent.problem field");
    }
  } else {
    // 检查 problem 是否为空或只包含空白字符
    if (intent.problem.trim().length === 0) {
      errors.push("intent.problem field is empty");
    }
  }

  // 检查 expected_effect 字段（feature 必填，bugfix/refactor 推荐）
  if (!intent.expected_effect || typeof intent.expected_effect !== "string") {
    const changeType = fm.change_type;
    if (INTENT_REQUIRED_CHANGE_TYPES.has(changeType)) {
      errors.push("Missing intent.expected_effect field");
    }
    // bugfix/refactor 可以不填 expected_effect
  } else {
    // 检查 expected_effect 是否可判定（不含模糊词）
    const fuzzyWords = ["提升", "优化", "改善", "更好", "更优", "增强"];
    const hasFuzzyWord = fuzzyWords.some(word => intent.expected_effect.includes(word));
    if (hasFuzzyWord) {
      warnings.push("intent.expected_effect contains fuzzy words (提升/优化/改善等)");
    }
  }

  // 检查 verify_by 字段（feature 必填，bugfix/refactor 可选）
  if (intent.verify_by) {
    if (typeof intent.verify_by !== "object") {
      errors.push("intent.verify_by must be an object");
    } else {
      // 检查 verify_by.type 是否为合法值
      if (!intent.verify_by.type || !VALID_VERIFY_BY_TYPES.has(intent.verify_by.type)) {
        errors.push(`Invalid intent.verify_by.type: ${intent.verify_by.type}. Must be one of: ${Array.from(VALID_VERIFY_BY_TYPES).join(", ")}`);
      }
    }
  } else {
    // verify_by 可选，但 feature 最好有
    const changeType = fm.change_type;
    if (INTENT_REQUIRED_CHANGE_TYPES.has(changeType)) {
      warnings.push("Recommended intent.verify_by field for feature");
    }
  }

  // 检查 effect_window 字段（可选，有默认值）
  if (intent.effect_window) {
    if (typeof intent.effect_window !== "string") {
      errors.push("intent.effect_window must be a string (e.g., '72h', '1w')");
    } else {
      // 简单校验格式：数字 + 单位（h/d/w）
      if (!/^\d+[hdw]$/.test(intent.effect_window)) {
        errors.push(`Invalid intent.effect_window format: ${intent.effect_window}. Must be like '72h', '1d', '1w'`);
      }
    }
  }

  return { errors, warnings };
}

let errors = 0;
let warnings = 0;
const files = walk(path.join(root, "docs/features"));

for (const file of files) {
  const rel = path.relative(root, file);
  const txt = fs.readFileSync(file, "utf8");
  let frontmatter;
  try {
    frontmatter = parseFrontmatterFromContent(txt).frontmatter;
  } catch {
    // 缺少 frontmatter 的文件由 lint-docs 处理，这里跳过
    continue;
  }

  const result = validateIntent(frontmatter, rel);

  if (result.errors.length > 0) {
    errors++;
    console.error(`✗ ${rel}\n    ${result.errors.join("\n    ")}`);
  } else if (result.warnings.length > 0) {
    warnings++;
    console.warn(`⚠ ${frontmatter.id || rel}\n    ${result.warnings.join("\n    ")}`);
  }
}

if (warnings > 0) {
  console.warn(`\n[lint:intent] ${warnings} warnings（不阻断 commit）`);
}
if (errors > 0) {
  console.error(`\n[lint:intent] ${errors} errors（阻断 commit）`);
  console.error("修复参考：docs/README.md（硬规则单一真相源）");
  process.exit(1);
}
console.log(`[lint:intent] ${files.length} docs OK`);
