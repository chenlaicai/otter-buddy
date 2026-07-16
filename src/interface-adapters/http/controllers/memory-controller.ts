import type { Context } from "hono";
import type { SearchMemory } from "@usecases/memory/search-memory";
import type { ManageMemory } from "@usecases/memory/manage-memory";
import type { MemoryLayer, RetrievalGranularity } from "@entities/memory/memory-entry";
import { handleError, param } from "../http-error";
import { toMemoryEntryDTO } from "../dto/memory-dto";
import type { SearchSimilarRequestDTO, FlagMemoryRequestDTO } from "../dto/memory-dto";

export class MemoryController {
  constructor(
    private readonly searchMemory: SearchMemory,
    private readonly manageMemory: ManageMemory,
  ) {}

  async search(c: Context): Promise<Response> {
    try {
      const query = c.req.query("query");
      if (!query) {
        return c.json({ error: "query parameter is required" }, 400);
      }
      const limit = Number(c.req.query("limit") ?? "10");
      const layer = c.req.query("layer") as MemoryLayer | undefined;
      const granularity = c.req.query("granularity") as RetrievalGranularity | undefined;
      const conversationId = c.req.query("conversationId");

      const result = await this.searchMemory.search({
        query,
        limit,
        layer,
        granularity,
        conversationId,
      });

      return c.json({
        entries: result.entries.map((e) => toMemoryEntryDTO(e, e.score, e.source)),
        total: result.total,
      });
    } catch (err) {
      return handleError(c, err);
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
      });
    } catch (err) {
      return handleError(c, err);
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
      return handleError(c, err);
    }
  }

  async flag(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const body = await c.req.json<FlagMemoryRequestDTO>();
      await this.manageMemory.flagMemory(id, body.flagged);
      return c.json({ status: "flagged", flagged: body.flagged });
    } catch (err) {
      return handleError(c, err);
    }
  }
}
