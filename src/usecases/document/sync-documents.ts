import * as path from "path";
import * as fs from "fs/promises";
import type { FeatureRepository } from "./feature-repository";
import type { ResearchRepository } from "./research-repository";
import type { MemoryIndexGateway } from "../conversation/memory-index-gateway";
import { parseFrontmatter } from "../../frameworks/document/frontmatter-parser";
import {
  validateFeatureFrontmatter,
  validateResearchFrontmatter,
} from "../../frameworks/document/frontmatter-validator";
import type { FeatureDocument, ChangeType, FeatureStatus } from "../../entities/document/feature";
import type { ResearchDocument, ExplorationType, ResearchStatus } from "../../entities/document/research";

export interface SyncResult {
  synced: number;
  skipped: number;
  archived: number;
  errors: Array<{ file: string; error: string }>;
}

export class SyncDocuments {
  constructor(
    private readonly featureRepo: FeatureRepository,
    private readonly researchRepo: ResearchRepository,
    private readonly memoryIndex: MemoryIndexGateway,
    private readonly rootDir: string
  ) {}

  async execute(): Promise<SyncResult> {
    const result: SyncResult = { synced: 0, skipped: 0, archived: 0, errors: [] };

    // 1. 扫描并同步 features
    await this.syncDirectory("docs/features", "feature", result);

    // 2. 扫描并同步 research
    await this.syncDirectory("docs/research", "research", result);

    // 3. 检测已删除的文档，标记为 archived
    await this.archiveDeletedDocuments(result);

    return result;
  }

  private async syncDirectory(
    dir: string,
    type: "feature" | "research",
    result: SyncResult
  ): Promise<void> {
    const fullPath = path.join(this.rootDir, dir);
    const files = await this.scanMarkdownFiles(fullPath);

    for (const file of files) {
      try {
        const relativePath = path.relative(this.rootDir, file);
        const { frontmatter } = await parseFrontmatter(file);

        // 验证
        const validation =
          type === "feature"
            ? validateFeatureFrontmatter(frontmatter, relativePath)
            : validateResearchFrontmatter(frontmatter, relativePath);

        if (!validation.valid) {
          result.errors.push({ file, error: validation.errors.join("; ") });
          continue;
        }

        const id = frontmatter.id as string;

        // 检查是否已存在
        const existing =
          type === "feature"
            ? await this.featureRepo.findById(id)
            : await this.researchRepo.findById(id);

        if (existing) {
          // 幂等性：已存在则跳过
          result.skipped++;
          continue;
        }

        // 构造文档对象
        if (type === "feature") {
          const doc = this.buildFeatureDocument(frontmatter, relativePath);
          await this.featureRepo.insert(doc);
          await this.memoryIndex.indexFeature(doc.id, doc.summary, {
            doc_type: "feature",
            change_type: doc.changeType,
            tags: doc.tags,
            modules: doc.modules,
            from: doc.causalLinksFrom,
            supersedes: doc.supersedes,
          });
        } else {
          const doc = this.buildResearchDocument(frontmatter, relativePath);
          await this.researchRepo.insert(doc);
          await this.memoryIndex.indexResearch(doc.id, doc.summary, {
            doc_type: "research",
            exploration_type: doc.explorationType,
            tags: doc.tags,
            conclusion: doc.conclusion,
            from: doc.causalLinksFrom,
            supersedes: doc.supersedes,
          });
        }

        result.synced++;
      } catch (error) {
        result.errors.push({
          file,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async archiveDeletedDocuments(result: SyncResult): Promise<void> {
    // 扫描数据库中存在但文件系统中不存在的 Feature
    const dbFeatures = await this.featureRepo.findAll();
    for (const doc of dbFeatures) {
      if (doc.status === "archived") continue;
      try {
        await fs.access(path.join(this.rootDir, doc.filePath));
      } catch {
        // 文件不存在，标记为 archived
        await this.featureRepo.updateStatus(doc.id, "archived");
        result.archived++;
      }
    }

    // 扫描数据库中存在但文件系统中不存在的 Research
    const dbResearch = await this.researchRepo.findAll();
    for (const doc of dbResearch) {
      if (doc.status === "archived") continue;
      try {
        await fs.access(path.join(this.rootDir, doc.filePath));
      } catch {
        await this.researchRepo.updateStatus(doc.id, "archived");
        result.archived++;
      }
    }
  }

  private async scanMarkdownFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
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
    return {
      id: fm.id as string,
      title: fm.title as string,
      summary: (fm.summary as string).trim(),
      changeType: ((fm.change_type as string) || "feature") as ChangeType,
      status: ((fm.status as string) || "draft") as FeatureStatus,
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
    return {
      id: fm.id as string,
      title: fm.title as string,
      summary: (fm.summary as string).trim(),
      explorationType: ((fm.exploration_type as string) || "technical") as ExplorationType,
      status: ((fm.status as string) || "draft") as ResearchStatus,
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
