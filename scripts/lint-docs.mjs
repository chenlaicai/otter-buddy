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
 * F20261009fdid（#1274）: 新增 id 唯一性检查——文档 id 是 sync_docs 入库的
 * 主键性质标识，两个文件共用同一 id 会导致后同步覆盖前同步（#1274 实证：
 * F20260824ax376 组 fix-lock 篇内容在记忆库被 pr-evaluation 后同步覆盖丢失）。
 * 存量两组重复（ax376 / gh698）已治理清零，本检查防复发。
 *
 * 退出码：0 通过 / 1 有违规。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/** #1274 / F20261009fdid: id 唯一性检查（纯函数，供测试 import）。
 *  entries: Array<{ rel: string, id?: string }>（rel = 仓库根相对路径）。
 *  返回 Map<重复 id, 文件路径列表>；缺 id 的条目跳过（缺 id 由
 *  validateXxxFrontmatter 管辖，不属重复语义）。 */
export function findDuplicateIds(entries) {
  const byId = new Map();
  for (const e of entries) {
    if (!e.id) continue;
    if (!byId.has(e.id)) byId.set(e.id, []);
    byId.get(e.id).push(e.rel);
  }
  const dupes = new Map();
  for (const [id, files] of byId) {
    if (files.length > 1) dupes.set(id, files);
  }
  return dupes;
}

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

async function main() {
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

  let errors = 0;
  let warnings = 0;
  const files = [
    ...walk(path.join(root, "docs/features")),
    ...walk(path.join(root, "docs/research")),
  ];

  const idEntries = []; // #1274: 收集 { rel, id } 供唯一性检查
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
    idEntries.push({ rel, id: frontmatter.id }); // frontmatter.id 可能 undefined，findDuplicateIds 内跳过
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

  // #1274 / F20261009fdid: id 唯一性检查——重复 id 一律 error（防复发锁定）
  const dupes = findDuplicateIds(idEntries);
  for (const [id, dupeFiles] of dupes) {
    errors++;
    console.error(`✗ [duplicate id] ${id} 被 ${dupeFiles.length} 个文件共用:\n    ${dupeFiles.join("\n    ")}`);
    console.error(`    id 是 sync_docs 入库的主键性质标识（重复 = 后同步覆盖前同步，#1274）——重复方应换新 id（F + 当日日期 + 4 随机后缀，先查重）+ git mv 同步文件名`);
  }

  /** Ratchet（#470，#455）: 警告数只许减不许增——与 lint:capability 的 MAX_WARNINGS 同模式。
   *  当前基线构成（#1257 清存量后）：仅剩 3 条 filename 缺 slug——
   *  F20260716i5n2 / F20260826mwrd / F20260826sgpa 被其他历史文档正文以相对链接引用
   *  （如 c2sg/c3hr/c4sg 的「父方案」链接），rename 会断链，而修链接=改历史正文，
   *  被 lint:historical-docs 禁止——三者长期豁免，此值即地板。 */
  const MAX_WARNINGS = 3;

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
}

// isMain 守卫（对齐 lint-intent.mjs）：import 时只暴露纯函数，不触发 dist 依赖与文件遍历
const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  await main();
}
