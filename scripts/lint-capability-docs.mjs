#!/usr/bin/env node
/**
 * F20260806tstr Part 5: 能力测试约定校验（commit-time gate）。
 *
 * 规则（docs/README.md「能力测试约定」）：
 * - change_type 为 feature / prompt 的 F 文档，应声明 capability_test 字段：
 *   指向 tests/capability/ 下的用例路径，或 `n/a: <理由>`（纯代码逻辑改动）。
 * - 缺字段：警告（过渡期不阻断）。
 * - 字段给了路径但文件不存在：错误（说了就要有）。
 *
 * 退出码：0 通过（含警告）/ 1 有错误。
 */
import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const ENFORCED_CHANGE_TYPES = new Set(["feature", "prompt"]);

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

/** 轻量 frontmatter 提取（不依赖 dist，只读 capability_test 与 change_type 两个字段） */
function readFields(txt) {
  const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fields = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    /** 剥引号：change_type: "feature" 与 capability_test: "n/a: ..." 与不带引号等价 */
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return fields;
}

let errors = 0;
let warnings = 0;

for (const file of walk(path.join(root, "docs/features"))) {
  const rel = path.relative(root, file);
  const fields = readFields(fs.readFileSync(file, "utf8"));
  if (!ENFORCED_CHANGE_TYPES.has(fields.change_type)) continue;

  const capTest = fields.capability_test;
  if (!capTest) {
    warnings++;
    console.warn(`⚠ ${rel}\n    change_type=${fields.change_type} 但未声明 capability_test（路径或 n/a: 理由）`);
    continue;
  }
  if (capTest.startsWith("n/a")) continue;

  const testPath = capTest.replace(/^["']|["']$/g, "");
  if (!fs.existsSync(path.join(root, testPath))) {
    errors++;
    console.error(`✗ ${rel}\n    capability_test 指向的文件不存在: ${testPath}`);
  }
}

if (warnings > 0) console.log(`[lint:capability] ${warnings} 个警告（过渡期不阻断）`);
if (errors > 0) {
  console.error(`[lint:capability] ${errors} 个错误`);
  process.exit(1);
}
console.log(`[lint:capability] OK${warnings > 0 ? `（${warnings} warnings）` : ""}`);
