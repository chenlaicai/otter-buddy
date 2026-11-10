/**
 * M-9af49d4a R2 回归：durable 会话 entries 只读投影（换世档案合成原料修复）。
 *
 * #1783 迁移欠账：前世对话住进 durable sqlite 后，JSONL 读取器拿不到原料 →
 * 换世档案 100% 机械转储（「前世 session 文件读取失败」）。本测试锁死：
 * ① 投影形状满足 session-slicer 消费面（type/id/parentId/timestamp/message）；
 * ② 世代边界（reset 后只含当前世代）；③ 真空/缺失语义（[] vs undefined）；
 * ④ 切片器端到端（keptEntries 含前世 speak 原文）；⑤ 工厂 durable 分支接线。
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import Database from "better-sqlite3";
import { DurableSession } from "../../../src/frameworks/agent/durable-session";
import { DurableEventStream } from "../../../src/frameworks/agent/durable-event-stream";
import { createInvokeRegister } from "../../../src/frameworks/agent/tool-builder";
import { readDurableActiveSessionEntries } from "../../../src/frameworks/agent/durable-slice-source";
import { sliceSessionEntries } from "../../../src/frameworks/agent/session-slicer";
import { PiSessionFactory } from "../../../src/frameworks/agent/pi-session-factory";
import { SqliteOtterRepository } from "../../../src/frameworks/db/otter/sqlite-otter-repository";
import { SqliteOtterConfigProvider } from "../../../src/frameworks/db/otter/sqlite-otter-config-provider";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import type { Logger } from "../../../src/usecases/ports/logger";
import type { Otter } from "../../../src/entities/otter/otter";

vi.mock("@frameworks/config", () => ({ getConfig: () => ({ circuitBreaker: {} }) }));

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

describe("durable-slice-source：只读投影（R2）", () => {
  it("投影真实 durable 会话：形状/顺序/时间戳单调，满足 slicer 消费面", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-slice-"));
    const file = path.join(dir, "session.sqlite");
    const { session } = await openSession(file, [
      fauxAssistantMessage("answer-one"),
      fauxAssistantMessage("answer-two"),
    ]);
    await session.prompt("question-one 原料标记", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    await session.close(BACKGROUND_CONTEXT);

    const entries = readDurableActiveSessionEntries(file);
    expect(entries).toBeDefined();
    const msgs = entries!.filter(e => e.type === "message") as unknown as Array<{ id: string; parentId: string | null; timestamp: string; message: { role: string; content: unknown } }>;
    expect(msgs.length).toBeGreaterThanOrEqual(3); // ≥ user + assistant（faux 单轮无工具）
    expect(JSON.stringify(msgs.find(m => m.message.role === "user")?.message.content)).toContain("question-one 原料标记");
    // parentId 链式 + 时间戳单调
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i].parentId).toBe(msgs[i - 1].id);
      expect(msgs[i].timestamp > msgs[i - 1].timestamp).toBe(true);
    }
  });

  it("世代边界：reset 后只投影当前世代（前世不混入合成原料）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-slice-gen-"));
    const file = path.join(dir, "session.sqlite");
    const { session } = await openSession(file, [fauxAssistantMessage("old-a"), fauxAssistantMessage("new-a")]);
    await session.prompt("前世标记-gen1", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    await session.resetForGeneration(BACKGROUND_CONTEXT);
    await session.prompt("新世标记-gen2", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    await session.close(BACKGROUND_CONTEXT);

    const entries = readDurableActiveSessionEntries(file);
    const dump = JSON.stringify(entries);
    expect(dump).toContain("新世标记-gen2");
    expect(dump).not.toContain("前世标记-gen1");
  });

  it("真空/缺失语义：无库文件=undefined，空库=[]（降级归因依赖此区分）", async () => {
    expect(readDurableActiveSessionEntries(path.join(tmpdir(), "no-such", "x.sqlite"))).toBeUndefined();
    const dir = await mkdtemp(path.join(tmpdir(), "otter-slice-empty-"));
    const file = path.join(dir, "session.sqlite");
    const { session } = await openSession(file, []);
    await session.close(BACKGROUND_CONTEXT);
    expect(readDurableActiveSessionEntries(file)).toEqual([]);
  });

  it("pi.compaction → compaction entry（跨代谱系种子）+ head 边界生效", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-slice-compaction-"));
    const file = path.join(dir, "session.sqlite");
    const { session } = await openSession(file, [fauxAssistantMessage("pre-summary-turn")]);
    await session.prompt("被压缩的旧内容", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    await session.close(BACKGROUND_CONTEXT);

    // 直接注入一条合成 compaction 边界（真实压缩走 LLM 任务，形状以 entries.d.ts 为准）
    const db = new Database(file);
    const maxRow = db.prepare("SELECT MAX(id) m FROM entries").get() as { m: number };
    const compactionId = (maxRow.m ?? 0) + 1;
    db.prepare("INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, 1, ?, ?, ?)").run(
      compactionId, compactionId, compactionId * 10,
      JSON.stringify({ id: compactionId, kind: "pi.compaction", model: [{ role: "user", content: "【压缩摘要】前世干了 X 和 Y" }], head: compactionId }),
    );
    db.close();

    const entries = readDurableActiveSessionEntries(file);
    const dump = JSON.stringify(entries);
    expect(dump).not.toContain("被压缩的旧内容"); // head 边界：压缩点之前不进原料
    const compaction = entries!.find(e => e.type === "compaction") as { summary?: string };
    expect(compaction?.summary).toContain("前世干了 X 和 Y");
  });

  it("切片器端到端：投影原料 → keptEntries 含前世 speak 原文", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-slice-e2e-"));
    const file = path.join(dir, "session.sqlite");
    const { session } = await openSession(file, [fauxAssistantMessage("前世最终发言：delta 确认通过")]);
    await session.prompt("最后一问", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    await session.close(BACKGROUND_CONTEXT);

    const projected = readDurableActiveSessionEntries(file)!;
    const slice = sliceSessionEntries(projected as never);
    expect(slice).toBeDefined();
    expect(slice!.keptEntries.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(slice!.keptEntries)).toContain("前世最终发言：delta 确认通过");
  });
});

describe("工厂接线：readCurrentSessionEntries durable 分支（R2）", () => {
  function makeOtter(id: string): Otter {
    return { id, name: `otter-${id.slice(0, 4)}`, type: "small", status: "active", createdAt: new Date().toISOString() } as unknown as Otter;
  }

  it("账本指向 durable 库时返回投影原料（机械转储根因消除）", async () => {
    const db = createTestDb();
    const sessionDir = mkdtempSync(path.join(tmpdir(), "otter-slice-factory-"));
    const otterId = "fac-slice-otter";
    await new SqliteOtterRepository(db).createOtter(makeOtter(otterId));

    const faux = fauxProvider({});
    const models = createModels();
    models.setProvider(faux.provider);
    const factory = new PiSessionFactory({
      db, sessionDir,
      otterToolClient: {} as never,
      model: faux.getModel() as never,
      createTools: () => [],
      otterConfigProvider: new SqliteOtterConfigProvider(db),
      otterRepo: new SqliteOtterRepository(db),
    }, createTestLogger());
    await factory.create(otterId, { systemPrompt: "w1" } as never);

    const durableFile = path.join(sessionDir, `${otterId}.sqlite`);
    const seeded = await openSession(durableFile, [fauxAssistantMessage("slice-answer")]);
    await seeded.session.prompt("工厂分支原料标记", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    await seeded.session.close(BACKGROUND_CONTEXT);
    expect(existsSync(durableFile)).toBe(true);

    const entries = await factory.readCurrentSessionEntries(otterId);
    expect(entries).toBeDefined();
    expect(JSON.stringify(entries)).toContain("工厂分支原料标记");
  });

  it("无库无账本的獭返回 undefined（降级归因保持，不误报真空）", async () => {
    const db = createTestDb();
    const sessionDir = mkdtempSync(path.join(tmpdir(), "otter-slice-nofile-"));
    const otterId = "fac-nofile-otter";
    await new SqliteOtterRepository(db).createOtter(makeOtter(otterId));
    const faux = fauxProvider({});
    const models = createModels();
    models.setProvider(faux.provider);
    const factory = new PiSessionFactory({
      db, sessionDir,
      otterToolClient: {} as never,
      model: faux.getModel() as never,
      createTools: () => [],
      otterConfigProvider: new SqliteOtterConfigProvider(db),
      otterRepo: new SqliteOtterRepository(db),
    }, createTestLogger());
    await factory.create(otterId, { systemPrompt: "w1" } as never);

    expect(await factory.readCurrentSessionEntries(otterId)).toBeUndefined();
    void models;
  });
});
