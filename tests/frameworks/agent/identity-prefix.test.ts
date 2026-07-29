import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";

/** worktree/CI 中无 config/config.yaml，mock 掉避免急切加载配置文件 */
vi.mock("@frameworks/config", () => ({ config: { circuitBreaker: {} } }));

import { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import type { Logger } from "@usecases/ports/logger";
import type { OtterConfigProvider } from "@usecases/ports/otter-config-provider";
import type { OtterRepository } from "@usecases/otter/otter-repository";

function mockLogger(): Logger & { warns: unknown[][] } {
  const warns: unknown[][] = [];
  const logger: Logger & { warns: unknown[][] } = {
    info: () => {},
    warn: (...args: unknown[]) => { warns.push(args); },
    error: () => {},
    debug: () => {},
    child: () => logger,
    warns,
  };
  return logger;
}

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.prepare("CREATE TABLE otters (id TEXT PRIMARY KEY, name TEXT, type TEXT)").run();
  db.prepare("CREATE TABLE agent_sessions (otter_id TEXT PRIMARY KEY, pi_session_id TEXT, session_file TEXT, updated_at TEXT)").run();
  return db;
}

/** 直接读真实 prompts/identity/ 目录：内容断言（如"海獭团队的头儿"）是有意的文案存在性守护，改文案需同步本测试 */
const REAL_IDENTITY_DIR = path.resolve(__dirname, "../../../prompts/identity");

function makeFactory(db: Database.Database, logger: Logger, identityPromptDir?: string): PiSessionFactory {
  const otterConfigProvider = {
    getConfig: () => null,
    setConfig: () => {},
    deleteConfig: () => {},
  } as unknown as OtterConfigProvider;
  const otterRepo = {
    getById: async (id: string) => {
      const row = db.prepare("SELECT id, name, type FROM otters WHERE id = ?").get(id) as { id: string; name: string; type: string } | undefined;
      return row ? { id: row.id, name: row.name, type: row.type, status: 'active', role: null, parentOtterId: null, createdAt: '', dissolvedAt: null } : null;
    },
  } as unknown as OtterRepository;
  return new PiSessionFactory({
    db,
    sessionDir: ":memory:",
    otterToolClient: {} as never,
    model: null,
    identityPromptDir,
    createTools: () => [],
    otterConfigProvider,
    otterRepo,
  }, logger);
}

/** 调用私有方法 buildIdentityPrefix（单元测试注入内容，绕过 SDK session） */
async function buildIdentityPrefix(factory: PiSessionFactory, otterId: string, otterType: string): Promise<string> {
  return (factory as unknown as { buildIdentityPrefix(id: string, type: string): Promise<string> })
    .buildIdentityPrefix(otterId, otterType);
}

describe("PiSessionFactory 身份注入（buildIdentityPrefix）", () => {
  it("大獭：注入名称/ID/类型头部 + 大獭身份正文（frontmatter 已剥离）", async () => {
    const db = makeDb();
    db.prepare("INSERT INTO otters (id, name, type) VALUES (?, ?, ?)").run("o-big", "大獭", "big");
    const factory = makeFactory(db, mockLogger(), REAL_IDENTITY_DIR);

    const prefix = await buildIdentityPrefix(factory, "o-big", "big");

    expect(prefix).toContain("## 你的身份");
    expect(prefix).toContain("名称：大獭");
    expect(prefix).toContain("ID：o-big");
    expect(prefix).toContain("类型：大獭");
    expect(prefix).toContain("海獭团队的头儿");
    expect(prefix).not.toContain("name: big-otter-identity");
  });

  it("小獭：注入小獭身份正文，即使 DB 中 type 字段与 otterConfig 不一致也以 otterConfig 为准", async () => {
    const db = makeDb();
    db.prepare("INSERT INTO otters (id, name, type) VALUES (?, ?, ?)").run("o-small", "开发者", "big");
    const factory = makeFactory(db, mockLogger(), REAL_IDENTITY_DIR);

    const prefix = await buildIdentityPrefix(factory, "o-small", "small");

    expect(prefix).toContain("类型：小獭");
    expect(prefix).toContain("由大獭为完成特定任务而创建");
  });

  it("未知类型按小獭处理（保守默认）", async () => {
    const db = makeDb();
    db.prepare("INSERT INTO otters (id, name, type) VALUES (?, ?, ?)").run("o-x", "某獭", "weird");
    const factory = makeFactory(db, mockLogger(), REAL_IDENTITY_DIR);

    const prefix = await buildIdentityPrefix(factory, "o-x", "weird");

    expect(prefix).toContain("类型：小獭");
    expect(prefix).toContain("由大獭为完成特定任务而创建");
  });

  it("otter 不存在时返回空串", async () => {
    const db = makeDb();
    const factory = makeFactory(db, mockLogger(), REAL_IDENTITY_DIR);

    await expect(buildIdentityPrefix(factory, "ghost", "big")).resolves.toBe("");
  });

  it("身份文件目录缺失：降级为仅头部，并打 warn 日志", async () => {
    const db = makeDb();
    db.prepare("INSERT INTO otters (id, name, type) VALUES (?, ?, ?)").run("o-big", "大獭", "big");
    const logger = mockLogger();
    const factory = makeFactory(db, logger, "/nonexistent/identity/dir");

    expect(logger.warns.length).toBeGreaterThan(0);

    const prefix = await buildIdentityPrefix(factory, "o-big", "big");
    expect(prefix).toContain("名称：大獭");
    expect(prefix).toContain("类型：大獭");
    expect(prefix).not.toContain("海獭团队的头儿");
  });

  it("未配置 identityPromptDir：构造时打 warn 日志", () => {
    const db = makeDb();
    const logger = mockLogger();
    makeFactory(db, logger, undefined);

    expect(logger.warns.length).toBeGreaterThan(0);
  });
});

