/**
 * 熔断器相关的辅助函数
 */

import { ToolCallCircuitBreaker, buildToolSignature } from "./tool-call-circuit-breaker";
import type { CircuitBreakerConfig } from "./tool-call-circuit-breaker";
import type { Logger } from "@usecases/ports/logger";
import { getContextWindowTokens, getLastStopReason } from "./context-tokens";
import type { ModelPool } from "@frameworks/llm/model-pool";
import type { OtterConfigProvider } from "@usecases/ports/otter-config-provider";
import type { Model, Api } from "@earendil-works/pi-ai";
import { getConfig } from "@frameworks/config";
import type { OutputGuardConfig } from "./output-guard";
import { attachOutputGuard } from "./output-guard";
// F20261023ktru（#1069）：自有项目提醒里的正道脚本路径同走仓根绝对路径（外部项目 cwd 不可解析相对路径）
import { RESTART_SERVICE_SCRIPT } from "./kill-block-messages";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { checkBashCommandSafety, readMainProcessPid, SLEEP_REASON_PREFIX, stripSleepMarkerIfPresent } from "./bash-safety-guard";
import { loadAllowedServicePorts } from "./allowed-service-ports";

/**
 * #844（F20260914dsrv）：拦截文案动态附加 dev server 受控路径引导。
 * 守卫的静态文案只提供「worktree 隔离/告知搭档」两条路，对外部项目 dev server 重启类
 * 正当诉求失效（6 次变体重试实证）——本函数在拦截发生时检查端口白名单文件是否存在：
 *   - 已配置：提示用 restart-service 受控脚本 + 已声明的端口列表；
 *   - 未配置：提示 restart-service --add 现场声明路径（#1069），或搭档创建白名单文件。
 * 静态文案零改动（测试断言友好），追加段动态生成。IO 异常静默退化为原文案。
 *
 * #1207（F20260930l573）：引导改为命令感知——只在命令真实命中进程操作形态
 *（kill 族/lsof -ti/pkill/killall/restart-service 自身）时附加。此前无差别附加导致
 * 只读 python heredoc 探查被拦时文案里出现 dev-server 重启引导（issue #1207
 * 9/29 09:06 案例：判定层拦的是 heredoc patch 通道，引导层又叠了不相关建议，
 * 两条线索都没指向真实原因）。
 */
const PROCESS_OPS_SHAPE = /\b(?:p?kill|killall\d?|pgrep|skill|lsof)\b|restart-service/;

// F20261023ktru（#1069）：导出供单测覆盖指引分支（此前零测试覆盖，双分支相对路径漏网的根因）
export function appendDevServerGuidance(reason: string, projectRoot: string, command?: string): string {
  // 命令感知：非进程操作形态的拦截（heredoc 探查/重定向/主仓写等）不附加 dev-server
  // 引导——内容与拦截原因无关，只会误导排查方向。command 未传（历史调用方）保持旧行为。
  if (command !== undefined && !PROCESS_OPS_SHAPE.test(command)) return reason;
  try {
    const allowed = loadAllowedServicePorts(projectRoot);
    if (allowed.length > 0) {
      const ports = allowed.map(s => s.port).join("、");
      return `${reason}\n【自有项目 dev server】检测到端口白名单（已声明端口：${ports}）。重启自有项目 dev server 请用受控脚本：node ${RESTART_SERVICE_SCRIPT} <port>（脚本内部做 PID/cwd 校验后终止）；按 PID 终止自己起的进程（含非白名单端口）：node ${RESTART_SERVICE_SCRIPT} kill-by-pid <pid> --project /abs/path（#1540，--project 声明归属目录）；端口未声明且项目在 otter 工作根内的，可加 --project /abs/path --add 现场声明（#1069）。`;
    }
    return `${reason}\n【自有项目 dev server】如需重启自有项目的 dev server：node ${RESTART_SERVICE_SCRIPT} <port> --project /abs/path --add 可现场声明并重启（#1069，限 otter 工作根内项目，脚本内部做 PID/cwd 校验）；按 PID 终止自己起的进程：node ${RESTART_SERVICE_SCRIPT} kill-by-pid <pid> --project /abs/path（#1540，--project 声明归属目录）；范围外项目请搭档创建 ${projectRoot}/.otter/allowed-service-ports.json（格式见 docs/features/2026/09/14/ 下 F20260914dsrv 文档）。`;
  } catch {
    return reason;
  }
}

