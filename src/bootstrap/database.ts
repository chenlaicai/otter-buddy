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
import { initEmbeddingService } from "@frameworks/embedding/embedding-service";
import type { EmbeddingGateway, EmbedModelMeta } from "@usecases/memory/embedding-gateway";
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

  /** F20260827mgux（#506）：initSchema 无条件执行（幂等，全 IF NOT EXISTS）——
   *  新库建全表，老库补缺失表。消灭「新表需在 initSchema + migrateDatabase 两处登记」
   *  的誊抄结构（历史四案：embedding_meta / RHI 两表 / signal_events+restart_pending_resumes /
   *  search_query_logs 漏登，最后一例被 fire-and-forget 吞错静默丢数据）。 */
  initSchema(db, logger);
  /** initSchema 不含历史补丁列（如 agent_sessions.session_file）。
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

export function initRepositoriesWithDb(db: Database.Database, logger?: Logger): Repositories {
  return initRepositories(db, logger);
}

/** DB 初始化后的种子数据 + 孤儿修复 + ledger 回填 */
export async function postInitDatabase(db: Database.Database, repos: Repositories, logger: Logger): Promise<void> {
  await seedTerminologyData(db, logger);
  await reconcileOrphans(repos.conversation, logger);
  await backfillSessionLedger(db, repos.otter, logger);

  // ── F20260902sgp2 S1：派发台账启动任务（顺序固定：死亡证明 → backfill 墓碑）──
  // ① 死亡证明（§4.4）：上个进程遗留的 in_progress 一律标 failed（进程内不可能有存活的
  //    in_progress 跨越重启；先例 reconcile-orphans failInFlightMessages 同款语义）。
  //    每次重启都跑（记账面收尾，非迁移）。
  // ② backfill 墓碑（§4.5）：**仅一次**——F20260902hopf 后续核查发现墓碑每次重启都重跑
  //    （3589→3607），会吞掉崩溃窗口的真 pending（R1 场景：用户消息落库后进程死、
  //    无人应答，该由补扫点燃——被下次重启的墓碑误标翻篇）。守卫：settings CAS 一次性锁，
    //    tryInsertIfAbsent 先到先得；老库已跑过墓碑（无守卫期）的处理见下方 comment。
  // 两者失败均仅日志——台账是记账面不是控制面，任何失败不阻断启动（硬约束 1）。
  try {
    const stale = repos.dispatchAttempt.markStaleInProgressFailed();
    if (stale > 0) logger.info('[signal-ledger] 死亡证明：重启翻篇 in_progress 派发记录', { count: stale });
    // 墓碑守卫：CAS 抢锁成功才跑。老库在无守卫期已跑过墓碑的判定：
    // 表内有 source='backfill' 行 = 墓碑已执行过（幂等 OR IGNORE 语义下行数只会增）。
    // 三者（锁 + 历史行检查）构成完整一次性语义，无需 settings 追加额外 key。
    const legacyTombstones = db.prepare(
      "SELECT count(*) AS n FROM dispatch_attempts WHERE source = 'backfill'"
    ).get() as { n: number };
    if (legacyTombstones.n > 0) {
      logger.info('[signal-ledger] backfill 墓碑已执行过（存量墓碑行），跳过', { existing: legacyTombstones.n });
    } else {
      const gotLock = await repos.settings.tryInsertIfAbsent(
        'sgp2:backfill-legacy-attempted', new Date().toISOString(),
      );
      if (gotLock) {
        const backfilled = repos.dispatchAttempt.backfillLegacyAttempted();
        logger.info('[signal-ledger] backfill 墓碑：存量已投递消息标记 legacy-attempted（一次性）', { count: backfilled });
      } else {
        logger.info('[signal-ledger] backfill 墓碑：另一进程已抢锁，跳过');
      }
    }
    const pendingCount = repos.dispatchAttempt.countPendingSignals();
    logger.info('[signal-ledger] 启动完成，当前 pending 计数', { pending: pendingCount });
  } catch (e) {
    logger.warn('[signal-ledger] 启动任务失败（不影响启动）', { error: e instanceof Error ? e.message : String(e) });
  }
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

/**
 * F20260811mrpy Part 3：Embedding 版本锚校验。
 *
 * bootstrap 时比对 worker 实际加载的模型元信息（modelId/modelRev/dim）与 embedding_meta 表存储的基线。
 * 不一致则禁用 vec 路径（检索结果的 vecCoverage.vecDisabled 向消费方暴露降级状态）。
 * 初次启动（表为空）写入基线。
 *
 * 失败模式：无 getMeta 方法（老接口）或 getMeta 超时/失败时跳过校验（vecEnabled=true）。
 *
 * F20260821evaf 审视记录：原设计的 otter_context('system','embedding_degraded') 写入是双重死代码——
 * a) FK 约束（otter_id → otters.id）挡住 'system' 幽灵 id，写入必失败；
 * b) agent 的 get_context 工具按注入 otterId 读，无任何路径读 'system' 行，写了也没人消费。
 * agent 感知实际由 search_memory 结果的 vecCoverage 字段承担，故移除该写入。
 */
const GET_META_TIMEOUT_MS = 30_000;

/** 取 worker 当前 meta，带超时。超时/失败返回 null（调用方跳过校验，不崩 boot）。
 * 超时只截断"worker 永不 ready 也永不报错"的挂起态（onnxruntime 死锁等），
 * 不掩盖 mismatch——mismatch 在 meta 成功拿到后才判定（F20260821evaf 审视项）。
 * 依赖：getMeta 内部 waitForReady 的 waiters 由 worker ready/error/exit 事件兜底回收，
 * 超时后残留 waiter 最坏滞留为有界对象，无泄漏。 */
async function fetchCurrentMeta(
  embeddingGateway: EmbeddingGateway,
  logger: Logger,
): Promise<EmbedModelMeta | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const meta = await Promise.race([
      embeddingGateway.getMeta!(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`getMeta timeout after ${GET_META_TIMEOUT_MS}ms`)), GET_META_TIMEOUT_MS);
      }),
    ]);
    return meta;
  } catch (err) {
    logger.warn(`Failed to read embedding meta from worker, skipping version check: ${err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 读存储基线。IO 错误（磁盘满/只读等）返回 null（跳过校验，不崩 boot）。
 * schema 缺失（no such table）单独识别并 error 级告警——那是 migration 没跑到的信号，
 * 不能像 IO 错误一样静默 skip（否则重演"静默跳过藏 10 天"，F20260821evaf 二轮审视项）。 */
async function readStoredMeta(repos: Repositories, logger: Logger): Promise<Partial<EmbedModelMeta> | null> {
  try {
    return await repos.memoryReader.getEmbeddingMeta();
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      logger.error(`embedding_meta table missing — version anchor silently inactive, check migration: ${err}`);
    } else {
      logger.warn(`Failed to read embedding_meta from db, skipping version check: ${err}`);
    }
    return null;
  }
}

/** 初次启动写基线。写失败仅 warn（跳过校验，不崩 boot）。 */
async function writeBaseline(
  repos: Repositories,
  currentMeta: EmbedModelMeta,
  logger: Logger,
): Promise<void> {
  try {
    await repos.memoryWriter.setEmbeddingMeta(currentMeta);
    logger.info(`Embedding meta baseline recorded: ${currentMeta.modelId} rev=${currentMeta.modelRev} dim=${currentMeta.dim}`);
  } catch (err) {
    logger.warn(`Failed to write embedding meta baseline: ${err}`);
  }
}

export async function verifyEmbeddingVersion(
  embeddingGateway: EmbeddingGateway,
  repos: Repositories,
  logger: Logger,
): Promise<{ vecEnabled: boolean; reason?: string }> {
  // 兼容老接口（无 getMeta）：跳过校验，保持原有行为。
  // 注意不能用 available 判断——它是 worker ready 的时序快照，bootstrap 时恒为 false，
  // 会让校验永远走不到（F20260821evaf 根因）。getMeta 内部会 waitForReady，直接调用即可。
  if (typeof embeddingGateway.getMeta !== "function") {
    return { vecEnabled: true };
  }

  const currentMeta = await fetchCurrentMeta(embeddingGateway, logger);
  if (!currentMeta) return { vecEnabled: true };

  const stored = await readStoredMeta(repos, logger);
  if (!stored) return { vecEnabled: true };

  // 初次启动：表为空，写入基线
  if (!stored.modelId) {
    await writeBaseline(repos, currentMeta, logger);
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