describe("PiSessionFactory 身份注入触发链路（pendingIdentity / createdNew）", () => {
  type FactoryInternals = {
    pendingIdentity: Set<string>;
    _restoreOrCreateSession: (id: string) => Promise<{ sessionManager: unknown; createdNew: boolean }>;
    _executeWithSession: (...args: unknown[]) => Promise<unknown>;
    _invokeInternal: (id: string, msg: string, opts: unknown) => Promise<unknown>;
  };

  function makeWiredFactory(createdNew: boolean): { factory: PiSessionFactory; internals: FactoryInternals; captured: { invokeOptions: unknown }; executeShouldFail: { value: boolean } } {
    const db = makeDb();
    const otterConfigProvider = {
      getConfig: () => ({ systemPrompt: undefined, otterType: "big" }),
      setConfig: () => {},
      deleteConfig: () => {},
    } as unknown as OtterConfigProvider;
    const otterRepo = {
      getById: async (id: string) => {
        const row = db.prepare("SELECT id, name, type FROM otters WHERE id = ?").get(id) as { id: string; name: string; type: string } | undefined;
        return row ? { id: row.id, name: row.name, type: row.type, status: 'active', role: null, parentOtterId: null, createdAt: '', dissolvedAt: null } : null;
      },
    } as unknown as OtterRepository;
    const factory = new PiSessionFactory({
      db,
      sessionDir: ":memory:",
      otterToolClient: {} as never,
      model: null,
      identityPromptDir: REAL_IDENTITY_DIR,
      createTools: () => [],
      otterConfigProvider,
      otterRepo,
    }, mockLogger());

    const captured: { invokeOptions: unknown } = { invokeOptions: undefined };
    const executeShouldFail = { value: false };
    const internals = factory as unknown as FactoryInternals;
    internals._restoreOrCreateSession = async () => ({ sessionManager: {}, createdNew });
    internals._executeWithSession = async (...args: unknown[]) => {
      captured.invokeOptions = args[2];
      if (executeShouldFail.value) throw new Error("invoke failed");
      return {};
    };
    return { factory, internals, captured, executeShouldFail };
  }

  it("create 后（pendingIdentity 有标记）首次 invoke 注入身份，成功后消费标记", async () => {
    const { internals, captured } = makeWiredFactory(false);
    internals.pendingIdentity.add("o1");

    await internals._invokeInternal("o1", "hi", undefined);

    expect((captured.invokeOptions as { isFirstInvoke: boolean }).isFirstInvoke).toBe(true);
    expect(internals.pendingIdentity.has("o1")).toBe(false);
  });

  it("invoke 失败时不消费标记，下次重试仍注入", async () => {
    const { internals, executeShouldFail } = makeWiredFactory(false);
    internals.pendingIdentity.add("o1");
    executeShouldFail.value = true;

    await expect(internals._invokeInternal("o1", "hi", undefined)).rejects.toThrow("invoke failed");

    expect(internals.pendingIdentity.has("o1")).toBe(true);
  });

  it("restore 重建新 session（createdNew=true）即使无标记也注入", async () => {
    const { internals, captured } = makeWiredFactory(true);

    await internals._invokeInternal("o1", "hi", undefined);

    expect((captured.invokeOptions as { isFirstInvoke: boolean }).isFirstInvoke).toBe(true);
  });

  it("恢复旧 session 且无标记 → 不注入", async () => {
    const { internals, captured } = makeWiredFactory(false);

    await internals._invokeInternal("o1", "hi", undefined);

    expect((captured.invokeOptions as { isFirstInvoke: boolean }).isFirstInvoke).toBe(false);
  });

  it("options 缺省时 isFirstInvoke 标志仍然传递", async () => {
    const { internals, captured } = makeWiredFactory(true);

    await internals._invokeInternal("o1", "hi", undefined);

    expect(captured.invokeOptions).not.toBeUndefined();
  });
});

