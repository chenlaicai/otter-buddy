import path from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { WatchHandle } from "@earendil-works/chord";
import type { EntryId } from "@earendil-works/pi-durable";
import {
  Harness, GenerationTask, LiveDoc, ToolTask, UsageDoc, createRegistry,
  defineExtension, hook, section, type AgentChange, type Conversation, type ConversationView,
  type Registry, type ToolHooks, type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { Logger } from "@usecases/ports/logger";
import { stripEmptyAssistantText, aggregateFragmentedToolCalls } from "./assistant-message-sanitizer";
import type { ExecutionMachineResolver } from "@usecases/ports/execution-machine";
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
  cwd: string;
  executionMachines: ExecutionMachineResolver;
  tools: DurableToolBundle;
  logger: Logger;
  register: InvokeRegister;
  invokeId?: string;
  context: Context;
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
  private toolSearchExtension?: ReturnType<typeof defineExtension>;
  private currentInvokeId?: string;
  private hasBoundInvoke = false;
  private renderedPrompt = "";
  private extraTools: ToolRegistration[] = [];

  private constructor(private readonly options: DurableSessionOptions) {
    this.model = options.model;
    this.currentInvokeId = options.invokeId;
    this.hasBoundInvoke = options.invokeId !== undefined;
    this.contextWindow = options.model.contextWindow;
    this.deferredTools = options.tools.customTools.filter(t => options.tools.toolExposure?.[t.name] === "deferred").map(t => t.name);
    this.otterExtension = defineExtension({
      name: "otter",
      // Why: Durable executes the one prompt compiled at the invoke boundary; it must
      // not reconstruct policy from legacy identity, skill, or MCP side channels.
      sections: [section("otter", () => this.renderedPrompt, { tag: false })],
      tools: this.customToolRegistrations().map(tool => options.tools.toolExposure?.[tool.name] === "deferred" ? { ...tool, deferred: true as const } : tool),
      hooks: [hook(ToolTask, {
        beforeTool: (call) => this.beforeTool(call),
        ...(options.afterTool ? { afterTool: options.afterTool } : {}),
      }), hook(GenerationTask, {
        // kimi 流式缺陷的两层净化（出口恒净，存量中毒 session 一并痊愈；历史记录不动、可审计）：
        // 1) kimi 会把一次 function call 拆成多个碎片 item（仅首个带 call_id/name），
        //    碎片以空 call_id 落库，回放时多条 `call_id:""` 被 kimi 判 400 duplicated
        //    ——先聚合恢复参数、剔除碎片与孤儿 error。
        // 2) kimi 会在 toolCall 响应里附带空 text 块，回放时插在
        //    function_call 与其 output 之间触发 kimi /responses 邻接校验 400（session 每轮必死）——再剥空 text 块。
        beforeRequest: ({ messages }) => {
          const aggregated = aggregateFragmentedToolCalls(messages);
          const cleaned = stripEmptyAssistantText(aggregated ?? messages);
          return cleaned === undefined && aggregated === undefined
            ? undefined
            : { messages: cleaned ?? aggregated! };
        },
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
      env: async ({ cwd }) => {
        const conversationId = otterInvokeStorage.getStore()?.currentConversationId;
        const machine = options.executionMachines.resolveForConversation
          ? await options.executionMachines.resolveForConversation(conversationId)
          : options.executionMachines.resolve();
        return machine.createExecutionEnvironment(cwd ?? options.cwd, conversationId);
      },
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
    // tool_search 只在「实际存在 deferred 工具」时注册（deferred customTools 或 deferred MCP）。
    // extraTools 在 open() 阶段才就位，故在此处动态创建并安装（构造时无法知道 MCP 的 deferred 面）。
    // direct-only MCP / restricted external 不注册空候选 tool_search，保持工具声明面与 deferred 检索语义一致。
    if (!options.tools.readOnly && (session.deferredTools.length > 0 || session.extraTools.some(t => t.deferred === true))) {
      session.toolSearchExtension = defineExtension({ name: "tool-search", tools: [new DurableToolSearch(() => session.toolSearchCandidates(), options.logger).registration()] });
      session.registry.install(session.toolSearchExtension);
    }
    const change = session.agentChange();
    session.conversation = await session.harness.root(options.context, { agent: change });
    await session.reconcileToolsAfterReopen(change, options.context);
    await session.recoverAfterReopen();
    return session;
  }

  // harness.root 只在 root conversation 首次创建时应用 agent（重开直接返回），因此重开必须自己在 configure 里
  // 把 tools/modelTools 对账到当前配置：direct 白名单与 modelTools 基底随工作区 MCP 配置而变，只 configure 会变
  // 字段会留下旧 state.tools/modelTools——同一个持久库从 direct-only MCP 变为 deferred MCP 时，重开得到
  // offered/deferred 双双为空且没有 tool_search。
  // 但不能无条件全量覆盖：上一 session 已通过 tool_search 加载的 deferred 工具名持久化在 state.tools 白名单里，
  // 粗暴重置会让冷启动重开后这些工具重新 not available。对账规则：resolved agent 里「已 offer 且 deferred」
  // 的工具 = 已加载且当前仍为 deferred 的工具，把它们并回当前 direct 白名单与 modelTools 基底——刷新配置面，
  // 同时保留合法加载。prompt() 轮内不再 configure，该加载在会话内不会被任何 configure 抹掉。
  private async reconcileToolsAfterReopen(change: AgentChange, context: Context): Promise<void> {
    const before = await this.conversation.agent(context);
    const loadedDeferred = before.tools.filter(tool => tool.deferred === true);
    const tools = Array.isArray(change.tools) ? [...change.tools] : [];
    const modelToolsAdd = change.modelTools && "add" in change.modelTools ? [...(change.modelTools.add ?? [])] : [];
    for (const tool of loadedDeferred) {
      if (!tools.some(t => t.name === tool.name)) tools.push(tool);
      if (!modelToolsAdd.some(t => t.name === tool.name)) modelToolsAdd.push(tool);
    }
    await this.conversation.configure({
      model: change.model,
      ...(change.thinkingLevel ? { thinkingLevel: change.thinkingLevel } : {}),
      extensions: change.extensions,
      tools,
      modelTools: { add: modelToolsAdd },
      cwd: change.cwd,
    }, context);
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
    const searchTools = this.toolSearchExtension?.tools ?? [];
    return {
      model: { provider: this.options.model.provider, modelId: this.options.model.id },
      ...(this.options.thinkingLevel ? { thinkingLevel: this.options.thinkingLevel as never } : {}),
      extensions: { add: [this.codingTools, this.otterExtension, ...(this.toolSearchExtension ? [this.toolSearchExtension] : []), ...(this.options.mcp ? [defineExtension({ name: "mcp-native", tools: this.extraTools })] : [])] },
      tools: [
        ...(this.codingTools.tools ?? []).filter(tool => this.options.tools.codingTools.includes(tool.name)),
        ...this.customToolRegistrations().filter(tool => this.options.tools.toolExposure?.[tool.name] !== "deferred"),
        ...searchTools,
        ...this.extraTools.filter(tool => !tool.deferred),
      ],
      modelTools: { add: [...this.customToolRegistrations(), ...searchTools, ...this.extraTools] },
      cwd: this.options.cwd,
    };
  }

  private customToolRegistrations(): ToolRegistration[] {
    return this.options.tools.customTools.map(toDurableTool);
  }

  /** tool_search 检索候选：deferred customTools + deferred MCP extraTools（与 SDK candidates=agent.deferred 对齐）。 */
  private toolSearchCandidates(): Array<{ name: string; description?: string; parameters?: unknown }> {
    return [
      ...this.options.tools.customTools.filter(t => this.deferredTools.includes(t.name)),
      ...this.extraTools.filter(t => t.deferred === true).map(t => ({ name: t.name, description: t.description, parameters: t.parameters })),
    ];
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
    // 守卫放行后才写入当前工具调用 id（SUGG-4：被拦截的 call.id 不应
    // 残留到下一枚覆盖前——那会让非工具期的 env 动作误归属到被拦调用）。
    if (ctx) ctx.currentToolCallId = call.id;
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
   * 恢复 abort 归因观测窗的信号源）；消失 = 退避结束（auto_retry_end）。 */
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
    // 压缩失败上报（delta 残余补全）：pi.live.compactionFailure 随 watch 分发，
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

  /** delta 修复：compaction 事件双通道送达。sink.dispatch 经构造回调一次双投——
   *  emit 进 subscribe 总线（outputGuard 等订阅者）+ stream.dispatch 进当前 invoke 的
   *  消费链（handleStreamEvent：agent-invoker:853 的失败 warn / metrics / 域事件映射）。
   * 仅 emit 总线时 invoke 侧收不到（delta 严重发现）；无活跃 sink（非 invoke 期）回落总线。 */
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

  updateOptions(next: { currentInvokeId?: string; renderedPrompt?: string }): void {
    this.currentInvokeId = next.currentInvokeId;
    this.hasBoundInvoke = true;
    if (next.renderedPrompt !== undefined) this.renderedPrompt = next.renderedPrompt;
  }

  get mcpInstructions(): string {
    return this.options.mcp?.instructions() ?? "";
  }

  // A turn owns watch, admission, settlement and usage accounting as one boundary.
  // eslint-disable-next-line complexity, max-statements
  async prompt(text: string, options: DurablePromptOptions | undefined, stream: DurableEventStream, context: Context): Promise<void> {
    const scope = otterInvokeStorage.getStore();
    // 原 scope.currentInvokeId fallback 分支是死代码（store 每次 execute 新建、
    // 此前无人写入）——摘除，避免本阶段写入后跨 prompt 复用旧值。
    const invokeId = this.hasBoundInvoke ? this.currentInvokeId : (this.options.invokeId ?? this.options.register.currentInvokeId);
    if (!invokeId) throw new Error("Durable prompt requires currentInvokeId");
    this.currentInvokeId = invokeId;
    // invoke id 写入 ALS store——动作台账归属（RecordingNodeExecutionEnv
    // 与 LocalExecutionMachine 读取）；工具调用 id 由 beforeTool 逐枚覆盖。
    if (scope) scope.currentInvokeId = invokeId;
    // 不再每轮 configure(agentChange())——它会把 state.tools 重置为初始激活集，
    // 覆盖 tool_search `control.addTools` 的加载结果（deferred 工具跨 invoke 报 not available）。
    // 初始 tools/modelTools 由 open() 的 harness.root 首次创建时写入（重开时只刷新会变字段）；
    // prompt/identity 经 otterExtension section 的动态 render 即时生效，无需 configure。
    const before = await this.usage(BACKGROUND_CONTEXT);
    // 检视处置（严亟 1）：事件单一源在 watch→sink 路径——派生事件先上 session 事件总线
    // （熔断器/看门狗/编排守卫/outputGuard 经 subscribe 消费），再分发到调用方 stream；
    // sink 同时是派生状态（lastMessage/lastUsage）真相源，promptWatch 指向 sink。
    // 不依赖 factory 层包装：任何直接调 prompt 的路径（含测试）守卫均在场。
    this.watcher ??= await this.conversation.watch(BACKGROUND_CONTEXT, { min: 100, max: 200 });
    // watch 的初始 value 含历史 transcript；只把本轮 submit 之后的新 entry 送入当前 invoke 事件流。
    // 否则上一任务的 speak/tool_call 会被持久化到本次 invoke_events，伪装成「本轮已调用」。
    const entryBoundary = Math.max(0, ...this.watcher.value.entries.map(entry => Number(entry.id)));
    const sink = new DurableEventStream(event => { this.emit(event); stream.dispatch(event); }, undefined, entryBoundary);
    this.promptWatch = sink;
    // alpha 实测修复（bug4）：chord Watch.start() 不允许二次调用，watcher 只能 start 一次；
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
    // 异常生命周期（同一边界）：submit/wait/waitForIdle/usage 任一阶段抛错，
    // running 状态与当前工具调用 id 都必须在 finally 清回——残留的 running
    // 会让 isStreaming 误报、残留的 toolCallId 会把后续非工具期动作误归属到旧调用。
    try {
    const submission = await this.conversation.submit({ type: "input", content: this.promptInput(text, options) as never, whenBusy: "reject" }, context);
    const settled = await submission.wait(context);
    // A final terminate boundary can place queued inputs and start a successor run.
    // Keep the current invoke/abort/tool ownership alive until durable has drained it .
    await this.conversation.waitForIdle(context);
    this._state = "idle";
    await sink.apply(this.watcher.value, []);
    // （dspro RESIDUAL-3）：回合结束即清除当前工具调用 id（置于 unanswered
    // 抛错之前——异常回合同样清除，非工具期 env 动作不误归属）。
    if (scope) scope.currentToolCallId = undefined;
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
    } finally {
      // 幂等收口：正常路径已在上方清理，异常路径在此兑付；重复清理无副作用。
      this._state = "idle";
      if (scope) scope.currentToolCallId = undefined;
    }
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
  /** 只读视图：当前 durable agent 配置（model/cwd/thinkingLevel/tools）——测试与诊断用。 */
  async agentView(context: Context = BACKGROUND_CONTEXT) { return this.conversation.agent(context); }

  /** M-9af49d4a 换世根因修复：同库世代 reset——写 pi.reset entry + head 指针，
   *  模型上下文自此清零（前世 = reset 点之前的 entries，同库可审计）。
   *  档案仍由既有首注入链路交付（pendingIdentity），与 reset 解耦。
   * 守护：reset 落盘后校验边界真实存在（最新可见 entry 为 pi.reset 且 head 非空），
   * 不满足即抛错——式「静默空转」必须变成响亮失败，由 unifiedHandoff 向搭档显式报错。 */
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
      // 响亮失败，不是补偿。busy 前置拒绝（pi.live.run 检查）归入 后续防御层。
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