/** _attachGuards 所需的参数类型 */
export interface AttachGuardsParams {
  session: { subscribe: (fn: (event: unknown) => void) => () => void; abort: () => Promise<void> };
  sessionKey: string;
  otterId: string;
  activeSessions: Map<string, { abort: () => Promise<void>; toolCallCount: number; guardAbortReason?: string }>;
  circuitBreakerConfig: CircuitBreakerConfig;
  logger: Logger;
  /** F20260821i336：编排守卫检查函数（可选） */
  orchestrationCheck?: (toolName: string, args?: unknown) => string | null;
  /** F20260830bsgr：项目根目录（bash 安全守卫读 .otter-buddy.pid 用） */
  projectRoot?: string;
  /** F20261014cwsp：session 工作目录（invoke 时的对话工作区）——守卫落点判定基准 */
  sessionCwd?: string;
  /** F20261016gsbx 二期 2a/2b：沙箱 spawnHook 真实挂载决策（session 创建点绑定，R-2b）——
   *  true 时守卫 main_write 文件写族退役；不可用回位（降级不降安全）。 */
  sandboxGuarded?: boolean;
  /** F20260831aksp T3：bash 守卫拦截落 healing_events（框架层 medium 样本；fire-and-forget） */
  onGuardIntercept?: (input: { command: string; reason: string }) => void;
  /** F20261020hlbk（#1556）：per-turn 循环硬熔断标记（签名→理由）。检测器报警时写入，
   *  tool_call 门（loopBlockGuard）读到即物理阻断该工具后续调用。 */
  loopBlockedTools?: Map<string, string>;
  /** F20261026gobs delta-r1（检视獭1646 S3）：tool_call 门（bashGuardGate）激活探测——
   *  门激活时 bash 守卫判定由门单点拦下（显式 reason 落痕），abort 链不双拦
   *  （SDK signal.aborted 会覆盖门的 reason）；门失活时 abort 链兑底。 */
  guardGateActive?: () => boolean;
  /** F20261019gses P0 影子下线：onShadowEval（观察期对照回调）已删——主判定切
   *  evaluateWriteVerdict 后无「旧链 vs 新链」对照面。 */
}

/** _attachGuards 返回类型 */
export interface AttachGuardsResult {
  activeEntry: { abort: () => Promise<void>; toolCallCount: number; guardAbortReason?: string } | undefined;
  circuitBreaker: ToolCallCircuitBreaker;
  unregisterToolCall: (() => void) | undefined;
  outputGuard: { getMetadata: () => { totalLength: number; tripped: boolean; reason?: string; firstByteLatencyMs?: number }; armFirstByteTimer: (guardAbort: () => void) => void };
  cleanupOutputGuard: () => void;
  armFirstByte: () => void;
}

