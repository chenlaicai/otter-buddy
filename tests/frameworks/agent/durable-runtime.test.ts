import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { DurableSession } from "../../../src/frameworks/agent/durable-session";
import { DurableMcpBridge } from "../../../src/frameworks/agent/durable-mcp";
import { DurableEventStream } from "../../../src/frameworks/agent/durable-event-stream";
import { createInvokeRegister } from "../../../src/frameworks/agent/tool-builder";
import type { Logger } from "../../../src/usecases/ports/logger";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

async function open(file: string, responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0], execute: (id: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean; terminate?: boolean }> = async () => ({ content: [{ type: "text" as const, text: "tool-ok" }], details: {} })) {
  const faux = fauxProvider({});
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const session = await DurableSession.open({
    otterId: "otter", file, models, model: faux.getModel(), cwd: tmpdir(), logger,
    register: createInvokeRegister(), invokeId: "invoke-test", context: BACKGROUND_CONTEXT,
    tools: { codingTools: [], customTools: [{ name: "side_effect", label: "test", description: "test", parameters: { type: "object", properties: {} }, execute }] },
  });
  return { session, faux };
}

describe("durable-native runtime", () => {
  it("runs real custom tools and maps terminal text/usage through public watch", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-durable-"));
    let calls = 0;
    const { session } = await open(path.join(dir, "session.sqlite"), [
      fauxAssistantMessage([fauxText("before"), fauxToolCall("side_effect", { value: 1 }, { id: "call-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("after"),
    ], async () => { calls++; return { content: [{ type: "text", text: "tool-ok" }], details: {} }; });
    const events: Array<{ type?: string }> = [];
    const stream = new DurableEventStream(event => events.push(event));
    await session.prompt("do the work", undefined, stream, BACKGROUND_CONTEXT);
    expect(calls).toBe(1);
    expect(session.turnText).toBe("after");
    expect(events.map(e => e.type)).toContain("tool_execution_start");
    expect(events.map(e => e.type)).toContain("tool_execution_end");
    expect(session.tokenUsage.output).toBeGreaterThan(0);
    await session.close(BACKGROUND_CONTEXT);
  });

  it("keeps isError and terminate on the native tool result control", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-durable-"));
    let calls = 0;
    const { session, faux } = await open(path.join(dir, "session.sqlite"), [
      fauxAssistantMessage(fauxToolCall("side_effect", {}, { id: "call-error" }), { stopReason: "toolUse" }),
    ], async () => { calls++; return { content: [{ type: "text", text: "no" }], details: {}, isError: true, terminate: true }; });
    await session.prompt("stop", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    expect(calls).toBe(1);
    expect(faux.state.callCount).toBe(1);
    const ctx = await session.rawContext(BACKGROUND_CONTEXT);
    expect(ctx.entries.some(entry => entry.kind === "pi.tool-result" && entry.model?.[0].role === "toolResult" && entry.model[0].isError)).toBe(true);
    await session.close(BACKGROUND_CONTEXT);
  });

  it("reopens the durable transcript without running the unsafe tool again", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-durable-"));
    const file = path.join(dir, "session.sqlite");
    let calls = 0;
    const execute = async () => { calls++; return { content: [{ type: "text" as const, text: "done" }], details: {} }; };
    const first = await open(file, [fauxAssistantMessage(fauxToolCall("side_effect", {}, { id: "persisted-call" }), { stopReason: "toolUse" }), fauxAssistantMessage("persisted")], execute);
    await first.session.prompt("persist", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    await first.session.close(BACKGROUND_CONTEXT);
    const second = await open(file, [fauxAssistantMessage("resumed")], execute);
    const ctx = await second.session.rawContext(BACKGROUND_CONTEXT);
    expect(ctx.entries.some(entry => entry.kind === "pi.tool-result")).toBe(true);
    expect(calls).toBe(1);
    await second.session.close(BACKGROUND_CONTEXT);
  });

  // 搭档定调（2026-11-06）：单主人保证归运行环境（部署层单实例），海獭不做锁。
  // 原「rejects a second owner for the same durable store」用例随 proper-lockfile
  // 机制一并移除——它测的是被删除的拒绝行为。

  it("aborts a running tool and keeps the checkpoint readable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-durable-"));
    let started = false;
    let aborted = false;
    const { session } = await open(path.join(dir, "session.sqlite"), [
      fauxAssistantMessage(fauxToolCall("side_effect", {}, { id: "abort-call" }), { stopReason: "toolUse" }),
    ], async (_id, _args, signal) => {
      started = true;
      await new Promise<void>((resolve) => { signal?.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }); });
      return { content: [{ type: "text", text: "aborted" }], details: {} };
    });
    const pending = session.prompt("cancel", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    for (let i = 0; i < 100 && !started; i++) await new Promise(resolve => setTimeout(resolve, 5));
    await session.abort(BACKGROUND_CONTEXT);
    await expect(pending).rejects.toThrow();
    expect(aborted).toBe(true);
    await session.close(BACKGROUND_CONTEXT);
  });

  it("accepts steer/followUp while a run is active", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-durable-"));
    let first = true;
    const { session, faux } = await open(path.join(dir, "session.sqlite"), [
      async () => { if (first) { first = false; await new Promise(resolve => setTimeout(resolve, 100)); } return fauxAssistantMessage("first"); },
      fauxAssistantMessage("second"),
    ]);
    const pending = session.prompt("start", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    for (let i = 0; i < 100 && !session.isStreaming; i++) await new Promise(resolve => setTimeout(resolve, 5));
    await session.steer("change direction", BACKGROUND_CONTEXT);
    await session.followUp("next task", BACKGROUND_CONTEXT);
    await pending;
    expect(faux.state.callCount).toBeGreaterThanOrEqual(1);
    await session.close(BACKGROUND_CONTEXT);
  });

  it("bridges a real stdio MCP server into durable tools", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-durable-mcp-"));
    const server = path.join(dir, "server.mjs");
    await (await import("node:fs/promises")).writeFile(server, `
      let buffer=''; process.stdin.on('data', chunk => { buffer += chunk.toString(); let i; while((i=buffer.indexOf('\\n'))>=0){ const line=buffer.slice(0,i); buffer=buffer.slice(i+1); if(!line.trim())continue; const m=JSON.parse(line); if(m.id===undefined)continue; if(m.method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}}})); else if(m.method==='tools/list') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'echo',description:'echo',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}})); else if(m.method==='tools/call') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'echo:'+m.params.arguments.text}]}})); } });
    `);
    const bridge = new DurableMcpBridge([{ name: "fake", config: { command: process.execPath, args: [server] }, scope: "global", source: server }], dir, logger);
    const tools = await bridge.registrations();
    expect(tools.map(t => t.name)).toContain("mcp__fake__echo");
    const result = await tools.find(t => t.name === "mcp__fake__echo")!.execute({ text: "ok" }, { callId: "mcp-1" } as never, BACKGROUND_CONTEXT);
    expect(result.output).toEqual([{ type: "text", text: "echo:ok" }]);
    await bridge.close();
  });

  it("retries a transient provider failure and compacts through the public harness", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-durable-"));
    let attempts = 0;
    const { session } = await open(path.join(dir, "session.sqlite"), [
      () => { attempts++; return fauxAssistantMessage("temporary provider failure", { stopReason: "error", errorMessage: "server error 503" }); },
      fauxAssistantMessage("recovered"),
      fauxAssistantMessage("summary"),
    ]);
    await session.prompt("retry", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    expect(attempts).toBe(1);
    await session.compact("Summarize this conversation");
    expect((await session.inspect(BACKGROUND_CONTEXT)).tasks.every(item => item.record.state.status === "terminal")).toBe(true);
    const context = await session.rawContext(BACKGROUND_CONTEXT);
    expect(context.entries.length).toBeGreaterThan(0);
    expect((await session.inspect(BACKGROUND_CONTEXT)).submissions.every(item => item.status === "done" || item.status === "unanswered")).toBe(true);
    await session.close(BACKGROUND_CONTEXT);
  });

  it("reopens after a real process SIGKILL without replaying the unsafe tool", { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-durable-crash-"));
    const file = path.join(dir, "session.sqlite");
    const child = spawn(process.execPath, [path.resolve("tests/fixtures/durable-crash-child.mjs"), file], { cwd: path.resolve("."), stdio: "ignore" });
    for (let i = 0; i < 200; i++) {
      if (await (await import("node:fs/promises")).stat(`${file}.tool-started`).then(() => true).catch(() => false)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    child.kill("SIGKILL");
    await new Promise(resolve => child.once("exit", resolve));
    let reopened: Awaited<ReturnType<typeof open>> | undefined;
    for (let i = 0; i < 150; i++) {
      try { reopened = await open(file, [fauxAssistantMessage("recovered")]); break; }
      catch (error) { if ((error as { code?: string }).code !== "ELOCKED") throw error; if (i === 149) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (!reopened) {
      const { stat } = await import("node:fs/promises");
      const lock = await stat(`${file}.lock`).catch(() => undefined);
      throw new Error(`durable store did not recover after process death: lock=${lock ? lock.mtime.toISOString() : "none"}`);
    }
    const calls = await (await import("node:fs/promises")).readFile(`${file}.calls`, "utf8");
    // 检视处置（PR #1783 严亟 2）：原 split("\\n")（字面反斜杠+n）对 1/2 次执行均返回长度 1，
    // 断言零判别力——改为按非空行计数，若 unsafe 工具真被重放则必红。
    expect(calls.split("\n").filter(line => line.trim().length > 0)).toHaveLength(1);
    expect((await reopened.session.rawContext(BACKGROUND_CONTEXT)).entries.length).toBeGreaterThan(0);
    await reopened.session.close(BACKGROUND_CONTEXT);
  });

  it("rejects a side-effect tool without an invoke owner", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-durable-"));
    const { session } = await open(path.join(dir, "session.sqlite"), [fauxAssistantMessage("x")]);
    session.updateOptions({ currentInvokeId: undefined });
    await expect(session.prompt("no owner", undefined, new DurableEventStream(), BACKGROUND_CONTEXT)).rejects.toThrow(/currentInvokeId/);
    await session.close(BACKGROUND_CONTEXT);
  });

  it("restores the tool-execution watchdog: maxPerEventTimeMs aborts a hung tool (PR #1783 严亟 1 回归)", { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-durable-watchdog-"));
    let cancelled = false;
    const { session } = await open(path.join(dir, "session.sqlite"), [
      fauxAssistantMessage(fauxToolCall("side_effect", {}, { id: "hang-call" }), { stopReason: "toolUse" }),
    ], async (_id, _args, signal) => {
      // 挂起但可被取消（真实工具形态：await IO，abort 即退）；永不 resolve 且不听 signal 的
      // promise 在任何 JS runtime 都不可强杀（旧 SDK 同理），不足看门狗契约面。
      await new Promise<void>(resolve => { signal?.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }); });
      return { content: [{ type: "text" as const, text: "cancelled" }], details: {} };
    });
    const events: Array<{ type?: string }> = [];
    const stream = new DurableEventStream(event => events.push(event));
    const { attachCircuitBreaker } = await import("../../../src/frameworks/agent/circuit-breaker-helpers");
    const activeEntry = { abort: async () => { await session.abort(BACKGROUND_CONTEXT); }, toolCallCount: 0, guardAbortReason: undefined as string | undefined };
    attachCircuitBreaker(
      { subscribe: (fn: (e: unknown) => void) => session.subscribe(fn), abort: () => session.abort(BACKGROUND_CONTEXT) },
      "otter",
      { maxConsecutiveIdentical: 99, maxRepeatAfterWarning: 99, maxPerEventTimeMs: 300, slidingWindowSize: 99, slidingWindowRepeat: 99 },
      logger,
      { abortOverride: reason => { activeEntry.guardAbortReason = reason; void activeEntry.abort(); } },
    );
    // 若看门狗断裂（事件链死/计时器未起），prompt 将永久挂起 → 本测试超时红。
    await expect(session.prompt("hang it", undefined, stream, BACKGROUND_CONTEXT)).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(events.map(e => e.type)).toContain("tool_execution_start");
    expect(activeEntry.guardAbortReason).toBe("circuit_break:event_timeout");
    await session.close(BACKGROUND_CONTEXT);
  });
});

