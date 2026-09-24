#!/usr/bin/env node
/**
 * F20260824ax376: PR 评估体系 - intent 字段校验脚本（commit-time gate）。
 * F20260825evgl: 扩展软代码域三值 + 联动可判定检查；validateIntent 导出供测试 import 真实现
 *               （检视发现 1：测试副本与实现分叉导致假阳性，改为单一真相源）。
 * F20260917sdpl: 软代码 verify_by 声明时间界收口（≥2026-09-17 error）+ golden_replay 执行
 *               记录弱核对（分环境：本地 error / CI 缺文件降 warning）。
 *
 * 检查 F 文档 frontmatter 的 intent 字段，确保每次合入都有明确目标。
 * 依赖：pre-commit hook 已跑 `npm run check`（= build）产出 dist/。
 *
 * 退出码：0 通过 / 1 有违规。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = process.cwd();
// F20260917sdpl：golden_replay 执行核对读此路径。测试通过临时切 cwd 覆盖。
// 注：root 在模块加载时求值；validateIntent 内用 getter 重新读 process.cwd()，
// 使测试的 withTempCwd 切目录生效（脚本主流程仍用上面的 root，行为不变）。
const goldenResultsPath = () => path.join(process.cwd(), "data", "metrics", "golden-results.jsonl");
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

// F20260917sdpl：软代码 verify_by 声明收口时间界——created_at ≥ 此日期的新文档缺声明是 error。
// 可伪造性：lint 不防（回填旧日期可降回 warning），由检视獭按 git 首提交时间对照打回（PR 核对点④）。
const SOFT_CODE_ENFORCE_DATE = "2026-09-17";

/** 时间界判定：文档 created_at ≥ 收口日期（created_at 缺失按存量处理，不追诉） */
function isNewEnough(fm) {
  if (typeof fm.created_at !== "string") return false;
  return fm.created_at >= SOFT_CODE_ENFORCE_DATE;
}

/**
 * P0-c 声明率统计：分两层（intent 存在率 / verify_by 率）× 两口径（存量参考 / 本期判定）。
 * 存量参考 = 全量文档；本期判定 = 本次 PR 修改的文档（通过 git diff 获取）。
 */
async function computeDeclarationStats(files, root) {
  // 获取本次 PR 修改/新增的文件列表（diff 仅含 tracked 修改，untracked 新文档单独列）
  let currentFiles = new Set();
  try {
    const diffOutput = execSync(
      "git diff --name-only origin/main -- docs/features && git ls-files --others --exclude-standard docs/features",
      { encoding: "utf8", cwd: root },
    );
    currentFiles = new Set(
      diffOutput.split("\n").filter(f => f.startsWith("docs/features/") && f.endsWith(".md"))
    );
  } catch {
    // 非 git 环境或无 origin/main，本期判定为空
  }

  const stats = {
    existing: { total: 0, intentExists: 0, verifyByExists: 0, intentRate: 0, verifyByRate: 0 },
    current: { total: 0, intentExists: 0, verifyByExists: 0, intentRate: 0, verifyByRate: 0 },
  };

  const { parseFrontmatterFromContent } =
    await import(distRoot + "/usecases/document/frontmatter-parse.js");

  for (const file of files) {
    const rel = path.relative(root, file);
    const txt = fs.readFileSync(file, "utf8");
    let frontmatter;
    try {
      frontmatter = parseFrontmatterFromContent(txt).frontmatter;
    } catch {
      continue;
    }

    // 存量参考统计
    stats.existing.total++;
    if (frontmatter.intent && typeof frontmatter.intent === "object") {
      stats.existing.intentExists++;
      if (frontmatter.intent.verify_by) {
        stats.existing.verifyByExists++;
      }
    }

    // 本期判定统计（仅统计本次 PR 修改的文档）
    if (currentFiles.has(rel)) {
      stats.current.total++;
      if (frontmatter.intent && typeof frontmatter.intent === "object") {
        stats.current.intentExists++;
        if (frontmatter.intent.verify_by) {
          stats.current.verifyByExists++;
        }
      }
    }
  }

  // 计算百分比。口径（v6.3 方案 P0-c）：intent 存在率分母 = 全部文档；
  // intent 内 verify_by 率分母 = 有 intent 的文档（若分母用全量，3 个 intent 全带 verify_by
  // 会读成 3/393=1%，掩盖「写了 intent 的都声明了验证方式」这一事实）
  stats.existing.intentRate = stats.existing.total > 0
    ? Math.round(stats.existing.intentExists / stats.existing.total * 100)
    : 0;
  stats.existing.verifyByRate = stats.existing.intentExists > 0
    ? Math.round(stats.existing.verifyByExists / stats.existing.intentExists * 100)
    : 0;
  stats.current.intentRate = stats.current.total > 0
    ? Math.round(stats.current.intentExists / stats.current.total * 100)
    : 0;
  stats.current.verifyByRate = stats.current.intentExists > 0
    ? Math.round(stats.current.verifyByExists / stats.current.intentExists * 100)
    : 0;

  return stats;
}

