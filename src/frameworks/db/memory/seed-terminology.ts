import type Database from "better-sqlite3";
import type { TerminologyEntry } from "@entities/memory/terminology-entry";
import { SqliteTerminologyRepository } from "./sqlite-terminology-repository";
import type { Logger } from "@usecases/ports/logger";
import seedTermData from "./seed-terminology.json" with { type: "json" };

interface SeedTermData {
  id: string;
  term: string;
  aliases: string[];
  definition: string;
  context: string | null;
  examples: string[] | null;
  category: string | null;
}

const SEED_TIMESTAMP = "2026-07-09T00:00:00Z";

/**
 * 从外部 JSON 文件加载种子数据并转换为 TerminologyEntry 格式。
 * JSON 文件包含精简字段（无 id 前缀、status、version 等运行时字段），
 * 此处补全为完整的 TerminologyEntry。
 */
function loadSeedEntries(): TerminologyEntry[] {
  // 种子是代码资产（git 追踪）非运行时数据：原放 data/terminology/ 依赖 getRepoRoot
  // 解析仓根——云端部署（deploy.sh 排除 data/、无 git 仓）下 ENOENT（演练轮实证）。
  // 改为编译期 import JSON（resolveJsonModule），随 dist 部署即带，路径基准问题消失。
  const terms = seedTermData as SeedTermData[];

  return terms.map((t) => ({
    id: t.id,
    term: t.term,
    aliases: t.aliases,
    definition: t.definition,
    context: t.context,
    examples: t.examples,
    category: t.category,
    status: "active" as const,
    createdAt: SEED_TIMESTAMP,
    updatedAt: SEED_TIMESTAMP,
    version: 1,
  }));
}

/** 种子数据同步：从外部 JSON 文件读取，比对数据库差异，新增/更新术语 */
export async function seedTerminologyData(db: Database.Database, logger?: Logger): Promise<void> {
  const startTime = Date.now();
  const repo = new SqliteTerminologyRepository(db);
  const entries = loadSeedEntries();

  // 记录种子数据导入开始日志
  if (logger) {
    logger.info('Seed terminology data started', {
      entries: entries.length,
      action: 'seed_start',
    });
  }

  await repo.syncSeed(entries);

  const duration = Date.now() - startTime;

  // 记录种子数据导入完成日志
  if (logger) {
    logger.info('Seed terminology data completed', {
      entries: entries.length,
      duration,
      action: 'seed_complete',
    });
  }
}
