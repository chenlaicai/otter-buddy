/**
 * F20260811mrpy Part 2：extractSnippet 边界测试
 *
 * SqliteMemoryRepository.extractSnippet 是 private 方法，通过 searchFTSWithHighlight 间接测试。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import { tokenizeWithJieba } from "@frameworks/db/jieba-tokenizer";
import { initSchema } from "@frameworks/db/schema";
import type DatabaseType from "better-sqlite3";

let db: DatabaseType.Database;
let repo: SqliteMemoryRepository;

beforeAll(() => {
  db = new Database(":memory:");
  try { loadSqliteVec(db); } catch { /* */ }
  initSchema(db);
  repo = new SqliteMemoryRepository(db);
});

afterAll(() => {
  db.close();
});

function insertEntry(id: string, content: string) {
  db.prepare(`
    INSERT INTO memory_entries (id, layer, content_type, source_id, source_table,
      conversation_id, granularity, content, metadata, created_at)
    VALUES (?, 'working', 'message', ?, 'messages', NULL, 'fine', ?, NULL, '2026-08-11T00:00:00Z')
  `).run(id, id, content);
  // 同步写 jieba FTS 表（storeEntry 双写，这里手动写以便查询）
  // jieba 表存储分词后内容（空格分隔 tokens），匹配 searchFTSWithHighlight 的 tokenizeQuery 行为
  const tokenized = tokenizeWithJieba(content); // 返回已是 join 后的 string
  db.prepare(`
    INSERT INTO memory_fts_jieba (memory_entry_id, content) VALUES (?, ?)
  `).run(id, tokenized);
}

describe("searchFTSWithHighlight - F20260811mrpy Part 2 extractSnippet", () => {
  it("snippet 含匹配 token 且加了省略号窗口", async () => {
    const longContent = "前导文本".repeat(50) + "目标关键词" + "后继文本".repeat(50);
    insertEntry("e1", longContent);

    const hits = await repo.searchFTSWithHighlight("目标关键词", {});
    expect(hits).toHaveLength(1);
    const snippet = hits[0].snippet ?? "";
    expect(snippet).toContain("目标关键词");
    expect(snippet.length).toBeLessThan(longContent.length);
    expect(snippet.startsWith("...") || snippet.endsWith("...")).toBe(true);
  });

  it("jieba 不分词的纯英文短查询仍能命中", async () => {
    insertEntry("e2-en", "memory recall optimization with various keywords");
    const hits = await repo.searchFTSWithHighlight("memory", {});
    expect(hits.length).toBeGreaterThan(0);
    const target = hits.find(h => h.entryId === "e2-en");
    expect(target?.snippet).toContain("memory");
  });

  it("token 全部不匹配时 fallback 到前 200 字符", async () => {
    const longContent = "完全无关的内容".repeat(100);
    insertEntry("e3", longContent);
    // 搜一个不存在的 token——jieba 分词后能查询但 content 里没匹配
    // 用 e3 这个 ID 本身做 query（jieba 分 "e3"，能匹配 memory_fts_jieba）
    const hits = await repo.searchFTSWithHighlight("e3", {});
    // 即使 FTS 命中，extractSnippet 在 content 里 indexOf "e3" 找不到
    const target = hits.find(h => h.entryId === "e3");
    if (target) {
      // #740: fallback 带 sourceId 前缀（[e3] + 空格 + 200 字符）
      expect(target.snippet?.startsWith("[e3] ")).toBe(true);
      expect((target.snippet?.length ?? 0) <= 205).toBe(true); // 前缀 + 200 字符
    }
  });

  it("#740: 锚点命中时 snippet 回退显示文档标识前缀", async () => {
    // 模拟 F20260902rcq3 锚点注入形态：FTS 索引含 sourceId 前缀，content 本体不含
    const content = "这是文档正文，不包含自己的编号。".repeat(10);
    const fid = "F20260829raft";
    db.prepare(`
      INSERT INTO memory_entries (id, layer, content_type, source_id, source_table,
        conversation_id, granularity, content, metadata, created_at)
      VALUES ('anchor-doc', 'document', 'feature', ?, 'features', NULL, 'summary', ?, NULL, '2026-08-29T00:00:00Z')
    `).run(fid, content);
    // FTS 索引按锚点注入逻辑写：sourceId + content（sqlite-memory-repository.ts:112 同款）
    db.prepare(`
      INSERT INTO memory_fts_jieba (memory_entry_id, content) VALUES (?, ?)
    `).run("anchor-doc", tokenizeWithJieba(`${fid} ${content}`));

    const hits = await repo.searchFTSWithHighlight(fid, {});
    const target = hits.find(h => h.entryId === "anchor-doc");
    expect(target).toBeDefined();
    // 修复后：锚点词在 content 里找不到 → fallback 带 [F20260829raft] 前缀，命中原因可见
    expect(target?.snippet?.startsWith(`[${fid}] `)).toBe(true);
    expect(target?.snippet).toContain("这是文档正文");
  });

  it("#740: 正常命中路径不受 sourceIdPrefix 影响", async () => {
    const longContent = "leadfiller ".repeat(80) + "realmemkeyword" + " tailfiller ".repeat(80);
    insertEntry("e4-normal", longContent);
    const hits = await repo.searchFTSWithHighlight("realmemkeyword", {});
    const target = hits.find(h => h.entryId === "e4-normal");
    expect(target).toBeDefined();
    expect(target?.snippet).toContain("realmemkeyword");
    expect(target?.snippet?.startsWith("[")).toBe(false); // 正常路径无前缀
  });
});
