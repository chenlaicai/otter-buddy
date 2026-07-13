/**
 * 工厂函数：注入 db + embedding，返回 MemoryPort。
 *
 * 使用方式：
 *   const memoryPort = initMemory({ db, embedding });
 */

import type Database from "better-sqlite3";
import { config } from "@infra/config";
import type { EmbeddingService } from "@infra/embedding/service";
import type { MemoryPort } from "../port";
import { MemoryRepository } from "./repository";
import { SearchEngine } from "./search-engine";
import { MemoryAdapter } from "./adapter";

export function initMemory({
  db,
  embedding,
}: {
  db: Database.Database;
  embedding: EmbeddingService;
}): MemoryPort {
  const repository = new MemoryRepository(db);
  const searchEngine = new SearchEngine({
    rrfK: config.memory.rrfK,
    weightHalfLifeDays: config.memory.weightHalfLifeDays,
    samePathBoost: config.memory.samePathBoost,
    crossPathDecay: config.memory.crossPathDecay,
    userFlagMultiplier: config.memory.userFlagMultiplier,
    frequencyBoostFactor: config.memory.frequencyBoostFactor,
  });
  const adapter = new MemoryAdapter(repository, embedding, searchEngine);
  return adapter;
}
