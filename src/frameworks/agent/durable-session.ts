import path from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { WatchHandle } from "@earendil-works/chord";
import type { EntryId } from "@earendil-works/pi-durable";
import {
  Harness, LiveDoc, ToolTask, UsageDoc, createRegistry,
  defineExtension, hook, section, type AgentChange, type Conversation, type ConversationView,
  type Registry, type ToolHooks, type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { Logger } from "@usecases/ports/logger";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { bashGuardGate, haltToolCallGuard, loopBlockGuard, otterInvokeStorage } from "./model-runtime-registry";
import { toDurableTool } from "./durable-tool-registry";
import { DurableEventStream } from "./durable-event-stream";
import { contextTokensFromUsage } from "./durable-event-stream";
import { DurableToolSearch } from "./durable-tool-search";
import type { InvokeRegister } from "./tool-builder";
import type { TokenUsage } from "@usecases/conversation/token-usage";

export interface DurablePromptOptions { images?: Array<{ type: "image"; data: string; mimeType: string }> }
export type DurableSessionState = "running" | "idle" | "failed" | "closed";

export interface DurableToolBundle {
  customTools: Parameters<typeof toDurableTool>[0][];
  codingTools: string[];
  readOnly?: boolean;
  toolExposure?: Record<string, "direct" | "deferred">;
}

export interface DurableSessionOptions {
  otterId: string;
  file: string;
  models: Models;
  model: Model<Api>;
  thinkingLevel?: string;
  prompt?: string;
  identity?: string;
  cwd: string;
  tools: DurableToolBundle;
  logger: Logger;
  register: InvokeRegister;
  invokeId?: string;
  context: Context;
  promptProvider?: () => string | Promise<string>;
  mcp?: { registrations(signal?: AbortSignal): Promise<ToolRegistration[]>; instructions(): string; close(): Promise<void> };
  haltRegistry?: { takeForBlock(otterId: string): any[]; isHalted(otterId: string): boolean };
  haltSignal?: { addHook(otterId: string, hook: () => void): void };
  onHaltFirstBlock?: (directive: unknown) => void;
  /** Host hook seam for tool-result boundary tests and observability. */
  afterTool?: ToolHooks["afterTool"];
}

/** One per-otter store/writer. Never share a conversation across otters. */
export class DurableSession {
  private harness!: Harness;
  private conversation!: Conversation;
  private watcher?: WatchHandle<ConversationView>;
  private _state: DurableSessionState = "idle";
  private closeRequested = false;
  private promptWatch?: DurableEventStream;
  private watcherStarted = false;
  /** pi.live compactions 状态的边沿检测（false→true 发 compaction_start，true→false 发 end） */
  private wasCompacting = false;
  /** pi.live.compactionFailure 去重锚（同 taskId 只发一次失败事件） */
  private lastCompactionFailureTaskId?: number;
  /** pi.live.generation.retry 边沿检测锚（auto_retry 生命周期） */
  private wasRetrying = false;
  private lastWatchedEntry?: number;
  private invocationTokens: TokenUsage = { input: 0, output: 0 };
  private totalTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  readonly model: Model<Api>;
  readonly contextWindow?: number;
  private readonly registry: Registry;
  private readonly codingTools = createCodingTools();
  private readonly deferredTools: string[];
  private readonly otterExtension: ReturnType<typeof defineExtension>;
  private currentInvokeId?: string;
  private hasBoundInvoke = false;
  private promptText: string;
  private extraTools: ToolRegistration[] = [];

  private constructor(private readonly options: DurableSessionOptions) {
    this.model = options.model;
    this.currentInvokeId = options.invokeId;
    this.hasBoundInvoke = options.invokeId !== undefined;
    this.promptText = options.prompt ?? "";
    this.contextWindow = options.model.contextWindow;
    this.deferredTools = options.tools.customTools.filter(t => options.tools.toolExposure?.[t.name] === "deferred").map(t => t.name);
    this.otterExtension = defineExtension({
      name: "otter",
      sections: [section("otter", () => [this.promptText, this.options.identity, this.options.mcp?.instructions()].filter(Boolean).join("\n\n"), { tag: false })],
      tools: this.toolRegistrations().map(tool => options.tools.toolExposure?.[tool.name] === "deferred" ? { ...tool, deferred: true as const } : tool),
      hooks: [hook(ToolTask, {
        beforeTool: (call) => this.beforeTool(call),
        ...(options.afterTool ? { afterTool: options.afterTool } : {}),
      })],
    });
    this.registry = createRegistry();
    this.registry.install(createCodingTools());
    this.registry.install(this.otterExtension);
  }

  static async open(options: DurableSessionOptions): Promise<DurableSession> {
    const session = new DurableSession(options);
    await session.ensureDir();
    const storage = await openNodeSqliteStorage(options.file);
    session.harness = await Harness.open(storage, {
      models: options.models,
      registry: session.registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? options.cwd }),
      settings: {
        retry: { enabled: true, maxRetries: 4, baseDelayMs: 1000, maxAgentDelayMs: 30000 },
        stream: { timeoutMs: 600000, maxRetries: 0 },
        compaction: options.model.contextWindow ? {
          enabled: true,
          reserveTokens: Math.min(16384, Math.floor(options.model.contextWindow * 0.1)),
          keepRecentTokens: Math.min(20000, Math.floor(options.model.contextWindow * 0.2)),
          backgroundTokens: 0,
        } : { enabled: false },
      },
    }, options.context);
    if (options.mcp) {
      const tools = await options.mcp.registrations();
      session.extraTools = tools;
      session.registry.install(defineExtension({ name: "mcp-native", tools }));
    }
    session.conversation = await session.harness.root(options.context, { agent: session.agentChange() });
    await session.conversation.configure(session.agentChange(), options.context);
    await session.recoverAfterReopen();
    return session;
  }

  private async ensureDir(): Promise<void> {
    // 搭档定调（2026-11-06）：会话单主人是运行环境责任，海獭不做锁——
    // 单实例由部署层保证（launchd/systemd + 崩溃重启退避），数据一致性由
    // sqlite busy_timeout + pi-durable commit 校验兑底。原 proper-lockfile 实现
    // 移除（含其 60s stale 判死窗口在 SIGKILL 快速重启下的误拦）。
    const fs = await import("node:fs");
    await fs.promises.mkdir(path.dirname(this.options.file), { recursive: true });
  }

  private agentChange(): AgentChange {
    return {
      model: { provider: this.options.model.provider, modelId: this.options.model.id },
      ...(this.options.thinkingLevel ? { thinkingLevel: this.options.thinkingLevel as never } : {}),
      extensions: { add: [this.codingTools, this.otterExtension, ...(this.options.mcp ? [defineExtension({ name: "mcp-native", tools: this.extraTools })] : [])] },
      tools: [
        ...(this.codingTools.tools ?? []).filter(tool => this.options.tools.codingTools.includes(tool.name)),
        ...this.toolRegistrations().filter(tool => this.options.tools.toolExposure?.[tool.name] !== "deferred"),
        ...this.extraTools.filter(tool => !tool.deferred),
      ],
      modelTools: { add: [...this.toolRegistrations(), ...this.extraTools] },
      cwd: this.options.cwd,
    };
  }

  private toolRegistrations(): ToolRegistration[] {
    const tools = this.options.tools.customTools.map(toDurableTool);
    if (this.deferredTools.length > 0 && !this.options.tools.readOnly) {
      tools.push(new DurableToolSearch(this.options.tools.customTools, this.options.logger).registration());
    }
    return tools;
  }

  // Durable tool admission keeps the physical gates that must run BEFORE execution:
  // invoke ownership, halt, loop blacklist, bash guard. The behavioral guards
  // (circuit breaker / orchestration / per-event watchdog / output guard) consume
  // tool_execution_* events through the multicast subscribe channel instead —
  // wiring both feeds would double-count the breaker sliding window.
  private async beforeTool(call: { name: string; arguments: Record<string, unknown>; id: string }): Promise<{ block: string } | undefined> {
    const ctx = otterInvokeStorage.getStore();
    if (!this.currentInvokeId) return { block: "Durable tool execution requires currentInvokeId; refusing side effect." };
    const halt = haltToolCallGuard(ctx, this.options.haltRegistry as never, call.name);
    const guard = await halt ?? loopBlockGuard(ctx, call.name, call.arguments) ?? bashGuardGate(ctx, call.name, call.arguments);
    if (guard) return { block: guard.reason };
    return undefined;
  }

  // Multicast event bus: guards (circuit breaker, output guard, orchestration check)
  // and future consumers each own their subscription; emitting to the current
  // DurableEventStream outlet replaces the single-listener override the SDK had.
  private readonly listeners = new Set<(event: unknown) => void>();
  /** 迁移不兼容修复：pi.live 状态边沿检测——重建 compaction/auto_retry 生命周期事件。
   * 第二次误判教训（2026-11-06 搭档批评）：durable 把一切瞬时通知改为 pi.live 状态文档，
   * 逐项核查须「先问 durable 机制、再对照旧字段」，而非拿旧事件名找不到即断言「无信号源」。 */
  private readLiveDoc(view: ConversationView): { compactions?: unknown[]; compactionFailure?: { error?: unknown }; generation?: { retry?: { at: number; error: string } } } | undefined {
    return (view.docs as Record<string, { compactions?: unknown[]; compactionFailure?: { error?: unknown }; generation?: { retry?: { at: number; error: string } } } | undefined> | undefined)?.["pi.live"];
  }

  /** auto_retry 边沿：generation.retry 出现 = 退避中（auto_retry_start + errorMessage 透传，
   * 恢复 #764 abort 归因观测窗的信号源）；消失 = 退避结束（auto_retry_end）。 */
  private detectRetryEdge(live: { generation?: { retry?: { at: number; error: string } } } | undefined): void {
    const retryingNow = live?.generation?.retry !== undefined;
    if (retryingNow === this.wasRetrying) return;
    this.wasRetrying = retryingNow;
    const error = retryingNow ? live?.generation?.retry?.error : undefined;
    this.forwardCompactionEvent({ type: retryingNow ? "auto_retry_start" : "auto_retry_end", errorMessage: error });
  }

  private detectLiveEdges(view: ConversationView): void {
    const live = this.readLiveDoc(view);
    this.detectRetryEdge(live);
    const compactions = live?.compactions;
    const compactingNow = Array.isArray(compactions) && compactions.length > 0;
    if (compactingNow !== this.wasCompacting) {
      this.wasCompacting = compactingNow;
      this.forwardCompactionEvent({ type: compactingNow ? "compaction_start" : "compaction_end" });
    }
    // 压缩失败上报（delta #3 残余补全）：pi.live.compactionFailure 随 watch 分发，
    // 9/22 事故同款呼救信号——agent-invoker 的 compaction_end(errorMessage) warn 恢复喂数。
    // 每 taskId 只报一次（failure 对象在后续视图会保持存在，靠 lastFailureTaskId 去重）。
    const failure = live?.compactionFailure;
    const taskId = (failure as { taskId?: number } | undefined)?.taskId;
    if (failure && typeof taskId === "number" && taskId !== this.lastCompactionFailureTaskId) {
      this.lastCompactionFailureTaskId = taskId;
      const error = failure.error;
      this.forwardCompactionEvent({ type: "compaction_end", errorMessage: typeof error === "string" ? error : JSON.stringify(error) });
    }
  }

  /** delta #4 修复：compaction 事件双通道送达。sink.dispatch 经构造回调一次双投——
   *  emit 进 subscribe 总线（outputGuard 等订阅者）+ stream.dispatch 进当前 invoke 的
   *  消费链（handleStreamEvent：agent-invoker:853 的失败 warn / metrics / 域事件映射）。
   *  仅 emit 总线时 invoke 侧收不到（delta #4 严重发现）；无活跃 sink（非 invoke 期）回落总线。 */
  private forwardCompactionEvent(evt: { type: string; errorMessage?: string }): void {
    if (this.promptWatch) this.promptWatch.dispatch(evt);
    else this.emit(evt);
  }

  emit(event: unknown): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch (error) { this.options.logger.warn("durable event listener failed", { error: String(error) }); }
    }
  }
  getSessionStats(): { tokens: TokenUsage } { return { tokens: this.totalTokens }; }
  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  updateOptions(next: { currentInvokeId?: string; prompt?: string; identity?: string }): void {
    this.currentInvokeId = next.currentInvokeId;
    this.hasBoundInvoke = true;
    if (next.prompt !== undefined) this.promptText = next.prompt;
    this.options.identity = next.identity;
  }

  // A turn owns watch, admission, settlement and usage accounting as one boundary.
  // eslint-disable-next-line complexity, max-statements
  async prompt(text: string, options: DurablePromptOptions | undefined, stream: DurableEventStream, context: Context): Promise<void> {
    const scope = otterInvokeStorage.getStore();
    const invokeId = this.hasBoundInvoke ? this.currentInvokeId : ((scope as { currentInvokeId?: string } | undefined)?.currentInvokeId ?? this.options.invokeId ?? this.options.register.currentInvokeId);
    if (!invokeId) throw new Error("Durable prompt requires currentInvokeId");
    this.currentInvokeId = invokeId;
    if (this.options.promptProvider) this.promptText = await this.options.promptProvider();
    await this.conversation.configure(this.agentChange(), BACKGROUND_CONTEXT);
    const before = await this.usage(BACKGROUND_CONTEXT);
    // 检视处置（PR #1783 严亟 1）：事件单一源在 watch→sink 路径——派生事件先上 session 事件总线
    // （熔断器/看门狗/编排守卫/outputGuard 经 subscribe 消费），再分发到调用方 stream；
    // sink 同时是派生状态（lastMessage/lastUsage）真相源，promptWatch 指向 sink。
    // 不依赖 factory 层包装：任何直接调 prompt 的路径（含测试）守卫均在场。
    const sink = new DurableEventStream(event => { this.emit(event); stream.dispatch(event); });
    this.promptWatch = sink;
    this.watcher ??= await this.conversation.watch(BACKGROUND_CONTEXT, { min: 100, max: 200 });
    // PR #1783 alpha 实测修复（bug4）：chord Watch.start() 不允许二次调用，watcher 只能 start 一次；
    // 回调经 this.promptWatch 动态分发到当前 sink（闭包捕获首次 sink 会把后续轮事件送进旧流）。
    // 修复前同进程同獭第二次 invoke 必炸「Watch is already started」。
    if (!this.watcherStarted) {
      this.watcherStarted = true;
      this.watcher.start(async (call: { kind: string; value?: ConversationView; ops?: readonly unknown[] }) => {
        if (call.kind === "value" && call.value) {
          // 迁移不兼容修复（2026-11-06 搭档定调）：pi-durable 把压缩状态写入 pi.live 文档
          // （compactions 列表非空 = 压缩进行中），随 watch 视图分发——旧 runtime 的
          // compaction_start/end 事件链在此重建，outputGuard 的压缩期避让（pause/resume）
          // 恢复喂数。此前回调只取 entries，丢弃了 docs，守卫在压缩期间盲超时。
          this.detectLiveEdges(call.value);
          const before = this.lastWatchedEntry;
          const ids = call.value.entries.map(entry => Number(entry.id));
          const newest = Math.max(0, ...ids);
          if (before !== undefined && (call.value.before === undefined || Number(call.value.before) < before)) {
            const missed = await this.conversation.entries({ minEntryId: (before + 1) as EntryId, order: "ascending" }, 1000, undefined, BACKGROUND_CONTEXT);
            await this.promptWatch?.apply({ ...call.value, entries: missed.items }, []);
          }
          this.lastWatchedEntry = Math.max(before ?? 0, newest);
          await this.promptWatch?.apply(call.value, call.ops);
        }
      });
    }
    this._state = "running";
    const submission = await this.conversation.submit({ type: "input", content: this.promptInput(text, options) as never, whenBusy: "reject" }, context);
    const settled = await submission.wait(context);
    // A final terminate boundary can place queued inputs and start a successor run.
    // Keep the current invoke/abort/tool ownership alive until durable has drained it (#1788).
    await this.conversation.waitForIdle(context);
    this._state = "idle";
    await sink.apply(this.watcher.value, []);
    const after = await this.usage(BACKGROUND_CONTEXT);
    this.invocationTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const bucket of ["models", "tools"] as const) for (const [key, usage] of Object.entries(after?.[bucket] ?? {})) {
      const previous = before?.[bucket]?.[key];
      this.invocationTokens.input += usage.input - (previous?.input ?? 0);
      this.invocationTokens.output += usage.output - (previous?.output ?? 0);
      this.invocationTokens.cacheRead! += (usage.cacheRead ?? 0) - (previous?.cacheRead ?? 0);
      this.invocationTokens.cacheWrite! += (usage.cacheWrite ?? 0) - (previous?.cacheWrite ?? 0);
      this.totalTokens.input += usage.input - (previous?.input ?? 0);
      this.totalTokens.output += usage.output - (previous?.output ?? 0);
      this.totalTokens.cacheRead += (usage.cacheRead ?? 0) - (previous?.cacheRead ?? 0);
      this.totalTokens.cacheWrite += (usage.cacheWrite ?? 0) - (previous?.cacheWrite ?? 0);
    }
    if (settled.status === "unanswered") throw new Error(`Durable turn unanswered: ${settled.reason}${settled.detail ? ` (${JSON.stringify(settled.detail)})` : ""}`);
  }

  private promptInput(text: string, options?: DurablePromptOptions): string | { content: Array<Record<string, unknown>> } {
    if (!options?.images?.length) return text;
    return { content: [{ type: "text", text }, ...options.images] };
  }

  async steer(text: string, context: Context = BACKGROUND_CONTEXT): Promise<void> {
    await this.conversation.submit({ type: "input", content: text, whenBusy: "steer", whenIdle: "reject" }, context);
  }

  async followUp(text: string, context: Context): Promise<"queued"> {
    await this.conversation.submit({ type: "input", content: text, whenBusy: "followUp", whenIdle: "reject" }, context);
    return "queued";
  }

  async abort(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    this.closeRequested = false;
    await this.conversation.abort(context);
    this._state = "idle";
  }

  async compact(instructions?: string): Promise<void> {
    const task = await this.conversation.compact(instructions, BACKGROUND_CONTEXT);
    await this.harness.waitForTask(task, BACKGROUND_CONTEXT);
  }

  async recoverAfterReopen(): Promise<void> {
    const pending = await this.harness.inspect(BACKGROUND_CONTEXT);
    const active = pending.tasks.filter(item => item.record.state.status !== "terminal" && item.record.state.status !== "completing");
    if (!active.length) return;
    this.options.logger.warn("durable checkpoint has unfinished tasks; aborting before a new otter invoke", { otterId: this.options.otterId, tasks: active.map(item => item.record.id) });
    await this.conversation.abort(BACKGROUND_CONTEXT, { background: true });
    await this.conversation.waitForIdle(BACKGROUND_CONTEXT);
  }

  setCwd(cwd: string, context: Context): Promise<void> { return this.conversation.configure({ cwd }, context); }
  dispose(): void { void this.close(BACKGROUND_CONTEXT).catch(error => this.options.logger.warn("durable dispose failed", { error: String(error) })); }
  get isStreaming(): boolean { return this._state === "running"; }
  get state(): DurableSessionState { return this._state; }
  get lastMessage() { return this.promptWatch?.lastMessage; }
  get turnText(): string { return this.promptWatch?.lastMessage?.content?.filter(b => b.type === "text").map(b => b.text as string).join("") ?? ""; }
  get tokenUsage() { return this.invocationTokens; }
  get lastStopReason(): string | undefined { return this.promptWatch?.lastMessage?.stopReason; }
  get ctxTokens(): number | undefined {
    const message = this.promptWatch?.lastMessage as { usage?: Parameters<typeof contextTokensFromUsage>[0] } | undefined;
    return contextTokensFromUsage(message?.usage);
  }
  async usage(context: Context) { return await this.harness.snapshot(UsageDoc, this.conversation.id, context); }
  async inspect(context: Context) { return this.harness.inspect(context); }
  async live(context: Context) { return this.harness.commit(tx => tx.doc(LiveDoc, this.conversation.id), context); }
  async rawContext(context: Context) { return this.conversation.context(context); }

  /** M-9af49d4a 换世根因修复：同库世代 reset——写 pi.reset entry + head 指针，
   *  模型上下文自此清零（前世 = reset 点之前的 entries，同库可审计）。
   *  档案仍由既有首注入链路交付（pendingIdentity），与 reset 解耦。
   *  守护（R5）：reset 落盘后校验边界真实存在（最新可见 entry 为 pi.reset 且 head 非空），
   *  不满足即抛错——#1783 式「静默空转」必须变成响亮失败，由 unifiedHandoff 向搭档显式报错。 */
  async resetForGeneration(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    if (this.isStreaming) {
      throw new Error(`durable generation reset refused while running (otter=${this.options.otterId})`);
    }
    await this.conversation.reset(undefined, context);
    const page = await this.conversation.entries({ order: "descending" }, 1, undefined, context);
    const newest = page.items[0];
    if (!newest || newest.kind !== "pi.reset" || newest.head == null) {
      // 审视复核澄清：abort **不撤回** queued write（上游 withdrawQueuedInputs 跳过
      // write 模式，reset 正是 queued write）——此处 abort 仅作活流收尾，残余 queued
      // reset 若在下一边界落盘，效果等同一次合法世代边界（无害）；守护的职责是
      // 响亮失败，不是补偿。busy 前置拒绝（pi.live.run 检查）归入 R5 后续防御层。
      await this.conversation.abort(context).catch(() => undefined);
      throw new Error(`durable generation reset guard failed: no pi.reset head boundary after reset (otter=${this.options.otterId}, newest=${newest?.kind ?? "none"})`);
    }
  }

  async close(context: Context): Promise<void> {
    if (this.closeRequested) return;
    this.closeRequested = true;
    if (this.isStreaming) await this.abort(context).catch(() => undefined);
    await this.watcher?.stop();
    await this.harness.close(context);
    await this.options.mcp?.close();
    this._state = "closed";
  }
}
