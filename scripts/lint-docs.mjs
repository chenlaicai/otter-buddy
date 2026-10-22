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
 * F20261022frsh（#1400）: 新增 dist 新鲜度闸——src 修改晚于 dist 构建即报错
 * （陈旧 dist 假绿防线）。issue 现场：本地 dist 停在旧 commit 时跑 lint:docs
 * 用旧 validator 逻辑假绿、误导「预检干净」判断，CI fresh build 才报红返工。
 * pre-commit 路径不受影响（check 的 build 先行，dist 恒新鲜）。
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
 *  validateXxxFrontmatter 管辖，不属重复语义）。
 *
 *  ⚠️ 与 fid-format 门的隐式耦合（检视 S3）：本检查按字面量精确比对 id，
 *  大小写/空白/前缀等变体之所以不构成绕过，依赖 dist 侧 validateFeatureId
 *  （fid-format.ts 严校验）在前置路径上已拦——若未来 format 门放宽（如允许
 *  大小写不敏感域），此处需同步引入规范化比对，否则变体可逃过重复检查。 */
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

/** #1400 / F20261022frsh: dist 新鲜度检查（纯函数，供测试 import）。
 *  srcEntries / distEntries: Array<{ rel: string, mtimeMs: number }>。
 *  判据（fail-closed）：src 最新修改时刻 >= dist 产物最早写入时刻 → 这次 src
 *  修改未进 dist（陈旧），lint 结果基于旧 validator 不可信（假绿——issue 现场：
 *  本地旧 dist 绿、CI fresh build 红）。等号保守判陈旧（写入同刻无法证明已含）。
 *
 *  目录级而非依赖图级：两目录内新增 import 自动入列（跨目录依赖出现时需扩列，
 *  当前无此形态）；误报方向安全（多提示一次 rebuild），假绿方向被闸死。
 *
 *  返回 { fresh: true } / { fresh: true, skipped: true }（任一侧为空——dist 缺失
 *  归调用方「未构建」检查管，此处不误报）/ { fresh: false, newestSrc }（供报错指路）。 */
export function evaluateDistFreshness(srcEntries, distEntries) {
  if (srcEntries.length === 0 || distEntries.length === 0) {
    return { fresh: true, skipped: true };
  }
  const newestSrc = srcEntries.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
  const oldestDist = distEntries.reduce((a, b) => (b.mtimeMs < a.mtimeMs ? b : a));
  if (newestSrc.mtimeMs >= oldestDist.mtimeMs) {
    return { fresh: false, newestSrc: newestSrc.rel };
  }
  return { fresh: true };
}

function walk(dir, ext = ".md") {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, ext));
    else if (e.name.endsWith(ext)) out.push(full);
  }
  return out;
}

/** #1400: 递归收集 dir 下 ext 文件的 { rel, mtimeMs }（rel = 仓库根相对路径）。 */
function collectMtimes(root, dir, ext) {
  return walk(dir, ext).map((full) => ({
    rel: path.relative(root, full),
    mtimeMs: fs.statSync(full).mtimeMs,
  }));
}

async function main() {
  const root = process.cwd();
  const distRoot = pathToFileURL(path.join(root, "dist/src")).href;

  if (!fs.existsSync(path.join(root, "dist/src/entities/document/frontmatter-validator.js"))) {
    console.error("[lint:docs] dist/ 未构建。请先 `npm run build`。");
    process.exit(1);
  }

  // #1400 / F20261022frsh: dist 新鲜度闸——在 import 前把关，陈旧 dist 即拒绝运行
  // （假绿防线：旧 validator 不含新规则 → 绿是假绿，误导预检）。覆盖面 = validator
  // 与 parser 的源目录（目录级；目录内新增 import 自动入列，跨目录依赖出现时需
  // 同步扩列——当前无此形态）。
  const fresh = evaluateDistFreshness(
    [
      ...collectMtimes(root, path.join(root, "src/entities/document"), ".ts"),
      ...collectMtimes(root, path.join(root, "src/usecases/document"), ".ts"),
    ],
    [
      ...collectMtimes(root, path.join(root, "dist/src/entities/document"), ".js"),
      ...collectMtimes(root, path.join(root, "dist/src/usecases/document"), ".js"),
    ],
  );
  if (!fresh.fresh) {
    console.error(`✗ [lint:docs] dist/ 产物陈旧（#1400 假绿防线）：${fresh.newestSrc} 的修改未进构建，` +
      "当前跑的是旧 validator 逻辑，结果不可信（本地绿 ≠ CI 绿）");
    console.error("  请先 `npm run build` 重新构建后再跑 lint:docs。");
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
