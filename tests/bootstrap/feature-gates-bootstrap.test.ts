/**
 * issue #937：feature-gates 装配层集成测试（platforms.ts 级接线验证）。
 *
 * 验证 resolveFeatureGates 解析结果真实接线到 seed 点行为级——不是单测 gateOn
 * 三态短路（那是 tests/frameworks/config/features-config.test.ts 的活），而是跑真实
 * initPlatforms 装配（真 uc + 真 repos + 内存 DB），断言门控结果落 DB 的行为面：
 * healingInit / recruitingInit 两个 seed 点在「显式配置 / DB 存量推断 / 缺省」三态下的
 * 启动与否。
 *
 * 结构变迁说明（issue #937 立案 2026-09-15 时为四 seed 点）：
 * - F20260920stkx：seedPaperTradingTasks 随 paper-trading 能力整体移除
 * - F20260917swsh：dailyReviewInit 随每日复盘任务移除
 * 现存 seed 点 = healingInit（gates.selfHealing 单门）+ recruitingInit
 * （apiKey && gates.recruiting 双门），S1 型回归（paperTrading 门 raw 值双入口
 * 读值不一致）的载体已随门移除，其等价防线改由「双入口一致性」用例承接
 * （resolveFeatureGates vs inferDomainActive 同数据同结果）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import type { AppConfig } from "@frameworks/config";
import { initRepositories } from "../../src/bootstrap/repositories";
import { initUseCases } from "../../src/bootstrap/usecases";
import { initPlatforms } from "../../src/bootstrap/platforms";
import { resolveFeatureGates, inferDomainActive } from "../../src/bootstrap/feature-gates";
import type { Repositories } from "../../src/bootstrap/types";
import type { UseCases } from "../../src/bootstrap/types";
import { createTestDb } from "../helpers/db";
import { createTestLogger } from "../helpers/logger";
import { fakeAgentGateway } from "../helpers/agent-gateway.fake";

const T0 = "2026-10-01T00:00:00Z";

/** 构造三态 features 段的最小 AppConfig（其余平台段缺省 = 不拉起对应通道） */
function appConfigWith(features: { selfHealing?: boolean; recruiting?: boolean }, opts?: { recruitingApiKey?: string }): AppConfig {
  return {
    features,
    ...(opts?.recruitingApiKey ? { inbound: { recruiting: { apiKey: opts.recruitingApiKey } } } : {}),
  } as unknown as AppConfig;
}

/** 预插存量 active 定时任务（DB 存量推断的判据源） */
function seedActiveTask(db: Database.Database, name: string): void {
  db.prepare("INSERT OR IGNORE INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-seed', '存量种子', 'active', ?, ?)").run(T0, T0);
  db.prepare(
    "INSERT INTO scheduled_tasks (id, conversation_id, name, cron, body, sender_id, status, created_at, updated_at) VALUES (?, 'conv-seed', ?, '0 10 * * *', '存量种子任务', 'seed', 'active', ?, ?)",
  ).run(`task-${name}`, name, T0, T0);
}

function healingConversationCount(db: Database.Database): number {
  return db.prepare("SELECT COUNT(*) FROM conversations WHERE title = '🩺 Self-Healing'").pluck().get() as number;
}

function healingTaskCount(db: Database.Database): number {
  return db.prepare("SELECT COUNT(*) FROM scheduled_tasks WHERE name = 'self-healing-analysis'").pluck().get() as number;
}

function recruitingTaskCount(db: Database.Database): number {
  return db.prepare("SELECT COUNT(*) FROM scheduled_tasks WHERE name = 'recruiting-daily-summary'").pluck().get() as number;
}

