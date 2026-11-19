#!/usr/bin/env node
/**
 * connector 配对管理 CLI。
 *
 * 用法：
 *   node scripts/connector-pair.mjs                       # 生成一次性配对码（8 位，10 分钟有效）
 *   node scripts/connector-pair.mjs --list                # 列已配对设备
 *   node scripts/connector-pair.mjs --unpair <deviceId>   # 撤销配对（token 即刻失效，online 行关闭）
 *   node scripts/connector-pair.mjs --db=/path/to.db      # 指定 DB（默认 data/otter-buddy.db）
 *
 * 配对流程：本 CLI 生成一次性码 → 人贴给 connector 首启参数 →
 * connector POST /api/connector/pair 核销换长效 token → 之后 WSS upgrade 用 token 鉴权。
 * 码即秘密：时效内单次核销，过期/重放一律拒绝（repo.redeemPairingCode fail-closed）。
 */
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TTL_MINUTES = 10;

function parseArgs(argv) {
  const args = { db: path.join(rootDir, "data", "otter-buddy.db"), unpair: undefined, list: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--list") args.list = true;
    else if (arg.startsWith("--db=")) args.db = arg.slice(5);
    else if (arg.startsWith("--unpair=")) args.unpair = arg.slice(9);
    else if (args.unpair === undefined && !arg.startsWith("--")) args.unpair = arg;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const db = new Database(args.db);

  if (args.unpair) {
    const closed = db.prepare(
      "UPDATE online_sessions SET status='offline', disconnected_at=datetime('now'), disconnect_reason='auth-failed' WHERE device_id=? AND status='online'",
    ).run(args.unpair);
    const removed = db.prepare("DELETE FROM devices WHERE id=?").run(args.unpair);
    if (removed.changes === 0) {
      process.stderr.write(`未找到设备: ${args.unpair}\n`);
      process.exit(1);
    }
    process.stdout.write(`已撤销配对: ${args.unpair}（关闭 online 行 ${closed.changes} 条，token 即刻失效）\n`);
    db.close();
    return;
  }

  if (args.list) {
    const rows = db.prepare("SELECT id, name, created_at, last_seen_at FROM devices ORDER BY created_at DESC").all();
    if (rows.length === 0) process.stdout.write("（尚无已配对设备）\n");
    for (const row of rows) {
      process.stdout.write(`${row.id}  ${row.name}  配对于 ${row.created_at}  最后活跃 ${row.last_seen_at ?? "无"}\n`);
    }
    db.close();
    return;
  }

  // 生成一次性配对码（8 位数字字母，避免易混淆字符）
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const code = Array.from(randomBytes(8)).map(b => alphabet[b % alphabet.length]).join("");
  const expiresAt = new Date(Date.now() + TTL_MINUTES * 60_000).toISOString();
  db.prepare("INSERT INTO pairing_codes (code, created_at, expires_at, redeemed_at) VALUES (?, ?, ?, NULL)")
    .run(code, new Date().toISOString(), expiresAt);
  process.stdout.write(`配对码: ${code}\n有效期: ${TTL_MINUTES} 分钟（至 ${expiresAt}），单次核销\nconnector 侧使用: node dist/connector/connector/main.js --hub http://localhost:3000 --pair ${code} --name <设备名>\n`);
  db.close();
}

main();
