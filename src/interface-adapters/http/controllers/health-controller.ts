import type { Context } from "hono";
import * as path from "path";
import type { FeatureRepository } from "@usecases/document/feature-repository";
import type { ResearchRepository } from "@usecases/document/research-repository";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import type { FileSystemGateway } from "@usecases/ports/file-system-gateway";
import type { Logger } from "@usecases/ports/logger";
import { parseFrontmatterFromContent } from "@usecases/document/frontmatter-parse";

/**
 * F20260803mval: 记忆系统健康端点。
 * 实时聚合磁盘 vs DB 对账 + embedding 状态，让链路断裂可见（不靠人翻日志）。
 * try-catch 兜底：DB 异常时返回 healthy:false 而非 500，守门人自身可观测。
 */
export class HealthController {
  // eslint-disable-next-line max-params -- 6 个 DI 依赖均为必需
  constructor(
    private readonly featureRepo: FeatureRepository,
    private readonly researchRepo: ResearchRepository,
    private readonly embeddingGateway: EmbeddingGateway,
    private readonly fs: FileSystemGateway,
    private readonly rootDir: string,
    private readonly logger: Logger,
  ) {}

  async memory(c: Context): Promise<Response> {
    try {
      const [diskFeatureIds, diskResearchIds, dbFeatures, dbResearch] = await Promise.all([
        this.collectDiskIds("docs/features"),
        this.collectDiskIds("docs/research"),
        this.featureRepo.findAll(),
        this.researchRepo.findAll(),
      ]);

      const dbFeatureIds = new Set(
        dbFeatures.filter(f => f.status !== "archived").map(f => f.id)
      );
      const dbResearchIds = new Set(
        dbResearch.filter(r => r.status !== "archived").map(r => r.id)
      );

      const featureGaps = [...diskFeatureIds].filter(id => !dbFeatureIds.has(id));
      const researchGaps = [...diskResearchIds].filter(id => !dbResearchIds.has(id));
      const embeddingAvailable = this.embeddingGateway.available;

      const healthy =
        featureGaps.length === 0 && researchGaps.length === 0 && embeddingAvailable;

      return c.json({
        healthy,
        documentsOnDisk: diskFeatureIds.size + diskResearchIds.size,
        documentsInDb: dbFeatureIds.size + dbResearchIds.size,
        reconcileGaps: [...featureGaps, ...researchGaps],
        embeddingAvailable,
        embeddingModel: "Xenova/bge-m3",
      });
    } catch (err) {
      this.logger.error(
        "Memory health check failed",
        err instanceof Error ? err : undefined,
      );
      // F20260803mval: 返回 200 + healthy:false（非 500），客户端只需看 body 判定健康度
      return c.json(
        { healthy: false, error: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  private async collectDiskIds(dir: string): Promise<Set<string>> {
    const fullPath = path.join(this.rootDir, dir);
    const ids = new Set<string>();
    await this.scanAndCollect(fullPath, ids);
    return ids;
  }

  private async scanAndCollect(dir: string, ids: Set<string>): Promise<void> {
    let entries;
    try {
      entries = await this.fs.readDir(dir);
    } catch {
      return; // 目录不存在
    }
    for (const entry of entries) {
      await this.processEntry(dir, entry, ids);
    }
  }

  private async processEntry(
    dir: string,
    entry: Awaited<ReturnType<FileSystemGateway["readDir"]>>[number],
    ids: Set<string>,
  ): Promise<void> {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await this.scanAndCollect(fullPath, ids);
      return;
    }
    if (!entry.name.endsWith(".md")) return;
    try {
      const content = await this.fs.readFile(fullPath);
      const { frontmatter } = parseFrontmatterFromContent(content);
      if (frontmatter.id && typeof frontmatter.id === "string") {
        ids.add(frontmatter.id as string);
      }
    } catch {
      // 解析失败跳过
    }
  }
}
