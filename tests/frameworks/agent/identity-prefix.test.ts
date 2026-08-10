/**
 * buildIdentityPrefix 分支测试（真 schema + 真 repo）。
 *
 * 端到端的不变量（首次注入、不重复注入）由
 * tests/capability/otter-lifecycle.capability.test.ts 用真系统 + 真 LLM 验证。
 * 本文件只保留能力层覆盖不到的分支：类型优先级/未知类型降级/幽灵獭/目录缺失降级。
 *
 * 明知妥协：buildIdentityPrefix 是私有方法，经 cast 触达——分支密集且能力层无法触发，
 * 保留私有触达是有意的（已删除更深的 _invokeInternal 内部件替换测试）。
 * 文案标记「海獭团队的头儿」「由大獭为完成特定任务而创建」是大小獭身份文件的判别器，改文案需同步。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import path from "node:path";

/** worktree/CI 中无 config/config.yaml，mock 掉避免急切加载配置文件 */
vi.mock("@frameworks/config", () => ({ getConfig: () => ({ circuitBreaker: {} }) }));

import { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import { SqliteOtterConfigProvider } from "@frameworks/db/otter/sqlite-otter-config-provider";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";

const REAL_IDENTITY_DIR = path.resolve(__dirname, "../../../prompts/identity");

function makeFactory(db: Database.Database, identityPromptDir?: string): PiSessionFactory {
  return new PiSessionFactory({
    db,
    sessionDir: ":memory:",
    otterToolClient: {} as never,
    model: null as never,
    identityPromptDir,
    createTools: () => [],
    otterConfigProvider: new SqliteOtterConfigProvider(db),
    otterRepo: new SqliteOtterRepository(db),
  }, createTestLogger());
}

async function buildIdentityPrefix(factory: PiSessionFactory, otterId: string, otterType: string): Promise<string> {
  return (factory as unknown as { buildIdentityPrefix(id: string, type: string): Promise<string> })
    .buildIdentityPrefix(otterId, otterType);
}

describe("buildIdentityPrefix 分支", () => {
  let db: Database.Database;
  let repo: SqliteOtterRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteOtterRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  async function seedOtter(id: string, name: string, type: "big" | "small"): Promise<void> {
    await repo.createOtter({
      id, name, type, status: "active",
      role: null, parentOtterId: null, createdAt: new Date().toISOString(), dissolvedAt: null,
    });
  }

  it("大獭：头部字段 + 大獭身份正文（frontmatter 已剥离）", async () => {
    await seedOtter("o-big", "大獭", "big");
    const prefix = await buildIdentityPrefix(makeFactory(db, REAL_IDENTITY_DIR), "o-big", "big");

    expect(prefix).toContain("名称：大獭");
    expect(prefix).toContain("ID：o-big");
    expect(prefix).toContain("类型：大獭");
    expect(prefix).toContain("海獭团队的头儿");
    expect(prefix).not.toContain("name: big-otter-identity");
  });

  it("小獭：以 otterType 参数为准（即使 DB type 字段不一致）", async () => {
    await seedOtter("o-small", "开发者", "big");
    const prefix = await buildIdentityPrefix(makeFactory(db, REAL_IDENTITY_DIR), "o-small", "small");

    expect(prefix).toContain("类型：小獭");
    expect(prefix).toContain("由大獭为完成特定任务而创建");
  });

  it("未知类型按小獭处理（保守默认）", async () => {
    await seedOtter("o-x", "某獭", "big");
    const prefix = await buildIdentityPrefix(makeFactory(db, REAL_IDENTITY_DIR), "o-x", "weird");

    expect(prefix).toContain("类型：小獭");
    expect(prefix).toContain("由大獭为完成特定任务而创建");
  });

  it("otter 不存在时返回空串", async () => {
    await expect(buildIdentityPrefix(makeFactory(db, REAL_IDENTITY_DIR), "ghost", "big")).resolves.toBe("");
  });

  it("身份文件目录缺失：降级为仅头部（不含身份正文）", async () => {
    await seedOtter("o-big", "大獭", "big");
    const prefix = await buildIdentityPrefix(makeFactory(db, "/nonexistent/identity/dir"), "o-big", "big");

    expect(prefix).toContain("名称：大獭");
    expect(prefix).toContain("类型：大獭");
    expect(prefix).not.toContain("海獭团队的头儿");
  });
});

/**
 * 身份注入触发链路的确定性回归锁（A 类，不依赖 LLM，CI 可跑）。
 * 对抗检视决定恢复：端到端能力用例是 LLM-gated 的（无密钥即 skip），
 * 这条事故史链路（pendingIdentity 标记/失败不消费/createdNew 注入）必须有 CI 守护。
 * 明知妥协：经 cast 触达内部件（_invokeInternal/_restoreOrCreateSession 替换在 pi SDK 边界上）。
 */
describe("身份注入触发链路（pendingIdentity / createdNew）", () => {
  type FactoryInternals = {
    pendingIdentity: Set<string>;
    _restoreOrCreateSession: (id: string) => Promise<{ sessionManager: unknown; createdNew: boolean }>;
    _executeWithSession: (...args: unknown[]) => Promise<unknown>;
    _invokeInternal: (id: string, msg: string, opts: unknown) => Promise<unknown>;
  };

  function makeWiredFactory(createdNew: boolean) {
    const db = createTestDb();
    const factory = new PiSessionFactory({
      db,
      sessionDir: ":memory:",
      otterToolClient: {} as never,
      model: null as never,
      identityPromptDir: REAL_IDENTITY_DIR,
      createTools: () => [],
      otterConfigProvider: {
        getConfig: () => ({ systemPrompt: undefined, otterType: "big", modelAlias: null }),
        setConfig: () => {},
        deleteConfig: () => {},
      } as never,
      otterRepo: new SqliteOtterRepository(db),
    }, createTestLogger());

    const captured: { invokeOptions: unknown } = { invokeOptions: undefined };
    const executeShouldFail = { value: false };
    const internals = factory as unknown as FactoryInternals;
    internals._restoreOrCreateSession = async () => ({ sessionManager: {}, createdNew });
    internals._executeWithSession = async (...args: unknown[]) => {
      captured.invokeOptions = args[2];
      if (executeShouldFail.value) throw new Error("invoke failed");
      return {};
    };
    return { internals, captured, executeShouldFail, db };
  }

  it("create 后（pendingIdentity 有标记）首次 invoke 注入身份，成功后消费标记", async () => {
    const { internals, captured, db } = makeWiredFactory(false);
    internals.pendingIdentity.add("o1");

    await internals._invokeInternal("o1", "hi", undefined);

    expect((captured.invokeOptions as { isFirstInvoke: boolean }).isFirstInvoke).toBe(true);
    expect(internals.pendingIdentity.has("o1")).toBe(false);
    db.close();
  });

  it("invoke 失败时不消费标记，下次重试仍注入（B1 回归锁：删掉标记整个 feature 失效）", async () => {
    const { internals, executeShouldFail, db } = makeWiredFactory(false);
    internals.pendingIdentity.add("o1");
    executeShouldFail.value = true;

    await expect(internals._invokeInternal("o1", "hi", undefined)).rejects.toThrow("invoke failed");

    expect(internals.pendingIdentity.has("o1")).toBe(true);
    db.close();
  });

  it("restore 重建新 session（createdNew=true）即使无标记也注入", async () => {
    const { internals, captured, db } = makeWiredFactory(true);

    await internals._invokeInternal("o1", "hi", undefined);

    expect((captured.invokeOptions as { isFirstInvoke: boolean }).isFirstInvoke).toBe(true);
    db.close();
  });

  it("恢复旧 session 且无标记 → 不注入", async () => {
    const { internals, captured, db } = makeWiredFactory(false);

    await internals._invokeInternal("o1", "hi", undefined);

    expect((captured.invokeOptions as { isFirstInvoke: boolean }).isFirstInvoke).toBe(false);
    db.close();
  });

  it("options 缺省时 isFirstInvoke 标志仍然传递", async () => {
    const { internals, captured, db } = makeWiredFactory(true);

    await internals._invokeInternal("o1", "hi", undefined);

    expect(captured.invokeOptions).not.toBeUndefined();
    db.close();
  });
});
