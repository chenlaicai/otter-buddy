/**
 * M-9af49d4a 换世交接 durable 路径失配——根因修复回归锁。
 *
 * #1783 事故回顾：换世登记 ${otterId}-${uuid}.sqlite 世代文件，而打开路径恒用
 * durableFile(otterId)=plain 库 → 换世只翻账本不换 transcript。三连伤：
 * ①水位循环（上下文不降反复触发交接，40 分钟三连）；②幽灵账本（世代文件从未创建）；
 * ③前世档案恒机械转储（读取前世文件失败）。生产表现：「大獭触发压缩但上下文还是 400k+」。
 *
 * 修复语义（本测试锁死）：
 * - 会话层：resetForGeneration 写 pi.reset + head，模型上下文对前世断崖（同库多世代）；
 * - 工厂层：reset 后账本恒指 plain 库、零世代文件、config 换新、旧 JSONL 账本行归一。
 *
 * 验收线（完整分析第 ⑥ 节）：换世后 pi.reset 存在、head 非空、下一轮模型上下文断崖、
 * 账本与实际打开文件一致、连续多世代不回流。
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";

vi.mock("@frameworks/config", () => ({ getConfig: () => ({ circuitBreaker: {} }) }));
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type Database from "better-sqlite3";
import { DurableSession } from "../../../src/frameworks/agent/durable-session";
import { DurableEventStream } from "../../../src/frameworks/agent/durable-event-stream";
import { createInvokeRegister } from "../../../src/frameworks/agent/tool-builder";
import { PiSessionFactory } from "../../../src/frameworks/agent/pi-session-factory";
import { SqliteOtterRepository } from "../../../src/frameworks/db/otter/sqlite-otter-repository";
import { SqliteOtterConfigProvider } from "../../../src/frameworks/db/otter/sqlite-otter-config-provider";
import { createTestDb } from "../../helpers/db";
import { createCapturingLogger, createTestLogger } from "../../helpers/logger";
import type { Logger } from "../../../src/usecases/ports/logger";
import type { Otter } from "../../../src/entities/otter/otter";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

async function openSession(file: string, responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  const faux = fauxProvider({});
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const session = await DurableSession.open({
    otterId: "otter", file, models, model: faux.getModel(), cwd: tmpdir(), logger,
    register: createInvokeRegister(), invokeId: "invoke-test", context: BACKGROUND_CONTEXT,
    tools: { codingTools: [], customTools: [] },
  });
  return { session, faux };
}

const MARKER_OLD = "marker-alpha-前世内容";
const MARKER_NEW = "marker-beta-新世内容";

describe("会话层：durable 换世代 reset（M-9af49d4a 根因修复）", () => {
  it("reset 写 pi.reset+head，模型上下文对前世断崖、新世内容可见", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-reset-"));
    const { session } = await openSession(path.join(dir, "session.sqlite"), [
      fauxAssistantMessage("answer-alpha"),
      fauxAssistantMessage("answer-beta"),
    ]);
    await session.prompt(MARKER_OLD, undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    expect(JSON.stringify((await session.rawContext(BACKGROUND_CONTEXT)).messages)).toContain(MARKER_OLD);

    await session.resetForGeneration(BACKGROUND_CONTEXT);

    // 守护内建：resetForGeneration 无抛错即「最新 entry=pi.reset 且 head 非空」已校验
    const after = await session.rawContext(BACKGROUND_CONTEXT);
    expect(after.entries.some(e => e.kind === "pi.reset" && e.head != null)).toBe(true);
    expect(JSON.stringify(after.messages)).not.toContain(MARKER_OLD);

    // 新世继续：新 marker 可见，前世 marker 不回流
    await session.prompt(MARKER_NEW, undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    const next = await session.rawContext(BACKGROUND_CONTEXT);
    expect(JSON.stringify(next.messages)).toContain(MARKER_NEW);
    expect(JSON.stringify(next.messages)).not.toContain(MARKER_OLD);
    await session.close(BACKGROUND_CONTEXT);
  });

  it("换世后重开库（冷启动链路）：世代边界持久、前世不回流", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-reset-reopen-"));
    const file = path.join(dir, "session.sqlite");
    const first = await openSession(file, [fauxAssistantMessage("answer-alpha")]);
    await first.session.prompt(MARKER_OLD, undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    await first.session.resetForGeneration(BACKGROUND_CONTEXT);
    await first.session.close(BACKGROUND_CONTEXT);

    // 模拟换世后的下一次 invoke 冷启动：全新进程视角重开同一文件
    const second = await openSession(file, [fauxAssistantMessage("answer-beta")]);
    const view = await second.session.rawContext(BACKGROUND_CONTEXT);
    expect(view.entries.some(e => e.kind === "pi.reset" && e.head != null)).toBe(true);
    expect(JSON.stringify(view.messages)).not.toContain(MARKER_OLD);
    await second.session.prompt(MARKER_NEW, undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    const next = await second.session.rawContext(BACKGROUND_CONTEXT);
    expect(JSON.stringify(next.messages)).toContain(MARKER_NEW);
    expect(JSON.stringify(next.messages)).not.toContain(MARKER_OLD);
    await second.session.close(BACKGROUND_CONTEXT);
  });

  it("连续两代换世（多世代）：上下文只含最新世代", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-reset-multi-"));
    const { session } = await openSession(path.join(dir, "session.sqlite"), [
      fauxAssistantMessage("a1"), fauxAssistantMessage("a2"), fauxAssistantMessage("a3"),
    ]);
    await session.prompt("marker-gen1", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    await session.resetForGeneration(BACKGROUND_CONTEXT);
    await session.prompt("marker-gen2", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    await session.resetForGeneration(BACKGROUND_CONTEXT);
    await session.prompt("marker-gen3", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    const view = await session.rawContext(BACKGROUND_CONTEXT);
    const dump = JSON.stringify(view.messages);
    expect(dump).toContain("marker-gen3");
    expect(dump).not.toContain("marker-gen2");
    expect(dump).not.toContain("marker-gen1");
    // 历史同库可审计：rawContext 只含活动上下文（设计使然），世代边界数直查库验证
    const genDb = new BetterSqlite3(path.join(dir, "session.sqlite"), { readonly: true });
    const resetCount = genDb.prepare("SELECT COUNT(*) n FROM entries WHERE json_extract(record,'$.kind')='pi.reset'").get() as { n: number };
    genDb.close();
    expect(resetCount.n).toBe(2);
    await session.close(BACKGROUND_CONTEXT);
  });
});

describe("工厂层：换世账本与世代文件（M-9af49d4a 回归锁）", () => {
  function buildFactory(db: Database.Database, sessionDir: string, model: unknown) {
    return new PiSessionFactory({
      db,
      sessionDir,
      otterToolClient: {} as never,
      model: model as never,
      createTools: () => [],
      otterConfigProvider: new SqliteOtterConfigProvider(db),
      otterRepo: new SqliteOtterRepository(db),
    }, createTestLogger());
  }

  function makeOtter(id: string): Otter {
    return { id, name: `otter-${id.slice(0, 4)}`, type: "small", status: "active", createdAt: new Date().toISOString() } as unknown as Otter;
  }

  it("reset 后：账本恒指 plain 库、零世代幽灵文件、库内出现 pi.reset 边界、config 换新", async () => {
    const db = createTestDb();
    const sessionDir = mkdtempSync(path.join(tmpdir(), "otter-reset-factory-"));
    const otterId = "fac-reset-otter";
    await new SqliteOtterRepository(db).createOtter(makeOtter(otterId));

    const faux = fauxProvider({});
    const models = createModels();
    models.setProvider(faux.provider);
    const factory = buildFactory(db, sessionDir, faux.getModel());
    await factory.create(otterId, { systemPrompt: "world-1" } as never);

    // 预置一世：直接向 plain durable 库写两轮真实内容再关闭（模拟已有前世）
    const durableFile = path.join(sessionDir, `${otterId}.sqlite`);
    const seeded = await openSession(durableFile, [fauxAssistantMessage("seed-answer")]);
    await seeded.session.prompt(MARKER_OLD, undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    await seeded.session.close(BACKGROUND_CONTEXT);
    expect(existsSync(durableFile)).toBe(true);

    // 换世（normal 渠道，走锁路径 → _resetInternal 全链）
    await factory.reset(otterId, { systemPrompt: "world-2" } as never);

    // ① 账本恒指 plain 库，绝无 ${otterId}-${uuid} 双 UUID 世代文件（幽灵账本根除）
    const row = db.prepare("SELECT session_file FROM agent_sessions WHERE otter_id = ?").get(otterId) as { session_file: string };
    expect(row.session_file).toBe(durableFile);
    const ghosts = readdirSync(sessionDir).filter(f => f.startsWith(`${otterId}-`) && f.endsWith(".sqlite"));
    expect(ghosts).toEqual([]);

    // ② plain 库内出现 pi.reset 世代边界，前世 marker 不再进入模型上下文
    const verify = await openSession(durableFile, [fauxAssistantMessage("verify-answer")]);
    const view = await verify.session.rawContext(BACKGROUND_CONTEXT);
    expect(view.entries.some(e => e.kind === "pi.reset" && e.head != null)).toBe(true);
    expect(JSON.stringify(view.messages)).not.toContain(MARKER_OLD);
    await verify.session.close(BACKGROUND_CONTEXT);

    // ③ config 换新（换世附带 systemPrompt 更新语义保留）
    const configRow = db.prepare("SELECT system_prompt FROM otter_configs WHERE otter_id = ?").get(otterId) as { system_prompt: string };
    expect(configRow.system_prompt).toContain("world-2");
  });

  it("旧 JSONL 账本行在换世时归一到 plain durable 路径（存量账本自愈）", async () => {
    const db = createTestDb();
    const sessionDir = mkdtempSync(path.join(tmpdir(), "otter-reset-legacy-"));
    const otterId = "fac-legacy-otter";
    await new SqliteOtterRepository(db).createOtter(makeOtter(otterId));

    const faux = fauxProvider({});
    const models = createModels();
    models.setProvider(faux.provider);
    const factory = buildFactory(db, sessionDir, faux.getModel());
    await factory.create(otterId, { systemPrompt: "world-1" } as never);

    // 预置旧世界账本行（指向 jsonl——#1783 前的存量形态）
    const legacyJsonl = path.join(sessionDir, "legacy.jsonl");
    writeFileSync(legacyJsonl, "");
    db.prepare("UPDATE agent_sessions SET session_file = ? WHERE otter_id = ?").run(legacyJsonl, otterId);

    await factory.reset(otterId, undefined as never);

    const row = db.prepare("SELECT session_file FROM agent_sessions WHERE otter_id = ?").get(otterId) as { session_file: string };
    expect(row.session_file).toBe(path.join(sessionDir, `${otterId}.sqlite`));
    // 日志锚点：世代替换事件带 in-file reset 标记（观测口径）
    expect(existsSync(row.session_file)).toBe(true);
  });

  it("handoff 渠道：池内活句柄优先复用（零冷开），出池且 reset 生效（审视严重 1 回归锁）", async () => {
    const db = createTestDb();
    const sessionDir = mkdtempSync(path.join(tmpdir(), "otter-reset-handoff-"));
    const otterId = "fac-handoff-otter";
    await new SqliteOtterRepository(db).createOtter(makeOtter(otterId));

    const faux = fauxProvider({});
    const models = createModels();
    models.setProvider(faux.provider);
    const capturing = createCapturingLogger();
    const factory = new PiSessionFactory({
      db, sessionDir,
      otterToolClient: {} as never,
      model: faux.getModel() as never,
      createTools: () => [],
      otterConfigProvider: new SqliteOtterConfigProvider(db),
      otterRepo: new SqliteOtterRepository(db),
    }, capturing);
    await factory.create(otterId, { systemPrompt: "w1" } as never);

    // 预置一世内容 + 活句柄入池（模拟 invoke 池命中态）
    const durableFile = path.join(sessionDir, `${otterId}.sqlite`);
    const seeded = await openSession(durableFile, [fauxAssistantMessage("seed-a")]);
    await seeded.session.prompt(MARKER_OLD, undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    const internals = factory as unknown as {
      poolMeta: Map<string, unknown>;
    };
    internals.poolMeta.set(otterId, { session: seeded.session, register: createInvokeRegister(), toolContext: {} });

    await factory.reset(otterId, undefined as never, "handoff");

    // 活句柄路径：零冷开（reset-only open 日志为 0）
    expect(capturing.captured.infos.filter(m => m === "durable reset-only session opened").length).toBe(0);
    // 出池完成
    expect(internals.poolMeta.has(otterId)).toBe(false);
    // reset 生效：pi.reset 边界 + 前世 marker 断崖
    const view = await seeded.session.rawContext(BACKGROUND_CONTEXT);
    expect(view.entries.some(e => e.kind === "pi.reset" && e.head != null)).toBe(true);
    expect(JSON.stringify(view.messages)).not.toContain(MARKER_OLD);
    await seeded.session.close(BACKGROUND_CONTEXT);
  });

  it("流中守护：孤儿活句柄 streaming 时换世响亮拒绝，不冷开不翻账本（审视严重 1 扩面）", async () => {
    const db = createTestDb();
    const sessionDir = mkdtempSync(path.join(tmpdir(), "otter-reset-stream-"));
    const otterId = "fac-stream-otter";
    await new SqliteOtterRepository(db).createOtter(makeOtter(otterId));

    const faux = fauxProvider({});
    const models = createModels();
    models.setProvider(faux.provider);
    const capturing = createCapturingLogger();
    const factory = new PiSessionFactory({
      db, sessionDir,
      otterToolClient: {} as never,
      model: faux.getModel() as never,
      createTools: () => [],
      otterConfigProvider: new SqliteOtterConfigProvider(db),
      otterRepo: new SqliteOtterRepository(db),
    }, capturing);
    await factory.create(otterId, { systemPrompt: "w1" } as never);

    const internals = factory as unknown as {
      activeSessions: Map<string, unknown>;
    };
    internals.activeSessions.set(`${otterId}:msg-1`, { isStreaming: true });

    await expect(factory.reset(otterId, undefined as never, "handoff")).rejects.toThrow(/refused while session running/);
    // 守护先于一切：无 reset-only 冷开（库文件未创建）、无世代替换日志、账本未翻
    expect(capturing.captured.infos.filter(m => m === "durable reset-only session opened").length).toBe(0);
    expect(capturing.captured.infos.some(m => m.includes("generation replaced"))).toBe(false);
    expect(existsSync(path.join(sessionDir, `${otterId}.sqlite`))).toBe(false);
    const ledgerRow = db.prepare("SELECT session_file FROM agent_sessions WHERE otter_id = ?").get(otterId) as { session_file: string };
    expect(ledgerRow.session_file).toBe(path.join(sessionDir, `${otterId}.sqlite`));
  });
});
