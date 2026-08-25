#!/usr/bin/env node
/**
 * F20260824ax376: PR 评估体系 - intent 字段校验脚本（commit-time gate）。
 * F20260825evgl: 扩展软代码域三值 + 联动可判定检查；validateIntent 导出供测试 import 真实现
 *               （检视发现 1：测试副本与实现分叉导致假阳性，改为单一真相源）。
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
// F20260825evgl：扩展软代码域三值。behavior_check 语义保持"人工行为检查"（对齐
// metric_probe/human_judge 的人工语义），capability_test/golden_replay 是自动采样断言设施，
// static_only 是纯文字润色的静态守护——分开声明避免混淆两类不同验证设施。
const VALID_VERIFY_BY_TYPES = new Set([
  "metric_probe",
  "behavior_check",
  "human_judge",
  "capability_test",
  "golden_replay",
  "static_only",
]);

// 软代码域 verify_by：capability_test/golden_replay 要求 expected_effect 可判定（采样断言门禁）
const SOFT_CODE_SAMPLE_TYPES = new Set(["capability_test", "golden_replay"]);

/** 软代码判定：frontmatter modules 含 prompts/ 或 .pi/ 路径（直接消费已有字段，不重新发明判定） */
function isSoftCodeChange(fm) {
  const modules = fm.modules;
  if (!Array.isArray(modules)) return false;
  return modules.some((m) => typeof m === "string" && (m.startsWith("prompts/") || m.startsWith(".pi/")));
}

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
      } else if (SOFT_CODE_SAMPLE_TYPES.has(intent.verify_by.type)) {
        // F20260825evgl 联动规则：capability_test/golden_replay 要求 expected_effect 可判定——
        // 采样断言的门禁是"评分布移动"翻译成可判定形式，模糊词在这里不是警告是错误。
        const fuzzyWords = ["提升", "优化", "改善", "更好", "更优", "增强"];
        const effect = typeof intent.expected_effect === "string" ? intent.expected_effect : "";
        if (fuzzyWords.some((w) => effect.includes(w))) {
          errors.push(`intent.expected_effect must be measurable when verify_by.type=${intent.verify_by.type}（采样断言门禁，禁用模糊词）`);
        }
      }
    }
  } else {
    // verify_by 缺失：软代码改动（modules 含 prompts/ 或 .pi/）提示必须显式声明。
    // 存量宽容：统一警告不阻断（沿用阶段一策略，与 F20260824ax376 一致）——新规则靠后续
    // PR 检视流程约束（检视獭按 verify_by.type 跑场景），不靠 lint 硬阻断存量文档。
    const changeType = fm.change_type;
    if (isSoftCodeChange(fm)) {
      warnings.push("Recommended intent.verify_by field for soft-code change (modules 含 prompts/ 或 .pi/)——软代码 PR 应显式声明 capability_test/golden_replay/human_judge/static_only 四选一");
    } else if (INTENT_REQUIRED_CHANGE_TYPES.has(changeType)) {
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

export { validateIntent, isSoftCodeChange, VALID_VERIFY_BY_TYPES };

/** 仅作为脚本直接运行时执行 lint 主流程；被测试 import 时只取纯函数，不触发 dist 依赖与文件遍历 */
const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  await main();
}

async function main() {
  if (!fs.existsSync(path.join(root, "dist/src/entities/document/frontmatter-validator.js"))) {
    console.error("[lint:intent] dist/ 未构建。请先 `npm run build`。");
    process.exit(1);
  }

  const { parseFrontmatterFromContent } =
    await import(distRoot + "/usecases/document/frontmatter-parse.js");

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
}
