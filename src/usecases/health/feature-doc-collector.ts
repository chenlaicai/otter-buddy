/**
 * FeatureDocCollector: 从 docs/features/ 目录采集 F 文档信息
 * 
 * 复用 sync_docs 的解析器，提取 F 文档的 frontmatter 信息。
 * 用于特性链追踪和指标计算。
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { parseFrontmatterFromContent } from "@usecases/document/frontmatter-parse";
import { validateFeatureFrontmatter } from "@entities/document/frontmatter-validator";

export interface CollectedFeatureDoc {
  /** F 文档 ID（如 F20260824rhib） */
  id: string;
  /** 文档标题 */
  title: string;
  /** 变更类型 */
  changeType: string | null;
  /** 文档状态。#646 值域契约：语义分组（在途/终态/未知）消费方统一用
   *  @entities/document/doc-status 的 classifyDocStatus，勿在各消费点自行 has 判断。
   *  本字段保留原始值（含行内注释已被 yaml 解析器剥离后的裸值），不做归一改写。 */
  status: string | null;
  /** 标签 */
  tags: string[];
  /** 模块 */
  modules: string[];
  /** 因果链上游 */
  causalLinksFrom: string[];
  /** 被取代的文档 */
  supersedes: string[];
  /** 文件路径（相对于仓库根目录） */
  filePath: string;
  /** 创建时间 */
  createdAt: string | null;
  /** 创建对话 ID */
  createdInConversationId: string | null;
  /** intent 信息（如果存在） */
  intent?: {
    problem?: string;
    expectedEffect?: string;
    verifyBy?: string;
  };
}

/**
 * 从 docs/features/ 目录采集 F 文档信息
 * @param repoPath 仓库根目录路径
 * @returns F 文档列表
 */
export async function collectFeatureDocs(repoPath: string): Promise<CollectedFeatureDoc[]> {
  const featuresDir = path.join(repoPath, "docs", "features");
  const docs: CollectedFeatureDoc[] = [];

  try {
    await collectDocsRecursively(featuresDir, docs, repoPath);
  } catch (error) {
    // 如果目录不存在，返回空列表
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return docs;
}

/**
 * 递归采集目录中的 F 文档
 */
async function collectDocsRecursively(
  dirPath: string,
  docs: CollectedFeatureDoc[],
  repoPath: string
): Promise<void> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      await collectDocsRecursively(fullPath, docs, repoPath);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      try {
        const doc = await parseFeatureDoc(fullPath, repoPath);
        if (doc) {
          docs.push(doc);
        }
      } catch {
        // 跳过解析失败的文件（不合规的 frontmatter）
      }
    }
  }
}

/**
 * 解析单个 F 文档
 */
async function parseFeatureDoc(
  filePath: string,
  repoPath: string
): Promise<CollectedFeatureDoc | null> {
  const content = await fs.readFile(filePath, "utf-8");
  const { frontmatter } = parseFrontmatterFromContent(content);

  // 验证 frontmatter
  const validation = validateFeatureFrontmatter(frontmatter);
  if (!validation.valid) {
    return null;
  }

  const relativePath = path.relative(repoPath, filePath);

  return {
    id: frontmatter.id as string,
    title: (frontmatter.title as string) ?? "",
    changeType: (frontmatter.change_type as string) ?? null,
    status: (frontmatter.status as string) ?? null,
    tags: (frontmatter.tags as string[]) ?? [],
    modules: (frontmatter.modules as string[]) ?? [],
    causalLinksFrom: (frontmatter.from as string[]) ?? [],
    supersedes: (frontmatter.supersedes as string[]) ?? [],
    filePath: relativePath,
    createdAt: (frontmatter.created_at as string) ?? null,
    createdInConversationId: (frontmatter.created_in_conversation as string) ?? null,
    intent: frontmatter.intent ? {
      problem: (frontmatter.intent as Record<string, unknown>).problem as string,
      expectedEffect: (frontmatter.intent as Record<string, unknown>).expected_effect as string,
      verifyBy: (frontmatter.intent as Record<string, unknown>).verify_by as string,
    } : undefined,
  };
}