describe("issue #937 feature-gates 装配层接线（platforms.ts 级）", () => {
  let db: Database.Database;
  let repos: Repositories;
  let uc: UseCases;

  beforeEach(() => {
    db = createTestDb();
    const logger = createTestLogger();
    repos = initRepositories(db, logger);
    uc = initUseCases({
      repos,
      entryRepo: repos.entry,
      invokeRepo: repos.invoke,
      agentGateway: fakeAgentGateway() as never,
      embeddingService: { embed: vi.fn(async () => []), embedBatch: vi.fn(async () => []) } as never,
      memoryIndex: { upsert: vi.fn(), search: vi.fn(async () => []) } as never,
      appConfig: appConfigWith({}),
      logger,
    });
  });

  afterEach(() => {
    db.close();
  });

  /** 跑真实装配，返回 initPlatforms 结果 */
  async function boot(features: { selfHealing?: boolean; recruiting?: boolean }, opts?: { recruitingApiKey?: string }) {
    return initPlatforms({
      appConfig: appConfigWith(features, opts),
      repos,
      uc,
      agentInvoker: {} as never,
      dispatchChainEngine: {} as never,
      messageBroadcaster: undefined as never,
      logger: createTestLogger(),
    });
  }

  describe("healingInit 接线（gates.selfHealing 单门）", () => {
    it("显式 true：DB 空也启动 seed——healing 会话与 self-healing-analysis 任务落库", async () => {
      const result = await boot({ selfHealing: true });
      await result.healingInit;
      expect(healingConversationCount(db)).toBe(1);
      expect(healingTaskCount(db)).toBe(1);
    });

    it("显式 false：DB 有存量任务也不启动（显式配置优先于推断）", async () => {
      seedActiveTask(db, "self-healing-analysis");
      const result = await boot({ selfHealing: false });
      await result.healingInit;
      expect(healingConversationCount(db)).toBe(0);
      // 预插的存量行是推断判据而非 seed 产出——不得新增
      expect(healingTaskCount(db)).toBe(1);
    });

    it("未配置 + DB 存量 active 任务：存量推断为 true，启动 seed", async () => {
      seedActiveTask(db, "self-healing-analysis");
      const result = await boot({});
      await result.healingInit;
      expect(healingConversationCount(db)).toBe(1);
    });

    it("未配置 + DB 空：缺省关，不启动 seed", async () => {
      const result = await boot({});
      await result.healingInit;
      expect(healingConversationCount(db)).toBe(0);
      expect(healingTaskCount(db)).toBe(0);
    });
  });

  describe("recruitingInit 接线（apiKey && gates.recruiting 双门）", () => {
    it("显式 true + apiKey：双门开——三对象创建 + recruiting 会话与任务落库", async () => {
      const result = await boot({ recruiting: true }, { recruitingApiKey: "key-1" });
      await result.recruitingInit;
      expect(result.processInboundRecruit).toBeDefined();
      expect(result.inboundApiKey).toBe("key-1");
      expect(result.getBridgeStatus).toBeDefined();
      expect(recruitingTaskCount(db)).toBe(1);
    });

    it("显式 true + 无 apiKey：双门缺一不开——三对象留空、无 seed", async () => {
      const result = await boot({ recruiting: true });
      await result.recruitingInit;
      expect(result.processInboundRecruit).toBeUndefined();
      expect(result.inboundApiKey).toBeUndefined();
      expect(recruitingTaskCount(db)).toBe(0);
    });

    it("显式 false + apiKey + 存量：显式配置优先，整个子系统不起", async () => {
      seedActiveTask(db, "recruiting-daily-summary");
      const result = await boot({ recruiting: false }, { recruitingApiKey: "key-1" });
      await result.recruitingInit;
      expect(result.processInboundRecruit).toBeUndefined();
      expect(recruitingTaskCount(db)).toBe(1); // 预插存量行，不新增
    });

    it("未配置 + apiKey + 存量：推断为 true，双门开", async () => {
      seedActiveTask(db, "recruiting-daily-summary");
      const result = await boot({}, { recruitingApiKey: "key-1" });
      await result.recruitingInit;
      expect(result.processInboundRecruit).toBeDefined();
      expect(recruitingTaskCount(db)).toBe(2); // 预插 1 + seed 1
    });

    it("未配置 + apiKey + DB 空：apiKey 本身是意图信号，推断 true 双门开", async () => {
      const result = await boot({}, { recruitingApiKey: "key-1" });
      await result.recruitingInit;
      expect(result.processInboundRecruit).toBeDefined();
      expect(recruitingTaskCount(db)).toBe(1);
    });

    it("未配置 + 无 apiKey + DB 空：缺省关", async () => {
      const result = await boot({});
      await result.recruitingInit;
      expect(result.processInboundRecruit).toBeUndefined();
      expect(recruitingTaskCount(db)).toBe(0);
    });
  });

  describe("双入口一致性（S1 型回归防线：读值不一致即回归）", () => {
    it("selfHealing：resolveFeatureGates 与 inferDomainActive 同数据同结果", async () => {
      for (const withTask of [true, false]) {
        db = createTestDb();
        const logger = createTestLogger();
        repos = initRepositories(db, logger);
        if (withTask) seedActiveTask(db, "self-healing-analysis");
        const gates = await resolveFeatureGates({ features: { selfHealing: undefined, recruiting: undefined }, scheduledTaskRepo: repos.scheduledTask, logger });
        const single = await inferDomainActive(repos.scheduledTask, "selfHealing");
        expect(gates.selfHealing).toBe(single);
        db.close();
      }
    });

    it("recruiting：无 apiKey 场景下 resolveFeatureGates 与 inferDomainActive 同数据同结果", async () => {
      for (const withTask of [true, false]) {
        db = createTestDb();
        const logger = createTestLogger();
        repos = initRepositories(db, logger);
        if (withTask) seedActiveTask(db, "recruiting-daily-summary");
        const gates = await resolveFeatureGates({ features: { selfHealing: undefined, recruiting: undefined }, scheduledTaskRepo: repos.scheduledTask, logger });
        const single = await inferDomainActive(repos.scheduledTask, "recruiting");
        expect(gates.recruiting).toBe(single);
        db.close();
      }
    });
  });

  describe("装配返回面", () => {
    it("无 weixin 段且无登录账号：weixinPollers 空数组、registry 照常创建", async () => {
      const result = await boot({});
      expect(result.weixinPollers).toEqual([]);
      expect(result.registry).toBeDefined();
    });
  });
});
