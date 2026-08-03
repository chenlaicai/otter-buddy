import * as path from "path";
import type { FileSystemGateway } from "@usecases/ports/file-system-gateway";
import type { FeatureRepository } from "./feature-repository";
import type { ResearchRepository } from "./research-repository";
import type { MemoryIndexGateway } from "../conversation/memory-index-gateway";
import type { Logger } from "@usecases/ports/logger";
import { parseFrontmatterFromContent } from "./frontmatter-parse";
import { validateFeatureFrontmatter, validateResearchFrontmatter } from "@entities/document/frontmatter-validator";
import type { FeatureDocument, ChangeType, FeatureStatus } from "@entities/document/feature";
import type { ResearchDocument, ExplorationType, ResearchStatus } from "@entities/document/research";
import {
  isKnownChangeType,
  isKnownFeatureStatus,
  isKnownResearchStatus,
  isKnownExplorationType,
} from "@entities/document/known-values";

export interface SyncResult {
  synced: number;
  skipped: number;
  /** F20260803mval: upsert 更新的文档数（内容指纹变了） */
  updated: number;
  archived: number;
  /** F20260803mval: 未知枚举值等软警告，不阻断入库，进健康端点暴露 */
  warnings: string[];
  /** F20260803mval: 磁盘有 DB 无的文档 ID（同步失败正向对账） */
  reconcileGaps: string[];
  /** F20260803mval: supersedes 引用不存在的 ID（因果链悬空） */
  supersedesDangling: string[];
  errors: Array<{ file: string; error: string }>;
}

/** F20260803mval: 内容指纹，用于 upsert 判定（变更才 update + reindex） */
function featureFingerprint(doc: FeatureDocument): string {
  return [doc.title, doc.summary, doc.changeType, doc.status, doc.filePath,
    JSON.stringify(doc.tags), JSON.stringify(doc.modules),
    JSON.stringify(doc.causalLinksFrom), JSON.stringify(doc.supersedes)].join("|");
}

function researchFingerprint(doc: ResearchDocument): string {
  return [doc.title, doc.summary, doc.explorationType, doc.status, doc.filePath,
    JSON.stringify(doc.tags), doc.conclusion ?? "",
    JSON.stringify(doc.causalLinksFrom), JSON.stringify(doc.supersedes)].join("|");
}

export class SyncDocuments {
  constructor(
    private readonly fs: FileSystemGateway,
    private readonly featureRepo: FeatureRepository,
    private readonly researchRepo: ResearchRepository,
    private readonly memoryIndex: MemoryIndexGateway,
    private readonly logger: Logger
  ) {}

  async execute(rootDir: string): Promise<SyncResult> {
    const startTime = Date.now();
    const result: SyncResult = {
      synced: 0, skipped: 0, updated: 0, archived: 0,
      warnings: [], reconcileGaps: [], supersedesDangling: [], errors: [],
    };

    this.logger.info('Document sync started', { action: 'sync_start' });

    await this.syncDirectory(rootDir, "docs/features", "feature", result);
    await this.syncDirectory(rootDir, "docs/research", "research", result);
    /** F20260803mval: 正向对账在归档前，避免归档操作干扰 gap 判定 */
    await this.reconcileSync(rootDir, result);
    await this.archiveDeletedDocuments(rootDir, result);

    const duration = Date.now() - startTime;
    this.logger.info('Document sync completed', {
      synced: result.synced, skipped: result.skipped, updated: result.updated,
      archived: result.archived, errors: result.errors.length,
      warnings: result.warnings.length, reconcileGaps: result.reconcileGaps.length,
      supersedesDangling: result.supersedesDangling.length,
      duration, action: 'sync_complete',
    });

    return result;
  }