describe("durable-native runtime 同进程多轮 invoke（alpha bug4 回归守卫）", () => {
  it("同一 session 连续两次 prompt：第二次不得炸「Watch is already started」，事件到达新 sink", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-durable-twice-"));
    const { session, faux } = await open(path.join(dir, "session.sqlite"), [
      fauxAssistantMessage("first turn done"),
    ]);
    const firstEvents: string[] = [];
    await session.prompt("turn one", undefined, new DurableEventStream(e => firstEvents.push(e.type ?? "?")), BACKGROUND_CONTEXT);
    expect(session.turnText).toBe("first turn done");

    // 第二轮：换新 responses + 新 sink——修复前此调用必炸「Watch is already started」
    faux.setResponses([fauxAssistantMessage("second turn ok")]);
    const secondEvents: string[] = [];
    await session.prompt("turn two", undefined, new DurableEventStream(e => secondEvents.push(e.type ?? "?")), BACKGROUND_CONTEXT);

    expect(session.turnText).toBe("second turn ok");
    // 事件链完整：第二轮的 message_start/message_end 必须到达第二轮 sink（动态分发验证）
    expect(secondEvents).toContain("message_start");
    expect(secondEvents).toContain("message_end");
    // 事件不串轮：第二轮 sink 收到的 message_start 不得多于本轮会话的 1 条
    //（watch 回调 apply 全量视图时 sink.apply 自身会因 promptInput 产生 message_start，
    //  与 LLM 应答的 message_start 是两条——放开为 2 条以内，防假红）
    expect(secondEvents.filter(e => e === "message_start").length).toBeLessThanOrEqual(2);
    await session.close(BACKGROUND_CONTEXT);
  });
});

