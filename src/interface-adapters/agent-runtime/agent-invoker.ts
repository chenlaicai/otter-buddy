/* eslint-disable max-lines -- Phase 1 新增触发链路；后续可拆分为 handoff-support.ts */
/**
 * AgentInvoker - SDK 调用适配器
 *
 * Why: Phase 2 将编排逻辑上提到 AgentTurnOrchestrator（usecase 层），
 * AgentInvoker 瘦身为 SDK 调用 + SSE 事件映射 + AttemptDriver 提供。
 *
 * 职责边界：
 * - orchestrator 负责：退出分类、重试决策、终态防护、metrics 埋点
 * - invoker 负责：SDK 调用、SSE 事件映射、消息生命周期、上下文构建
 */

import type { SdkInvokePort, AgentStreamEvent, DynamicContext } from "@usecases/ports/sdk-invoke-port";
import type { SendEntry } from "@usecases/conversation/send-entry";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Logger } from "@usecases/ports/logger";
import type { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import { USER_DISPLAY_NAME_KEY } from "@usecases/settings/settings-keys";
import type { SSEEvent } from "@contract/sse/events";
import { runWithTrace, getTraceContext, newTraceId } from "@usecases/ports/trace-context";
import type { AgentMetricsPort } from "@usecases/ports/agent-metrics-port";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { ScheduledTaskRepository } from "@usecases/scheduled-task/scheduled-task-repository";
import type { ManageContext } from "@usecases/otter/manage-context";
import type { LinkedResource } from "@entities/conversation/conversation";
import type { OtterSession } from "@entities/otter/otter-session";
 
import type { buildHandoffPackage, StateInventoryDeps, HandoffEntryReader } from "@frameworks/agent/handoff-package-builder";
 
import type { SynthesisPrefetch } from "@frameworks/agent/synthesis-prompt-builder";
// F20260920uhuc：统一交接引擎与 jsonl 切片的 DI 契约（层约束：interface-adapters 不
// import frameworks 实现——同 buildHandoffPackage 注入先例，运行时由 bootstrap 装配）
import { DomainError } from "@entities/errors";

/** F20260923hlck：合成 prompt 长度→token 估算比率——9/23 生产日志实测校准。
 *  F20260924swin 起退役：预检与 trim 共享 synthesisFullBudgetChars（引擎端口注入），
 *  不再各自维护密度常数（此前 trim chars/3 预检 chars/2 双口径漂移的教训）。 */

/** 统一交接的引擎输入形状（与 narrative-synthesis-engine 的同名接口结构兼容——
 *  独立声明避免 interface-adapters→frameworks 的模块依赖，参数类型就地内联） */
export interface EngineSynthesisInput {
  otterName: string;
  oldSessionId?: string;
  trigger: '水位' | '手动' | '自重启' | '熔断' | '首哑复活';
  messagesToSummarize: Array<{ role: string; content?: unknown }>;
  previousSummary?: string;
  lineage?: string;
  selfSummary?: string;
  stateInventoryText?: string;
  prefetch?: {
    contextKeys?: string[];
    activeArtifacts?: Array<{ id: string; resourceType: string; title?: string }>;
    recentUserMessages?: string[];
  };
  timestamp?: string;
  /** F20260923hsyn：目标模型上下文窗口（tokens）——传入则历史段预算裁剪（丢最老保最近）；缺省不裁 */
  contextWindowTokens?: number;
  /** F20260924swin 观测锚：trim 结果回调（与引擎 NarrativeSynthesisInput.onTrim 结构兼容） */
  onTrim?: (result: {
    inputChars: number;
    measuredFixedChars: number;
    historyBudgetChars: number;
    droppedCount: number;
    promptChars: number;
  }) => void;
}

/** jsonl 切片结果的最小消费面（与 session-slicer.JsonlSlice 结构兼容） */
export interface EngineJsonlSlice {
  firstKeptEntryId: string | undefined;
  messagesToSummarize: Array<{ role: string; content?: unknown }>;
  turnPrefixMessages: Array<{ role: string; content?: unknown }>;
  isSplitTurn: boolean;
  previousSummary: string | undefined;
  tokensBefore: number;
}

/** 引擎函数包（bootstrap 注入；缺省时统一交接降级机械档案） */
export interface HandoffEngineDeps {
  buildNarrativeSynthesisPrompt: (input: EngineSynthesisInput) => string;
  assembleHandoffArchive: (params: {
    narrativeSummary?: string;
    selfSummary?: string;
    lineage?: string;
    fileTrail?: string;
    stateInventory?: string;
    recencyWindow?: string;
  }) => string;
  buildMechanicalArchive: (input: {
    otterName: string;
    trigger: string;
    oldSessionId?: string;
    selfSummary?: string;
    stateInventoryText?: string;
    recencyWindow?: string;
    fileTrail?: string;
  }) => string;
  sliceSessionEntries: (entries: unknown[]) => EngineJsonlSlice | undefined;
  serializeKeptWindow: (slice: EngineJsonlSlice) => string;
  collectStateInventory: (conversationId: string, otterId: string, deps: unknown) => Promise<unknown>;
  renderStateInventory: (inventory: unknown) => string;
  scanWorkspaceFiles: (path: string) => string[];
  renderFileTrail: (trail: unknown) => string;
  /** 合成超时上界 ms */
  synthesisTimeoutMs: number;
  /** F20260924swin：合成全文预算函数（trim 与预检共享的唯一预算对象）——
   *  引擎端口注入（层约束：interface-adapters 不 import frameworks 常量）。
   *  delta 复核建议4：可选 → 必填——可选时漏注入 = 预检静默失效 fail-open。 */
  synthesisFullBudgetChars: (contextWindowTokens: number) => number;
}
import { resolveSpeakerName } from "@usecases/conversation/speaker-resolver";
// F20260826mwrd C3：高危 healing 事件提醒（Part 4 高危路由消费侧）
import { healingAlertRegistry, renderHealingAlerts } from "@usecases/healing/healing-alert-registry";
import { HandoffState, restoreHandoffContext, DEFAULT_CTX_MAX } from "./handoff-support";
import { shouldInjectSessionPreamble } from "@frameworks/agent/session-helpers";
import { MIN_SENSIBLE_CTX_WINDOW, type OtterContextWindowProvider } from "@usecases/ports/otter-context-window-provider";
import { mapToSSEEvent, mapToInvokeEventInput, extractMessageEndUsage } from "@usecases/conversation/agent-turn-orchestrator/event-mapping";
import { AgentTurnOrchestrator } from "@usecases/conversation/agent-turn-orchestrator/orchestrator";
import { CircuitBreakSupport } from "./circuit-break-support";
import type { TurnInput, AttemptDriver, TurnCallbacks, InvokeResultShape, CircuitBreakInfo, FirstDumbInfo, HealingEventInput } from "@usecases/conversation/agent-turn-orchestrator/types";
import type { InvokeRepository } from "@usecases/conversation/invoke-repository";
import type { AgentTurnPort, AgentTurnResult } from "@usecases/ports/agent-turn-port";
import type { AgentDispatchService } from "@usecases/conversation/agent-dispatch-service";

// F20260920uhuc：buildAutoHandoffOptions / buildManualHandoffOptions 退役——
// 红线重审（对抗审视确认推翻）：影子通道改变了 P1 当年的技术形态（合成者是干净的
// inMemory 引擎而非退化獭的 invoke 通道），手动/熔断路径统一走 LLM 合成 + 降级链。
// 四件套 options 组装由统一 handoff 入口（unifiedHandoff）内的机械供料收集取代。

export class AgentInvoker implements AgentTurnPort {
  /** Messages explicitly aborted by the user (written only by abort()) */
  private readonly userAbortedMessages = new Set<string>();
  /** #764：SDK auto_retry_start 观测窗——retry backoff 期间 abort 时 err 被 retry 层抹掉
   *  errorMessage（{...rest, stopReason: "aborted"}），exit 分类拿不到底层错误；
   *  但 auto_retry_start 事件带完整 errorMessage，且 retry 会话在成功/耗尽前不结束。
   *  invokeId → 最近一次 retry 的 errorMessage，abort 归因消费后随 invoke 生命周期清理。 */
  private readonly retryContextByInvoke = new Map<string, string>();
  private readonly orchestrator: AgentTurnOrchestrator;
  /** F20260818cbkr：熔断执行器（healingRepo 未注入时为 null，熔断禁用） */
  private readonly circuitBreak: CircuitBreakSupport | null;
  /** F20260825hndf：handoff 状态管理 */
  private readonly handoffState = new HandoffState();
  /** F20260901cxmw：按 otter 缓存解析出的 ctxMax（池条目启动后不可变，见 ModelPool 注释） */
  private readonly resolvedCtxMax = new Map<string, number>();
  /** F20260901cxmw：按 otter 缓存解析出的 ctxMax。缓存边界（cxrev 审视发现 #3 措辞精确化）：
   * ModelPool 的 entries 启动后不可变；defaultAlias 可通过 settings 页运行时切换，
   * 仅影响无显式 modelAlias otter 的新解析（新 session 口径）——已缓存的 otter 保持首解析值。 */

  // eslint-disable-next-line max-params -- AgentInvoker 依赖较多，参数数量由 DI 框架决定
  constructor(
    private readonly agentInvoke: SdkInvokePort,
    private readonly queryMessage: QueryMessage,
    private readonly manageSession: ManageSession,
    private readonly queryOtter: QueryOtter,
    private readonly logger: Logger,
    private readonly messageBroadcaster?: MessageBroadcaster,
    private readonly workspaceGateway?: WorkspaceGateway,
    private readonly settingsRepo?: SettingsRepository,
    /** F20260814mtrc：可选注入，缺省 no-op（不破坏既有测试） */
    private readonly metrics?: AgentMetricsPort,
    /** F20260818cbkr：可选注入，缺省禁用熔断（不破坏既有测试） */
    private readonly healingRepo?: HealingEventRepository,
    /** F20260825hndf：可选注入，用于活状态盘点（不破坏既有测试） */
    private readonly conversationRepo?: ConversationRepository,
    /** F20260825hndf：可选注入，用于调度任务盘点（不破坏既有测试） */
    private readonly scheduledTaskRepo?: ScheduledTaskRepository,
    /** F20260825hndf：可选注入，用于产物盘点（不破坏既有测试） */
    private readonly listArtifacts?: (conversationId: string) => Promise<LinkedResource[]>,
    /** F20260825hndf：可选注入，用于 otter_context 读写（借用式交接上下文） */
    private readonly manageContext?: ManageContext,
    /** F20260825hndf：可选注入，四件套构建器（从 bootstrap 注入，避免 interface-adapters→frameworks 直接依赖） */
    private readonly buildHandoffPkg?: typeof buildHandoffPackage,
    /** F20260831cbkw：可选注入，熔断 session 年龄窗口阈值（ms），缺省 2h */
    private readonly healthySessionThresholdMs?: number,
    /** F20260901cxmw：可选注入，otter 实际模型 contextWindow 解析（缺省回退 128k，兼容旧测试） */
    private readonly ctxWindowProvider?: OtterContextWindowProvider,
    /** F20260913ctlv：invoke 生命周期管理（彻底切换后必注入——invoke/entries 唯一写入面） */
    private readonly sendEntry?: SendEntry,
    /** F20260913ctlv 彻底切换：invoke 仓库（熔断摘要读 invoke_events） */
    private readonly invokeRepo?: InvokeRepository,
    /** F20260916fst4：可选注入，首哑信号消费时 dispatch 大獭——正常装配走 attachAgentDispatchService
     * setter（bootstrap 时序补偿）；构造直传仅供测试（缺省降级仅日志，不破坏既有测试构造调用） */
    agentDispatchService?: AgentDispatchService,
    /** F20260920uhuc：统一交接引擎函数包（bootstrap 注入；缺省时统一交接降级机械档案） */
    private readonly engine?: HandoffEngineDeps,
  ) {
    this.agentDispatchService = agentDispatchService;
    this.orchestrator = new AgentTurnOrchestrator(logger, metrics);
    this.circuitBreak = healingRepo && sendEntry
      ? new CircuitBreakSupport({
        manageSession,
        // F20260913ctlv 收尾批3：历史读取切 entries（user entry 唯一真相源）
        entryReader: {
          getEntries: async (convId: string, opts?: { entryType?: string; limit?: number }) =>
            sendEntry.getEntries(convId, opts),
        },
        // F20260913ctlv 彻底切换：sendSystem 走 entries（system entry），不再写 messages
        sendSystem: async (convId, body) => {
          const { entry } = await sendEntry.createSystemEntry({ conversationId: convId, body });
          // F20260921urdo 契约收口：投影补 createdAt
          return { id: entry.id, body: entry.body, sequenceNum: entry.sequenceNum, createdAt: entry.createdAt };
        },
        healingRepo,
        invokeRepo,
        logger,
        healthySessionThresholdMs,
        // F20260922handoff 审视严重1：熔断换世也清水位状态（与 unifiedHandoff 入口同语义）。
        onSessionRestarted: (id: string) => { this.handoffState.clearLastCtxTokens(id); },
      })
      : null;
  }

  // F20260916fst4：首哑信号消费依赖——AgentDispatchService 构建晚于 agentInvoker
  //（initPlatforms / app.ts setupFeishu 内各建一份），时序上无法构造注入。
  // 选定 setter 延迟挂接：装配完成后由调用方挂接首个可用实例（见 app.ts），
  // 对既有构造零侵入（agentDispatchService 为可选参数，缺省降级仅日志）。
  private agentDispatchService?: AgentDispatchService;

  /** F20260916fst4：装配后挂接 AgentDispatchService（bootstrap 时序补偿，见属性注释）。
   *  幂等：飞书/微信双通道装配时后挂接者覆盖前者——两实例的 dispatch 能力等价
   *  （同 dispatchChainEngine/entryRepo/agentInvokePort），覆盖无语义差异 */
  attachAgentDispatchService(service: AgentDispatchService): void {
    this.agentDispatchService = service;
  }

  /**
   * 驱动 Agent 对话：构建上下文 -> 创建 streaming 消息 -> invoke -> 事件映射 -> 完成/失败。
   * B7-B11 行为实现。
   *
   * streaming 事件通过 messageBroadcaster.broadcastEvent 统一推送给所有订阅者。
   * onSSEEvent 可选覆盖（测试用），默认走 broadcastEvent。
   *
   * F20260814mtrc：trace 兜底——已有链级 trace（DispatchChainEngine 注入）则直接执行；
   * 直连路径（scheduler/手动重试）生成新 traceId 并标记 source="direct"。
   */
  async invokeConversation(params: {
    otterId: string;
    conversationId: string;
    userMessageContent: string;
    senderId: string;
    onSSEEvent?: (event: SSEEvent) => void;
    retryCount?: number;
    /** F20260814mtrc：Web 手动重试标识（retry label 区分 manual/auto） */
    manualRetry?: boolean;
    /** 多模态 Phase 1：当前任务消息携带的图片（≤2 张，dispatch-chain 透传） */
    images?: Array<{ type: "image"; data: string; mimeType: string }>;
    /** F20260908rlcp：本批未读消息的最大 sequence_num（启动成功后推进游标用） */
    batchMaxSeq?: number;
  }): Promise<AgentTurnResult> {
    if (getTraceContext().traceId) {
      return this.invokeConversationInner(params);
    }
    return runWithTrace({ traceId: newTraceId(), source: "direct" }, () => this.invokeConversationInner(params));
  }

   
  // eslint-disable-next-line max-lines-per-function, max-statements, complexity -- F20260913ctlv 双路径迁移期；F20260920uhuc 轮边界水位触发器 +3 语句（时机权回收应用层）；F20260921otcl +invoke.start 身份透传 1 分支；F20260922handoff 水位写回 +2 语句（max-statements 覆盖已与 main(#1094) 对齐）
  private async invokeConversationInner(params: {
    otterId: string;
    conversationId: string;
    userMessageContent: string;
    senderId: string;
    onSSEEvent?: (event: SSEEvent) => void;
    retryCount?: number;
    manualRetry?: boolean;
    images?: Array<{ type: "image"; data: string; mimeType: string }>;
    batchMaxSeq?: number;
  }): Promise<AgentTurnResult> {
    const { otterId, conversationId, userMessageContent, onSSEEvent, retryCount = 0, images, batchMaxSeq } = params;
    const startTime = Date.now();

    // 统一事件推送：优先用 onSSEEvent 覆盖（测试），默认走 broadcastEvent
    const emitEvent = onSSEEvent ?? ((event: SSEEvent): void => {
      if (this.messageBroadcaster) {
        this.messageBroadcaster.broadcastEvent(conversationId, event);
      }
    });

    // 记录 Agent 调用开始日志
    this.logger.info('Agent invocation started', {
      otterId,
      conversationId,
      messageLength: userMessageContent.length,
      ...(retryCount > 0 && { retryCount }),
    });

    /**
     * F20260920uhuc：水位交接触发器（invoke 轮边界检查——时机权从 Pi 钩子收回应用层）。
     *
     * 写回语义变为「换 session 交接」后，Pi 钩子内换 session 是竞态地狱（#896 同构：
     * 外层 invoke 持锁+池引用），故时机权收回：每轮 invoke 开始前查上轮 ctxTokens，
     * 超过该獭模型的交接阈值（ctxTokens > handoffThresholdTokens，2026-09-20 需求变更：
     * 按模型直给已用 token 绝对值，旧全局 compactionReserveTokens 预留制退役）即执行统一交接。
     *
     * 检查密度取舍（F20260903cmpk 反向）：从 Pi 每轮 LLM 调用边界降为 invoke 轮边界，
     * 轮内工具循环暴涨可能漏检——补偿 = SDK overflow 兜底（reserve=50K 贴溢出点，
     * U1 验证 overflow 判定独立于 reserve）。
     */
    if (this.shouldTriggerWatermarkHandoff(otterId)) {
      this.logger.info('[handoff] watermark exceeded at invoke boundary, starting unified handoff', {
        otterId, conversationId,
        lastCtxTokens: this.handoffState.getLastCtxTokens(otterId),
        threshold: this.ctxWindowProvider?.getOtterHandoffThresholdTokens(otterId),
      });
      try {
        await this.unifiedHandoff(otterId, conversationId, { trigger: '水位', synthesizePast: true });
      } catch (err) {
        // F20260922handoff 审视严重3修正：交接失败（含 inProgress 撞车 conflict——
        //  交接窗口内本獭 invoke 正是「重启后 30 秒内发言」主场景）不杀本消息——
        //  D9 同源：交接失败永不阻塞 invoke，照常走当前世。conflict 除外？不，
        //  水位入口的 conflict 只可能来自另一路交接已在进行（手动/熔断），本消息
        //  照旧执行是最安全的降级（旧世上下文继续，下轮再检水位）。
        this.logger.warn('[handoff] watermark handoff failed at invoke boundary, continuing with current session', {
          otterId, conversationId, error: err instanceof Error ? err.message : String(err),
        });
      }
      // 交接完成后继续本 invoke——新世 session 由 restartSession 建立，本消息成为新世首个输入，
      // 起始档案经 dynamicContext（buildDynamicContext 读新 session.summary + 借用式 context）注入
    }

    this.logger.debug('Building dynamic context', { otterId });
    /** F20260818cbkr 二级触发：invoke 前按 healing_events 推导，命中先重启（消息尚未创建，重启后摘要随新 invoke 注入） */
    await this.circuitBreak?.maybeSecondaryCircuitBreak(otterId, conversationId);
    const dynamicContext = await this.buildDynamicContext(otterId, conversationId);
    // F20260826mwrd C3（Part 4）：高危 healing 事件提醒——仅 big 獭消费（编排者处置义务），
    // small 獭 invoke 不取队列（队列滞留，大獭下轮补提醒）。失败不阻断主流程（台账在，提醒可再等）。
    // otterType 查询与下方 otter 复用：此处仅取 type，会话中 otter 主体仍在 streaming 消息创建后取。
    const otterType = (await this.queryOtter.getById(otterId))?.type;
    if (otterType === 'big') {
      const alerts = healingAlertRegistry.takeAll(conversationId);
      if (alerts.length > 0) {
        dynamicContext.healingAlerts = renderHealingAlerts(alerts);
        this.logger.info('Healing high alerts injected', { otterId, conversationId, count: alerts.length });
      }
    }
    this.logger.debug('Dynamic context built', { otterId, hasSummary: !!dynamicContext.sessionSummary, hasWorkspace: !!dynamicContext.workspacePath });

    this.logger.debug('Creating invoke (timeline model)', { otterId, conversationId });
    const otter = await this.queryOtter.getById(otterId);

    // F20260913ctlv 彻底切换：不再创建 streaming 主 message（messages 表停写 UI 消息）。
    // invoke 开始 = createInvoke + invoke_start entry + invoke.start SSE（唯一路径，失败硬抛）
    const { invoke, invokeStartEntry } = await this.sendEntry!.createInvoke({
      conversationId,
      otterId,
    });
    const currentInvokeId = invoke.id;
    const resolvedOtterName = resolveSpeakerName("otter", otterId, otter?.name) ?? otterId;
    // SSE: invoke.start（triggerEntryId = invoke_start entry id——时间线居中条目与 invoke 关联）
    // F20260921otcl：otter 实体在手则透传出生色（闭包透传，零额外查询；otter 为 null（已解散等）时缺省，前端展示回退）
    emitEvent({ event: "invoke.start", data: { invokeId: invoke.id, otterId, otterName: resolvedOtterName, conversationId, startedAt: invoke.startedAt, triggerEntryId: invokeStartEntry.id, otterType: otter?.type, otterColor: otter?.color ?? null } });
    this.logger.info('Invoke created', { invokeId: invoke.id, otterId, conversationId });

    // F20260814mtrc：invokeId 进 trace scope（onEvent 回调与收尾日志自动携带）
    return runWithTrace({ messageId: currentInvokeId }, async () => {
      // F20260819rscn: 用闭包捕获自重启信号（orchestrator 不透传未知字段）
      // F20260908efmd: 扩展 modelAlias 字段——配额耗尽时应急切模型
      let pendingSelfRestart: { otterId: string; summary?: string; modelAlias?: string; synthesizePast?: boolean } | undefined;

      // 创建 AttemptDriver 和 TurnCallbacks
      const driver = this.createAttemptDriver(otterId, conversationId, dynamicContext, emitEvent, { otterName: otter?.name, otterType: otter?.type, otterColor: otter?.color ?? null, onSelfRestart: (signal) => { pendingSelfRestart = signal; }, images, batchMaxSeq, currentInvokeId });
      // F20260913ctlv 彻底切换：invoke 态回调（无 failMessage→abort SDK 联动——handleAutoRetry 同 invoke 重试不再杀 session）
      const callbacks = this.createTurnCallbacks(emitEvent, otterId);

      const turnInput = this.buildTurnInput(params, currentInvokeId, startTime);

      // 委托给 orchestrator 执行（#764 审视 A1：观测窗清理进 finally——classifyExit/
      // routeByReason 在 executeTurn 的 try 外，DB 抖动上抛时普通清理会被跳过，
      // 长生命周期单例逐 turn 泄漏）
      let turnResult: Awaited<ReturnType<typeof this.orchestrator.executeTurn>>;
      try {
        turnResult = await this.orchestrator.executeTurn(turnInput, driver, callbacks);
      } finally {
        // #764：turn 结束清理 retry 观测窗（归因消费已发生在 executeTurn 内）
        this.retryContextByInvoke.delete(turnInput.invokeId);
      }

      /**
       * F20260818cbkr 一级熔断：orchestrator 上抛熔断信号（executeTurn 循环内不消费）→
       * restart + 写 circuit_break 事件 + 全新 invoke（新入口重新 buildDynamicContext，前情摘要随新 session.summary 注入）。
       */
      const retried = await this.handleCircuitBreakSignal(turnResult, params, emitEvent);
      if (retried) return retried;

      /**
       * F20260916fst4：首哑信号消费（_circuitBreak 之后——circuit break 是系统级保护优先于场景级信号）。
       * fire-and-forget：首哑处置不嵌套当前 invoke（唤醒大獭走独立直连链），失败仅日志不影响当前收尾。
       */
      if (turnResult._firstDumb) {
        void this.handleFirstDumbSignal(turnResult._firstDumb);
      }

      /**
       * F20260819rscn 自重启信号：LLM 调用 restart_otter(self) 后，SDK 标记信号不执行 restart，
       * 由 agent-invoker 执行 restart + 全新 invoke（獭继续工作）。
       * Why 对齐 handleCircuitBreakSignal 模式：restart 后必须递归调用 invokeConversationInner，
       * 新 session 的 summary 仅在入口 buildDynamicContext 注入一次。
       */
      if (pendingSelfRestart) {
        const selfRestarted = await this.handleSelfRestartSignal(pendingSelfRestart, params, currentInvokeId);
        if (selfRestarted) return selfRestarted;
      }

      // F20260920uhuc 死链修复：水位状态写回（此前 setLastCtxTokens 零调用 →
      // shouldTriggerWatermarkHandoff 永远 false → 水位交接从未触发）。ctxTokens 来自
      // turn 内 message_end usage（右栏实时口径同公式），换世后首 invoke 读不到 usage
      // 属自然语义（新世上下文为空）。
      const lastCtxTokens = driver._lastCtxTokens;
      if (lastCtxTokens !== undefined && Number.isFinite(lastCtxTokens)) {
        this.handoffState.setLastCtxTokens(otterId, lastCtxTokens);
      }
      return {
        invokeId: turnResult.invokeId,
        messageId: turnResult.invokeId, // F20260913ctlv：兼容字段——链引擎过渡期仍读 messageId，值 = invokeId
        duration: turnResult.duration,
        tokenUsage: turnResult.tokenUsage,
      };
    });
  }

  /** 创建 AttemptDriver：包装 SdkInvokePort（F20260913ctlv：currentInvokeId 必传） */
  private createAttemptDriver(
    otterId: string,
    conversationId: string,
    dynamicContext: DynamicContext,
    emitEvent: (event: SSEEvent) => void,
    opts: { otterName?: string; otterType?: string; otterColor?: string | null; onSelfRestart?: (signal: { otterId: string; summary?: string; synthesizePast?: boolean }) => void; images?: Array<{ type: "image"; data: string; mimeType: string }>; batchMaxSeq?: number; currentInvokeId: string },
  ): AttemptDriver {
    /** F20260922handoff 建议1：ctxTokens 旁路盒——TurnResult 不带 ctxTokens，闭包直改
     *  外部 let 不可行，driver 对象生命周期覆盖整个 turn，invokeConversationInner 收尾处
     *  读 driver._lastCtxTokens（类型上显式可选字段）写回 handoffState 水位状态。 */
    const ctxTokensBox = { value: undefined as number | undefined };
    const driver: AttemptDriver = {
      invoke: async (input: TurnInput, onEvent: (event: AgentStreamEvent) => void) => {
        const toolStarts = new Map<string, number>();
        /** toolCallCount 透传盒——handleStreamEvent 提取后闭包直改外部 let 不再可行，改盒式引用 */
        const countBox = { count: 0 };

        this.logger.debug('Calling agentInvoke.invoke', { otterId: input.otterId, invokeId: input.invokeId });
        const result = await this.agentInvoke.invoke(input.otterId, input.userMessageContent, {
          dynamicContext,
          conversationId: input.conversationId,
          messageId: input.invokeId, // SDK 层 messageId 语义 = abort/guard 键控（invokeId 承担）
          currentInvokeId: opts.currentInvokeId,
          emitEvent,
          ...(opts?.images && { images: opts.images }),
          batchMaxSeq: opts?.batchMaxSeq,
          onEvent: (e: AgentStreamEvent) => this.handleStreamEvent(e, input, otterId, emitEvent, opts, toolStarts, countBox, onEvent, conversationId),
        });
        // F20260920uhuc 死链修复：invoke 结果 ctxTokens 写盒（水位状态数据源）
        ctxTokensBox.value = result.ctxTokens;
        // F20260819rscn: SDK 标记了自重启信号时，通知调用方（闭包捕获）
        if (result._selfRestart) opts?.onSelfRestart?.(result._selfRestart);
        return { result: result as unknown as InvokeResultShape, toolCallCount: countBox.count };
      },

      abort: (otterId: string, invokeId?: string) => {
        this.userAbortedMessages.add(invokeId ?? '');
        this.agentInvoke.abort(otterId, invokeId);
      },

      getInternalAbortReason: (invokeId: string) => {
        return this.agentInvoke.getInternalAbortReason(invokeId);
      },

      getToolCallCount: (otterId: string, invokeId: string) => {
        return this.agentInvoke.getToolCallCount(otterId, invokeId);
      },

      isUserAborted: (invokeId: string) => {
        return this.userAbortedMessages.has(invokeId);
      },

      getRetryErrorMessage: (invokeId: string) => {
        return this.retryContextByInvoke.get(invokeId);
      },
    };
    // F20260922handoff 建议1：ctxTokens 旁路盒经 defineProperty 挂 driver——AttemptDriver
    //  类型已显式声明 _lastCtxTokens 可选字段，消除消费侧 cast。
    Object.defineProperty(driver, '_lastCtxTokens', {
      get: () => ctxTokensBox.value,
      configurable: true,
    });
    return driver;
  }

  /** F20260913ctlv 彻底切换：系统消息唯一落点 = entries（system entry），messages 停写 */
  /** invoke 持久化回调集（createTurnCallbacks 拆分）：直透 send-entry 用例层 */
  private makeInvokePersistenceCallbacks(): Pick<TurnCallbacks,
    'getInvokeById' | 'updateInvokeStatus' | 'updateInvokeTalkingStonePassedTo'
    | 'updateInvokeTokenUsage' | 'updateInvokeModel' | 'createInvokeEndEntry'
  > {
    const sendEntry = this.sendEntry!;
    return {
      getInvokeById: async (invokeId: string) => {
        const invoke = await sendEntry.getInvokeById(invokeId);
        return invoke ? { status: invoke.status, toolCallCount: invoke.toolCallCount, talkingStonePassedTo: invoke.talkingStonePassedTo } : null;
      },

      updateInvokeStatus: async (invokeId: string, status: 'completed' | 'failed' | 'aborted') => {
        await sendEntry.updateInvokeStatus(invokeId, status);
      },

      updateInvokeTalkingStonePassedTo: async (invokeId: string, targets: string[]) => {
        await sendEntry.updateInvokeTalkingStonePassedTo(invokeId, targets);
      },

      updateInvokeTokenUsage: async (invokeId: string, input: number, output: number, cacheRead?: number, cacheWrite?: number) => {
        await sendEntry.updateInvokeTokenUsage(invokeId, input, output, cacheRead, cacheWrite);
      },

      updateInvokeModel: async (invokeId: string, model: string) => {
        await sendEntry.updateInvokeModel(invokeId, model);
      },

      createInvokeEndEntry: async (invokeId: string, status: 'failed' | 'aborted', body?: string): Promise<{ entryId: string; body: string } | undefined> => {
        const invoke = await sendEntry.getInvokeById(invokeId);
        if (!invoke) return undefined;
        const { invokeEndEntry } = await sendEntry.createInvokeEndEntry({
          conversationId: invoke.conversationId,
          invokeId,
          otterId: invoke.otterId,
          status,
          body,
        });
        return { entryId: invokeEndEntry.id, body: invokeEndEntry.body ?? '' };
      },
    };
  }

  private async sendSystemEntry(convId: string, body: string) {
    const sendEntry = this.sendEntry!;
    const { entry } = await sendEntry.createSystemEntry({ conversationId: convId, body });
    this.logger.debug('System entry sent', { entryId: entry.id, conversationId: convId });
    // F20260921urdo 契约收口：投影补 createdAt（SSE 载荷必含字段）
    return { id: entry.id, body: entry.body, sequenceNum: entry.sequenceNum, createdAt: entry.createdAt };
  }

  /** 创建 TurnCallbacks：invoke 生命周期 + SSE 事件推送（F20260913ctlv 彻底切换：全部 invoke 化）
   *  invoke 持久化回调收编 makeInvokePersistenceCallbacks（F20260914usgm 拆分守 max-lines） */
  private createTurnCallbacks(
    emitEvent: (event: SSEEvent) => void,
    otterId?: string,
  ): TurnCallbacks {
    return {
      ...this.makeInvokePersistenceCallbacks(),

      emitInvokeEnd: (invokeId: string, status: 'completed' | 'failed' | 'aborted', duration: number, stats?: { toolCallCount?: number; tokenUsage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }; invokeEndEntryId?: string; endBody?: string; otterName?: string; otterType?: string; otterColor?: string | null }) => {
        emitEvent({ event: 'invoke.end', data: { invokeId, otterId: otterId ?? '', status, duration, endedAt: new Date().toISOString(), toolCallCount: stats?.toolCallCount, tokenUsage: stats?.tokenUsage, invokeEndEntryId: stats?.invokeEndEntryId, endBody: stats?.endBody, otterName: stats?.otterName, otterType: stats?.otterType, otterColor: stats?.otterColor ?? null } });
      },

      recordHealingEvent: async (input: HealingEventInput) => {
        if (!this.circuitBreak) return;
        await this.circuitBreak.recordHealingEvent(input);
      },

      // #731：bounce 计数查询——直透 CircuitBreakSupport（无 healingRepo 时 circuitBreak 为 null，
      // 拋错交由 orchestrator fail-closed 升级；不静默返回 0，防「降级配置下无限回发」）
      getRecentGuardBounces: async (otterId: string, windowMs: number) => {
        if (!this.circuitBreak) throw new Error('guard bounce count unavailable: healing repo not configured');
        return this.circuitBreak.countRecentGuardBounces(otterId, windowMs);
      },

      isCircuitBreakerEnabled: () => !!this.circuitBreak,

      isSessionCircuitBreakCreated: async (otterId: string) => {
        return this.circuitBreak ? this.circuitBreak.isSessionCircuitBreakCreated(otterId) : false;
      },

      sendSystem: (convId: string, body: string) => this.sendSystemEntry(convId, body),

      getOtterById: async (otterId: string) => {
        const otter = await this.queryOtter.getById(otterId);
        return otter ? { name: otter.name, type: otter.type, color: otter.color } : null;
      },

      // F20260916fst4：首哑判定数据源——invokeRepo 缺省时拋错由 orchestrator fail-open
      // 降级（detectFirstDumb 外层 catch，回到现状静默终链）
      getInvokeCount: async (conversationId: string, otterId: string) => {
        if (!this.invokeRepo) throw new Error('invoke count unavailable: invoke repo not configured');
        const invokes = await this.invokeRepo.getInvokes(conversationId, { otterId });
        return invokes.length;
      },

      getPartnerLabel: async () => {
        return this.settingsRepo ? ((await this.settingsRepo.get(USER_DISPLAY_NAME_KEY))?.trim() || '搭档') : '搭档';
      },

      emitEvent,

      logger: this.logger,

      metrics: this.metrics,
    };
  }

  /**
   * F20260814mtrc：流事件埋点——工具调用/耗时/错误、SDK 自动重试、compaction。
   * 工具按 toolCallId 配对计时（对齐 circuit-breaker 的防御式配对）。
   */
  private recordStreamEventMetrics(e: AgentStreamEvent, toolStarts: Map<string, number>): void {
    if (!this.metrics) return;
    try {
      this.recordStreamEventMetricsInner(e, toolStarts);
    } catch (err) {
      /** PR 审视修复：onEvent 在 SDK 事件分发通道内同步执行，metrics 异常绝不能打断事件流 */
      this.logger.warn('stream event metrics failed (non-fatal)', {
        eventType: e.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private recordStreamEventMetricsInner(e: AgentStreamEvent, toolStarts: Map<string, number>): void {
    if (!this.metrics) return;
    switch (e.type) {
      case "tool_execution_start": {
        this.metrics.recordToolCall(String(e.name ?? e.toolName ?? "unknown"));
        const toolCallId = e.toolCallId as string | undefined;
        if (toolCallId) toolStarts.set(toolCallId, Date.now());
        break;
      }
      case "tool_execution_end": {
        const tool = String(e.name ?? e.toolName ?? "unknown");
        this.recordToolEndMetric(e, tool, toolStarts);
        break;
      }
      case "auto_retry_start":
        this.metrics.recordRetry("sdk_auto");
        break;
      case "compaction_end":
        this.metrics.recordCompaction(String(e.reason ?? ""), e.aborted === true);
        break;
      default:
        break;
    }
  }

  /** 工具执行结束：按 toolCallId 配对计时 + 顶层 isError 错误计数 */
  private recordToolEndMetric(e: AgentStreamEvent, tool: string, toolStarts: Map<string, number>): void {
    const toolCallId = e.toolCallId as string | undefined;
    const start = toolCallId !== undefined ? toolStarts.get(toolCallId) : undefined;
    if (toolCallId !== undefined && start !== undefined) {
      this.metrics?.recordToolDuration(tool, Date.now() - start);
      toolStarts.delete(toolCallId);
    }
    /** 错误标志在事件顶层（result.isError 成功路径被 SDK 硬编码 false） */
    if (e.isError === true) this.metrics?.recordToolError(tool);
  }

  /**
   * #764：retry 观测窗生命周期。
   * auto_retry_start：捕获 backoff 的底层错误（429 等）——backoff 期间 abort 时 err 通道
   * 拿不到 errorMessage，exit 分类从这里取归因上下文。
   * auto_retry_end(success=true)：retry 成功 = backoff 等待已结束、LLM 恢复干活——观测窗
   * 必须清空，否则陈旧 429 原文在「retry 成功后干活 N 分钟用户才 abort」（常态时机）时被
   * 误回填为「底层错误：429」（审视 S1）——陈旧误归因比无归因更误导。
   * 只在 success===true 时清：abort 打断 backoff 时 SDK 也发 auto_retry_end(success:false)，
   * 无条件清会把正确归因一起清掉。
   */
  private trackRetryWindow(e: AgentStreamEvent, invokeId: string): void {
    if (e.type === "auto_retry_start") {
      const errorMessage = (e as { errorMessage?: unknown }).errorMessage;
      if (typeof errorMessage === "string" && errorMessage) {
        this.retryContextByInvoke.set(invokeId, errorMessage);
      }
    } else if (e.type === "auto_retry_end" && (e as { success?: unknown }).success === true) {
      this.retryContextByInvoke.delete(invokeId);
    }
  }

  /** F20260913ctlv 彻底切换：流式事件处理（SSE 转发 + speak entry 发射 + invoke_events 持久化 + 计数）
   *  F20260914rtsp：message_end → invoke.tick（右栏 ctx/工具计数实时化）+ ctx_window_used 落库 */
  // eslint-disable-next-line max-params, complexity, max-statements -- 事件管线需要完整上下文；事件分发本质是多分支；F20260922wbfx +compaction 失败上浮分支
  private handleStreamEvent(
    e: AgentStreamEvent,
    input: { invokeId: string },
    otterId: string,
    emitEvent: (event: SSEEvent) => void,
    opts: { otterName?: string; otterType?: string; otterColor?: string | null; currentInvokeId: string },
    toolStarts: Map<string, number>,
    toolCallCountBox: { count: number },
    onEvent: (e: AgentStreamEvent) => void,
    conversationId?: string,
  ): void {
    this.logger.debug('Agent event received', { invokeId: input.invokeId, eventType: e.type, toolName: e.name ?? e.toolName });
    this.recordStreamEventMetrics(e, toolStarts);
    this.trackRetryWindow(e, input.invokeId);
    // F20260922wbfx：SDK 压缩失败上浮——compaction_end 携带 errorMessage 时 warn 留痕。
    // 9/22 事故实证：18:40 SDK threshold 压缩触发但摘要失败，compaction_end(errorMessage)
    // 走 _emit 普通订阅通道到达本处，但 otter 侧只记 metrics 不读 errorMessage——呼救被静默吞掉。
    // （session_compact_failed 走 extension 通道，subscribe 收不到，errorMessage 是唯一可达信号。）
    if (e.type === "compaction_end") {
      const errorMessage = (e as { errorMessage?: unknown }).errorMessage;
      if (typeof errorMessage === "string" && errorMessage) {
        this.logger.warn('SDK compaction failed', {
          invokeId: input.invokeId,
          otterId,
          reason: (e as { reason?: unknown }).reason,
          errorMessage,
        });
      }
    }
    if (e.type === "tool_execution_start") {
      toolCallCountBox.count++;
    }
    /** 结构化事件如实推送（agent.retry / compaction）；流式过程事件已停发（只落 invoke_events） */
    const sse = mapToSSEEvent(e);
    if (sse) {
      emitEvent({ event: sse.event, data: { ...sse.data, invokeId: input.invokeId } });
    }
    if (e.type === "tool_execution_end" && (e.name ?? e.toolName) === "speak") {
      this.logger.debug('speak tool executed', { invokeId: input.invokeId });
      // F20260913ctlv 彻底切换 + 语义清理：speak 是原子工具调用（无流式生命周期）——
      // 落库即 completed，单事件 entry.speak 携带全量 body 一次性渲染完整气泡。
      // entry.start 伪事件已退役（原与 entry.speak 背靠背同数据发射，纯为模拟不存在的占位生命周期）。
      const speakDetails = (e.result as { details?: { entryId?: string } } | undefined)?.details;
      if (speakDetails?.entryId) {
        const resolvedName = resolveSpeakerName("otter", otterId, opts?.otterName) ?? otterId;
        const entryId = speakDetails.entryId as string;
        const body = String((speakDetails as { body?: unknown }).body ?? "");
        // F20260921urdo 契约收口：sequenceNum/createdAt 必含——已读游标与排序数据源（缺席即红点僵死）
        const sequenceNum = (speakDetails as { sequenceNum?: number }).sequenceNum;
        const createdAt = (speakDetails as { createdAt?: string }).createdAt;
        emitEvent({ event: "entry.speak", data: { entryId, invokeId: opts.currentInvokeId, otterId, body, otterName: resolvedName, otterType: opts.otterType, otterColor: opts.otterColor ?? null, ...(sequenceNum != null && { sequenceNum }), ...(createdAt && { createdAt }) } });
      }
    }
    // F20260913ctlv 彻底切换：流式过程唯一存储 = invoke_events（message_events 停写）
    // F20260914evdz：落库后广播 invoke.event（弹窗实时观察）——需 otterId/conversationId 路由上下文
    this.persistInvokeEvent(e, opts.currentInvokeId, { otterId, conversationId });
    // F20260914rtsp：message_end → invoke.tick（ctx 窗口占用快照 + 工具计数，右栏实时化）
    if (e.type === "message_end") {
      this.emitInvokeTick(e, { otterId, conversationId, invokeId: opts.currentInvokeId, toolCallCount: toolCallCountBox.count }, emitEvent);
    }
    // 传递事件给 orchestrator
    onEvent(e);
  }

  /** F20260914rtsp：message_end 提取 usage → 发射 invoke.tick + ctx_window_used 落库。
   *  usage.totalTokens = input+output+cacheRead+cacheWrite（实测 pi session jsonl 验证，不含 reasoning）。
   *  usage 缺失（SDK 版本差异/部分 provider 不报）→ 静默不发射，右栏显示 '—' 兑底（AT-11）。 */
  private emitInvokeTick(
    e: AgentStreamEvent,
    ctx: { otterId: string; conversationId?: string; invokeId: string; toolCallCount: number },
    emitEvent: (event: SSEEvent) => void,
  ): void {
    const usage = extractMessageEndUsage(e);
    if (usage == null) return;
    const ctxWindowUsed = usage.totalTokens ?? (usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
    if (!Number.isFinite(ctxWindowUsed) || ctxWindowUsed <= 0) return;
    const ctxMax = this.getCtxMax(ctx.otterId);
    if (ctx.conversationId) {
      emitEvent({ event: "invoke.tick", data: { invokeId: ctx.invokeId, otterId: ctx.otterId, conversationId: ctx.conversationId, ctxWindowUsed, ctxMax, toolCallCount: ctx.toolCallCount } });
    }
    // 落库（刷新恢复用）：失败静默降级——右栏仅丢实时性，不影响主流程
    this.sendEntry?.updateInvokeCtxWindowUsed(ctx.invokeId, ctxWindowUsed).catch((err: unknown) => {
      this.logger.warn(`Failed to persist ctx_window_used for ${ctx.invokeId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** F20260913ctlv：流式事件同步落 invoke_events（Session 弹窗数据源）+ 工具计数递增 */
  private persistInvokeEvent(e: AgentStreamEvent, invokeId: string, ctx?: { otterId?: string; conversationId?: string }): void {
    const sendEntry = this.sendEntry;
    if (!sendEntry) return;
    const ievt = mapToInvokeEventInput(e);
    if (ievt) sendEntry.appendInvokeEvent(invokeId, ievt.eventType, ievt.payload).then((saved: unknown) => {
      /** F20260914evdz：落库成功后广播 invoke.event（Session 弹窗观察模式）。
 *  广播是 fire-and-forget 增量通道：落库才是真相源，弹窗重新打开时全量拉取补齐。
 *  主界面不渲染此事件（弹窗独享）——不会引起主界面 re-render */
      const s = saved as { id?: string; sequenceNum?: number; createdAt?: string } | null;
      if (s?.id != null && s.sequenceNum != null) {
        this.messageBroadcaster?.broadcastEvent(ctx?.conversationId ?? "", {
          event: "invoke.event",
          data: {
            invokeId,
            otterId: ctx?.otterId ?? "",
            conversationId: ctx?.conversationId,
            event: {
              id: s.id,
              eventType: ievt.eventType,
              payload: ievt.payload,
              sequenceNum: s.sequenceNum,
              createdAt: s.createdAt ?? new Date().toISOString(),
            },
          },
        });
      }
    }).catch((err: unknown) => {
      const m = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to persist invoke event for ${invokeId}: ${m}`);
    });
    if (e.type === "tool_execution_start") {
      sendEntry.incrementInvokeToolCallCount(invokeId).catch(() => {});
    }
  }

  /** 中断 Agent 生成（UA-2: 调用 SdkInvokePort.abort()）；F20260913ctlv：标记按 invokeId 键控 */
  abort(otterId: string, invokeId: string): void {
    this.userAbortedMessages.add(invokeId);
    this.agentInvoke.abort(otterId, invokeId);
  }

  /** 构建 DynamicContext：会话摘要（前情）。记忆召回由 agent 通过 search_memory tool 主动触发。
   *  F20260922ctxi：换世首轮注入——sessionSummary/workspacePath 仅在新世首轮注入（session 尚无
   *  user 消息），后续轮次历史里已有原文，不再重复拼接（实测每轮重复 ~780 字符逐字节相同）。
   *  F20260818cbkr 红线不破：熔断 restart / 水位交接后都是新 session（无 user 消息）→ 首轮注入 ✓ */
  private async buildDynamicContext(
    otterId: string,
    conversationId: string,
  ): Promise<DynamicContext> {
    const ctx: DynamicContext = {};

    // F20260922ctxi：首轮判定。entries 门面缺失（mock/旧装配）或读取失败 → 保守视为首轮（宁重复不丢失）
    const isFirstTurn = await this.probeFirstTurn(otterId);

    try {
      let session = await this.manageSession.getActiveSession(otterId);
      if (!session) {
        /**
         * F20260805rsto 兜底：agent 会话存在但 domain 账本缺失（存量獭/异常路径）时补登记，
         * 保证「有 agent 会话 ⟹ 有 active domain session」，restart/dissolve 不再空操作。
         * 挂在这是因此处每次 invoke 本来就查一次 getActiveSession，零额外读放大，
         * 且 web/飞书/定时任务全部汇入本 invoker。
         *
         * #753 源头堵漏：backfill 前查 otter 状态——dissolved 獭不得建行。
         * PR #749 修的是路由器不再点火 dissolved，但本兜底是另一入口：任何触达 dissolved
         * 獭的 invoke 路径都会在此产生幽灵 otter_sessions 行（S2 事故实证，6b1042ae）。
         * dissolved 獭 invoke 本身就是异常，让后续路径因无 session 自然报错，不静默补账。
         */
        const otter = await this.queryOtter.getById(otterId).catch(() => null);
        if (otter && otter.status !== 'active') {
          this.logger.warn('Skip domain session backfill for non-active otter', {
            otterId, otterStatus: otter.status, action: 'session_backfill_rejected',
          });
        } else {
        try {
          session = await this.manageSession.createSession(otterId);
          this.logger.info('Backfilled missing domain session on invoke', { otterId, action: 'session_backfill' });
        } catch (backfillErr) {
          /**
           * 并发补登记撞 conflict 属良性（他人已建）；其余失败必须留痕——
           * 兜底坏掉的唯一表现是 restart 再次静默空操作（F20260805rsto 原 bug 复发）。
           */
          this.logger.warn('Domain session backfill failed, re-reading active session', {
            otterId,
            error: backfillErr instanceof Error ? backfillErr.message : String(backfillErr),
          });
          session = await this.manageSession.getActiveSession(otterId).catch(() => null);
        }
        }
      }
      if (session?.summary && isFirstTurn) {
        ctx.sessionSummary = session.summary;
      }
    } catch (err) {
      this.logger.warn(`Session lookup failed for otter ${otterId}, degrading to no-session context:`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // F20260825hndf：从 otter_context 恢复交接上下文（借用式，消费即删）
    await restoreHandoffContext(otterId, ctx, this.manageContext, this.logger);

    // F20260922ctxi：工作区路径恒定不变，同归首轮注入组（移自 invokeConversation 的每轮注入）
    if (isFirstTurn) {
      await this.injectWorkspacePath(ctx, conversationId);
    }

    return ctx;
  }

  /** 构建 TurnInput。F20260818cbkr：originalUserMessage 单独保留——retry 会覆写 userMessageContent 为系统提醒文案，熔断摘要必须取原始消息 */
  private buildTurnInput(
    params: { otterId: string; conversationId: string; userMessageContent: string; senderId: string; retryCount?: number; manualRetry?: boolean },
    invokeId: string,
    startTime: number,
  ): TurnInput {
    const { otterId, conversationId, userMessageContent, senderId, retryCount = 0, manualRetry = false } = params;
    return {
      otterId,
      conversationId,
      invokeId,
      userMessageContent,
      originalUserMessage: params.userMessageContent,
      senderId,
      retryCount,
      manualRetry,
      attemptStartTime: startTime,
    };
  }

  /** 注入对话工作区路径到 DynamicContext */
  private async injectWorkspacePath(ctx: DynamicContext, conversationId: string): Promise<void> {
    if (!this.workspaceGateway) return;
    const ok = await this.workspaceGateway.exists(conversationId);
    if (ok) {
      ctx.workspacePath = this.workspaceGateway.getWorkspacePath(conversationId);
    }
  }
  /**
   * F20260920uhuc：统一交接入口——所有触发场景（水位/手动/自重启/熔断）的单一 handoff 动作。
   *
   * 时序（方案「交接时序」节，同步原子 + 冻结窗口）：
   * T_start: 取 per-otter 锁（等当前 turn 结束），持锁至交接完成——窗口内该獭
   *          invoke 全部锁排队（冻结：旧世不接新单），档案切片在此刻锁定（快照一致）。
   * 窗口内:  原料收集（jsonl 切片 + 状态盘点 + prefetch）→ synthesizePast 时影子通道合成
   *          （不触锁不入池）→ 组装叠加式档案。
   * T_done:  restartSession 换世（reason 按场景）→ 释放锁 → 排队消息由新世消化。
   *
   * 降级链（D9 不变量：交接失败永不阻塞重启）：
   * - 合成失败/超时/空/截断 → 机械转储档案（buildMechanicalArchive），照样换世
   * - synthesizePast=false → 跳过合成，档案 = 自总结（必有）+ 机械档案
   * - jsonl 空/缺失 → 同上（首哑复活场景前世为空）
   * - restartSession 失败 → 补偿删除借用式 context，错误上抛（调用方决定重试）
   */
  // eslint-disable-next-line max-statements, complexity, max-lines-per-function -- 统一交接：持锁+原料收集+合成+降级链+换世同内聚（拆分会割裂 T_start 快照一致性——原料必须在持锁后同一闭包内收集）
  private async unifiedHandoff(
    otterId: string,
    conversationId: string,
    params: {
      trigger: '水位' | '手动' | '自重启' | '熔断' | '首哑复活';
      selfSummary?: string;
      synthesizePast: boolean;
      modelAlias?: string;
      /** 锁策略：默认 'acquire'（交接窗口持锁冻结并发 invoke）。'none' 跳过取锁——
       *  历史遗留（#1049 水位路径曾传 'none' 认为外层 invoke 持锁，经 F20260922handoff 审视
       *  核实锁在 invoke 收尾 finally 已释放），现所有触发路径均用默认/'acquire'，
       *  'none' 仅存留作防御性选项，调用方不应再使用。 */
      lockMode?: 'acquire' | 'none';
      /** F20260920uhuc 需求变更（2026-09-20）：交接进度系统消息通道（前端 entry.system SSE 消费）。
       *  缺省 true；测试可注入 false 关闭。 */
      progressEntry?: boolean;
    },
  ): Promise<OtterSession> {
    const { trigger, selfSummary, synthesizePast, modelAlias, lockMode = 'acquire', progressEntry = true } = params;

    // 防重入（同獭并发交接：手动重启连点 / 水位与手动撞车）
    if (this.handoffState.isInProgress(otterId)) {
      throw new DomainError(`[handoff] already in progress for ${otterId}`, "conflict");
    }
    this.handoffState.setInProgress(otterId, true);
    // F20260922handoff 审视严重1修正：换世统一在入口清水位状态（任何 await 前）——
    //  无论后续走合成/机械/降级/裸重启哪条路径，换世后都不残留旧世 ctxTokens，
    //  防误触发水位二次换世。此前 clearLastCtxTokens 在 restartSession 成功后，
    //  降级/异常路径绕过 → 残留。
    this.handoffState.clearLastCtxTokens(otterId);

    /** 交接进度系统消息（需求变更 2026-09-20：等待要有反馈）。失败静默——UX 反馈不阻塞交接主线。 */
    /** F20260922handoff 审视严重2残余修正：otterDisplay 求值加容错——queryOtter.getById
     *  抛错时模板实参求值（在 try 外）会泄漏 inProgress → 永久 409。fallback 到 otterId
     *  兜底（进度消息降级为「獭 <id>」），异常不穿透 sendProgress 调用点。 */
    const otterDisplay = async (): Promise<string> => {
      try {
        const o = await this.queryOtter.getById(otterId);
        return o ? `${o.type === 'big' ? '大獭' : '小獭'}「${o.name}」` : otterId;
      } catch {
        return otterId;
      }
    };
    const sendProgress = async (body: string): Promise<void> => {
      if (!progressEntry) return;
      try {
        const sysMsg = await this.sendSystemEntry(conversationId, body);
        this.messageBroadcaster?.broadcastEvent(conversationId, {
          event: 'entry.system', data: { entryId: sysMsg.id, content: sysMsg.body, sequenceNum: sysMsg.sequenceNum, createdAt: sysMsg.createdAt },
        });
      } catch (err) {
        this.logger.warn('[handoff] progress entry failed (non-fatal)', {
          otterId, conversationId, error: err instanceof Error ? err.message : String(err),
        });
      }
    };
    if (progressEntry) {
      await sendProgress(`⏳ ${await otterDisplay()}的上下文已满（${trigger}触发），正在封装前世档案…（预计 5-15 秒，最长约 1 分钟）`);
    }

    // 冻结窗口：持锁直到交接完成。所有触发路径均走 'acquire'（严重5修正后）——
    //  invoke 锁在收尾 finally 已归还，「外层持锁」不是事实。
    // F20260922handoff 审视严重2修正：acquireSessionLock 挪进 try——此前在 try 外，
    //  超时抛错时 finally 的 setInProgress(false) 不执行（try/finally 尚未进入），该獭
    //  永久 409 conflict（acquireSessionLock 超时路径正是本 PR 激活的）。
    let releaseLock: (() => void) | undefined;
    try {
      if (lockMode === 'acquire' && this.agentInvoke.acquireSessionLock) {
        releaseLock = await this.agentInvoke.acquireSessionLock(otterId);
      }

      // ---- 原料收集（持锁后快照一致）----
      const workspacePath = this.workspaceGateway?.getWorkspacePath(conversationId);
      const [lineageInfo, inventoryText, prefetch, slice] = await Promise.all([
        this.resolveHandoffLineage(otterId),
        this.collectInventoryText(conversationId, otterId, workspacePath),
        this.buildSynthesisPrefetch(conversationId, otterId),
        this.collectJsonlSlice(otterId),
      ]);

      // 机械档案四件（秒级，必有）：近期保留段（jsonl 切片序列化，对齐 Pi keepRecent 20K）
      // + 状态盘点 + 文件轨迹 + 谱系
      const recencyWindow = slice ? this.engine!.serializeKeptWindow(slice) : await this.collectRecencyWindowFallback(conversationId);
      const fileTrail = workspacePath
        ? this.engine!.renderFileTrail({ modified: [], readOnly: [], workspaceFiles: this.engine!.scanWorkspaceFiles(workspacePath) })
        : '';

      // ---- 叙事合成（synthesizePast=true 时；影子通道，不触锁）----
      // F20260923hsyn：死循环熔断——连续 ≥2 次交接失败则跳过合成直接机械档案
      // （9/23 压缩死亡链：失败后 continuing with current session → ctx 继续涨 → 再触发再失败）
      const priorFailures = this.handoffState.getConsecutiveFailures(otterId);
      const skipSynthesisByCircuitBreaker = synthesizePast && priorFailures >= 2;
      if (skipSynthesisByCircuitBreaker) {
        this.logger.warn('[handoff] synthesis circuit breaker open: consecutive failures >= 2, forcing mechanical archive', {
          otterId, trigger, priorFailures,
        });
      }
      let narrativeSummary: string | undefined;
      if (synthesizePast && !skipSynthesisByCircuitBreaker && slice && slice.messagesToSummarize.length + slice.turnPrefixMessages.length > 0) {
        try {
          const prompt = this.engine!.buildNarrativeSynthesisPrompt({
            otterName: (await this.queryOtter.getById(otterId))?.name ?? otterId,
            oldSessionId: lineageInfo.oldSessionId,
            trigger,
            messagesToSummarize: slice.isSplitTurn
              ? [...slice.messagesToSummarize, ...slice.turnPrefixMessages]
              : slice.messagesToSummarize,
            previousSummary: slice.previousSummary,
            lineage: lineageInfo.lineage,
            selfSummary,
            stateInventoryText: inventoryText,
            prefetch,
            // F20260923hsyn：预算裁剪（丢最老保最近）——目标窗口缺省时取合成模型覆盖值或该獭当前模型
            contextWindowTokens: this.resolveSynthesisContextWindow(otterId, modelAlias),
            // F20260924swin 观测锚：trim 日志（输入/固定段实测/预算/dropped/最终 prompt 长度）——
            //  「裁没裁」从此可查（9/24 生产 vs 探针数字偏差的定谳锚）。
            onTrim: (r) => this.logger.info('[handoff] synthesis trim', {
              otterId, trigger,
              inputChars: r.inputChars,
              measuredFixedChars: r.measuredFixedChars,
              historyBudgetChars: r.historyBudgetChars,
              droppedCount: r.droppedCount,
              promptChars: r.promptChars,
            }),
          });
          // F20260923hlck：合成后预检——trimMessagesToBudget 只裁历史段，previousSummary/§⑤ 状态盘点等
          //  固定段在大 session 可突破 10K token 预算假设（9/23 实测 546KB jsonl 裁剪后合成请求仍超窗，
          //  白等 96s 才 400，还全程拖着交接锁逼死后续 waiter）。超窗直接跳合成走机械档案，
          //  与合成失败同语义计一次失败——既有 ≥2 熔断机制会接管「固定段结构性超窗」的死亡链。
          // F20260924swin：预检与 trim 共享同一预算函数（synthesisFullBudgetChars，经引擎端口注入——
          //  层约束不 import frameworks 常量）。口径修正：预算对象 = 全文（与 trim 同一对象），
          //  不再各自口径（此前 trim 管历史段/预检比全文，trim 裁满的产物会被预检自拦）。
          const synthesisWindow = this.resolveSynthesisContextWindow(otterId, modelAlias);
          const budgetChars = synthesisWindow !== undefined
            ? this.engine!.synthesisFullBudgetChars(synthesisWindow)
            : undefined;
          const overWindow = budgetChars !== undefined && prompt.length > budgetChars;
          if (overWindow) {
            this.metrics?.recordSynthesis('error');
            this.handoffState.recordHandoffFailure(otterId);
            this.logger.warn('[handoff] prompt still over window after trim, skipping synthesis (mechanical archive)', {
              otterId, trigger,
              promptChars: prompt.length,
              budgetChars,
              consecutiveFailures: this.handoffState.getConsecutiveFailures(otterId),
            });
          } else {
            narrativeSummary = await this.runShadowSynthesis(otterId, prompt, modelAlias);
          }
        } catch (err) {
          this.metrics?.recordSynthesis('error');
          this.handoffState.recordHandoffFailure(otterId);
          this.logger.warn('[handoff] narrative synthesis failed, degrading to mechanical archive', {
            otterId, trigger, error: err instanceof Error ? err.message : String(err),
            consecutiveFailures: this.handoffState.getConsecutiveFailures(otterId),
          });
        }
      } else if (synthesizePast) {
        // jsonl 无可压缩内容（首哑前世/空 session）——合成跳过，机械档案完整覆盖
        this.logger.info('[handoff] no jsonl content to synthesize, mechanical archive only', { otterId, trigger });
      }

      // ---- 组装叠加式档案 + 换世 ----
      const archive = narrativeSummary
        ? this.engine!.assembleHandoffArchive({
          narrativeSummary,
          selfSummary,
          fileTrail,
          stateInventory: inventoryText,
          recencyWindow,
        })
        : this.engine!.buildMechanicalArchive({
          otterName: (await this.queryOtter.getById(otterId))?.name ?? otterId,
          trigger,
          oldSessionId: lineageInfo.oldSessionId,
          selfSummary,
          stateInventoryText: inventoryText,
          recencyWindow,
          fileTrail,
        });

      // D8 演进：档案走 session.summary 单点写入（不再预写 otter_context 借用式 key），
      // 天然原子——restart 失败无幽灵上下文泄漏，无需补偿删除
      const reason = trigger === '水位' ? 'compaction' : 'restart';
      // F20260923hspx：channel='handoff'——交接冻结锁已由本管线持有（unifiedHandoff 入口
      //  acquireSessionLock），换世的 archive→reset 必须走锁旁路（resetForHandoff），
      //  否则二次取同一把 per-otter 锁 = 自死锁（9/23 实证 4 獭连续「Lock acquire timeout」，
      //  holderHeldForMs 恂 ≈120s、queueLength=0——等的是自己）。
      const session = await this.manageSession.restartSession(otterId, archive, modelAlias, reason, 'handoff');
      // 水位状态已在 unifiedHandoff 入口统一清理（严重1修正），此处不再重复。
      // F20260923hsyn 审视严重1修正：熔断清零挂「合成成功」（narrativeSummary 非空）而非
      // 「交接成功」——死亡链场景每次交接都是「合成失败→机械档案→restart 成功」，清零挂交接成功
      // 会让计数永远到不了 2，熔断形同虚设。合成成功才清零（机械档案交接不清零，计数继续累积，
      // 下次交接直接跳过合成熔断分支生效）。
      if (narrativeSummary) {
        this.handoffState.clearHandoffFailures(otterId);
      }
      this.logger.info('[handoff] unified handoff completed', {
        otterId, trigger, synthesizePast, narrative: !!narrativeSummary,
        archiveTokens: Math.ceil(archive.length / 4), newSessionId: session.id,
      });
      // 完成 feedback（需求变更 2026-09-20）：档案形态告知（叙事/机械）——合成降级对用户可见
      await sendProgress(
        `✅ ${await otterDisplay()}前世已封存（${narrativeSummary ? '完整叙事档案' : '机械档案'}），新一世携带前世记忆开始`,
      );
      return session;
    } catch (err) {
      // 失败 feedback：仅上抛的失败发（降级链内部已吞的失败照常 done）。
      // sendProgress 自身失败静默（防反馈通道故障反噬主流程）
      if (progressEntry) {
        await sendProgress(`⚠️ 「${trigger}」交接未能完成，本次保持当前世代——可稍后重试或手动重启`).catch(() => { /* non-fatal */ });
      }
      throw err;
    } finally {
      releaseLock?.();
      this.handoffState.setInProgress(otterId, false);
    }
  }

  /** 水位判定：上轮 ctxTokens 超过该獭模型的交接阈值（按模型直给，2026-09-20 需求变更）。
   *  阈值无法解析（模型缺失/旧装配）时不触发——水位交接静默失活优于拿错阈值误触发。
   *  F20260922handoff 审视严重3修正：交接进行中（inProgress）短路不触发——交接窗口内
   *  本獭 invoke（「重启后 30 秒内发言」主场景）不该因旧世残留水位被判超阈值，且
   *  unifiedHandoff 自身的防重入会抛 conflict。
   *  F20260922wbfx：每次判定留痕（debug）——9/22 事故实证：大獭 ctx 261k 超 40k 阈值
   *  但水位从未触发且零日志，静态推演无法定位断在守卫链哪一环。防线放弃时必须可见。 */
  private shouldTriggerWatermarkHandoff(otterId: string): boolean {
    if (this.handoffState.isInProgress(otterId)) {
      this.logger.debug('[handoff] watermark check skipped: handoff in progress', { otterId });
      return false;
    }
    const last = this.handoffState.getLastCtxTokens(otterId);
    const threshold = this.ctxWindowProvider?.getOtterHandoffThresholdTokens(otterId);
    const triggered = last !== undefined && threshold !== undefined && last > threshold;
    this.logger.debug('[handoff] watermark check', { otterId, lastCtxTokens: last, threshold, triggered });
    return triggered;
  }

  /** F20260923hsyn：解析合成目标窗口——重启换模型时按目标模型（新世以新模型启动，
   *  合成 prompt 最终给的是新模型）；未换模型按该獭当前配置。缺省 undefined（不裁剪，向后兼容）。 */
  private resolveSynthesisContextWindow(otterId: string, modelOverride?: string): number | undefined {
    if (modelOverride) return this.ctxWindowProvider?.getContextWindowByAlias(modelOverride);
    return this.ctxWindowProvider?.getOtterContextWindow(otterId);
  }

  /** 影子通道合成 + fail-closed 防线（空/截断拒入库；超时降级机械档案——
   *  F20260923hsyn：超时为兜底异常语义 300s，防 LLM 卡死/网络挂起，不是质量闸门。
   *  实证分布（9/23 日志）：正常 20-65s，最大真实案例 146s；60s 会把大 session 正常合成误判超时。） */
  private async runShadowSynthesis(otterId: string, prompt: string, modelOverride?: string): Promise<string> {
    if (!this.agentInvoke.runCompactionSynthesis) {
      throw new Error('runCompactionSynthesis not available on SdkInvokePort');
    }
    const result = await Promise.race([
      this.agentInvoke.runCompactionSynthesis(otterId, prompt, modelOverride),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Narrative synthesis timeout')), this.engine?.synthesisTimeoutMs ?? 300_000),
      ),
    ]);
    const text = result.directText?.trim() ?? '';
    // length-stop fail-closed（借鉴 Pi getSummarizationFailure）：截断摘要不完整，不得入库
    if (result.lastStopReason === 'length') {
      this.metrics?.recordSynthesis('truncated');
      throw new Error('LLM synthesis truncated (stopReason=length), refusing to persist incomplete summary');
    }
    if (text.length === 0) {
      this.metrics?.recordSynthesis('empty');
      throw new Error('LLM synthesis returned empty result');
    }
    this.metrics?.recordSynthesis('success');
    return text;
  }

  /** jsonl 切片收集（U2 落地：SDK prepareCompaction 未导出，自实现同款算法）。
   *  entries 读取门面缺失（mock/旧装配）或空 session 返回 undefined → 机械档案降级 */
  private async collectJsonlSlice(otterId: string): Promise<EngineJsonlSlice | undefined> {
    try {
      const entries = await this.agentInvoke.readCurrentSessionEntries?.(otterId);
      if (!entries) return undefined;
      return this.engine?.sliceSessionEntries(entries as never);
    } catch (err) {
      this.logger.warn('[handoff] jsonl slice failed, degrading', {
        otterId, error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /** 近期原文降级收集（jsonl 不可读时用 DB entries 近期窗口——机械档案兜底，非完整 agent 视角） */
  private async collectRecencyWindowFallback(conversationId: string): Promise<string> {
    try {
      const reader = this.handoffEntryReader();
      const [speaks, users] = await Promise.all([
        reader.getEntries(conversationId, { entryType: 'speak', limit: 20 }),
        reader.getEntries(conversationId, { entryType: 'user', limit: 20 }),
      ]);
      const merged = [...speaks, ...users]
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, 20)
        .reverse();
      if (merged.length === 0) return '';
      return merged
        .map(e => `[${e.entryType === 'user' ? '搭档' : '海獭'}]: ${(e.body ?? '').slice(0, 500)}`)
        .join('\n');
    } catch {
      return '';
    }
  }

  /** 状态盘点文本收集（DB 权威源机械快照；依赖未注入/查询失败降级空文本，不阻塞交接） */
  private async collectInventoryText(conversationId: string, otterId: string, workspacePath?: string): Promise<string> {
    try {
      if (!this.conversationRepo) return '';
      const deps = this.buildStateInventoryDeps(conversationId, workspacePath);
      const inventory = await this.engine!.collectStateInventory(conversationId, otterId, deps);
      return this.engine!.renderStateInventory(inventory);
    } catch (err) {
      this.logger.warn('[handoff] state inventory failed, continuing without', {
        conversationId, error: err instanceof Error ? err.message : String(err),
      });
      return '';
    }
  }

  /**
   * 审视 P2/P1：stateInventoryDeps 的统一构造（三条路径共用，消除重复）。
   *  F20260913ctlv 收尾批1：历史读取切 entries（entryReader = sendEntry.getEntries 窄面）。
   */
  private buildStateInventoryDeps(conversationId: string, workspacePath?: string): StateInventoryDeps {
    return {
      entryReader: this.sendEntry ?? this.queryMessageCompatEntryReader(),
      conversationRepo: this.conversationRepo!,
      scheduledTaskRepo: this.scheduledTaskRepo,
      healingRepo: this.healingRepo ?? undefined,
      listArtifacts: this.listArtifacts ? () => this.listArtifacts!(conversationId) : (async () => []),
      workspacePath,
      logger: this.logger,
    };
  }

  /** F20260913ctlv：entries 读取器（sendEntry 注入时直接用；旧装配降级空读——不回 messages） */
  private handoffEntryReader(): HandoffEntryReader {
    return this.sendEntry ?? {
      getEntries: async () => [],
    };
  }

  /** state-inventory 降级兼容：sendEntry 缺失时返回空读（历史 reading 已全部切 entries） */
  private queryMessageCompatEntryReader(): HandoffEntryReader {
    return { getEntries: async () => [] };
  }

  /**
   * F20260901mbfx（审计 F2/F3）：交接谱系机械解析。
   *
   * 从当前 active session 的 summary（上一代交接时写入）提取既有谱系行
   * （`- genN xxx:` 格式，每代一行只追加），并返回真实 session ID。
   * 查询失败不阻塞交接（返回 undefined，合成端 gen1 重建谱系）——谱系是增强
   * 信息，不是交接硬依赖（D9 同源原则）。
   */
  private async resolveHandoffLineage(otterId: string): Promise<{ oldSessionId?: string; lineage?: string }> {
    try {
      const active = await this.manageSession.getActiveSession(otterId);
      if (!active) return {};
      // 从旧 summary 提取谱系行：匹配「- genN 开头」的行（kimi 模板 §⑦ 格式）。
      // 历史兼容：旧代未带 gen 标记时提取不到，视为谱系断档，新代从 gen1 重建。
      const lineage = (active.summary ?? '')
        .split('\n')
        .filter(l => /^\s*-\s*gen\d+\s/.test(l))
        .map(l => l.trim())
        .join('\n');
      return {
        oldSessionId: active.id,
        lineage: lineage.length > 0 ? lineage : undefined,
      };
    } catch (err) {
      this.logger.warn('[handoff] Lineage resolve failed, continuing without', {
        otterId, error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }

  /**
   * F20260901mbfx（审计 F1/F5）：合成 §④/⑥ 机械预取。
   *
   * 枚举型事实机械供料（判据：必然准确的给机制）：context keys、active 产物清单、
   * 最近搭档消息原文。全部容忍失败（返回部分数据或 undefined），不阻塞交接。
   */
  private async buildSynthesisPrefetch(conversationId: string, otterId: string): Promise<SynthesisPrefetch | undefined> {
    const results = await Promise.allSettled([
      this.manageContext ? this.manageContext.get(otterId) : Promise.resolve({} as Record<string, string>),
      this.listArtifacts ? this.listArtifacts(conversationId) : Promise.resolve([] as LinkedResource[]),
      this.fetchRecentUserMessages(conversationId),
    ]);
    const prefetch: SynthesisPrefetch = {};
    if (results[0].status === 'fulfilled') prefetch.contextKeys = Object.keys(results[0].value);
    if (results[1].status === 'fulfilled') {
      prefetch.activeArtifacts = (results[1].value as Array<{ id: string; resourceType: string; title?: string; status?: string }>)
        .filter(a => !a.status || a.status === 'active')
        .map(a => ({ id: a.id, resourceType: a.resourceType, title: a.title }));
    }
    if (results[2].status === 'fulfilled' && results[2].value.length > 0) prefetch.recentUserMessages = results[2].value;
    return Object.keys(prefetch).length > 0 ? prefetch : undefined;
  }

  /**
   * F20260901mbfx：拉取最近 N 条用户（搭档）消息原文，时间正序。
   * 供合成 prompt §⑥ 机械预取——LLM 只负责挑选哪句是指令，不负责翻找。
   */
  private async fetchRecentUserMessages(conversationId: string, limit = 6): Promise<string[]> {
    try {
      // F20260913ctlv 收尾批1：切 entries（user entry body 即全文，无 segments 聚合）
      const entries = await this.handoffEntryReader().getEntries(conversationId, { entryType: 'user', limit });
      return entries
        .map(e => (e.body ?? '').trim())
        .filter(t => t.length > 0 && t.length <= 500)
        .reverse();
    } catch {
      return [];
    }
  }

  /**
   * F20260825hndf Phase 2：构建 LLM 叙事合成函数。
   *
   * 返回一个闭包，接收 prompt 字符串，返回 LLM 合成的摘要文本。
   * 内部调用 readOnly invocation（跳过消息持久化和 SSE 广播）。
   */
  private buildSynthesisFunction(otterId: string, conversationId: string): (prompt: string) => Promise<string> {
    return async (prompt: string): Promise<string> => {
      this.logger.info('[handoff-synthesis] Starting readOnly invocation', { otterId, conversationId });

      // 构建动态上下文（包含 session summary，但不包含件②③④——那些是给新 session 的）
      const dynamicContext: DynamicContext = {};

      // readOnly 调用：跳过消息持久化和 SSE 广播
      const result = await this.agentInvoke.invoke(otterId, prompt, {
        conversationId,
        dynamicContext,
        readOnly: true,
      });

      // F20260901dtfx：LLM 直出文本在 directText（turnText 缓冲，pi-session-factory
      // 在 invoke 结果组装后填充），result.text 是 buildInvokeResult 的占位空串——
      // 只读 text 会 100% 误判 empty result，把已生成的摘要扔进降级（Phase 2 上线
      // 后微信对话 3/3 合成全失败的根因）。fallback 链：directText → text → 失败。
      const synthesisText = result.directText?.trim() || result.text?.trim() || '';

      // F20260903lngth：length-stop fail-closed（借鉴 Pi getSummarizationFailure）。
      // 截断的摘要不抛错、非空、看似成功——直接写进 session.summary 会误导下一代海獭。
      // 与 Pi 同立场：截断摘要不许当 checkpoint，throw 走防线②机械转储降级。
      if (result.lastStopReason === 'length') {
        this.metrics?.recordSynthesis('truncated');
        throw new Error('LLM synthesis truncated (stopReason=length), refusing to persist incomplete summary');
      }

      if (synthesisText.length === 0) {
        this.metrics?.recordSynthesis('empty');
        throw new Error('LLM synthesis returned empty result');
      }

      this.metrics?.recordSynthesis('success');
      this.logger.info('[handoff-synthesis] Completed', {
        otterId,
        length: synthesisText.length,
        source: result.directText?.trim() ? 'directText' : 'text',
      });

      return synthesisText;
    };
  }

  /** F20260827he2f：healing_repo 健康探针——外部健康检查可调用，验证熔断事件落库能力 */
  async probeHealingRepo(): Promise<boolean> {
    return this.circuitBreak ? this.circuitBreak.probeHealingRepo() : false;
  }

  /**
   * F20260920uhuc：手动重启统一入口（取代 F20260917rsta 的 restartWithAutoHandoffIfBlank）。
   *
   * 语义变化（叠加式档案）：不再「有摘要直透/无摘要合成」二选一——
   * 新世起始上下文 = 优雅组织(引擎七段总结【按 synthesizePast】+ 自总结【如有】)。
   * 有无 selfSummary 都走统一管线（unifiedHandoff），这正是「底层完全一样」的最终形态。
   *
   * 忙碌拒绝（搭档拍板 2026-09-18 16:31）：running invoke 存在 → 409 DomainError，
   * 不进锁等待不排队——重启是干净动作（F20260917rsta 锁雪崩 500 的根治）。
   *
   * 降级链（D9 同源原则）：任何环节失败（无对话/引擎缺失/合成异常）→ 降级为
   * 无档案直透重启，永不阻塞 restart。
   */
  async restartWithUnifiedHandoff(
    otterId: string,
    params: {
      selfSummary?: string;
      synthesizePast?: boolean;
      modelAlias?: string;
    },
  ): Promise<OtterSession> {
    const { selfSummary, synthesizePast = true, modelAlias } = params;

    // 忙碌检查：running invoke 存在即拒绝（U3 口径：isRunning = activeSessions 或池内 streaming）
    if (this.agentInvoke.isRunning?.(otterId)) {
      this.logger.warn('[manual-restart] otter busy (running invoke), rejecting', { otterId });
      throw new DomainError(`Otter ${otterId} 正在执行任务（忙碌中），不允许手动重启，请稍后再试`, "conflict");
    }

    /** F20260922handoff 审视严重1修正：裸重启统一收口——换世必须清水位状态，
     *  否则旧世 ctxTokens 残留 → 下轮 invoke 误判超阈值 → 二次换世（幽灵世代）。
     *  所有 unifiedHandoff 之外的 restartSession 调用点（手动降级/自重启保底）必须走本 helper。 */
    const bareRestart = async (): Promise<OtterSession> => {
      this.handoffState.clearLastCtxTokens(otterId);
      const session = await this.manageSession.restartSession(otterId, selfSummary, modelAlias);
      // F20260923hlck：裸重启成功 = 换世完成，失败链已断——熔断计数清零。
      //  此前只 +1 永不清（clearHandoffFailures 只在合成成功时调），进程重启也不恢复
      //  （内存态），该獭会被永久熔断（9/23 实证：重启后仍反复交接失败）。
      // F20260923hspx 检视建议5 说明：清零仅发生在「降级裸重启成功」——即「交接管线已炸但
      //  换世本身成功」的场景；若裸重启也失败（异常上抛），本行不执行，计数保留。
      //  「失败+1→bare 成功清零」不会掩盖「换世本身连续失败」的信号（那是上抛路径）。
      this.handoffState.clearHandoffFailures(otterId);
      return session;
    };

    const conversationId = await this.resolveFirstConversationId(otterId);
    if (!conversationId) {
      this.logger.warn('[manual-restart] No conversation found, restarting bare', { otterId });
      return bareRestart();
    }

    try {
      return await this.unifiedHandoff(otterId, conversationId, {
        trigger: '手动',
        selfSummary,
        synthesizePast,
        modelAlias,
        lockMode: 'acquire',
      });
    } catch (err) {
      // 防重入冲突（已在交接中）与忙碌冲突原样上抛；其余失败降级裸重启（D9：永不阻塞）
      if (err instanceof DomainError && err.kind === 'conflict') throw err;
      // F20260923hsyn：降级路径计入失败熔断 + 留痕用户原始选择（synthesizePast 原值）
      const failures = this.handoffState.recordHandoffFailure(otterId);
      this.logger.warn('[manual-restart] unified handoff failed, degrading to bare restart', {
        otterId, error: err instanceof Error ? err.message : String(err),
        synthesizePast, consecutiveFailures: failures,
      });
      return bareRestart();
    }
  }

  /** F20260917rsta：取 otter 关联的第一个对话 ID（无对话时返回 undefined，不阻塞重启）
   *  经 manageSession.conversationQuery 窄接口（ConversationQueryGateway.getIdsByOtterId），
   *  不经 queryOtter（它只管 otter 元数据） */
  private async resolveFirstConversationId(otterId: string): Promise<string | undefined> {
    try {
      const ids = await this.manageSession.conversationQuery.getIdsByOtterId(otterId);
      return ids[0];
    } catch (err) {
      this.logger.warn('[manual-restart-auto] Conversation resolve failed', {
        otterId, error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /** F20260903cmpk：压缩钩子合成函数。
   *  F20260912nlb896（#896 + PR #897 检视严重 1）：合成**不走 invoke**——invoke 路径双重不可行：
   *  ①锁：钩子在 prompt 中途触发，外层持有 per-otter 锁，嵌套 invoke 再取同锁死锁（原 #896）；
   *  ②池：锁旁路后嵌套 invoke 在 `_acquirePooled` 必判外层 streaming session 为 stale 出池、
   *  冷启动 SessionManager.open 同一 jsonl 顶替池条目——压缩摘要 entry 与外层后续消息全部丢失，
   *  压缩永远不生效且上下文逐轮膨胀（比死锁更隐蔽）。
   *  影子通道：临时 inMemory session 直调 LLM——自包含合成 prompt 无需会话历史，
   *  不入池、不触锁、不写共享 jsonl，天然规避①②。
   *  与 handoff 合成同款的空结果/截断 fail-closed 防线保留（防线②机械转储降级）。 */
  buildCompactionSynthesisFn(otterId: string): (prompt: string) => Promise<string> {
    return async (prompt: string): Promise<string> => {
      this.logger.info('[compaction-synthesis] Starting shadow synthesis', { otterId });
      // 影子通道缺省（mock/测试注入的 port 未实现）→ 抛错由钩子降级 Pi 默认（fail-closed，与合成失败同路径）
      if (!this.agentInvoke.runCompactionSynthesis) {
        throw new Error('runCompactionSynthesis not available on SdkInvokePort');
      }
      const result = await this.agentInvoke.runCompactionSynthesis(otterId, prompt);
      const synthesisText = result.directText?.trim() ?? '';
      if (result.lastStopReason === 'length') {
        this.metrics?.recordSynthesis('truncated');
        throw new Error('LLM synthesis truncated (stopReason=length), refusing to persist incomplete summary');
      }
      if (synthesisText.length === 0) {
        this.metrics?.recordSynthesis('empty');
        throw new Error('LLM synthesis returned empty result');
      }
      this.metrics?.recordSynthesis('success');
      this.logger.info('[compaction-synthesis] Completed', { otterId, length: synthesisText.length });
      return synthesisText;
    };
  }

  /**
   * F20260825hndf→F20260901cxmw：解析 otter 实际模型的 contextWindow。
   *
   * 回退链：otter 配了 modelAlias → getContextWindow(alias)；
   * 没配 alias → 默认模型窗口（provider 闭包内 getContextWindow(undefined)）；
   * 查出 undefined / 0 / < 合理下限 → DEFAULT_CTX_MAX 兜底
   * （models-factory 注释实锤：contextWindow 缺省时 SDK 视为 0，会让阈值恒真）。
   *
   * 结果按 otterId 缓存：ModelPool 条目启动后不可变，仅默认 alias 可运行时切换
   * （settings 页），切换只影响新 session 的窗口口径，缓存可接受。
   */
  private getCtxMax(otterId: string): number {
    const cached = this.resolvedCtxMax.get(otterId);
    if (cached !== undefined) return cached;

    const window = this.ctxWindowProvider?.getOtterContextWindow(otterId);
    const usable = window !== undefined && window >= MIN_SENSIBLE_CTX_WINDOW;
    const resolved = usable ? window : DEFAULT_CTX_MAX;
    const source = usable ? 'model-pool' : 'fallback-128k';
    this.resolvedCtxMax.set(otterId, resolved);
    // 低噪声可观测：每 otter 仅首饮打一次，部署后 grep 该事件即可验证解析链路
    this.logger.info('[handoff] ctxMax resolved', { otterId, ctxMax: resolved, source });
    return resolved;
  }

  /** F20260922ctxi：换世首轮判定探针（抽离独立方法守 buildDynamicContext 复杂度门禁）。
   *  门面缺失（mock/旧装配）或读取失败 → 保守视为首轮（宁重复不丢失前情） */
  private async probeFirstTurn(otterId: string): Promise<boolean> {
    try {
      const entries = await this.agentInvoke.readCurrentSessionEntries?.(otterId);
      return entries ? shouldInjectSessionPreamble(entries) : true;
    } catch (preambleErr) {
      this.logger.warn('Session preamble probe failed, injecting conservatively', {
        otterId, error: preambleErr instanceof Error ? preambleErr.message : String(preambleErr),
      });
      return true;
    }
  }

  /**
   * F20260818cbkr：熔断信号处理。restart 成功 → 全新 invoke 的结果；未触发或降级返回 null。
   * 全新 invoke 是硬约束：sessionSummary 仅在 invokeConversation 入口 buildDynamicContext 注入一次，
   * orchestrator 内 continue 拿不到新 session 的前情摘要（详见 F20260818cbkr 实现红线）。
   */
  private async handleCircuitBreakSignal(
    turnResult: { _circuitBreak?: CircuitBreakInfo },
    params: {
      otterId: string;
      conversationId: string;
      userMessageContent: string;
      senderId: string;
      onSSEEvent?: (event: SSEEvent) => void;
      retryCount?: number;
      manualRetry?: boolean;
    },
    emitEvent: (event: SSEEvent) => void,
  ): Promise<AgentTurnResult | null> {
    if (!turnResult._circuitBreak || !this.circuitBreak) return null;

    // F20260920uhuc：熔断重启走统一交接（红线重审后放开合成——P1 定罪的「退化獭
    // 现场 invoke 合成」技术形态已消失：合成者是影子通道的干净 inMemory 引擎，
    // 读序列化 jsonl、fail-closed 防线、机械供料不依赖 jsonl 质量；熔断场景合成
    // 命中率预期低于水位/手动（GIGO 残余，方案红线重审节），失败自动降级机械档案）。
    // executeCircuitBreakRestart 内部走 manageSession.restartSession——档案先行注入
    // session.summary 由 unifiedHandoff 完成，此处取回它建立的新 session 供递归 invoke。
    let circuitHandoffSession: OtterSession | null = null;
    try {
      circuitHandoffSession = await this.unifiedHandoff(params.otterId, params.conversationId, {
        trigger: '熔断',
        synthesizePast: true,
        // F20260922handoff 审视严重5修正：lockMode 改 'acquire'——熔断发生在 orchestrator
        //  收尾，此时本 invoke 的 PiSessionFactory.invoke 锁已释放（finally 归还），传 'none'
        //  跳过取锁会让交接窗口失去冻结保护（另一 invoke 可闯入）。取 invoke 同源锁是正确的
        //  交接互斥保障。
        lockMode: 'acquire',
      });
    } catch (handoffErr) {
      // 统一交接失败不阻塞熔断：executeCircuitBreakRestart 内部降级裸重启
      this.logger.warn('[circuit-break] unified handoff failed, circuit-break restart degrades to bare', {
        otterId: params.otterId,
        error: handoffErr instanceof Error ? handoffErr.message : String(handoffErr),
      });
    }
    if (circuitHandoffSession) {
      // F20260920uhuc 审视发现1修复：unifiedHandoff 已完成唯一换世（新 session 携带四段叠加档案），
      // 不再执行 executeCircuitBreakRestart 的第二次 restartSession（会导致幽灵世代+档案被熔断摘要覆盖）。
      // 只补熔断终态事件（newSessionId 指向 unifiedHandoff 建立的新世），让熔断台账/查询完整。
      await this.circuitBreak.writeCircuitBreakEvent(turnResult._circuitBreak, {
        newSessionId: circuitHandoffSession.id,
        trigger: 'primary',
      }).catch((evErr) => {
        this.logger.warn('[circuit-break] handoff-path circuit event write failed (non-blocking)', {
          otterId: params.otterId,
          error: evErr instanceof Error ? evErr.message : String(evErr),
        });
      });
    } else {
      // unifiedHandoff 失败（已 warn）：降级走 executeCircuitBreakRestart 裸重启（内部自行降级链）
      const restarted = await this.circuitBreak.executeCircuitBreakRestart(turnResult._circuitBreak, emitEvent);
      if (!restarted) {
        return null;
      }
    }
    try {
      /** retryCount 归零：新 session 语义上等同新 invoke，首次退化应获得自我纠正机会而非直达熔断判定 */
      return await this.invokeConversationInner({ ...params, retryCount: 0, manualRetry: false });
    } catch (err) {
      /** 递归失败不掩盖已完成的熔断收尾：降级返回原 turnResult（消息已 failed，系统消息已发） */
      this.logger.error('Circuit break re-invoke failed, falling back to interrupted state', err instanceof Error ? err : new Error(String(err)), {
        otterId: params.otterId,
        conversationId: params.conversationId,
      });
      return null;
    }
  }

  /**
   * F20260819rscn + F20260824srst：自重启信号处理。
   * LLM 调用 restart_otter(self) 后，SDK 标记 _selfRestart 信号不执行 restart；
   * agent-invoker 执行 restart + 写 self_restart healing 事件 + 传 continuation message 递归 invoke。
   *
   * Why continuation message 而非原始消息：
   * "你重启自己"是一次性指令，执行一次即完成。递归调用时若传同一消息，
   * 新 session 的 LLM 会再次执行 → 无限循环。continuation message 告知"你已重启，请继续"，
   * 消除循环根因。tool-factory 层 + healing_events 上限判定提供纵深防御。
   */
  /** F20260922handoff 审视严重1：自重启裸重启保底——清水位状态再换世（同手动降级收口语义），
   *  防旧世 ctxTokens 残留 → 下轮 invoke 误判超阈值 → 二次换世。抽出以守 handleSelfRestartSignal
   *  max-statements 上限。 */
  private async selfRestartBareFallback(
    otterId: string,
    summary: string | undefined,
    modelAlias: string | undefined,
  ): Promise<OtterSession> {
    this.handoffState.clearLastCtxTokens(otterId);
    return this.manageSession.restartSession(otterId, summary, modelAlias);
  }

  // eslint-disable-next-line max-lines-per-function, complexity -- F20260920uhuc：自重启统一交接 + 防循环 + 裸重启保底 + continuation 递归（同内聚，拆分割裂降级链）
  private async handleSelfRestartSignal(
    signal: { otterId: string; summary?: string; modelAlias?: string; synthesizePast?: boolean },
    params: {
      otterId: string;
      conversationId: string;
      userMessageContent: string;
      senderId: string;
      onSSEEvent?: (event: SSEEvent) => void;
      retryCount?: number;
      manualRetry?: boolean;
    },
    currentMessageId: string,
  ): Promise<AgentTurnResult | null> {
    if (!signal) return null;
    const { otterId, summary } = signal;

    // F20260824srst 防循环（第二道防线）：当前 session 是否由自重启创建
    // F20260906srst（#811）：加意图来源维度——传 conversationId 检测用户消息介入，
    // 搭档显式指令的重启不再误拦（issue 现场：重启后搭档发过 2 条新指令仍被拦）
    if (this.circuitBreak) {
      const isSelfRestartSession = await this.circuitBreak.isSessionSelfRestartCreated(otterId, params.conversationId);
      if (isSelfRestartSession) {
        this.logger.warn('Self-restart blocked: current session was created by self-restart', { otterId });
        return null;
      }
    }

    let newSessionId: string;

    // F20260920uhuc：自重启走统一交接（synthesizePast 由工具参数透传——獭最清楚
    // 前世价值；summary=自总结作为叠加档案的 §① 意图书 + 合成原料）。
    // F20260824srst 防循环机制不变（本方法开头的 session 成因判定 + tool 层拦截）。
    try {
      const newSession = await this.unifiedHandoff(otterId, params.conversationId, {
        trigger: '自重启',
        selfSummary: summary,
        // 獭未传 summary 且前世有料时也合成（修复现状 gap：空 summary 自重启 = 从零开始）；
        // summary 非空时合成照跑——叠加档案语义：引擎档案【总有】+ 自总结【可能有】
        synthesizePast: signal.synthesizePast ?? true,
        modelAlias: signal.modelAlias,
        // F20260922handoff 审视严重5修正：lockMode 改 'acquire'——自重启信号虽在 invoke 收尾
        //  消费，但 PiSessionFactory.invoke 的锁在 finally 已归还（invoke 先于 signal 处理返回），
        //  传 'none' 跳过取锁会让交接窗口失去冻结保护。取 invoke 同源锁是正确的交接互斥保障。
        lockMode: 'acquire',
      });
      newSessionId = newSession.id;
      this.logger.info('Self-restart completed (unified handoff), re-invoking with new session', { otterId, newSessionId });
    } catch (handoffErr) {
      // 统一交接失败（含 jsonl 缺失等降级路径耗尽）→ 裸重启保底（D9：自重启永不阻塞）
      this.logger.warn('[self-restart] unified handoff failed, falling back to bare restart', {
        otterId, error: handoffErr instanceof Error ? handoffErr.message : String(handoffErr),
      });
      try {
        // F20260922handoff 审视严重1修正：裸重启保底也清水位状态（收口语义同手动降级）。
        const newSession = await this.selfRestartBareFallback(otterId, summary, signal.modelAlias);
        newSessionId = newSession.id;
      } catch (restartErr) {
        this.logger.error('Self-restart failed, continuing with current session', restartErr instanceof Error ? restartErr : new Error(String(restartErr)), { otterId });
        return null;
      }
    }

    // F20260824srst 写 self_restart 事件（上限判定数据源）
    if (this.circuitBreak) {
      await this.circuitBreak.writeSelfRestartEvent(otterId, params.conversationId, newSessionId, currentMessageId).catch(err => {
        this.logger.error('self_restart event write failed (non-fatal)', err instanceof Error ? err : new Error(String(err)), { otterId, newSessionId });
      });
    }

    try {
      // F20260824srst 传 continuation message 而非原始消息（消除循环根因）
      const continuationMessage = summary
        ? `[系统] 你已完成自重启。前情摘要：${summary}\n请基于前情摘要继续当前工作。如果没有明确任务，请告知搭档你已重启完成，等待新指令。`
        : `[系统] 你已完成自重启，前世上下文已封存。请告知搭档你已重启完成，等待新指令。`;
      return await this.invokeConversationInner({
        ...params,
        userMessageContent: continuationMessage,
        retryCount: 0,
        manualRetry: false,
      });
    } catch (reinvokeErr) {
      this.logger.error('Self-restart re-invoke failed, falling back to interrupted state', reinvokeErr instanceof Error ? reinvokeErr : new Error(String(reinvokeErr)), {
        otterId: params.otterId,
        conversationId: params.conversationId,
      });
      return null;
    }
  }

  /**
   * F20260916fst4：首哑信号处理——小獭首次 invoke 即配额型 429 终态时唤醒大獭处置。
   * 严格串行三步（方案时序保证：alert 入队必须先于 dispatch，否则大獭 buildDynamicContext 错过上下文）：
   * 1. enqueue firstDumb alert（C3 队列，大獭 takeAll 消费）
   * 2. await 写 system entry（搭档可见留痕）
   * 3. dispatch resolvedTargets 直连链点火大獭（fireDirectChain fire-and-forget 不嵌当前链）
   * 处置指令文本自包含——双通道冗余（alert 丢失时 userMessageContent 仍带全量上下文）。
   */
  private async handleFirstDumbSignal(signal: FirstDumbInfo): Promise<void> {
    try {
      // 无 dispatch 能力时提前降级（web-only 部署未挂接）——alert + system entry 仍执行，只跳过 Step 3。
      // Why 提前判定：原实现在 Step 3 对 undefined 做非空断言 `this.agentDispatchService!`，web-only
      // 部署首哑时会抛 TypeError 被外层 catch 吞为 error 日志——降级应是显式路径而非意外异常。
      const canDispatch = !!this.agentDispatchService;

      // Step 1：C3 高警入队（同步）——先于 dispatch，保证大獭 invoke 的 buildDynamicContext takeAll 能取到
      healingAlertRegistry.enqueue(signal.conversationId, {
        eventId: crypto.randomUUID(),
        conversationId: signal.conversationId,
        otterId: signal.otterId,
        errorType: "first_dumb",
        description: `[首哑告警] 小獭首次发言即配额耗尽（模型 ${signal.modelAlias}），已唤醒大獭处置`,
        createdAt: new Date().toISOString(),
      });

      // Step 2：system entry 留痕（搭档可见）——解析一次名字供本条与 dispatch 消息共用
      let otterName = signal.otterId;
      if (this.sendEntry) {
        const otter = await this.queryOtter.getById(signal.otterId);
        otterName = resolveSpeakerName("otter", signal.otterId, otter?.name) ?? signal.otterId;
        await this.sendSystemEntry(signal.conversationId, `[首哑告警] 小獭「${otterName}」（模型 ${signal.modelAlias}）首次发言即配额耗尽，已唤醒大獭处置`);
      }

      // Step 3：dispatch 大獭——查在场大獭，无则降级仅日志（healing 已落账，告警已发）
      if (!canDispatch) {
        this.logger.warn('[first-dumb] dispatch service not attached (web-only deploy?), degraded to alert+log-only', { conversationId: signal.conversationId });
        return;
      }
      const bigOtterIds = await this.resolveBigOtterIds(signal.conversationId);
      if (bigOtterIds.length === 0) return;

      const resetHintClause = signal.resetHint ? `，重置提示：${signal.resetHint}` : '';
      const dispatchMessage = `[首哑告警] 你新建的小獭「${otterName}」（模型 ${signal.modelAlias}）首次发言即配额耗尽（429 终态${resetHintClause}）。\n原派工任务：${signal.originalUserMessage}\n处置决策树：\n1. 首选 restart_otter(otterId, modelAlias=<可用fallback>, summary=<任务摘要>) 原地复活，然后重新 yield 派工；\n2. 无可用 fallback / restart 失败 → 升级搭档（附决策简报）；\n3. 复活后再次 429 → 走运行中路径，不再升级。`;
      await this.agentDispatchService!.dispatch({
        conversationId: signal.conversationId,
        userMessageContent: dispatchMessage,
        senderId: 'system',
        resolvedTargets: bigOtterIds,
      });
      this.logger.info('[first-dumb] big otter dispatched for first-dumb recovery', {
        otterId: signal.otterId,
        conversationId: signal.conversationId,
        bigOtterIds,
      });
    } catch (err) {
      // fire-and-forget：首哑处置失败仅日志——回到现状（healing 已落账），不阻断当前 invoke 收尾
      this.logger.error('[first-dumb] signal handling failed, falling back to silent terminal', err instanceof Error ? err : new Error(String(err)), {
        otterId: signal.otterId,
        conversationId: signal.conversationId,
      });
    }
  }

  /** F20260916fst4：查 conversation 在场大獭（依赖未注入 / 无大獭时降级仅日志，返回空数组） */
  private async resolveBigOtterIds(conversationId: string): Promise<string[]> {
    if (!this.conversationRepo) {
      this.logger.warn('[first-dumb] conversation repo not injected, skipping wake-up', { conversationId });
      return [];
    }
    const participants = await this.conversationRepo.getActiveParticipants(conversationId);
    const bigOtterIds: string[] = [];
    for (const p of participants) {
      const otter = await this.queryOtter.getById(p.otterId);
      if (otter?.type === 'big') bigOtterIds.push(p.otterId);
    }
    if (bigOtterIds.length === 0) {
      this.logger.warn('[first-dumb] no big otter in conversation, degraded to log-only', { conversationId });
    }
    return bigOtterIds;
  }
}
