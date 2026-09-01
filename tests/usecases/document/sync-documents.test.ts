/**
 * F20260803mval: SyncDocuments 行为测试
 * 覆盖 upsert（新/内容变/内容不变）、unknown 枚举 warnings、reconcileSync supersedes 悬空
 */
import { describe, it, expect, vi } from "vitest";
import { createHash } from "crypto";
import { SyncDocuments } from "@usecases/document/sync-documents";
import type { FeatureRepository } from "@usecases/document/feature-repository";
import type { ResearchRepository } from "@usecases/document/research-repository";
import type { MemoryIndexGateway } from "@usecases/conversation/memory-index-gateway";
import type { FileSystemGateway } from "@usecases/ports/file-system-gateway";
import type { FeatureDocument } from "@entities/document/feature";
import { cleanMarkdownForFts } from "@usecases/document/markdown-noise-cleaner";
import { createTestLogger } from "../../helpers/logger";

/** F20260803fbit: 算 bodyHash，与 sync-documents 的 computeBodyHash 一致 */
/** F20260803chunk: 加版本前缀 "chunk-v1|"（D3 触发全量 reindex） */
function computeBodyHash(rawBody: string): string | null {
  const cleaned = cleanMarkdownForFts(rawBody);
  if (!cleaned) return null;
  return createHash("sha256").update(`chunk-v1|${cleaned}`).digest("hex").slice(0, 16);
}

const FEATURE_FM = (id: string, summary: string, changeType = "feature", supersedes = "") =>
  `---\nid: ${id}\ntitle: 测试文档\nsummary: ${summary}\nchange_type: ${changeType}\nstatus: draft\nsupersedes: [${supersedes ? `"${supersedes}"` : ""}]\ncreated_at: 2026-08-03\n---\n# 正文\n这是文档正文内容，用于测试分段索引。\n`;

function makeDoc(overrides: Partial<FeatureDocument> = {}): FeatureDocument {
  return {
    id: "F20260803tst1",
    title: "测试文档",
    summary: "测试摘要",
    bodyHash: null,
    changeType: "feature",
    status: "draft",
    tags: [],
    modules: [],
    causalLinksFrom: [],
    supersedes: [],
    filePath: "docs/features/2026/08/03/F20260803tst1.md",
    createdAt: "2026-08-03",
    ...overrides,
  };
}

/** 有状态 featureRepo mock：insert/updateContent 后 findAll 反映状态，避免 reconcileSync 误报 gap */
function makeStatefulFeatureRepo(initial: FeatureDocument[] = []): FeatureRepository & { store: FeatureDocument[] } {
  const store = [...initial];
  return {
    store,
    findById: vi.fn(async (id: string) => store.find(f => f.id === id) ?? null),
    findByFilePath: vi.fn(async (filePath: string) => store.find(f => f.filePath === filePath) ?? null),
    findAll: vi.fn(async () => [...store]),
    insert: vi.fn(async (doc: FeatureDocument) => { store.push(doc); }),
    updateStatus: vi.fn(async () => {}),
    updateContent: vi.fn(async (doc: FeatureDocument) => {
      const i = store.findIndex(f => f.id === doc.id);
      if (i >= 0) store[i] = doc;
    }),
    getCreatedInConversationId: vi.fn(async () => null),
  };
}

function makeResearchRepo(): ResearchRepository {
  return {
    findById: vi.fn(async () => null),
    findByFilePath: vi.fn(async () => null),
    findAll: vi.fn(async () => []),
    insert: vi.fn(async () => {}),
    updateStatus: vi.fn(async () => {}),
    updateContent: vi.fn(async () => {}),
    getCreatedInConversationId: vi.fn(async () => null),
  };
}

/** 智能递归 fs mock：模拟 docs/features/2026/08/03/ 目录树。
 *  F20260901dsyn: docs/research 目录返回空——旧 mock 把两棵树指向同一批文件，
 *  F 文档会被 research 扫描器重复解析报 Invalid research ID（旧测试不断言 errors 才没暴露） */
