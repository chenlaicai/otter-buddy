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
    else if (e.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

let violations = 0;

for (const file of walk(path.join(root, "tests"))) {
  const rel = path.relative(root, file);
  const txt = fs.readFileSync(file, "utf8");

  /** 豁免：文件含 "lint-tests:allow-ddl" 标记（迁移测试需要建旧 schema 的表）；
   *  匹配前剥掉注释行（防注释里的"CREATE TABLE"字样误报） */
  const codeOnly = txt.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
  const allowDdl = txt.includes("lint-tests:allow-ddl");

  if (!allowDdl && /CREATE\s+(VIRTUAL\s+)?TABLE/i.test(codeOnly)) {
    violations++;
    console.error(`✗ ${rel}\n    手写 DDL（CREATE TABLE）——测试必须用 tests/helpers/createTestDb()（生产 schema），防静默漂移`);
  }
  if (/function\s+(mockLogger|noopLogger)\s*\(/.test(txt)) {
    violations++;
    console.error(`✗ ${rel}\n    重复定义 mockLogger/noopLogger——必须用 tests/helpers/logger 的 createTestLogger()`);
  }
}

if (violations > 0) {
  console.error(`[lint:tests] ${violations} 个违规`);
  process.exit(1);
}
console.log("[lint:tests] OK");