/** attachGuards：熔断器 + 输出退化检测 */
export function attachGuards(params: AttachGuardsParams): AttachGuardsResult {
  const { session, sessionKey, otterId, activeSessions, circuitBreakerConfig, logger } = params;
  const activeEntry = activeSessions.get(sessionKey);
  const timerRef: { clear: (toolCallId?: string) => void } = { clear: () => {} };
  const wrappedAbort = (reason?: string) => { timerRef.clear(); if (activeEntry && !activeEntry.guardAbortReason) activeEntry.guardAbortReason = reason ?? "internal_abort"; return session.abort(); };
  const { circuitBreaker, unregisterToolCall, clearEventTimer } = attachCircuitBreaker(session, otterId, circuitBreakerConfig, logger, { abortOverride: wrappedAbort, orchestrationCheck: params.orchestrationCheck, projectRoot: params.projectRoot, sessionCwd: params.sessionCwd, onGuardIntercept: params.onGuardIntercept, sandboxGuarded: params.sandboxGuarded, loopBlockedTools: params.loopBlockedTools, guardGateActive: params.guardGateActive });
  timerRef.clear = clearEventTimer;
  /** F20260804dglp：outputGuard 配置含 detector 参数与首字节超时；显式过滤 undefined 防覆盖默认值 */
  const cb = getConfig().circuitBreaker;
  const cfg: Partial<OutputGuardConfig> = {
    ...cb?.outputGuard,
    ...(cb?.streamingTimeoutMs !== undefined && { streamingTimeoutMs: cb.streamingTimeoutMs }),
    ...(cb?.firstByteTimeoutMs !== undefined && { firstByteTimeoutMs: cb.firstByteTimeoutMs }),
  };
  /** abort 返回 Promise：fire 路径无人 await，catch 防 unhandledRejection */
  const guardAbort = () => {
    void wrappedAbort(outputGuard.getMetadata().reason).catch((err: unknown) => {
      logger.warn(`[output-guard] abort 调用失败 otter=${otterId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  const { guard: outputGuard, cleanup: cleanupOutputGuard } = attachOutputGuard(session, otterId, cfg, logger, guardAbort);
  const armFirstByte = () => outputGuard.armFirstByteTimer(guardAbort);
  return { activeEntry, circuitBreaker, unregisterToolCall, outputGuard, cleanupOutputGuard, armFirstByte };
}

/** _buildInvokeResult 所需的参数类型 */
export interface BuildInvokeResultParams {
  otterId: string;
  session: { getSessionStats: () => { tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number } }; sessionManager: { getBranch: () => SessionEntry[] } };
  circuitBreaker: ToolCallCircuitBreaker;
  modelPool?: ModelPool;
  otterConfigProvider: OtterConfigProvider;
  model: Model<Api>;
  logger: Logger;
  getModelAliasForLog: (otterId: string) => string;
}

/** _buildInvokeResult 返回类型 */
export interface BuildInvokeResultResult {
  text: string;
  tokenUsage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  ctxTokens?: number;
  ctxMax?: number;
  circuitBreakerMetadata?: { totalCalls: number; circuitReason?: string };
  outputGuardMetadata?: { totalLength: number; tripped: boolean; reason?: string; firstByteLatencyMs?: number };
  modelAlias?: string;
  _selfRestart?: { otterId: string; summary?: string; modelAlias?: string; synthesizePast?: boolean };
  /** LLM 直出文本（未通过 speak 输出，对其他人不可见）。用于检测"旁白流失"失败形态 */
  directText?: string;
  /** 末条 assistant 消息的 stopReason（F20260903lngth：length=生成被 token 上限截断）。
   *  Pi SDK 对 length-stop 摘要 fail-closed（compaction.js getSummarizationFailure），
   *  本字段把截断信号带上结果边界，供合成链路做同样的完整性校验 */
  lastStopReason?: string;
}

/** buildInvokeResult：构建 invoke 结果 */
export function buildInvokeResult(params: BuildInvokeResultParams): BuildInvokeResultResult {
  const { otterId, session, circuitBreaker, modelPool, otterConfigProvider, model, getModelAliasForLog } = params;
  const stats = session.getSessionStats();
  /** F20260923icus（#1149）：cache token 随快照透传——SDK SessionStats.tokens 本含四字段，
   *  此前只取 input/output 致 cache 数据在 invoke 落库链上丢失（健康面板 invoke 均值口径缺 cache）。 */
  const tokenUsage = { input: stats.tokens.input, output: stats.tokens.output, cacheRead: stats.tokens.cacheRead, cacheWrite: stats.tokens.cacheWrite };

  /** F20260808ctxw：上下文窗口占用 = 末次有效 assistant 消息的 usage（input+output+cacheRead+cacheWrite），
   * 与 SDK compaction 判定同公式、同 compaction 边界语义；session 重建/compaction 后自然回落，不会虚增 */
  const ctxTokens = getContextWindowTokens(session.sessionManager.getBranch());

  // per-otter contextWindow
  let ctxMax: number | undefined;
  if (modelPool) {
    const otterConfig = otterConfigProvider.getConfig(otterId);
    ctxMax = modelPool.getContextWindow(otterConfig?.modelAlias);
  } else {
    ctxMax = model.contextWindow;
  }
  const result: BuildInvokeResultResult = buildResult("", tokenUsage, circuitBreaker, ctxMax, ctxTokens);
  /** F20260814mtrc：模型别名随结果透传（metrics model label 数据源） */
  result.modelAlias = getModelAliasForLog(otterId);
  /** F20260903lngth：截断信号透传——length-stop 不抛错，不带上边界则下游无法感知 */
  result.lastStopReason = getLastStopReason(session.sessionManager.getBranch());
  return result;
}

/** checkSessionError：检查 session 是否记录了 LLM API 错误 */
export function checkSessionError(session: { state: { errorMessage?: string } }, otterId: string, logger: Logger): void {
  const errorMessage = session.state.errorMessage;
  if (errorMessage) {
    logger.error('LLM API error detected after prompt', undefined, { otterId, errorMessage });
    throw new Error(`LLM API error: ${errorMessage}`);
  }
}

/** buildPromptResult 所需的参数类型 */
export interface BuildPromptResultParams {
  otterId: string;
  session: { getSessionStats: () => { tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number } }; sessionManager: { getBranch: () => SessionEntry[] } };
  circuitBreaker: ToolCallCircuitBreaker;
  outputGuard: { getMetadata: () => { totalLength: number; tripped: boolean; reason?: string; firstByteLatencyMs?: number } };
  activeEntry: { guardAbortReason?: string } | undefined;
  modelPool: ModelPool | undefined;
  otterConfigProvider: OtterConfigProvider;
  model: Model<Api>;
  logger: Logger;
  getModelAliasForLog: (otterId: string) => string;
}

/** buildPromptResult：prompt 成功后的结果组装 + 首字节延迟埋点日志 */
export function buildPromptResult(params: BuildPromptResultParams): BuildInvokeResultResult {
  const { otterId, session, circuitBreaker, outputGuard, activeEntry, modelPool, otterConfigProvider, model, logger, getModelAliasForLog } = params;
  const result = buildInvokeResult({ otterId, session, circuitBreaker, modelPool, otterConfigProvider, model, logger, getModelAliasForLog });
  const guardMeta = outputGuard.getMetadata();
  result.outputGuardMetadata = guardMeta;
  if (guardMeta.firstByteLatencyMs !== undefined) {
    logger.info('LLM first-byte latency', { otterId, firstByteLatencyMs: guardMeta.firstByteLatencyMs });
  }
  if (activeEntry?.guardAbortReason) (result as unknown as Record<string, unknown>)._guardAbortReason = activeEntry.guardAbortReason;
  return result;
}

/** 熔断器 tool_execution_start 钩子 */
// eslint-disable-next-line max-lines-per-function
export function attachCircuitBreaker(
  session: { subscribe: (fn: (event: unknown) => void) => () => void; steer?: (text: string) => Promise<void>; abort: () => Promise<void> },
  otterId: string,
  circuitBreakerConfig: CircuitBreakerConfig,
  logger: Logger,
  options?: { abortOverride?: (reason?: string) => void; orchestrationCheck?: (toolName: string, args?: unknown) => string | null; projectRoot?: string; sessionCwd?: string; onGuardIntercept?: (input: { command: string; reason: string }) => void; sandboxGuarded?: boolean; loopBlockedTools?: Map<string, string>; guardGateActive?: () => boolean },
): { circuitBreaker: ToolCallCircuitBreaker; unregisterToolCall: (() => void) | undefined; clearEventTimer: (toolCallId?: string) => void } {
  // F20260830bsgr：bash 安全守卫——读取主进程 PID
  // F20260830fabt-r2: 每次检查都实时读 PID 文件（不缓存），支持热重启换 PID
  const getMainPid = (): number | null => {
    return readMainProcessPid(options?.projectRoot ?? process.cwd());
  };
  const circuitBreaker = new ToolCallCircuitBreaker(circuitBreakerConfig, otterId, logger);
  const doAbort = options?.abortOverride ?? (() => { session.abort(); });

  // per-event 超时：只计单次工具执行时间（start → end），不覆盖工具间的 LLM 思考时间
  // 按 toolCallId 分别跟踪计时器，支持并行工具调用（issue #140）
  const eventTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const maxPerEventMs = circuitBreakerConfig.maxPerEventTimeMs;
  const clearEventTimer = (toolCallId?: string) => {
    if (toolCallId) {
      const timer = eventTimers.get(toolCallId);
      if (timer) { clearTimeout(timer); eventTimers.delete(toolCallId); }
    } else {
      // 清除所有计时器（用于 unregister 等场景）
      for (const timer of eventTimers.values()) clearTimeout(timer);
      eventTimers.clear();
    }
  };

  /** 通过 subscribe 拦截 tool_execution_start / tool_execution_end 事件实现熔断 */
  // eslint-disable-next-line complexity, max-statements
  const unregisterToolCall = session.subscribe((event: unknown) => {
    const e = event as { type?: string; toolCallId?: string; toolName?: string; name?: string; args?: unknown };
    if (e.type === "tool_execution_start") {
      const toolCallId = e.toolCallId;
      if (!toolCallId) {
        logger.warn(`[circuit-breaker] tool_execution_start missing toolCallId, skipping per-event timer`);
      } else {
        // 启动 per-event 计时器（按 toolCallId 独立跟踪，支持并行工具调用）
        clearEventTimer(toolCallId);
        const timer = setTimeout(() => {
          logger.warn(`[circuit-breaker] PER_EVENT_TIMEOUT: otter=${otterId} toolCallId=${toolCallId} elapsed=${maxPerEventMs}ms`);
          doAbort("circuit_break:event_timeout");
        }, maxPerEventMs);
        eventTimers.set(toolCallId, timer);
      }

      const toolName = e.toolName ?? e.name ?? "unknown";

      // F20260830bsgr：bash 安全守卫——拦截针对主进程的 kill 命令（早于工具执行）
      // #844：guardOptions 传入 projectRoot 供白名单热加载；拦截文案动态附加受控脚本引导
      // r1 发现 2 修复：去掉 `&& e.toolCallId` 收窄——缺 toolCallId 的 bash 事件
      // （SDK 边缘形态）不能整体跳过守卫；toolCallId 可选传递给 abortOnUnsafeBash
      if (toolName === "bash") {
        const args = (e.args ?? {}) as Record<string, unknown>;
        const command = typeof args.command === "string" ? args.command : "";
        const guardHit = abortOnUnsafeBash(command, e.toolCallId);
        if (guardHit === "aborted") return;
        // deferred（门接管显式拦下）不 return：继续熔断计数——重复被拦命令由循环熔断兑住
      }

      const result = circuitBreaker.check(toolName, e.args);
      // F20261020hlbk（#1556）：循环报警（steer/terminate）→ 粘滞标记，tool_call 门据此
      // 物理阻断后续同签名调用（硬熔断）。speak/yield 豁免（报告 + 交棒是唯一逃生口）。
      // 粘滞 Map 独立于 steerStrikes，穿插 speak（allow）不清零——堵死「复又发作」逃逸。
      if ((result.action === "steer" || result.action === "terminate") && toolName !== "speak" && toolName !== "yield") {
        options?.loopBlockedTools?.set(buildToolSignature(toolName, e.args), result.reason ?? "循环重复调用");
      }
      if (result.action === "terminate") {
        // terminate 时清除所有计时器（避免其他并行工具的计时器在 abort 后继续运行）
        clearEventTimer();
        doAbort(`circuit_break:${result.trigger ?? "unknown"}`);
        return;
      }
      if (result.action === "steer") {
        if (toolName !== "speak") session.steer?.(result.reason ?? "Stop calling tools. Call speak now."); // F20260806cbsx: speak 是回合出口，对其 steer 有害无益
        return;
      }

      // F20260821i336：编排对话软守卫——熔断器检查通过后，检查编排守卫条件
      if (options?.orchestrationCheck && toolName !== "speak") {
        const orchestrationWarning = options.orchestrationCheck(toolName, e.args);
        if (orchestrationWarning) {
          session.steer?.(orchestrationWarning);
          return;
        }
      }
    }
    if (e.type === "tool_execution_end") {
      // 工具执行完成，只清除该工具的计时器（LLM 思考时间不计入 per-event 超时）
      if (!e.toolCallId) {
        logger.warn(`[circuit-breaker] tool_execution_end missing toolCallId, skipping timer cleanup`);
      } else {
        clearEventTimer(e.toolCallId);
      }
    }
  });

  /** F20261019gses P0 影子下线：观察期对照机制（notifyShadowEval 影子记账）随转正删除——
   *  主判定已切 evaluateWriteVerdict，无「旧链 vs 新链」对照面。 */

  /** bash 守卫判定 + abort 发射（自 subscribe 回调拆出控复杂度）。
   *  F20260928slan：sleep 拦截（感知问题）与 kill 域（安全问题）前缀分流——守卫返回带
   *  SLEEP_REASON_PREFIX 标记的 reason 时发射 `bash_sleep:`，否则 `bash_safety:`。判定用
   *  startsWith（delta-3 备注：精确匹配，禁用 includes），此发射点是 `bash_sleep:` 的唯一产源（D5a）。
   *  F20261019gses P0 影子下线：onShadowEval 影子记账（观察期对照机制）已删。 */
  /** F20261026gobs delta-r1：拦截观测面（结构化日志 + healing）自 abortOnUnsafeBash 拆出——
   *  门接管后本函数仍被兑底链与门共用语义参照，拆出控圈复杂度不改行为。 */
  function recordGuardIntercept(command: string, reason: string, mainPid: number | null, kind: "sleep" | "safety"): void {
    logger.warn("[bash-safety-guard] BLOCKED dangerous bash command", {
      otterId,
      mainPid,
      kind,
      command: command.substring(0, 200),
    });
    // F20260831aksp T3：拦截落 healing（框架层 medium 样本；失败不阻断拦截本身）
    options?.onGuardIntercept?.({ command, reason });
  }

  function abortOnUnsafeBash(command: string, toolCallId?: string): "aborted" | "deferred" | null {
    const mainPid = getMainPid();
    const rawSafetyBlock = checkBashCommandSafety(command, mainPid, logger, { projectRoot: options?.projectRoot, sessionCwd: options?.sessionCwd, sandboxGuarded: options?.sandboxGuarded });
    if (!rawSafetyBlock) return null;
    const isSleepBlock = rawSafetyBlock.startsWith(SLEEP_REASON_PREFIX);
    const safetyBlock = appendDevServerGuidance(stripSleepMarkerIfPresent(rawSafetyBlock), options?.projectRoot ?? process.cwd(), command);
    recordGuardIntercept(command, safetyBlock, mainPid, isSleepBlock ? "sleep" : "safety");
    clearEventTimer(toolCallId);
    // F20261026gobs delta-r1（检视獭1646 S3）：tool_call 门（bashGuardGate）已接管 bash 守卫判定
    //（同源同参）——门在 beforeToolCall 以显式 reason 落痕返回 LLM；SDK prepareToolCall 的
    // signal.aborted 检查先于 beforeResult.block（pi-agent-core agent-loop.js L500 vs L507），
    // 此处若同时 abort 会把门的显式理由覆盖成 "Operation aborted"（双拦=显式落痕失效）。
    // 故门激活时交由门单点拦下（不 abort、事件流继续——重复被拦命令由循环熔断计数兑住）；
    // 门失活（store 缺失等 fail-open）时此处兑底 abort——降级不降安全。
    if (options?.guardGateActive?.()) return "deferred";
    doAbort(isSleepBlock ? `bash_sleep:${safetyBlock}` : `bash_safety:${safetyBlock}`);
    return "aborted";
  }

  const originalUnregister = unregisterToolCall;
  return {
    circuitBreaker,
    unregisterToolCall: originalUnregister ? () => { clearEventTimer(); originalUnregister(); } : undefined,
    clearEventTimer,
  };
}

  /** token 超阈值警告已删（F20260904cq30）：1278 次日志零下游消费的假水位线。
   *  上下文水位域唯一真相源 = 交接触发线（llm.models[].handoffThresholdTokens，
   *  F20260920uhuc 需求变更 2026-09-20：按模型直给，旧 contextQuality.compactionReserveTokens 退役）；
   *  水位数据每消息落 DB（messages.context_tokens），观测走 DB/metrics 不走日志。 */

/** 构建执行结果（含熔断器元数据） */
export function buildResult(
  text: string,
  tokenUsage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
  circuitBreaker?: ToolCallCircuitBreaker,
  ctxMax?: number,
  ctxTokens?: number,
) {
  return {
    text,
    tokenUsage: tokenUsage
      ? { input: tokenUsage.input, output: tokenUsage.output }
      : undefined,
    ctxTokens,
    ctxMax,
    circuitBreakerMetadata: circuitBreaker?.getMetadata(),
  };
}