function makeFs(fileMap: Record<string, string>): FileSystemGateway {
  return {
    readFile: vi.fn(async (p: string) => {
      for (const [key, content] of Object.entries(fileMap)) {
        if (p.includes(key)) return content;
      }
      throw new Error(`readFile not mocked: ${p}`);
    }),
    readDir: vi.fn(async (dir: string) => {
      if (dir.endsWith("docs/research")) return [];
      if (dir.endsWith("docs/features"))
        return [{ name: "2026", isDirectory: () => true, isFile: () => false }];
      if (dir.endsWith("2026")) return [{ name: "08", isDirectory: () => true, isFile: () => false }];
      if (dir.endsWith("08")) return [{ name: "03", isDirectory: () => true, isFile: () => false }];
      if (dir.endsWith("03")) {
        return Object.keys(fileMap).map(name => ({ name, isDirectory: () => false, isFile: () => true }));
      }
      return [];
    }),
    exists: vi.fn(async () => true),
  };
}

describe("SyncDocuments - F20260803mval", () => {
  it("新文档：insert + indexFeature，synced=1", async () => {
    const featureRepo = makeStatefulFeatureRepo([]);
    const memoryIndex = { indexMessage: vi.fn(), indexLinkedResource: vi.fn(), indexFeature: vi.fn(async () => {}), indexResearch: vi.fn(), indexFeatureChunks: vi.fn(async () => {}), indexResearchChunks: vi.fn(async () => {}) };
    const fs = makeFs({ "F20260803tst1.md": FEATURE_FM("F20260803tst1", "新摘要") });
    const sync = new SyncDocuments(fs, featureRepo, makeResearchRepo(), memoryIndex as MemoryIndexGateway, createTestLogger());

    const result = await sync.execute("/root");

    expect(result.synced).toBe(1);
    expect(featureRepo.insert).toHaveBeenCalled();
    expect(memoryIndex.indexFeature).toHaveBeenCalled();
  });

  it("F20260803fbit: 新文档索引 body entry，chunkEntriesIndexed=1", async () => {
    const featureRepo = makeStatefulFeatureRepo([]);
    const memoryIndex = { indexMessage: vi.fn(), indexLinkedResource: vi.fn(), indexFeature: vi.fn(async () => {}), indexResearch: vi.fn(), indexFeatureChunks: vi.fn(async () => {}), indexResearchChunks: vi.fn(async () => {}) };
    const fs = makeFs({ "F20260803tst1.md": FEATURE_FM("F20260803tst1", "新摘要") });
    const sync = new SyncDocuments(fs, featureRepo, makeResearchRepo(), memoryIndex as MemoryIndexGateway, createTestLogger());

    const result = await sync.execute("/root");

    expect(memoryIndex.indexFeatureChunks).toHaveBeenCalled();
    expect(result.chunkEntriesIndexed).toBe(1);
  });

  it("F20260803fbit: body 经 markdown 噪声清理后索引（chunkEntriesIndexed + feature 入库）", async () => {
    const featureRepo = makeStatefulFeatureRepo([]);
    const memoryIndex = { indexMessage: vi.fn(), indexLinkedResource: vi.fn(), indexFeature: vi.fn(async () => {}), indexResearch: vi.fn(), indexFeatureChunks: vi.fn(async () => {}), indexResearchChunks: vi.fn(async () => {}) };
    const fm = `---\nid: F20260803tst1\ntitle: 测试\nsummary: 摘要\nchange_type: feature\nstatus: draft\ncreated_at: 2026-08-03\n---\n## 标题\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n`;
    const fs = makeFs({ "F20260803tst1.md": fm });
    const sync = new SyncDocuments(fs, featureRepo, makeResearchRepo(), memoryIndex as MemoryIndexGateway, createTestLogger());

    const result = await sync.execute("/root");

    expect(result.chunkEntriesIndexed).toBe(1);
    expect(featureRepo.insert).toHaveBeenCalled();
    // 噪声清理的正确性由 cleanMarkdownForFts 单元测试覆盖
  });

  it("已有文档内容变：updateContent + indexFeature，updated=1", async () => {
    const existing = makeDoc({ summary: "旧摘要" });
    const featureRepo = makeStatefulFeatureRepo([existing]);
    const memoryIndex = { indexMessage: vi.fn(), indexLinkedResource: vi.fn(), indexFeature: vi.fn(async () => {}), indexResearch: vi.fn(), indexFeatureChunks: vi.fn(async () => {}), indexResearchChunks: vi.fn(async () => {}) };
    const fs = makeFs({ "F20260803tst1.md": FEATURE_FM("F20260803tst1", "新摘要") });
    const sync = new SyncDocuments(fs, featureRepo, makeResearchRepo(), memoryIndex as MemoryIndexGateway, createTestLogger());

    const result = await sync.execute("/root");

    expect(result.updated).toBe(1);
    expect(featureRepo.updateContent).toHaveBeenCalled();
    expect(memoryIndex.indexFeature).toHaveBeenCalled();
  });

  it("F20260803fbit: 只改 body（summary 不变）触发 updated + reindex body", async () => {
    // existing 的 bodyHash 对应旧 body "# 旧正文\n"，文件 body 是 "# 新正文\n"
    const existing = makeDoc({ summary: "测试摘要", bodyHash: computeBodyHash("# 旧正文\n") });
    const featureRepo = makeStatefulFeatureRepo([existing]);
    const memoryIndex = { indexMessage: vi.fn(), indexLinkedResource: vi.fn(), indexFeature: vi.fn(async () => {}), indexResearch: vi.fn(), indexFeatureChunks: vi.fn(async () => {}), indexResearchChunks: vi.fn(async () => {}) };
    const fs = makeFs({ "F20260803tst1.md": FEATURE_FM("F20260803tst1", "测试摘要") });
    const sync = new SyncDocuments(fs, featureRepo, makeResearchRepo(), memoryIndex as MemoryIndexGateway, createTestLogger());

    const result = await sync.execute("/root");

    expect(result.updated).toBe(1);
    expect(featureRepo.updateContent).toHaveBeenCalled();
    expect(memoryIndex.indexFeatureChunks).toHaveBeenCalled();
  });

  it("已有文档内容不变：skip，不调 updateContent/indexFeature", async () => {
    // F20260803fbit: existing 的 bodyHash 要匹配文件内容算出的值，否则指纹不等走 updated
    const existing = makeDoc({ summary: "测试摘要", bodyHash: computeBodyHash("# 正文\n这是文档正文内容，用于测试分段索引。\n") });
    const featureRepo = makeStatefulFeatureRepo([existing]);
    const indexFeature = vi.fn(async () => {});
    const memoryIndex = { indexMessage: vi.fn(), indexLinkedResource: vi.fn(), indexFeature, indexResearch: vi.fn(), indexFeatureChunks: vi.fn(async () => {}), indexResearchChunks: vi.fn(async () => {}) };
    const fs = makeFs({ "F20260803tst1.md": FEATURE_FM("F20260803tst1", "测试摘要") });
    const sync = new SyncDocuments(fs, featureRepo, makeResearchRepo(), memoryIndex as MemoryIndexGateway, createTestLogger());

    const result = await sync.execute("/root");

    expect(result.skipped).toBe(1);
    expect(featureRepo.updateContent).not.toHaveBeenCalled();
    expect(indexFeature).not.toHaveBeenCalled();
    expect(memoryIndex.indexFeatureChunks).not.toHaveBeenCalled();
  });

  it("未知 change_type：warnings 收集，valid=true 继续入库", async () => {
    const featureRepo = makeStatefulFeatureRepo([]);
    const memoryIndex = { indexMessage: vi.fn(), indexLinkedResource: vi.fn(), indexFeature: vi.fn(async () => {}), indexResearch: vi.fn(), indexFeatureChunks: vi.fn(async () => {}), indexResearchChunks: vi.fn(async () => {}) };
    const fs = makeFs({ "F20260803tst1.md": FEATURE_FM("F20260803tst1", "摘要", "unknown-xyz") });
    const sync = new SyncDocuments(fs, featureRepo, makeResearchRepo(), memoryIndex as MemoryIndexGateway, createTestLogger());

    const result = await sync.execute("/root");

    expect(result.synced).toBe(1);
    expect(result.warnings.some(w => w.includes("Unknown change_type"))).toBe(true);
  });

  it("reconcileSync：supersedes 悬空引用 -> supersedesDangling", async () => {
    const existing = makeDoc({ summary: "测试摘要", supersedes: ["F20990101xxxx"] });
    const featureRepo = makeStatefulFeatureRepo([existing]);
    const memoryIndex = { indexMessage: vi.fn(), indexLinkedResource: vi.fn(), indexFeature: vi.fn(async () => {}), indexResearch: vi.fn(), indexFeatureChunks: vi.fn(async () => {}), indexResearchChunks: vi.fn(async () => {}) };
    const fs = makeFs({ "F20260803tst1.md": FEATURE_FM("F20260803tst1", "测试摘要", "feature", "F20990101xxxx") });
    const sync = new SyncDocuments(fs, featureRepo, makeResearchRepo(), memoryIndex as MemoryIndexGateway, createTestLogger());

    const result = await sync.execute("/root");

    expect(result.supersedesDangling.some(d => d.includes("F20990101xxxx"))).toBe(true);
  });

  it("F20260901dsyn: id 漂移——同 file_path DB 存在不同 id -> 结构化错误而非裸 UNIQUE 崩溃，不 insert", async () => {
    // 复现 #637：文档 id=mmr0，DB 同路径已有 id=mmr 的记录
    const dbDoc = makeDoc({
      id: "F20260803mmr",
      filePath: "docs/features/2026/08/03/F20260803mmr0.md",
      summary: "旧摘要",
    });
    const featureRepo = makeStatefulFeatureRepo([dbDoc]);
    const memoryIndex = { indexMessage: vi.fn(), indexLinkedResource: vi.fn(), indexFeature: vi.fn(async () => {}), indexResearch: vi.fn(), indexFeatureChunks: vi.fn(async () => {}), indexResearchChunks: vi.fn(async () => {}) };
    const fs = makeFs({ "F20260803mmr0.md": FEATURE_FM("F20260803mmr0", "新摘要") });
    const sync = new SyncDocuments(fs, featureRepo, makeResearchRepo(), memoryIndex as MemoryIndexGateway, createTestLogger());

    const result = await sync.execute("/root");

    // 结构化错误：含两个 id 与修复指引，而非裸 SQLite 文本
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].error).toContain("F20260803mmr0");
    expect(result.errors[0].error).toContain("F20260803mmr");
    expect(result.errors[0].error).toContain("ID drift");
    // 不 insert、不索引：避免撞唯一索引的半写状态
    expect(featureRepo.store.length).toBe(1);
    expect(memoryIndex.indexFeature).not.toHaveBeenCalled();
  });

  it("F20260901dsyn: id 对齐后（文档 id 改回 DB id）——走 upsert update 分支，不再报错", async () => {
    // 修复后形态：文档 id 已改回 F20260731mmr，与 DB 一致，fingerprint 不同（status 不同）触发 update
    const dbDoc = makeDoc({
      id: "F20260803mmr",
      filePath: "docs/features/2026/08/03/F20260803mmr.md",
      summary: "旧摘要",
      status: "archived",
    });
    const featureRepo = makeStatefulFeatureRepo([dbDoc]);
    const memoryIndex = { indexMessage: vi.fn(), indexLinkedResource: vi.fn(), indexFeature: vi.fn(async () => {}), indexResearch: vi.fn(), indexFeatureChunks: vi.fn(async () => {}), indexResearchChunks: vi.fn(async () => {}) };
    const fs = makeFs({ "F20260803mmr.md": FEATURE_FM("F20260803mmr", "新摘要") });
    const sync = new SyncDocuments(fs, featureRepo, makeResearchRepo(), memoryIndex as MemoryIndexGateway, createTestLogger());

    const result = await sync.execute("/root");

    expect(result.errors.length).toBe(0);
    expect(result.updated).toBe(1);
    expect(featureRepo.store[0].summary).toBe("新摘要");
    expect(featureRepo.store[0].status).toBe("draft");
  });
});