  private async syncDirectory(
    rootDir: string,
    dir: string,
    type: "feature" | "research",
    result: SyncResult
  ): Promise<void> {
    const fullPath = path.join(rootDir, dir);
    const files = await this.scanMarkdownFiles(fullPath);

    for (const file of files) {
      try {
        await this.syncFile(rootDir, file, type, result);
      } catch (error) {
        result.errors.push({
          file,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async syncFile(
    rootDir: string,
    file: string,
    type: "feature" | "research",
    result: SyncResult
  ): Promise<void> {
    const relativePath = path.relative(rootDir, file);
    const content = await this.fs.readFile(file);
    const { frontmatter } = parseFrontmatterFromContent(content);

    const validation =
      type === "feature"
        ? validateFeatureFrontmatter(frontmatter, relativePath)
        : validateResearchFrontmatter(frontmatter, relativePath);

    if (!validation.valid) {
      result.errors.push({ file, error: validation.errors.join("; ") });
      return;
    }

    if (validation.warnings.length > 0) {
      const id = frontmatter.id as string;
      for (const w of validation.warnings) result.warnings.push(`${id}: ${w}`);
    }

    if (type === "feature") {
      await this.syncFeatureDoc(frontmatter, relativePath, result);
    } else {
      await this.syncResearchDoc(frontmatter, relativePath, result);
    }
  }

  private async syncFeatureDoc(
    fm: Record<string, unknown>,
    filePath: string,
    result: SyncResult
  ): Promise<void> {
    const doc = this.buildFeatureDocument(fm, filePath);
    const existing = await this.featureRepo.findById(doc.id);
    const meta = {
      doc_type: "feature" as const, change_type: doc.changeType, tags: doc.tags,
      modules: doc.modules, from: doc.causalLinksFrom, supersedes: doc.supersedes,
    };
    if (!existing) {
      await this.featureRepo.insert(doc);
      await this.memoryIndex.indexFeature(doc.id, doc.summary, meta);
      result.synced++;
    } else if (featureFingerprint(doc) !== featureFingerprint(existing)) {
      await this.featureRepo.updateContent(doc);
      await this.memoryIndex.indexFeature(doc.id, doc.summary, meta);
      result.updated++;
    } else {
      result.skipped++;
    }
  }

  private async syncResearchDoc(
    fm: Record<string, unknown>,
    filePath: string,
    result: SyncResult
  ): Promise<void> {
    const doc = this.buildResearchDocument(fm, filePath);
    const existing = await this.researchRepo.findById(doc.id);
    const meta = {
      doc_type: "research" as const, exploration_type: doc.explorationType, tags: doc.tags,
      conclusion: doc.conclusion, from: doc.causalLinksFrom, supersedes: doc.supersedes,
    };
    if (!existing) {
      await this.researchRepo.insert(doc);
      await this.memoryIndex.indexResearch(doc.id, doc.summary, meta);
      result.synced++;
    } else if (researchFingerprint(doc) !== researchFingerprint(existing)) {
      await this.researchRepo.updateContent(doc);
      await this.memoryIndex.indexResearch(doc.id, doc.summary, meta);
      result.updated++;
    } else {
      result.skipped++;
    }
  }

  /**
   * F20260803mval: 正向对账。
   * 检测：磁盘有 DB 无（同步失败）、supersedes 悬空引用（因果链断裂）。
   * 与 archiveDeletedDocuments 互补：后者检测 DB 有磁盘无（归档）。
   */
  private async reconcileSync(rootDir: string, result: SyncResult): Promise<void> {
    await this.reconcileType(rootDir, "docs/features", this.featureRepo, result);
    await this.reconcileType(rootDir, "docs/research", this.researchRepo, result);

    if (result.reconcileGaps.length > 0) {
      this.logger.error(
        `Reconcile gaps: ${result.reconcileGaps.length} documents on disk but not in DB`,
        undefined,
        { gaps: result.reconcileGaps, action: 'reconcile_gaps' },
      );
    }
    if (result.supersedesDangling.length > 0) {
      this.logger.warn(`Dangling supersedes references: ${result.supersedesDangling.length}`, {
        dangling: result.supersedesDangling, action: 'supersedes_dangling',
      });
    }
  }

  private async reconcileType<T extends { id: string; status: string; supersedes: string[] }>(
    rootDir: string,
    dir: string,
    repo: { findAll(): Promise<T[]> },
    result: SyncResult,
  ): Promise<void> {
    const diskIds = await this.collectDiskIds(rootDir, dir);
    const dbDocs = await repo.findAll();
    const dbIds = new Set(dbDocs.filter(d => d.status !== "archived").map(d => d.id));
    // F20260803mval: supersedes 引用检查用全量 ID（含 archived），归档文档作为引用目标仍合法（B5）
    const allDbIds = new Set(dbDocs.map(d => d.id));
    for (const id of diskIds) {
      if (!dbIds.has(id)) result.reconcileGaps.push(id);
    }
    for (const d of dbDocs) {
      for (const sup of d.supersedes) {
        if (!allDbIds.has(sup) && !diskIds.has(sup)) {
          result.supersedesDangling.push(`${d.id} -> ${sup}`);
        }
      }
    }
  }

  /** 扫描磁盘文档提取 ID 集合（对账用，独立于 syncFile 避免共享盲区） */
  private async collectDiskIds(rootDir: string, dir: string): Promise<Set<string>> {
    const fullPath = path.join(rootDir, dir);
    const files = await this.scanMarkdownFiles(fullPath);
    const ids = new Set<string>();
    for (const file of files) {
      try {
        const content = await this.fs.readFile(file);
        const { frontmatter } = parseFrontmatterFromContent(content);
        if (frontmatter.id && typeof frontmatter.id === "string") {
          ids.add(frontmatter.id as string);
        }
      } catch {
        // 解析失败的文件已在 syncFile 记 errors，此处跳过
      }
    }
    return ids;
  }

  private async archiveDeletedDocuments(rootDir: string, result: SyncResult): Promise<void> {
    const dbFeatures = await this.featureRepo.findAll();
    for (const doc of dbFeatures) {
      if (doc.status === "archived") continue;
      if (!(await this.fs.exists(path.join(rootDir, doc.filePath)))) {
        await this.featureRepo.updateStatus(doc.id, "archived");
        result.archived++;
      }
    }

    const dbResearch = await this.researchRepo.findAll();
    for (const doc of dbResearch) {
      if (doc.status === "archived") continue;
      if (!(await this.fs.exists(path.join(rootDir, doc.filePath)))) {
        await this.researchRepo.updateStatus(doc.id, "archived");
        result.archived++;
      }
    }
  }

  private async scanMarkdownFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await this.fs.readDir(dir);
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const subFiles = await this.scanMarkdownFiles(fullPath);
          results.push(...subFiles);
        } else if (entry.name.endsWith(".md")) {
          results.push(fullPath);
        }
      }
    } catch {
      // 目录不存在，忽略
    }
    return results;
  }

  private buildFeatureDocument(
    fm: Record<string, unknown>,
    filePath: string
  ): FeatureDocument {
    const causalLinks = fm.causal_links as Record<string, unknown> | undefined;
    // F20260803mval: 未知枚举值 fallback 到默认，防 as 强转使类型安全形同虚设
    const ct = (fm.change_type as string) || "feature";
    const st = (fm.status as string) || "draft";
    return {
      id: fm.id as string,
      title: fm.title as string,
      summary: (fm.summary as string).trim(),
      changeType: (isKnownChangeType(ct) ? ct : "feature") as ChangeType,
      status: (isKnownFeatureStatus(st) ? st : "draft") as FeatureStatus,
      tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [],
      modules: Array.isArray(fm.modules) ? (fm.modules as string[]) : [],
      causalLinksFrom: Array.isArray(causalLinks?.from)
        ? (causalLinks.from as string[])
        : [],
      supersedes: Array.isArray(fm.supersedes)
        ? (fm.supersedes as string[])
        : [],
      filePath,
      createdAt: (fm.created_at as string) || new Date().toISOString(),
    };
  }

  private buildResearchDocument(
    fm: Record<string, unknown>,
    filePath: string
  ): ResearchDocument {
    const causalLinks = fm.causal_links as Record<string, unknown> | undefined;
    const et = (fm.exploration_type as string) || "technical";
    const st = (fm.status as string) || "draft";
    return {
      id: fm.id as string,
      title: fm.title as string,
      summary: (fm.summary as string).trim(),
      explorationType: (isKnownExplorationType(et) ? et : "technical") as ExplorationType,
      status: (isKnownResearchStatus(st) ? st : "draft") as ResearchStatus,
      tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [],
      conclusion: (fm.conclusion as string) || null,
      causalLinksFrom: Array.isArray(causalLinks?.from)
        ? (causalLinks.from as string[])
        : [],
      supersedes: Array.isArray(fm.supersedes)
        ? (fm.supersedes as string[])
        : [],
      filePath,
      createdAt: (fm.created_at as string) || new Date().toISOString(),
    };
  }
}
