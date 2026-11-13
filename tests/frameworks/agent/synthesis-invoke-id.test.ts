import { createTestExecutionMachineRegistry } from "../../helpers/execution-machine";
/**
 * M-9b24be04：合成影子通道 invokeId 守卫修复回归。
 *
 * 生产实证（2026-11-10 15:08/15:46）：#1814（R2 读取器）修好后，叙事合成在
 * durable 上仍 100% 失败——`error: "Durable prompt requires currentInvokeId"`。
 * 影子通道（runCompactionSynthesis）不在任何 invoke ALS 作用域内且开会话不带
 * invokeId，被 prompt() 首行的轮归属守卫当场拒绝（#1783 迁移后从未成功过，
 * 上午被读取失败掩盖）。修复：合成会话自带 synthesis-<uuid> 合成 id。
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { DurableSession } from "../../../src/frameworks/agent/durable-session";
import { DurableEventStream } from "../../../src/frameworks/agent/durable-event-stream";
import { createInvokeRegister } from "../../../src/frameworks/agent/tool-builder";
import { PiSessionFactory } from "../../../src/frameworks/agent/pi-session-factory";
import { registerModelSource } from "../../../src/frameworks/agent/durable-model-runtime";
import { SqliteOtterRepository } from "../../../src/frameworks/db/otter/sqlite-otter-repository";
import { SqliteOtterConfigProvider } from "../../../src/frameworks/db/otter/sqlite-otter-config-provider";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import type { Logger } from "../../../src/usecases/ports/logger";
import type { Otter } from "../../../src/entities/otter/otter";

vi.mock("@frameworks/config", () => ({ getConfig: () => ({ circuitBreaker: {} }) }));

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

describe("合成影子通道 invokeId（M-9b24be04）", () => {
  it("守卫回归锁定：无任何 id 来源的 prompt 被拒（守卫不可静默弱化）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-synth-guard-"));
    const faux = fauxProvider({});
    const models = createModels();
    models.setProvider(faux.provider);
    const session = await DurableSession.open({
      executionMachines: createTestExecutionMachineRegistry(),
      otterId: "otter", file: path.join(dir, "s.sqlite"), models, model: faux.getModel(),
      cwd: tmpdir(), logger, register: createInvokeRegister(), context: BACKGROUND_CONTEXT,
      tools: { codingTools: [], customTools: [] }, // 不传 invokeId——影子通道旧形态
    });
    await expect(
      session.prompt("no-id", undefined, new DurableEventStream(), BACKGROUND_CONTEXT),
    ).rejects.toThrow(/Durable prompt requires currentInvokeId/);
    await session.close(BACKGROUND_CONTEXT);
  });

  it("修复回归：runCompactionSynthesis 完成出文而非被守卫拒绝（15:46 生产故障锁定）", async () => {
    const db = createTestDb();
    const sessionDir = mkdtempSync(path.join(tmpdir(), "otter-synth-factory-"));
    const otterId = "fac-synth-otter";
    await new SqliteOtterRepository(db).createOtter(
      { id: otterId, name: "synth", type: "small", status: "active", createdAt: new Date().toISOString() } as unknown as Otter,
    );
    const faux = fauxProvider({});
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("叙事合成结果：前世完成了 X/Y/Z")]);
    // 注入真实 faux 模型目录（生产由 initModels 注册；空目录会 no_model）
    const pool = { getModel: () => faux.getModel(), getDefaultAlias: () => "faux", getThinkingLevel: () => "off" } as never;
    registerModelSource(pool, models);
    const factory = new PiSessionFactory({
      executionMachines: createTestExecutionMachineRegistry(),
      db, sessionDir,
      otterToolClient: {} as never,
      model: faux.getModel() as never,
      modelPool: pool,
      createTools: () => [],
      otterConfigProvider: new SqliteOtterConfigProvider(db),
      otterRepo: new SqliteOtterRepository(db),
    }, createTestLogger());
    await factory.create(otterId, { systemPrompt: "w1" } as never);

    const result = await factory.runCompactionSynthesis(otterId, "请合成前世叙事摘要（测试原料）");
    expect(result.directText).toContain("叙事合成结果");
  });
});
