/**
 * F20261110dsqci（#1818）第一轮对抗检视回归：真实 SQLite 验证复用闭环。
 *
 * 1. 并发 reindex 的 stale reuse 不得把文档 chunk 删成 0，存活行必须有恢复任务；
 * 2. 同 content 重复 chunk 按队列逐个复用，第二/三轮均零登记且 id 稳定；
 * 3. summary content 未变且 vec 已存在时保留 vec，不再发起实时 embed。
 *
 * lint-tests:allow-ddl——必须用真实 SQLite 事务、embedding_tasks ON CONFLICT
 * 与 memory_vec 行存续验证，内存 mock 无法复现检视报告的并发丢数据。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import { initSchema } from "@frameworks/db/schema";
import { StoreMemory } from "@usecases/memory/store-memory";
import type { MemoryEntryInput } from "@usecases/memory/store-memory";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import { createTestLogger } from "../../helpers/logger";
import { MemoryIndexAdapter } from "../../../src/bootstrap/memory";
import { SyncDocuments } from "@usecases/document/sync-documents";
import { NodeFileSystem } from "@frameworks/file-system/node-file-system";
import { SqliteFeatureRepository } from "@frameworks/db/document/sqlite-feature-repository";
import { SqliteResearchRepository } from "@frameworks/db/document/sqlite-research-repository";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let db: DatabaseType.Database;
let repo: SqliteMemoryRepository;
let store: StoreMemory;
let embedCalls: number;

const gateway: EmbeddingGateway = {
  available: true,
  embed: async () => {
    embedCalls += 1;
    return new Float32Array(1024).fill(0.25);
  },
};

function chunkInput(sourceId: string, index: number, content: string, total = 1): MemoryEntryInput {
  return {
    layer: "document",
    contentType: "feature_chunk",
    sourceId,
    sourceTable: "features",
    granularity: "fine",
    content,
    metadata: { chunk_index: index, chunk_total: total, heading_path: ["正文"], char_count: content.length },
  };
}

function summaryInput(sourceId: string, content: string): MemoryEntryInput {
  return {
    layer: "document",
    contentType: "feature",
    sourceId,
    sourceTable: "features",
    granularity: "coarse",
    content,
    metadata: { title: "复活回归" },
  };
}

function survivingChunks(sourceId: string): Array<{ id: string; content: string }> {
  return db.prepare(
    "SELECT id, content FROM memory_entries WHERE source_table='features' AND source_id=? AND content_type='feature_chunk'",
  ).all(sourceId) as Array<{ id: string; content: string }>;
}

function pendingIds(): string[] {
  return (db.prepare("SELECT entry_id FROM embedding_tasks WHERE status='pending'").all() as Array<{ entry_id: string }>)
    .map(row => row.entry_id);
}

beforeAll(async () => {
  db = new Database(":memory:");
  await loadSqliteVec(db);
  initSchema(db);
});

beforeEach(() => {
  db.exec("DELETE FROM memory_weights; DELETE FROM memory_fts_jieba; DELETE FROM embedding_tasks; DELETE FROM memory_vec; DELETE FROM memory_entries;");
  repo = new SqliteMemoryRepository(db);
  embedCalls = 0;
  store = new StoreMemory(repo, repo, gateway, createTestLogger());
});

afterAll(() => db.close());

describe("StoreMemory + SQLite 内容寻址复用（#1818 对抗检视）", () => {
  it("并发 stale reuse：最终 chunk 不丢，且实际未复用的存活行有 embedding 恢复任务", async () => {
    const sourceId = "F20261110stale";
    const unchanged = chunkInput(sourceId, 0, "旧内容保持完全不变，用于并发 stale 复现");
    const oldId = (await store.replaceChunksBySource([unchanged]))[0];
    db.exec("DELETE FROM embedding_tasks");

    // 强制 A（改内容）与 B（未改内容）都在替换事务前读到同一旧行 O。
    const originalFind = repo.findEntriesBySourceAndType.bind(repo);
    let reads = 0;
    let releaseReads!: () => void;
    const bothRead = new Promise<void>(resolve => { releaseReads = resolve; });
    repo.findEntriesBySourceAndType = async (...args) => {
      const result = await originalFind(...args);
      reads += 1;
      if (reads === 2) releaseReads();
      await bothRead;
      return result;
    };

    await Promise.all([
      store.replaceChunksBySource([chunkInput(sourceId, 0, "并发 A 已把旧内容改成全新版本")]),
      store.replaceChunksBySource([unchanged]),
    ]);

    const rows = survivingChunks(sourceId);
    expect(rows).toHaveLength(1);
    expect(pendingIds()).toContain(rows[0].id);
    // 若 B 后到，O 是 stale 降级 INSERT；若 B 先到，存活行是 A 的 N。两者都必须可恢复。
    expect([oldId, ...pendingIds()]).toContain(rows[0].id);
  });

  it("重复 chunk：第二轮与第三轮都零登记，三个 id 全稳定", async () => {
    const sourceId = "F20261110dups";
    const duplicate = "相同段落重复出现两次，用来验证旧 id 队列收敛";
    const inputs = [
      chunkInput(sourceId, 0, "开头段落的内容足够长，用于真实数据库回归", 3),
      chunkInput(sourceId, 1, duplicate, 3),
      chunkInput(sourceId, 2, duplicate, 3),
    ];
    const first = await store.replaceChunksBySource(inputs);
    expect(new Set(first).size).toBe(3);

    db.exec("DELETE FROM embedding_tasks");
    const second = await store.replaceChunksBySource(inputs);
    expect(second).toEqual(first);
    expect(pendingIds()).toEqual([]);

    const third = await store.replaceChunksBySource(inputs);
    expect(third).toEqual(first);
    expect(pendingIds()).toEqual([]);
    expect(survivingChunks(sourceId)).toHaveLength(3);
  });

  it("SyncDocuments.execute 复活轮：真实 sync 重索引后 chunk id 稳定、pending 零净增", async () => {
    const sourceId = "F20261110synrt";
    const root = mkdtempSync(path.join(tmpdir(), "sync-reuse-"));
    try {
      const dir = path.join(root, "docs/features/2026/11/10");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${sourceId}-sync-reuse.md`), `---
id: ${sourceId}
title: sync 级复活幂等验收
summary: 内容未变的摘要在复活轮保留向量
change_type: fix
status: draft
created_at: 2026-11-10
---
# 正文

这是足够长的文档正文，经过 SyncDocuments 完整路径切分并登记 chunk。
`);
      const featureRepo = new SqliteFeatureRepository(db);
      const sync = new SyncDocuments(
        new NodeFileSystem(),
        featureRepo,
        new SqliteResearchRepository(db),
        new MemoryIndexAdapter(store),
        createTestLogger(),
      );

      const first = await sync.execute(root, { canonicalRootDir: root });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(first.errors).toEqual([]);
      expect(first.synced).toBe(1);
      const firstIds = survivingChunks(sourceId).map(row => row.id);
      const firstPending = pendingIds();
      expect(firstIds).toHaveLength(1);
      expect(firstPending).toEqual(firstIds);

      // 归档→复活强制走 update/reindex，而非 skipped 快路径；同 corpus 不得新增任务。
      await featureRepo.updateStatus(sourceId, "archived");
      const revived = await sync.execute(root, { canonicalRootDir: root });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(revived.updated).toBe(1);
      expect(revived.errors).toEqual([]);
      expect(survivingChunks(sourceId).map(row => row.id)).toEqual(firstIds);
      expect(pendingIds()).toEqual(firstPending);

      const second = await sync.execute(root, { canonicalRootDir: root });
      expect(second.skipped).toBe(1);
      expect(pendingIds()).toEqual(firstPending);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("summary 复活：content 未变且 vec 存在时保留向量，gateway 零调用", async () => {
    const sourceId = "F20261110sumkeep";
    const input = summaryInput(sourceId, "摘要内容在归档复活前后完全一致");
    await store.replaceBySource(input);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(embedCalls).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM memory_vec WHERE memory_entry_id=?").get(sourceId)).toEqual({ c: 1 });

    await store.replaceBySource({ ...input, metadata: { title: "仅 metadata 漂移" } });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(embedCalls).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM memory_vec WHERE memory_entry_id=?").get(sourceId)).toEqual({ c: 1 });
    expect(pendingIds()).toEqual([]);
  });
});
