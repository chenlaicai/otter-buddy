import * as path from "node:path";
import type { FileSystemGateway } from "@usecases/ports/file-system-gateway";
import type { Logger } from "@usecases/ports/logger";
import { parseFrontmatterFromContent } from "@usecases/document/frontmatter-parse";
import { validateFeatureFrontmatter } from "@entities/document/frontmatter-validator";

export interface FeatureDoc {
  id: string;
  title: string;
  status: string;
  changeType: string;
  modules: string[];
  causalLinksFrom: string[];
  supersedes: string[];
  filePath: string;
  createdAt: string;
}

/**
 * 特性文档采集器。
 * 复用 sync_docs 解析器，采集特性文档元数据。
 */
export class FeatureDocCollector {
  constructor(
    private readonly fs: FileSystemGateway,
    private readonly rootDir: string,
    private readonly logger: Logger,
  ) {}

  /**
   * 采集特性文档。
   * @returns 特性文档列表
   */
  async collect(): Promise<FeatureDoc[]> {
    const docsDir = path.join(this.rootDir, "docs/features");
    const files = await this.scanMarkdownFiles(docsDir);
    const docs: FeatureDoc[] = [];

    for (const file of files) {
      try {
        const doc = await this.parseFile(file);
        if (doc) {
          docs.push(doc);
        }
      } catch (error) {
        this.logger.warn(`Failed to parse feature doc: ${file}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return docs;
  }

  /**
   * 扫描 markdown 文件。
   */
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

  /**
   * 解析特性文档文件。
   */
  private async parseFile(file: string): Promise<FeatureDoc | null> {
    const relativePath = path.relative(this.rootDir, file);
    const content = await this.fs.readFile(file);
    const { frontmatter } = parseFrontmatterFromContent(content);

    const validation = validateFeatureFrontmatter(frontmatter, relativePath);
    if (!validation.valid) {
      return null;
    }

    const causalLinks = frontmatter.causal_links as Record<string, unknown> | undefined;

    return {
      id: frontmatter.id as string,
      title: frontmatter.title as string,
      status: (frontmatter.status as string) || "draft",
      changeType: (frontmatter.change_type as string) || "feature",
      modules: Array.isArray(frontmatter.modules) ? (frontmatter.modules as string[]) : [],
      causalLinksFrom: Array.isArray(causalLinks?.from)
        ? (causalLinks.from as string[])
        : [],
      supersedes: Array.isArray(frontmatter.supersedes)
        ? (frontmatter.supersedes as string[])
        : [],
      filePath: relativePath,
      createdAt: (frontmatter.created_at as string) || new Date().toISOString(),
    };
  }
}
