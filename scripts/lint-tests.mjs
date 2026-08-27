#!/usr/bin/env node
/**
 * F20260806tstr Part 5: 测试反模式的机械拦截（commit-time gate）。
 *
 * 拦截清单（全部是可机械判定、零误判的形态——判断性要求靠 skill/文档信道，不在此列）：
 * 1. tests/ 下手写 CREATE TABLE / CREATE VIRTUAL TABLE（必须 createTestDb，防 schema 漂移）
 * 2. tests/ 下重复定义 mockLogger/noopLogger（必须用 tests/helpers/logger 的 createTestLogger）
 *
 * 退出码：0 通过 / 1 有违规。
 */
import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();

function walk(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|mts)$/.test(e.name)) out.push(full);
  }
  return out;
}

let violations = 0;
const allowDdlFiles = [];
// F20260821kgts: 豁免 ratchet——新增 allow-ddl 豁免必须显式上调此上限
// 2→3（F20260827mpcg）：tests/scripts/cleanup-memory-pollution.test.ts——运维脚本对任意 DB 的
// 行为测试，被测脚本不读生产 schema 迁移链，临时库手写 DDL 无漂移风险（与 migration 测试同类）
// 3→4（F20260829ppta）：tests/frameworks/db/paper-trade-repository-impl-expiry.test.ts——
// 仓储实现测试需要手写 DDL 建立最小表结构（测试 expireOldPendingOrders 的 SQL 行为，
// 不走生产 schema 迁移链，隔离内存 SQLite 无漂移风险）
const MAX_ALLOW_DDL_FILES = 4;

for (const file of walk(path.join(root, "tests"))) {
  const rel = path.relative(root, file);
  const txt = fs.readFileSync(file, "utf8");

  /** 豁免：文件含 "lint-tests:allow-ddl" 标记（迁移测试需要建旧 schema 的表）；
   *  豁免文件数有 ratchet 上限（F20260821kgts），新增豁免必须显式上调并过 review；
   *  匹配前剥掉注释行（防注释里的"CREATE TABLE"字样误报） */
  const codeOnly = txt.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
  const allowDdl = txt.includes("lint-tests:allow-ddl");
  if (allowDdl) allowDdlFiles.push(rel);

  if (!allowDdl && /CREATE\s+(VIRTUAL\s+)?TABLE/i.test(codeOnly)) {
    violations++;
    console.error(`✗ ${rel}\n    手写 DDL（CREATE TABLE）——测试必须用 tests/helpers/createTestDb()（生产 schema），防静默漂移`);
  }
  if (/function\s+(mockLogger|noopLogger)\s*\(/.test(txt)) {
    violations++;
    console.error(`✗ ${rel}\n    重复定义 mockLogger/noopLogger——必须用 tests/helpers/logger 的 createTestLogger()`);
  }
}

if (allowDdlFiles.length > MAX_ALLOW_DDL_FILES) {
  violations++;
  console.error(`✗ allow-ddl 豁免文件 ${allowDdlFiles.length} 个 > 上限 ${MAX_ALLOW_DDL_FILES}：${allowDdlFiles.join(", ")}\n    新增豁免须显式上调 MAX_ALLOW_DDL_FILES 并在 review 中说明理由`);
}

if (violations > 0) {
  console.error(`[lint:tests] ${violations} 个违规`);
  process.exit(1);
}
console.log("[lint:tests] OK");
