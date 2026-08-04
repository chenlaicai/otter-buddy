import type { Context } from "hono";
import * as path from "node:path";
import type { FeatureRepository } from "@usecases/document/feature-repository";
import type { ResearchRepository } from "@usecases/document/research-repository";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import type { FileSystemGateway } from "@usecases/ports/file-system-gateway";
import type { Logger } from "@usecases/ports/logger";
import { scanDiskIds } from "@usecases/document/disk-id-scanner";
import { parseFrontmatterFromContent } from "@usecases/document/frontmatter-parse";
import {
  validateFeatureFrontmatter,
  validateResearchFrontmatter,
} from "@entities/document/frontmatter-validator";

/**
 * F20260803mval: 记忆系统健康端点。
 * 实时聚合磁盘 vs DB 对账 + embedding 状态，让链路断裂可见（不靠人翻日志）。
 * try-catch 兜底：DB 异常时返回 healthy:false 而非 500，守门人自身可观测。
 *
 * F20260804dcnv: 增 gapReasons 字段--对每个 gap 文档跑 validator 返回失败原因，
 * 让前端 banner 直接显示根因；scanDiskIds 共享 scanner 修缺 frontmatter 双重消失 bug。
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
      const [diskFeatureMap, diskResearchMap, dbFeatures, dbResearch] = await Promise.all([
        scanDiskIds(this.fs, path.join(this.rootDir, "docs/features"), this.logger),
        scanDiskIds(this.fs, path.join(this.rootDir, "docs/research"), this.logger),
        this.featureRepo.findAll(),
        this.researchRepo.findAll(),
      ]);

      const dbFeatureIds = new Set(
        dbFeatures.filter(f => f.status !== "archived").map(f => f.id)
      );
      const dbResearchIds = new Set(
        dbResearch.filter(r => r.status !== "archived").map(r => r.id)
      );

      const featureGaps = [...diskFeatureMap.keys()].filter(id => !dbFeatureIds.has(id));
      const researchGaps = [...diskResearchMap.keys()].filter(id => !dbResearchIds.has(id));
      const embeddingAvailable = this.embeddingGateway.available;

      const healthy =
        featureGaps.length === 0 && researchGaps.length === 0 && embeddingAvailable;

      // F20260804dcnv: 对每个 gap 跑 validator 拿失败原因，前端 banner 直接显示根因
      const gapReasons = [
        ...await this.reasonFor(featureGaps, diskFeatureMap, "feature"),
        ...await this.reasonFor(researchGaps, diskResearchMap, "research"),
      ];

      return c.json({
        healthy,
        documentsOnDisk: diskFeatureMap.size + diskResearchMap.size,
        documentsInDb: dbFeatureIds.size + dbResearchIds.size,
        reconcileGaps: [...featureGaps, ...researchGaps],
        gapReasons,
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

  /** 对一组 gap ID 并行跑 validator，返回每个文档的失败原因 */
  private async reasonFor(
    gapIds: string[],
    diskMap: Map<string, string>,
    type: "feature" | "research",
  ): Promise<Array<{ id: string; file: string; errors: string[] }>> {
    const results = await Promise.all(
      gapIds.map(async (id) => {
        const file = diskMap.get(id);
        if (!file) return null;
        const errors: string[] = [];
        try {
          const content = await this.fs.readFile(file);
          const rel = path.relative(this.rootDir, file);
          const { frontmatter } = parseFrontmatterFromContent(content);
          const v = type === "feature"
            ? validateFeatureFrontmatter(frontmatter, rel)
            : validateResearchFrontmatter(frontmatter, rel);
          errors.push(...v.errors);
        } catch (e) {
          // frontmatter 整体解析失败（如 Missing frontmatter）
          errors.push(e instanceof Error ? e.message : String(e));
        }
        return { id, file: path.relative(this.rootDir, file), errors };
      }),
    );
    return results.filter((r): r is { id: string; file: string; errors: string[] } => r !== null);
  }
}