function validateIntent(fm) {
  const errors = [];
  const warnings = [];

  // 检查 intent 字段是否存在
  // F20260924vbsu：verify_by 位置统一收口——唯一合法位置是 intent 块内嵌套式。
  // 顶层式（frontmatter 顶层 verify_by）是 2026-09-17 后 3 个文档（mfrc/somf/icus）自创旁支，
  // 旁路了本校验的全部规则（类型枚举/expected_effect 联动/golden 核对），一律 error 指回嵌套式。
  if (fm.verify_by !== undefined) {
    errors.push(
      "frontmatter 顶层 verify_by 是非法位置（schema 已统一为 intent 块内嵌套式，见 #1158/F20260924vbsu）——请把 verify_by 移入 intent 块内",
    );
  }
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
    // F20260824ax376 存量宽容：2026-09-17 之前的文档统一 warning 不阻断。
    // F20260917sdpl 收口：created_at ≥ ENFORCE_DATE 的新软代码文档缺 verify_by → error
    // （时间界增量收口：新规则管新文档，不追诉存量）。
    const changeType = fm.change_type;
    if (isSoftCodeChange(fm)) {
      if (isNewEnough(fm)) {
        errors.push(
          `Missing intent.verify_by for soft-code change (modules 含 prompts/ 或 .pi/, created_at ≥ ${SOFT_CODE_ENFORCE_DATE})——新软代码 PR 必须显式声明 verify_by（推荐 capability_test/golden_replay/human_judge/static_only，metric_probe 在指标验证场景亦合法），纯润色类可用 static_only`,
        );
      } else {
        warnings.push("Recommended intent.verify_by field for soft-code change (modules 含 prompts/ 或 .pi/)——软代码 PR 应显式声明 capability_test/golden_replay/human_judge/static_only 四选一");
      }
    } else if (INTENT_REQUIRED_CHANGE_TYPES.has(changeType)) {
      warnings.push("Recommended intent.verify_by field for feature");
    }
  }

  // F20260917sdpl 改动 2：golden_replay 声明的执行核对（弱机械核对，分环境）。
  // 文件存在（本地）：无 ts ≥ created_at 记录 → error；文件不存在（CI 干净环境）→ warning
  // 提示不阻断（真实闸门在本地 lint 时机，CI 只兜底提醒——假红与假绿同为伪门禁）。
  // created_at 缺失的文档（存量无此字段）无时间界锚点，跳过核对——与声明收口的
  // 「missing created_at 按存量宽容」同口径，不追诉（实测：F20260902gact/F20260917asgv
  // 声明 golden_replay 但无 created_at，不跳过会在主仓本地必误伤）。
  if (intent.verify_by && typeof intent.verify_by === "object" &&
      intent.verify_by.type === "golden_replay" && isSoftCodeChange(fm) &&
      typeof fm.created_at === "string") {
    const resultsPath = goldenResultsPath();
    const createdAt = fm.created_at;
    if (fs.existsSync(resultsPath)) {
      const hasRecordAfterCreation = fs.readFileSync(resultsPath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .some((line) => {
          try {
            const rec = JSON.parse(line);
            return typeof rec.ts === "string" && rec.ts.slice(0, 10) >= createdAt;
          } catch { return false; }
        });
      if (!hasRecordAfterCreation) {
        errors.push(
          `intent.verify_by.type=golden_replay 但 data/metrics/golden-results.jsonl 无 created_at(${createdAt})之后的执行记录——先跑 npm run test:capability:only，fail 行按 PR 模板 Golden Gate 条款处置`,
        );
      }
    } else {
      warnings.push(
        "golden_replay 执行记录文件 data/metrics/golden-results.jsonl 不存在（CI 干净环境无本地记录）——本核对的真实闸门在本地 lint 时机（文档创建后、PR 前），请确认本地已跑 golden 并留痕",
      );
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

export { validateIntent, isSoftCodeChange, isNewEnough, VALID_VERIFY_BY_TYPES, SOFT_CODE_ENFORCE_DATE };

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

  // P0-c 声明率上墙：分两层（intent 存在率 / verify_by 率）× 两口径（存量参考 / 本期判定）
  const stats = await computeDeclarationStats(files, root);
  console.log(`\n[lint:intent] 声明率统计（P0-c）：`);
  console.log(`  存量参考（全量文档）：`);
  console.log(`    intent 存在率：${stats.existing.intentExists}/${stats.existing.total} = ${stats.existing.intentRate}%`);
  console.log(`    verify_by 率（分母=有 intent 的文档）：${stats.existing.verifyByExists}/${stats.existing.intentExists} = ${stats.existing.verifyByRate}%`);
  console.log(`  本期判定（本次 PR 修改的文档）：`);
  console.log(`    intent 存在率：${stats.current.intentExists}/${stats.current.total} = ${stats.current.intentRate}%`);
  console.log(`    verify_by 率（分母=有 intent 的文档）：${stats.current.verifyByExists}/${stats.current.intentExists} = ${stats.current.verifyByRate}%`);
}