describe("durable-native runtime 压缩感知（迁移不兼容修复回归守卫）", () => {
  it("compact 期间 pi.live.compactions 边沿触发 compaction_start/end 事件流经 subscribe 总线", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-durable-compaction-"));
    const { session, faux } = await open(path.join(dir, "session.sqlite"), [
      fauxAssistantMessage("ok"),
    ]);
    await session.prompt("warm up", undefined, new DurableEventStream(), BACKGROUND_CONTEXT);

    // delta #4 修复后：compaction 事件双通道（总线喂 outputGuard + invoke stream 喂 handleStreamEvent）
    const events: string[] = [];
    const unsub = session.subscribe((e: unknown) => { const t = (e as { type?: string })?.type; if (t?.startsWith("compaction")) events.push(t); });
    const streamEvents: string[] = [];
    const invokeStream = new DurableEventStream((e: unknown) => { const t = (e as { type?: string })?.type; if (t?.startsWith("compaction")) streamEvents.push(t); });
    // 重放一次 prompt 让 promptWatch 指向我们的 invoke stream（compact 事件经 sink.dispatch 双投）
    faux.setResponses([fauxAssistantMessage("rewarm")]);
    await session.prompt("rewarm", undefined, invokeStream, BACKGROUND_CONTEXT);

    // 手动触发 compact：faux 应答总结文本——compactions 任务出现→消失
    faux.setResponses([fauxAssistantMessage("summary: 压缩总结测试")]);
    await session.compact("test");
    await new Promise(r => setTimeout(r, 300));

    expect(events).toContain("compaction_start");
    expect(events).toContain("compaction_end");
    // invoke stream 侧（handleStreamEvent 同链）也必须收到——delta #4 严重发现的回归点
    expect(streamEvents).toContain("compaction_start");
    expect(streamEvents).toContain("compaction_end");
    unsub();
    await session.close(BACKGROUND_CONTEXT);
  });

  it("压缩失败上报：compactionFailure 到达 pi.live 时发 compaction_end(errorMessage)（9/22 同款呼救信号）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-durable-compact-fail-"));
    // 前置：灌长会话越过 keepRecentTokens（faux contextWindow 128k → keep 20000），
    // selectCut 才有切点、summarize 才会真调模型——短会话 compact 走 complete() 空切点
    // 正常结束（不调模型），failure 分支不可达（probe 实证，勿改回短会话写法）。
    const { session, faux } = await open(path.join(dir, "session.sqlite"),
      Array.from({ length: 12 }, () => fauxAssistantMessage([fauxText("z".repeat(12000))])));
    for (let i = 0; i < 8; i++) {
      await session.prompt("turn " + i + " " + "w".repeat(10000), undefined, new DurableEventStream(), BACKGROUND_CONTEXT);
    }
    const failures: string[] = [];
    const streamFailures: string[] = [];
    // delta #4：断言真正的消费者——invoke stream（handleStreamEvent 链）收到 errorMessage
    const invokeStream = new DurableEventStream((e: unknown) => {
      const ev = e as { type?: string; errorMessage?: string };
      if (ev?.type === "compaction_end" && ev.errorMessage) streamFailures.push(ev.errorMessage);
    });
    faux.setResponses([fauxAssistantMessage("rewarm")]);
    await session.prompt("rewarm2", undefined, invokeStream, BACKGROUND_CONTEXT);
    const unsub = session.subscribe((e: unknown) => {
      const ev = e as { type?: string; errorMessage?: string };
      if (ev?.type === "compaction_end" && ev.errorMessage) failures.push(ev.errorMessage);
    });
    // 非重试类错误（GoUsageLimitError 不匹配 retryable 模式）→ 直接 failCompactionStatus → pi.live.compactionFailure
    faux.setResponses([() => {
      const m = fauxAssistantMessage("fallback");
      (m as unknown as { stopReason: string }).stopReason = "error";
      (m as unknown as { errorMessage: string }).errorMessage = "GoUsageLimitError: subscription limit";
      return m;
    }]);
    await session.compact("force-fail").catch(() => undefined);
    await new Promise(r => setTimeout(r, 500));
    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(failures[0]).toContain("GoUsageLimitError");
    // invoke stream 侧必须收到（agent-invoker:853 warn 的真实喂数链）
    expect(streamFailures.length).toBeGreaterThanOrEqual(1);
    expect(streamFailures[0]).toContain("GoUsageLimitError");
    unsub();
    await session.close(BACKGROUND_CONTEXT);
  }, 60000);
});