describe("PiSessionFactory 消息前缀拼接（buildUserMessagePrefix）", () => {
  async function buildPrefix(factory: PiSessionFactory, otterId: string, otterType: string, prompt: string | undefined, isFirst: boolean | undefined): Promise<string> {
    return (factory as unknown as { buildUserMessagePrefix(id: string, type: string, p: string | undefined, first: boolean | undefined): Promise<string> })
      .buildUserMessagePrefix(otterId, otterType, prompt, isFirst);
  }

  it("首次 invoke：身份叠加在专属 systemPrompt 之前", async () => {
    const db = makeDb();
    db.prepare("INSERT INTO otters (id, name, type) VALUES (?, ?, ?)").run("o-small", "开发者", "small");
    const factory = makeFactory(db, mockLogger(), REAL_IDENTITY_DIR);

    const prefix = await buildPrefix(factory, "o-small", "small", "你是代码开发者，负责实现功能。", true);

    const identityIdx = prefix.indexOf("## 你的身份");
    const promptIdx = prefix.indexOf("你是代码开发者");
    expect(identityIdx).toBeGreaterThanOrEqual(0);
    expect(promptIdx).toBeGreaterThan(identityIdx);
  });

  it("非首次 invoke：仅专属 prompt，不重复注入身份", async () => {
    const db = makeDb();
    db.prepare("INSERT INTO otters (id, name, type) VALUES (?, ?, ?)").run("o-big", "大獭", "big");
    const factory = makeFactory(db, mockLogger(), REAL_IDENTITY_DIR);

    await expect(buildPrefix(factory, "o-big", "big", "专属 prompt", false)).resolves.toBe("专属 prompt");
  });

  it("首次但 otter 不存在：降级为仅专属 prompt", async () => {
    const db = makeDb();
    const factory = makeFactory(db, mockLogger(), REAL_IDENTITY_DIR);

    await expect(buildPrefix(factory, "ghost", "big", "专属 prompt", true)).resolves.toBe("专属 prompt");
  });
});

describe("PiSessionFactory pendingIdentity 回归锁（真实 create/reset/destroy 路径）", () => {
  function makeSdkMock() {
    let n = 0;
    return {
      SessionManager: {
        create: () => ({
          getSessionId: () => `sid-${++n}`,
          getSessionFile: () => `/tmp/fake-${n}.jsonl`,
        }),
        open: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
      },
    };
  }

  function makeRealFactory(db: Database.Database): { factory: PiSessionFactory; pending: Set<string> } {
    const otterConfigProvider = {
      getConfig: () => null,
      setConfig: () => {},
      deleteConfig: () => {},
    } as unknown as OtterConfigProvider;
    const otterRepo = {
      getById: async (id: string) => {
        const row = db.prepare("SELECT id, name, type FROM otters WHERE id = ?").get(id) as { id: string; name: string; type: string } | undefined;
        return row ? { id: row.id, name: row.name, type: row.type, status: 'active', role: null, parentOtterId: null, createdAt: '', dissolvedAt: null } : null;
      },
    } as unknown as OtterRepository;
    const factory = new PiSessionFactory({
      db,
      sessionDir: ":memory:",
      otterToolClient: {} as never,
      model: null,
      identityPromptDir: REAL_IDENTITY_DIR,
      createTools: () => [],
      otterConfigProvider,
      otterRepo,
    }, mockLogger());
    /** 预注入 SDK mock，跳过动态 import（ensurePiCodingAgent 检测已加载则跳过） */
    (factory as unknown as { piCodingAgent: unknown }).piCodingAgent = makeSdkMock();
    const pending = (factory as unknown as { pendingIdentity: Set<string> }).pendingIdentity;
    return { factory, pending };
  }

  it("create() 标记 pendingIdentity（B1 回归锁：删掉这行标记整个 feature 失效）", async () => {
    const db = makeDb();
    const { factory, pending } = makeRealFactory(db);

    await factory.create("o1", { systemPrompt: undefined, context: { otterType: "big" } } as never);

    expect(pending.has("o1")).toBe(true);
  });

  it("reset() 标记 pendingIdentity", async () => {
    const db = makeDb();
    const { factory, pending } = makeRealFactory(db);

    await factory.reset("o1");

    expect(pending.has("o1")).toBe(true);
  });

  it("destroy() 清理 pendingIdentity", async () => {
    const db = makeDb();
    const { factory, pending } = makeRealFactory(db);
    pending.add("o1");

    await factory.destroy("o1");

    expect(pending.has("o1")).toBe(false);
  });
});
