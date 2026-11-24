import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import { SqliteOtterConfigProvider } from "@frameworks/db/otter/sqlite-otter-config-provider";
import { initModels } from "@frameworks/llm/models-factory";
import type { Otter } from "@entities/otter/otter";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import { createTestExecutionMachineRegistry } from "../../helpers/execution-machine";
import { RecordingGateway, type ScriptedReply } from "../../capability/helpers/model-visible";

vi.mock("@frameworks/config", () => ({ getConfig: () => ({ circuitBreaker: {}, contextQuality: {} }) }));
vi.setConfig({ testTimeout: 20_000 });

const SYSTEM_FILE = path.join(".pi", "SYSTEM.md");
const SKILL_FILE = path.join(".pi", "skills", "wire-demo", "SKILL.md");

interface Fixture {
  factory: PiSessionFactory;
  gateway: RecordingGateway;
  config: SqliteOtterConfigProvider;
  resourceLoader: DefaultResourceLoader;
  db: ReturnType<typeof createTestDb>;
  root: string;
  invoke(otterId: string, message: string, options?: Record<string, unknown>): Promise<unknown>;
  cleanup(): Promise<void>;
}

async function fixture(options: { missingIdentity?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "otter-prompt-wire-"));
  const gateway = await RecordingGateway.start();
  const db = createTestDb();
  const logger = createTestLogger();
  const { model, modelPool } = await initModels({
    default: "wire",
    models: [{
      alias: "wire", provider: "anthropic", model: "wire-1", apiKey: "wire-key",
      apiBaseUrl: gateway.url, contextWindow: 200_000, maxTokens: 1024,
      handoffThresholdTokens: 150_000,
    }],
  } as never, logger);
  await mkdir(path.dirname(path.join(root, SYSTEM_FILE)), { recursive: true });
  await mkdir(path.dirname(path.join(root, SKILL_FILE)), { recursive: true });
  await writeFile(path.join(root, SYSTEM_FILE), "SYSTEM_V1\n平台规则完整可见。");
  await writeFile(path.join(root, SKILL_FILE), "---\nname: wire-demo\ndescription: SKILL_V1\n---\n正文懒读。\n");
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir: path.join(root, "agent"), noContextFiles: true,
    noExtensions: true, noPromptTemplates: true, noThemes: true,
  });
  const config = new SqliteOtterConfigProvider(db);
  const factory = new PiSessionFactory({
    db, sessionDir: path.join(root, "sessions"), dataDir: path.join(root, "data"),
    otterToolClient: {} as never, model, modelPool, resourceLoader,
    identityPromptDir: options.missingIdentity ? path.join(root, "missing-identity") : path.resolve("prompts/identity"),
    promptAssetRoot: root,
    createTools: () => [], executionMachines: createTestExecutionMachineRegistry(),
    otterConfigProvider: config, otterRepo: new SqliteOtterRepository(db),
  }, logger);
  await factory.warmup();
  let invokeSeq = 0;
  return {
    factory, gateway, config, resourceLoader, db, root,
    invoke: (otterId, message, options = {}) => factory.invoke(otterId, message, {
      conversationId: "conversation-a", currentInvokeId: `invoke-${++invokeSeq}`,
      messageId: `message-${invokeSeq}`, ...options,
    }),
    cleanup: async () => {
      (factory as unknown as { pool: { disposeAll(): void } }).pool.disposeAll();
      db.close();
      await gateway.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function createOtter(f: Fixture, id: string, type: "big" | "small", systemPrompt?: string): Promise<void> {
  const otter: Otter = {
    id, name: `wire-${id}`, type, status: "active", color: null, role: null,
    parentOtterId: null, createdAt: new Date().toISOString(), dissolvedAt: null,
  };
  await new SqliteOtterRepository(f.db).createOtter(otter);
  await f.factory.create(id, { systemPrompt, context: { otterType: type } });
}

function queue(f: Fixture, count: number): void {
  f.gateway.queue(Array.from({ length: count }, (): ScriptedReply => ({ text: "ok" })));
}

function systemAt(f: Fixture, index: number): string {
  return JSON.stringify((f.gateway.requests[index] as { system?: unknown }).system ?? "");
}

const active: Fixture[] = [];
afterEach(async () => {
  await Promise.all(active.splice(0).map(f => f.cleanup()));
});

async function start(options: { missingIdentity?: boolean } = {}): Promise<Fixture> {
  const f = await fixture(options);
  active.push(f);
  return f;
}

describe("PromptComposer 真实 Durable 首个 model request", () => {
  it("cold 与 pool 每轮重编译 SYSTEM/身份/Skill/任务，资产更新下一 invoke 生效", async () => {
    const f = await start();
    queue(f, 2);
    await createOtter(f, "small", "small", "TASK_V1");

    await f.invoke("small", "cold-message", { conversationId: "conversation-a" });
    await writeFile(path.join(f.root, SYSTEM_FILE), "SYSTEM_V2\n平台新规则。");
    await writeFile(path.join(f.root, SKILL_FILE), "---\nname: wire-demo\ndescription: SKILL_V2\n---\n正文仍懒读。\n");
    f.config.setConfig("small", { otterType: "small", systemPrompt: "TASK_V2" });
    await f.invoke("small", "pool-message", { conversationId: "conversation-b" });

    const cold = systemAt(f, 0);
    expect(cold).toContain("SYSTEM_V1");
    expect(cold).toContain("wire-small");
    expect(cold).toContain("SKILL_V1");
    expect(cold).toContain("wire-demo");
    expect(cold).toContain("TASK_V1");
    expect(cold).toContain("conversation-a");

    const pooled = systemAt(f, 1);
    expect(pooled).toContain("SYSTEM_V2");
    expect(pooled).not.toContain("SYSTEM_V1");
    expect(pooled).toContain("SKILL_V2");
    expect(pooled).not.toContain("SKILL_V1");
    expect(pooled).toContain("TASK_V2");
    expect(pooled).not.toContain("TASK_V1");
    expect(pooled).toContain("conversation-b");
    expect(JSON.stringify((f.gateway.requests[1] as { messages?: unknown }).messages)).toContain("cold-message");
  });

  it("restart 后存量空 system_prompt 主獭仍有完整内部段，且不回填配置", async () => {
    const f = await start();
    queue(f, 2);
    await createOtter(f, "big", "big");
    await f.invoke("big", "before-restart");
    expect(systemAt(f, 0)).toContain("SYSTEM_V1");
    expect(systemAt(f, 0)).toContain("wire-big");
    expect(systemAt(f, 0)).toContain("SKILL_V1");
    await f.factory.reset("big");
    await f.invoke("big", "after-restart");

    const restarted = systemAt(f, 1);
    expect(restarted).toContain("SYSTEM_V1");
    expect(restarted).toContain("wire-big");
    expect(restarted).toContain("大獭");
    expect(restarted).toContain("SKILL_V1");
    expect(f.config.getConfig("big")?.systemPrompt).toBeUndefined();
  });

  it("readOnly 首个请求保持完整知识装配，SYSTEM 读取失败在 submit 前响亮阻断", async () => {
    const f = await start();
    queue(f, 1);
    await createOtter(f, "small", "small", "READONLY_TASK");
    await f.invoke("small", "readonly-message", { readOnly: true });

    const readOnly = systemAt(f, 0);
    expect(readOnly).toContain("SYSTEM_V1");
    expect(readOnly).toContain("wire-small");
    expect(readOnly).toContain("SKILL_V1");
    expect(readOnly).toContain("READONLY_TASK");

    await rm(path.join(f.root, SYSTEM_FILE));
    await expect(f.invoke("small", "must-not-submit", { readOnly: true })).rejects.toThrow(/SYSTEM\.md/);
    expect(f.gateway.requests).toHaveLength(1);
    expect(f.factory.isRunning("small")).toBe(false);
  });

  it("readOnly 必需身份资产缺失同样零 submit", async () => {
    const f = await start({ missingIdentity: true });
    await createOtter(f, "big", "big");
    await expect(f.invoke("big", "missing-identity", { readOnly: true })).rejects.toThrow(/BIG_OTTER\.md/);
    expect(f.gateway.requests).toHaveLength(0);
    expect(f.factory.isRunning("big")).toBe(false);
  });

  it("合法空 Skill 集可执行，Skill 清单读取失败则零 submit", async () => {
    const f = await start();
    queue(f, 1);
    await rm(path.join(f.root, SKILL_FILE));
    await createOtter(f, "small", "small", "EMPTY_SKILLS_TASK");
    await f.invoke("small", "empty-skills", { readOnly: true });
    expect(systemAt(f, 0)).toContain("SYSTEM_V1");
    expect(systemAt(f, 0)).toContain("EMPTY_SKILLS_TASK");
    expect(systemAt(f, 0)).not.toContain("<available_skills>");

    vi.spyOn(f.resourceLoader, "reload").mockRejectedValueOnce(new Error("skill disk failure"));
    await expect(f.invoke("small", "skill-failure")).rejects.toThrow(/Skill index/);
    expect(f.gateway.requests).toHaveLength(1);
    expect(f.factory.isRunning("small")).toBe(false);
  });

  it("restricted 只用 externalTaskConfig 与安全最简面，内部资产故障也不影响分区请求", async () => {
    const f = await start();
    queue(f, 3);
    await createOtter(f, "big", "big", "INTERNAL_TASK_SECRET");

    await f.invoke("big", "external-message", {
      conversationId: "external-conversation", externalProfile: "restricted",
      externalTaskConfig: {
        instructions: "PUBLIC_TASK",
        reminders: [{ content: "PUBLIC_REMINDER", priority: "high" }],
      },
    });
    const restricted = systemAt(f, 0);
    expect(restricted).toContain("PUBLIC_TASK");
    expect(restricted).toContain("PUBLIC_REMINDER");
    expect(restricted).toContain("当前外部会话的助理");
    expect(restricted).toContain("受限外部会话安全边界");
    expect(restricted).not.toContain("SYSTEM_V1");
    expect(restricted).not.toContain("SKILL_V1");
    expect(restricted).not.toContain("INTERNAL_TASK_SECRET");
    expect(restricted).not.toContain("wire-big");
    expect(restricted).not.toContain("github.com/chenlaicai");

    await f.invoke("big", "external-default", {
      conversationId: "external-conversation", externalProfile: "restricted",
    });
    const safeDefault = systemAt(f, 1);
    expect(safeDefault).toContain("当前外部会话的助理");
    expect(safeDefault).toContain("受限外部会话安全边界");
    expect(safeDefault).not.toContain("PUBLIC_TASK");
    expect(safeDefault).not.toContain("INTERNAL_TASK_SECRET");

    await rm(path.join(f.root, SYSTEM_FILE));
    vi.spyOn(f.resourceLoader, "reload").mockRejectedValue(new Error("internal Skill store unavailable"));
    await f.invoke("big", "external-assets-down", {
      conversationId: "external-conversation", externalProfile: "restricted",
      externalTaskConfig: { instructions: "PUBLIC_STILL_WORKS" },
    });
    expect(systemAt(f, 2)).toContain("PUBLIC_STILL_WORKS");
    expect(f.gateway.requests).toHaveLength(3);
  });
});
