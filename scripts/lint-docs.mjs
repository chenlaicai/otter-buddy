#!/usr/bin/env node
/**
 * F20260804dcnv: 文档 frontmatter 校验脚本（commit-time gate）。
 *
 * 把反馈从运行时（启动 sync）推到 commit 时（pre-commit hook）--作者改完文档
 * 立刻知道违规，不用等启动后看 health banner。
 *
 * 复用 dist/ 里编译好的 validator + parser（单一真相源，不重复规则）。
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
  console.error("[lint:docs] dist/ 未构建。请先 `npm run build`。");
  process.exit(1);
}

const { validateFeatureFrontmatter, validateResearchFrontmatter } =
  await import(distRoot + "/entities/document/frontmatter-validator.js");
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

let errors = 0;
let warnings = 0;
const files = [
  ...walk(path.join(root, "docs/features")),
  ...walk(path.join(root, "docs/research")),
];

for (const file of files) {
  const rel = path.relative(root, file);
  const txt = fs.readFileSync(file, "utf8");
  let frontmatter;
  try {
    frontmatter = parseFrontmatterFromContent(txt).frontmatter;
  } catch (e) {
    errors++;
    console.error(`✗ ${rel}\n    Missing frontmatter: ${e.message}`);
    continue;
  }
  const type = rel.includes("/features/") ? "feature" : "research";
  const v = type === "feature"
    ? validateFeatureFrontmatter(frontmatter, rel)
    : validateResearchFrontmatter(frontmatter, rel);
  if (!v.valid) {
    errors++;
    console.error(`✗ ${rel}\n    ${v.errors.join("\n    ")}`);
  } else if (v.warnings.length > 0) {
    warnings += v.warnings.length;
    console.warn(`⚠ ${frontmatter.id || rel}\n    ${v.warnings.join("\n    ")}`);
  }
}

/** Ratchet（#470，#455）: 警告数只许减不许增——与 lint:capability 的 MAX_WARNINGS 同模式。
 *  当前基线构成（F20260827spcs 建立时）：221 title slug + 7 缺 slug 文件名 + 38 旧 change_type
 *  + 2 旧 status（review/reviewed）+ 1 旧 exploration_type。存量文档补齐后可下调本数值。 */
const MAX_WARNINGS = 269;

if (warnings > MAX_WARNINGS) {
  errors++;
  console.error(`✗ [lint:docs] 警告数 ${warnings} 超过上限 ${MAX_WARNINGS}（ratchet：新文档必须用人类可读 title + 文件名带 slug 后缀 + 已知枚举值）`);
}
if (warnings > 0) {
  console.warn(`\n[lint:docs] ${warnings} warnings（不阻断 commit，上限 ${MAX_WARNINGS}）`);
}
if (errors > 0) {
  console.error(`\n[lint:docs] ${errors} errors（阻断 commit）`);
  console.error("修复参考：docs/README.md（硬规则单一真相源）");
  process.exit(1);
}
console.log(`[lint:docs] ${files.length} docs OK`);
