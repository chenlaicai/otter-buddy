import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type Database from "better-sqlite3";
import type { AppConfig } from "@frameworks/config";
import type { Logger } from "@usecases/ports/logger";
import { initDatabase, closeDatabase } from "@frameworks/db/database";
import { initSchema } from "@frameworks/db/schema";
import { initModels } from "@frameworks/llm/models-factory";
import { ModelPool } from "@frameworks/llm/model-pool";
import { initEmbeddingService } from "@frameworks/embedding/embedding-service";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import { ensureBgeM3Model } from "@frameworks/embedding/ensure-model";
import { migrateDatabase, migrateExistingData, migrateFeatureBodyToChunks } from "@frameworks/db/migration";
import { SqliteOtterConfigProvider } from "@frameworks/db/otter/sqlite-otter-config-provider";
import type { OtterConfigProvider } from "@usecases/ports/otter-config-provider";
import { backfillSessionLedger } from "@frameworks/db/otter/backfill-session-ledger";
import { seedTerminologyData } from "@frameworks/db/memory/seed-terminology";
import { reconcileOrphans } from "@usecases/conversation/reconcile-orphans";
import type { SyncResult } from "@usecases/document/sync-documents";
import type { Repositories } from "./types";
import { initRepositories } from "./repositories";

export interface DatabaseBootstrapResult {
  db: Database.Database;
  otterConfigProvider: OtterConfigProvider;
  model: unknown;
  modelPool: ModelPool;
  embeddingService: EmbeddingGateway;
  dispose: () => void;
}

/** 测试注入预构建模型（如 initFauxModels）时，未带 pool 则按 llm 配置的全部别名合成池（共享同一模型对象） */
function synthesizePool(model: unknown, llm: AppConfig["llm"]): ModelPool {
  const alias = llm.default ?? "default";
  const configs = llm.models?.length
    ? llm.models
    : [{ alias, provider: llm.provider, model: llm.model }];
  return new ModelPool(alias, new Map(
    configs.map((mc) => [mc.alias, { config: mc, model }]),
  ));
}

export async function initDatabaseAndModels(
  appConfig: AppConfig,
  logger: Logger,
  /** 测试注入预构建模型（如 initFauxModels），跳过 initModels（无密钥环境下 initModels 会抛错） */
  modelsOverride?: { model: unknown; modelPool?: ModelPool },
): Promise<DatabaseBootstrapResult> {
  const dbPath = appConfig.db.path;
  const isNewDb = !fs.existsSync(dbPath);
  const db = initDatabase(appConfig.db, logger);

  if (isNewDb) {
    logger.info("New database detected, running schema initialization");
    initSchema(db, logger);
  }
  /** initSchema 只建基础表结构，不含历史补丁列（如 agent_sessions.session_file）。
   *  migrateDatabase 幂等（PRAGMA 检查 + IF NOT EXISTS），新库也必须跑到最新结构——
   *  否则下方 migrateExistingData 读 session_file 直接崩（F20260805codx 曾把两者做成互斥分支，新库无法启动）。 */
  migrateDatabase(db, logger);

  const otterConfigProvider = new SqliteOtterConfigProvider(db);
  ensureBgeM3Model(appConfig.embedding, logger);
  const { model, modelPool } = modelsOverride
    ? { model: modelsOverride.model, modelPool: modelsOverride.modelPool ?? synthesizePool(modelsOverride.model, appConfig.llm) }
    : await initModels(appConfig.llm, logger);
  const { service: embeddingService, dispose: disposeEmbedding } = await initEmbeddingService(appConfig.embedding, logger);

  if (isNewDb) {
    migrateExistingData(db, otterConfigProvider, logger);
  }

  return { db, otterConfigProvider, model, modelPool, embeddingService, dispose: disposeEmbedding };
}

export function initRepositoriesWithDb(db: Database.Database): Repositories {
  return initRepositories(db);
}

/** DB 初始化后的种子数据 + 孤儿修复 + ledger 回填 */
export async function postInitDatabase(db: Database.Database, repos: Repositories, logger: Logger): Promise<void> {
  await seedTerminologyData(db, logger);
  await reconcileOrphans(repos.conversation, logger);
  await backfillSessionLedger(db, repos.otter, logger);
}

/** sync 完成后的 chunk 迁移（独立于 migrateDatabase，PR 审视 S3-01） */
export function postSyncMigrations(db: Database.Database, logger: Logger, syncResult: SyncResult): void {
  migrateFeatureBodyToChunks(db, logger, syncResult.errors.length);
}

export function validateModelAliases(db: Database.Database, modelPool: { hasModel(alias: string): boolean }, logger: Logger): void {
  const allConfigs = db.prepare("SELECT otter_id, model_alias FROM otter_configs WHERE model_alias IS NOT NULL").all() as Array<{ otter_id: string; model_alias: string }>;
  for (const row of allConfigs) {
    if (!modelPool.hasModel(row.model_alias)) {
      logger.warn(`Otter ${row.otter_id} 引用了不存在的模型别名「${row.model_alias}」，invoke 时将回退到默认模型`);
    }
  }
}

export function shutdownDatabase(db: Database.Database, logger: Logger): void {
  closeDatabase(db, logger);
}

export function syncApiKeyToAgentAuth(llmConfig: AppConfig["llm"], logger: Logger): void {
  const homeDir = os.homedir();
  const agentDir = path.join(homeDir, ".pi", "agent");
  const authPath = path.join(agentDir, "auth.json");
  let auth: Record<string, string> = {};
  try {
    auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
  } catch {
    /* 文件不存在或格式错误，使用空对象 */
  }

  let changed = false;

  for (const mc of llmConfig.models) {
    if (!mc.apiKey) continue;
    const key = mc.alias;
    if (auth[key] !== mc.apiKey) {
      auth[key] = mc.apiKey;
      changed = true;
    }
  }

  if (changed) {
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 });
    logger.info(`Synced API keys to ${authPath}`);
  }
}
