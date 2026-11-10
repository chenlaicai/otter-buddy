#!/usr/bin/env node
/**
 * #1805 / #1793：恢复 DELETE 事故行的可证明字段并归档。
 *
 * 默认 dry-run，仅打印计划；--apply 才允许写生产 DB。
 * - 先用 better-sqlite3 backup API 生成一致性备份，再在单事务中更新。
 * - category/linked_by/group_id 仅来自 10-26 备份或下面的 merge commit/特性文档映射。
 * - 不从 URL/title 猜字段；metadata/otter_id/auto_linked/superseded_by 无来源不伪造。
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const apply = process.argv.includes("--apply");
const evidenceArg = process.argv.find(arg => arg.startsWith("--evidence="));
const dbArg = process.argv.find(arg => arg.startsWith("--db="));
const root = path.resolve(process.cwd());
const dbPath = dbArg ? path.resolve(dbArg.slice("--db=".length)) : path.join(root, "data/otter-buddy.db");
const backupSource = path.join(root, "data/backups/otter-buddy-pre-ghost-cleanup-online-2026-10-26T06-36-53-256Z.db");
const evidencePath = evidenceArg
  ? path.resolve(evidenceArg.slice("--evidence=".length))
  : path.join(root, "data/backups/restore-1793/restore-fields-1805-evidence.json");

// 人工核对过的合并 commit / PR 标题 / 特性文档；不是从 URL 或 title 推断。
const groupEvidence = new Map(Object.entries({
  "faf8404f-0df3-4d1c-a3a9-3b61168439fa": ["F20261022chatunify", "EchoAgent PR #2238 title"],
  "296a2ec0-f8c0-47ae-8a3b-fe4fb319ca40": ["F20261105ctxbg", "otter-buddy PR #1789 merge 4f72b85e"],
  "814cf104-8c04-4bc4-954f-ce84b2e7f6ba": ["F20261022chatunify", "EchoAgent PR #2238 title"],
  "35404835-d3a6-4aa3-8f4e-dd21aed6c0bd": ["F20261030gcfbx", "otter-buddy PR #1638 merge 944d784a"],
  "ce310949-7520-4542-8dc0-0cb97e12a5d2": ["F20261105sgemu", "otter-buddy PR #1781 merge 9fd92537"],
  "69de2711-9f86-4878-802d-465c0bcabc9e": ["F20261105killa", "otter-buddy PR #1782 merge 0f5a600c"],
  "c10c30b3-0d14-4173-afb3-27aa1a91a7ce": ["F20261105ctxbg", "otter-buddy PR #1789 merge 4f72b85e"],
  "4b65f765-fccb-4a7c-826b-f5e76163cbc2": ["F20261105killa", "otter-buddy PR #1782 merge 0f5a600c"],
  "a305f5a0-1332-4699-9458-e40972667a78": ["F20261105ctxbg", "otter-buddy PR #1789 merge 4f72b85e"],
  "12c8d161-5e30-42cb-9082-9cfba618493a": ["F20261105embqg", "otter-buddy PR #1790 merge 3c0a77ac"],
  "c37d217f-e1b0-41ee-8b6c-0693ab3235f0": ["F20261106gtagl", "otter-buddy PR #1792 merge a94ea3dc"],
}));

const requiredGroupTypes = new Set(["pr", "worktree", "branch"]);
const db = new Database(dbPath, { readonly: !apply });
const backup = new Database(backupSource, { readonly: true });
const rows = db.prepare("SELECT * FROM linked_resources WHERE linked_by = 'restored-1793'").all();
if (rows.length !== 120) throw new Error(`Expected 120 restored rows, got ${rows.length}; refusing partial run`);
const ids = rows.map(row => row.id);
const placeholders = ids.map(() => "?").join(",");
const backupRows = backup.prepare(`SELECT * FROM linked_resources WHERE id IN (${placeholders})`).all(...ids);
const backupById = new Map(backupRows.map(row => [row.id, row]));
if (backupRows.length !== 20) throw new Error(`Expected 20 backup matches, got ${backupRows.length}`);

const updates = [];
const supersededBackupValues = [];
for (const row of rows) {
  const old = backupById.get(row.id);
  const next = { category: row.category, linkedBy: row.linked_by, groupId: row.group_id };
  const sources = {};
  const documented = groupEvidence.get(row.id);
  if (row.group_id === null && documented) {
    next.groupId = documented[0];
    sources.groupId = documented[1];
  }
  if (old) {
    if (documented && old.group_id !== null && documented[0] !== old.group_id) {
      supersededBackupValues.push({ id: row.id, field: "group_id", backup: old.group_id, current: documented[0], accepted: documented[1] });
    }
    if (row.category === null && old.category !== null) {
      next.category = old.category;
      sources.category = "2026-10-26 backup";
    }
    if (row.linked_by === "restored-1793" && old.linked_by !== null) {
      next.linkedBy = old.linked_by;
      sources.linkedBy = "2026-10-26 backup";
    }
    if (next.groupId === null && old.group_id !== null) {
      next.groupId = old.group_id;
      sources.groupId = "2026-10-26 backup";
    }
    for (const [current, previous, name] of [[row.category, old.category, "category"], [row.group_id, old.group_id, "group_id"]]) {
      if (current !== null && previous !== null && current !== previous && !documented) {
        throw new Error(`${row.id} ${name} conflicts with backup; manual review required`);
      }
    }
  }
  if (Object.keys(sources).length > 0) updates.push({ id: row.id, type: row.resource_type, before: { category: row.category, linkedBy: row.linked_by, groupId: row.group_id }, next, sources });
}

const unresolvedGroupIds = rows
  .filter(row => requiredGroupTypes.has(row.resource_type) && row.group_id === null && !groupEvidence.has(row.id) && !backupById.get(row.id)?.group_id)
  .map(row => ({ id: row.id, type: row.resource_type, title: row.title }));
const plan = {
  issue: 1805,
  mode: apply ? "apply" : "dry-run",
  database: dbPath,
  backupSource,
  restoredRows: rows.length,
  backupMatches: backupRows.length,
  activeBefore: db.prepare("SELECT COUNT(*) AS n FROM linked_resources WHERE status = 'active'").get().n,
  restoredStatusBefore: Object.fromEntries(db.prepare("SELECT status, COUNT(*) AS n FROM linked_resources WHERE linked_by = 'restored-1793' GROUP BY status").all().map(row => [row.status, row.n])),
  updates,
  supersededBackupValues,
  unresolvedGroupIds,
  unresolvedFields: {
    category: rows.filter(row => row.category === null && !updates.some(update => update.id === row.id && update.sources.category)).length,
    metadata: rows.filter(row => row.metadata === null).length,
    otterId: rows.filter(row => row.otter_id === null).length,
    autoLinkedUnverified: rows.length,
    supersededBy: rows.filter(row => row.superseded_by === null).length,
    linkedByPlaceholder: rows.filter(row => row.linked_by === "restored-1793" && !updates.some(update => update.id === row.id && update.sources.linkedBy)).length,
  },
};
console.log(JSON.stringify(plan, null, 2));
if (!apply) process.exit(0);

const stamp = new Date().toISOString().replaceAll(":", "-");
const safetyBackup = path.join(path.dirname(dbPath), "backups", `otter-buddy-pre-restore-fields-1805-${stamp}.db`);
fs.mkdirSync(path.dirname(safetyBackup), { recursive: true });
await db.backup(safetyBackup);
const updateStatement = db.prepare("UPDATE linked_resources SET category = ?, linked_by = ?, group_id = ? WHERE id = ? AND linked_by = 'restored-1793'");
const archiveStatement = db.prepare(`UPDATE linked_resources SET status = 'archived' WHERE id IN (${placeholders}) AND status != 'archived'`);
const archiveIds = ids;
let archivedChanges = 0;
db.transaction(() => {
  for (const update of updates) updateStatement.run(update.next.category, update.next.linkedBy, update.next.groupId, update.id);
  archivedChanges = archiveStatement.run(...archiveIds).changes;
})();
const result = {
  ...plan,
  mode: "applied",
  safetyBackup,
  integrityCheck: db.prepare("PRAGMA integrity_check").get(),
  activeAfter: db.prepare("SELECT COUNT(*) AS n FROM linked_resources WHERE status = 'active'").get().n,
  restoredStatusAfter: Object.fromEntries(db.prepare(`SELECT status, COUNT(*) AS n FROM linked_resources WHERE id IN (${placeholders}) GROUP BY status`).all(...ids).map(row => [row.status, row.n])),
  archivedChanges,
  memoryMirrorCount: db.prepare(`SELECT COUNT(*) AS n FROM memory_entries WHERE source_table = 'linked_resources' AND source_id IN (${placeholders})`).get(...ids).n,
  danglingMirrorCount: db.prepare("SELECT COUNT(*) AS n FROM memory_entries m LEFT JOIN linked_resources r ON r.id = m.source_id WHERE m.source_table = 'linked_resources' AND r.id IS NULL").get().n,
};
if (result.activeAfter !== result.activeBefore - archivedChanges) throw new Error("Active reconciliation mismatch after commit");
if (result.restoredStatusAfter.archived !== 120) throw new Error("Not all restored rows reached archived");
if (result.memoryMirrorCount !== 120 || result.danglingMirrorCount !== 0) throw new Error("Memory mirror reconciliation failed");
fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
fs.writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
db.close();
backup.close();
