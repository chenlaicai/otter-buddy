#!/usr/bin/env node
/**
 * F20261009smex: DDL 同块引用静态门（#1390 事故防线 B）。
 *
 * 背景（第二次 P0 启动事故，#1390 复盘）：
 *   #1365 把 CREATE INDEX 与 CREATE TABLE 放同一 db.exec 块，而索引引用的列
 *   靠块外其后的 ALTER TABLE ADD COLUMN 补——存量库上 CREATE TABLE IF NOT EXISTS
 *   no-op（表早已存在、无该列），索引创建立即炸 `no such column`，永远走不到补列。
 *   全新库 CI/冒烟全绿（CREATE TABLE 一把建全，列天然存在），防线与线上形态错位。
 *
 * 规则（fail-closed，机械可判定）：
 *   对 src/frameworks/db/schema.ts / migration.ts 的每个 CREATE [UNIQUE] INDEX 语句：
 *   其引用的列必须满足其一——
 *   A) 同块 CREATE TABLE 定义了该列（全新库场景，列随表创建）；
 *   B) 同文件存在 ALTER TABLE 补列语句且位置在索引块之前（存量库场景，补列先于索引执行）。
 *   两者都不满足 = 违规（#1365 形态：索引在补列之前，存量库必炸）。
 *
 *   豁免：块内显式注释 `lint-schema:allow-index-before-column`（须附理由，
 *   如表重建场景索引建在 RENAME 后的新表上、列由旧表结构保证存在）。
 *
 * 抓取面（S1 处置后扩面）：
 *   - db.exec(`...`) 模板块（schema.ts/migration.ts 的 DDL 主体）
 *   - db.exec("...") 双引号单行块（migration.ts 的零散 DDL，如 :2088）
 *   - db.prepare("...").run() 单行块（migration.ts 的条件建索引，如 :820/:1235）
 *
 * 为什么是静态门而不是只靠冒烟：冒烟（tests/app/build-app-existing-db.test.ts）
 * 覆盖「快照形态回放」，静态门覆盖「规则本身」——快照可能滞后于 schema 演进，
 * 静态门不依赖快照新鲜度，两道互补。
 *
 * 退出码：0 通过 / 1 有违规。
 */
import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const TARGETS = [
  "src/frameworks/db/schema.ts",
  "src/frameworks/db/migration.ts",
];
const ALLOW_MARK = "lint-schema:allow-index-before-column";

let violations = 0;

/** 从源码提取全部 DDL 块（三种形态：db.exec 模板 / db.exec 双引号 / db.prepare(...).run()）。
 *  返回 { content, start } 列表，content 为 DDL 文本，start 为源码中的字符位置。 */
function extractDdlBlocks(src) {
  const blocks = [];

  // 形态 1：db.exec(`...`) 模板块（多行 DDL 主体）
  // 用 [^`]* 匹配块内容，避免贪婪跨块吞并（schema.ts/migration.ts 的 DDL 块无嵌套反引号）
  for (const m of src.matchAll(/db\.exec\(`([^`]*)`\)/g)) {
    blocks.push({ content: m[1], start: m.index });
  }

  // 形态 2：db.exec("...") 双引号单行块（migration.ts 的零散 DDL）
  for (const m of src.matchAll(/db\.exec\("([^"]*)"\)/g)) {
    blocks.push({ content: m[1], start: m.index });
  }

  // 形态 3：db.prepare("...").run() 单行块（migration.ts 的条件建索引）
  for (const m of src.matchAll(/db\.prepare\("([^"]*)"\)\.run\(\)/g)) {
    blocks.push({ content: m[1], start: m.index });
  }

  return blocks.sort((a, b) => a.start - b.start);
}

for (const rel of TARGETS) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) continue;
  const src = fs.readFileSync(abs, "utf8");

  const blocks = extractDdlBlocks(src);

  // 收集同文件全部 ALTER TABLE ADD COLUMN（补列语句）及其位置——
  // 索引引用列的合法性判据：要么列在同块 CREATE TABLE 中，要么有块外补列语句且位置在索引块之前。
  const alters = [...src.matchAll(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/gi)].map((a) => ({
    table: a[1],
    column: a[2],
    index: a.index,
  }));

  for (const { content: block, start: blockStart } of blocks) {
    const hasCreate = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i.test(block);
    if (block.includes(ALLOW_MARK)) continue;

    // 收集块内全部 CREATE [UNIQUE] INDEX 语句（D1 处置：IF NOT EXISTS 改可选——
    // 硬要求会放过无 IF NOT EXISTS 的裸索引（:2088/:1235 形态），抓取≠检测）
    const idxStmts = [...block.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\w+\s+ON\s+(\w+)\s*\(([^)]+)\)/gi)];
    if (idxStmts.length === 0) continue;

    for (const idx of idxStmts) {
      const table = idx[1];
      const cols = idx[2].split(",").map((c) => c.trim());
      for (const col of cols) {
        // 表达式索引豁免：列含括号/引号（如 JSON_EXTRACT(...)）不是裸列名，跳过
        if (/[('"]/.test(col)) continue;

        // 路径 A：列在同块 CREATE TABLE 定义内（列定义形态：`  col TYPE`）
        const colInCreate = hasCreate && new RegExp(`^\\s*${col}\\s+[A-Z]`, "im").test(block);
        if (colInCreate) continue;

        // 路径 B：同文件存在更早的 CREATE TABLE 定义了该列（独立索引块引用已建表）。
        // D3 修复：括号计数器限定在该表自己的定义体内——[\s\S]*? 会跨表吞并
        // （messages 前缀一路吞到 messages_meta 的同名列 → 假放行），\b 挡不住惰性跨段
        const before = src.slice(0, blockStart);
        const tableDefRe = new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${table}\\b\\s*\\(`, "gi");
        let definedInEarlier = false;
        for (const m of before.matchAll(tableDefRe)) {
          let depth = 0;
          let i = m.index + m[0].length - 1; // m[0] 以 '(' 结尾，从它开始计深
          for (; i < before.length; i++) {
            const ch = before[i];
            if (ch === "(") depth++;
            else if (ch === ")") {
              depth--;
              if (depth === 0) break;
            }
          }
          const body = before.slice(m.index + m[0].length, i);
          if (new RegExp(`^\\s*${col}\\s+[A-Z]`, "im").test(body)) {
            definedInEarlier = true;
            break;
          }
        }
        if (definedInEarlier) continue;

        // 路径 C：同文件存在 ALTER TABLE 补列语句且位置在本索引块之前（补列先于索引执行）
        const alterBefore = alters.find(
          (a) => a.table === table && a.column === col && a.index < blockStart,
        );
        if (alterBefore) continue;

        violations++;
        const blockHint = hasCreate ? "同块" : "独立索引块";
        console.error(
          `✗ ${rel}\n    CREATE INDEX ${table}(${cols.join(", ")}) 引用列「${col}」——${blockHint} CREATE TABLE 未定义该列，同文件更早 CREATE TABLE 也未定义，且无块外补列（ALTER TABLE ADD COLUMN）先于本块。\n` +
            `    存量库上 IF NOT EXISTS no-op 后索引创建必炸 no such column（#1390 事故形态）。\n` +
            `    修法：索引挪到补列（ALTER TABLE ADD COLUMN）之后的独立 exec 块；\n` +
            `    确属表重建等安全场景，块内加注释 ${ALLOW_MARK} 并附理由。`,
        );
      }
    }
  }
}

if (violations > 0) {
  console.error(`[lint:schema] ${violations} 个违规`);
  process.exit(1);
}
console.log("[lint:schema] OK");
