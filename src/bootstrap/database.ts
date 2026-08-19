import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type Database from "better-sqlite3";
import type { AppConfig } from "@frameworks/config";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { Logger } from "@usecases/ports/logger";
import { initDatabase, closeDatabase } from "@frameworks/db/database";
import { initSchema } from "@frameworks/db/schema";
import { initModels } from "@frameworks/llm/models-factory";
import { ModelPool } from "@frameworks/llm/model-pool";
import { DEFAULT_MODEL_ALIAS_KEY } from "@usecases/settings/settings-keys";
import { initEmbeddingService } from "@frameworks/embedding/embedding-service";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import { ensureBgeM3Model } from "@frameworks/embedding/ensure-model";
import { migrateDatabase, migrateExistingData, migrateFeatureBodyToChunks, migrateMessageSegments } from "@frameworks/db/migration";
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
  model: Model<Api>;
  modelPool: ModelPool;
  embeddingService: EmbeddingGateway;
  dispose: () => void;
}

/** 测试注入预构建模型（如 initFauxModels）时，未带 pool 则按 llm 配置的全部别名合成池（共享同一模型对象） */
function synthesizePool(model: Model<Api>, llm: AppConfig["llm"]): ModelPool {
  return new ModelPool(llm.default, new Map(
    llm.models.map((mc) => [mc.alias, { config: mc, model }]),
  ));
}

export async function initDatabaseAndModels(
  appConfig: AppConfig,
  logger: Logger,
  /** 测试注入预构建模型（如 initFauxModels），跳过 initModels（无密钥环境下 initModels 会抛错） */
  modelsOverride?: { model: Model<Api>; modelPool?: ModelPool },
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
  migrateMessageSegments(db, logger);

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

/**
 * 应用 settings 页保存的默认模型覆盖（settingsRepo「llm.defaultModelAlias」）。
 * 覆盖值指向已不存在的 alias 时忽略并告警（用户可能改了 config.yaml）。
 */
export async function applyDefaultModelOverride(
  settingsRepo: { get(key: string): Promise<string | null> },
  modelPool: ModelPool,
  logger: Logger,
): Promise<void> {
  const override = await settingsRepo.get(DEFAULT_MODEL_ALIAS_KEY);
  if (!override) return;
  if (!modelPool.hasModel(override)) {
    logger.warn(`settings 中保存的默认模型「${override}」不在 config.yaml models[] 中，忽略该覆盖`);
    return;
  }
  modelPool.setDefaultAlias(override);
  logger.info(`应用 settings 默认模型覆盖: ${override}`);
}

export function shutdownDatabase(db: Database.Database, logger: Logger): void {
  closeDatabase(db, logger);
}

/**
 * F20260811mrpy Part 3：Embedding 版本锚校验。
 *
 * bootstrap 时比对 worker 实际加载的模型元信息（modelId/modelRev/dim）与 embedding_meta 表存储的基线。
 * 不一致则禁用 vec 路径 + 写入 otter_context('system', 'embedding_degraded') 让 agent 感知。
 * 初次启动（表为空）写入基线。
 *
 * 失败模式：embeddingGateway 不 available 或无 getMeta 方法时跳过校验（兼容老接口与测试 mock）。
 */
export async function verifyEmbeddingVersion(
  embeddingGateway: EmbeddingGateway,
  repos: Repositories,
  logger: Logger,
): Promise<{ vecEnabled: boolean; reason?: string }> {
  // 兼容老接口（无 getMeta）：跳过校验，保持原有行为
  if (!embeddingGateway.available || typeof embeddingGateway.getMeta !== "function") {
    return { vecEnabled: true };
  }

  let currentMeta;
  try {
    currentMeta = await embeddingGateway.getMeta();
  } catch (err) {
    logger.warn(`Failed to read embedding meta from worker, skipping version check: ${err}`);
    return { vecEnabled: true };
  }

  const stored = await repos.memoryReader.getEmbeddingMeta();

  // 初次启动：表为空，写入基线
  if (!stored.modelId) {
    await repos.memoryWriter.setEmbeddingMeta(currentMeta);
    logger.info(`Embedding meta baseline recorded: ${currentMeta.modelId} rev=${currentMeta.modelRev} dim=${currentMeta.dim}`);
    return { vecEnabled: true };
  }

  // 一致性校验
  const consistent =
    stored.modelId === currentMeta.modelId &&
    stored.modelRev === currentMeta.modelRev &&
    stored.dim === currentMeta.dim;

  if (consistent) {
    return { vecEnabled: true };
  }

  // 不一致 → 降级
  logger.error(`Embedding version mismatch, degrading to FTS-only: stored=${JSON.stringify(stored)} current=${JSON.stringify(currentMeta)}`);
  const degradeInfo = JSON.stringify({
    reason: "version_mismatch",
    stored,
    current: currentMeta,
    detectedAt: new Date().toISOString(),
  });
  try {
    // otter_context 表是 (otter_id, key, value) 结构，embedding 降级是系统级状态用 otterId="system"
    await repos.otterContext.set("system", "embedding_degraded", degradeInfo);
  } catch (err) {
    logger.warn(`Failed to write embedding_degraded to otter_context: ${err}`);
  }

  // 禁用 vec 路径（SqliteMemoryRepository 特有方法）
  const sqliteMemoryRepo = repos.memory as { disableVec?: () => void };
  if (typeof sqliteMemoryRepo.disableVec === "function") {
    sqliteMemoryRepo.disableVec();
  }

  return { vecEnabled: false, reason: "version_mismatch" };
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
