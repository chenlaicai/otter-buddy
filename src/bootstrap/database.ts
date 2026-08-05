import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type Database from "better-sqlite3";
import type { AppConfig } from "@frameworks/config";
import type { PinoLogger } from "@frameworks/logger";
import { initDatabase } from "@frameworks/db/database";
import { initSchema } from "@frameworks/db/schema";
import { initModels } from "@frameworks/llm/models-factory";
import type { ModelPool } from "@frameworks/llm/model-pool";
import { initEmbeddingService } from "@frameworks/embedding/embedding-service";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import { ensureBgeM3Model } from "@frameworks/embedding/ensure-model";
import { migrateDatabase, migrateExistingData } from "@frameworks/db/migration";
import { SqliteOtterConfigProvider } from "@frameworks/db/otter/sqlite-otter-config-provider";
import type { OtterConfigProvider } from "@usecases/ports/otter-config-provider";
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

export async function initDatabaseAndModels(appConfig: AppConfig, logger: PinoLogger): Promise<DatabaseBootstrapResult> {
  const dbPath = appConfig.db.path;
  const isNewDb = !fs.existsSync(dbPath);
  const db = initDatabase(appConfig.db, logger);

  if (isNewDb) {
    logger.info("New database detected, running schema initialization");
    initSchema(db, logger);
  } else {
    migrateDatabase(db, logger);
  }

  const otterConfigProvider = new SqliteOtterConfigProvider(db);
  ensureBgeM3Model(appConfig.embedding, logger);
  const { model, modelPool } = await initModels(appConfig.llm, logger);
  const { service: embeddingService, dispose: disposeEmbedding } = await initEmbeddingService(appConfig.embedding, logger);

  if (isNewDb) {
    migrateExistingData(db, otterConfigProvider, logger);
  }

  const dispose = () => {
    disposeEmbedding();
  };

  return { db, otterConfigProvider, model, modelPool, embeddingService, dispose };
}

export function initRepositoriesWithDb(db: Database.Database): Repositories {
  return initRepositories(db);
}

export function validateModelAliases(db: Database.Database, modelPool: { hasModel(alias: string): boolean }, logger: PinoLogger): void {
  const allConfigs = db.prepare("SELECT otter_id, model_alias FROM otter_configs WHERE model_alias IS NOT NULL").all() as Array<{ otter_id: string; model_alias: string }>;
  for (const row of allConfigs) {
    if (!modelPool.hasModel(row.model_alias)) {
      logger.warn(`Otter ${row.otter_id} 引用了不存在的模型别名「${row.model_alias}」，invoke 时将回退到默认模型`);
    }
  }
}

export function syncApiKeyToAgentAuth(llmConfig: AppConfig["llm"], logger: PinoLogger): void {
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

  // 多模型模式：遍历所有模型
  if (llmConfig.models && llmConfig.models.length > 0) {
    for (const mc of llmConfig.models) {
      if (!mc.apiKey) continue;
      const key = mc.alias; // 用 alias 作为 auth key
      if (auth[key] !== mc.apiKey) {
        auth[key] = mc.apiKey;
        changed = true;
      }
    }
  } else if (llmConfig.apiKey) {
    // 单模型模式：兼容旧逻辑
    if (auth[llmConfig.provider] !== llmConfig.apiKey) {
      auth[llmConfig.provider] = llmConfig.apiKey;
      changed = true;
    }
  }

  if (changed) {
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 });
    logger.info(`Synced API keys to ${authPath}`);
  }
}
