import type { Context } from "hono";
import type { SearchMemory } from "@usecases/memory/search-memory";
import type { ManageMemory } from "@usecases/memory/manage-memory";
import type { ScanDarkEntries } from "@usecases/memory/scan-dark-entries";
import type { MemoryLayer, MemoryContentType, RetrievalGranularity, DetailLevel } from "@entities/memory/memory-entry";
import { isMemoryContentType } from "@entities/memory/memory-entry";
import type { Logger } from "@usecases/ports/logger";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import { handleError, param } from "../http-error";
import { toMemoryEntryDTO } from "../dto/memory-dto";
import type { SearchSimilarRequestDTO, FlagMemoryRequestDTO } from "../dto/memory-dto";

/**
 * 在纯文本 snippet 中高亮搜索词（Web 后端职责，不在记忆模块）
 * 使用 <b> 标签包裹匹配的搜索词，供前端 HighlightedSnippet 组件渲染
 */
function highlightSnippet(snippet: string, query: string): string {
  if (!snippet || !query) return snippet;

  // 对搜索词进行分词（空格分隔）
  const tokens = query.split(/\s+/).filter(t => t.length > 0);
  if (tokens.length === 0) return snippet;

  // 转义 HTML 特殊字符（XSS 防护）
  let highlighted = snippet
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  // 对每个搜索词进行高亮
  for (const token of tokens) {
    const escapedToken = token
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    highlighted = highlighted.replaceAll(escapedToken, `<b>${escapedToken}</b>`);
  }

  return highlighted;
}

export class MemoryController {
  constructor(

    private readonly searchMemory: SearchMemory,
    private readonly manageMemory: ManageMemory,
    private readonly scanDarkEntries: ScanDarkEntries,
    private readonly embeddingGateway: EmbeddingGateway,
      private readonly logger: Logger,
  ) {}

  async search(c: Context): Promise<Response> {
    try {
      const query = c.req.query("query");
      if (!query) {
        return c.json({ error: "query parameter is required" }, 400);
      }
      const limit = Number(c.req.query("limit") ?? "10");
      const granularity = c.req.query("granularity") as RetrievalGranularity | undefined;
      const conversationId = c.req.query("conversationId");
      const detailLevel = c.req.query("detail_level") as DetailLevel | undefined;
      const library = c.req.query("library");
      const layer = c.req.query("layer") as MemoryLayer | undefined;
      /** F20260803fbit/F20260803chunk: contentType 多选（逗号分隔），如 ?content_type=feature_chunk,feature
       *  命名与 detail_level 一致用 snake_case；agent 工具参数也是 content_type */
      const contentTypeParam = c.req.query("content_type") as string | undefined;
      let contentType: MemoryContentType[] | undefined;
      if (contentTypeParam) {
        const parts = contentTypeParam.split(",").map(s => s.trim()).filter(Boolean);
        const invalid = parts.filter(s => !isMemoryContentType(s));
        if (invalid.length > 0) {
          return c.json({ error: `invalid content_type: ${invalid.join(", ")}` }, 400);
        }
        contentType = parts as MemoryContentType[];
      }

      /** F20260805rbrg: 时间过滤（ISO timestamp），仅返回此时间之后创建的记忆 */
      const createdAfter = c.req.query("created_after") || undefined;
      const debug = c.req.query("debug") === "true";

      const result = await this.searchMemory.search({
        query,
        limit,
        granularity,
        conversationId,
        detailLevel,
        library,
        layer,
        contentType,
        createdAfter,
        debug,
      });

      /** F20260803mval: total=0 且 embedding 不可用时附 degraded，让用户感知结果可能不完整 */
      const degraded = result.total === 0 && !this.embeddingGateway.available;
      return c.json({
        entries: result.entries.map((e) => {
          // Web 后端负责高亮渲染，记忆模块返回纯文本
          const snippet = e.snippet ? highlightSnippet(e.snippet, query) : e.snippet;
          return toMemoryEntryDTO(e, e.score, e.source, snippet, detailLevel);
        }),
        total: result.total,
        vecCoverage: result.vecCoverage,
        ...(degraded ? { degraded: true, degradedReason: "embedding 不可用，语义检索降级，结果可能不完整" } : {}),
      });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async searchSimilar(c: Context): Promise<Response> {
    try {
      const body = await c.req.json<SearchSimilarRequestDTO>();
      const limit = body.limit ?? 10;
      const result = await this.searchMemory.searchSimilar(body.memoryEntryId, limit);
      return c.json({
        entries: result.entries.map((e) => toMemoryEntryDTO(e, e.score, e.source)),
        total: result.total,
        vecCoverage: result.vecCoverage,
      });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  /** F20260811mrpy Part 1：扫描无 vec 索引的暗化条目 */
  async getDarkEntries(c: Context): Promise<Response> {
    try {
      const result = await this.scanDarkEntries.execute();
      return c.json(result);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  /** 渐进式披露：按 ID 批量获取完整记忆条目 */
  async getDetails(c: Context): Promise<Response> {
    try {
      const idsParam = c.req.query("ids");
      if (!idsParam) {
        return c.json({ error: "ids parameter is required (comma-separated)" }, 400);
      }
      const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) {
        return c.json({ error: "ids parameter must contain at least one ID" }, 400);
      }
      const entries = await this.manageMemory.getDetails(ids);
      return c.json({
        entries: entries.map((e) => toMemoryEntryDTO(e)),
        total: entries.length,
      });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async getById(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const entry = await this.manageMemory.getById(id);
      if (!entry) {
        return c.json({ error: "Memory entry not found" }, 404);
      }
      return c.json(toMemoryEntryDTO(entry));
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async flag(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const body = await c.req.json<FlagMemoryRequestDTO>();
      await this.manageMemory.flagMemory(id, body.flagged);
      return c.json({ status: "flagged", flagged: body.flagged });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }
}
