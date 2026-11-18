/** agent: declarations for the matching SDK reference book. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfig, AppRuntime, LifecycleLog, PageOptions } from './runtime.js';
import type { UserMessageContext, EventHandler, EventType } from './events.js';
import type { CoLinkClient } from './business.js';
import type { ProviderOptions, ProviderTransaction } from './integrations.js';
import type { AppManifest } from './manifest.js';
export interface ToolDescription {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    annotations?: {
        readOnlyHint?: boolean;
        [key: string]: unknown;
    };
}
/** @sdkFailure transform
 * @remarks SDK 等待回调；异常使工具调用失败：回调处理的是已执行工具的结果；转换后仍经过公开输出检查，敏感输出会被拒绝。
 * @remarks 先持久保存所需私密结果，仅返回公开回执；转换异常不代表工具没有执行。
 * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#agent-工具结果转换回调
 */
export type ToolResultTransformer = (input: {
    name: string;
    result: unknown;
    context: Readonly<{
        kind: 'event';
        installationId: string;
        userId: string;
        eventId: string;
    }>;
}) => unknown | Promise<unknown>;
export interface AgentToolOptions {
    /** Applies to direct tools.call and MCP tool results, before the mandatory public-output check. */
    transformResult?: ToolResultTransformer;
}
export type AgentConfig = AppConfig;
export interface AgentRuntime extends Omit<AppRuntime, 'onEvent'> {
    /** Available only when MCP is configured; self-hosted loopback listener. */
    readonly mcp?: {
        handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
    };
    /** Mentions belong to the Agent adapter; other event handlers use durable handoff. */
    /** @sdkFailure registration
     * @throws 同步抛出：HANDLER_REGISTRATION_INVALID：未知事件、非函数处理器、重复注册，或在 Agent 注册由适配器负责的用户消息事件。
     * @remarks 每种事件只注册一个处理器；使用 EventType。注册成功并不执行回调，后续回调错误由运行时交接机制处理。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#注册事件处理器
     */
    onEvent<T extends Exclude<EventType, EventType.UserMessageReceived>>(type: T, handler: EventHandler<NoInfer<T>>): this;
}
export interface LocalMcpConnection {
    /** Private loopback HTTP endpoint. Pass to trusted framework configuration, never a prompt. */
    readonly url: string;
    readonly headers: Readonly<{
        authorization: string;
    }>;
}
export interface AgentTurn extends UserMessageContext {
    /** Model-facing platform tools, available only on Agent turns. */
    readonly tools: {
        /** @sdkFailure tools
         * @throws Promise 拒绝：TOOL_UNAVAILABLE 表示当前授权工具目录没有此项；目录冲突或协议异常可为 MCP_RESPONSE_INVALID。工具业务失败还可能以正常工具结果返回。
         * @remarks 仅使用当前回合授权目录，读取工具结果中的业务状态。执行后转换失败不回滚工具，不能重新调用有副作用工具来获取展示结果。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#agent-工具
         */
        list(): Promise<ToolDescription[]>;
        /** @sdkFailure tools
         * @throws Promise 拒绝：TOOL_UNAVAILABLE 表示当前授权工具目录没有此项；目录冲突或协议异常可为 MCP_RESPONSE_INVALID。工具业务失败还可能以正常工具结果返回。
         * @remarks 仅使用当前回合授权目录，读取工具结果中的业务状态。执行后转换失败不回滚工具，不能重新调用有副作用工具来获取展示结果。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#agent-工具
         */
        call(name: string, args: Record<string, unknown>): Promise<unknown>;
    };
    key: string;
    sessionId: string;
    /** Present only in managed MCP mode; revoked when this turn ends or is cancelled. */
    readonly mcpConnection?: LocalMcpConnection;
}
export type AgentMcpOptions = boolean | {
    port?: number;
    serverName?: string;
    clientName?: never;
} | {
    clientName: string;
    serverName?: string;
    port?: never;
};
export interface AgentSteerTurn extends Pick<AgentTurn, 'key' | 'sessionId' | 'event' | 'context' | 'signal' | 'assertActive'> {
    eventId: string;
    colink: CoLinkClient;
}
export interface AgentAdapter {
    /** @sdkFailure adapter
     * @remarks 由 SDK 调用并捕获；执行和清理阶段处理不同：runTurn / ensureSession 失败进入回合失败处理；steerTurn 的 false 表示明确未提交，未知结果应拒绝。关闭回调失败可能使 runtime.close 拒绝；取消或会话释放失败的记录与恢复由运行时管理。
     * @remarks runTurn 不混用返回文本与 reply。未知提交结果不得伪装 false 触发重放；清理回调不得删除用户远端会话。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#agent-适配回调
     */
    ensureSession(input: {
        key: string;
        sessionId: string;
        context: UserMessageContext['context'];
        eventId: string;
    }): Promise<{
        sessionId: string;
    }>;
    /** Return the final answer, or stage replies through turn.reply and return void. Never mix both. */
    /** @sdkFailure adapter
     * @remarks 由 SDK 调用并捕获；执行和清理阶段处理不同：runTurn / ensureSession 失败进入回合失败处理；steerTurn 的 false 表示明确未提交，未知结果应拒绝。关闭回调失败可能使 runtime.close 拒绝；取消或会话释放失败的记录与恢复由运行时管理。
     * @remarks runTurn 不混用返回文本与 reply。未知提交结果不得伪装 false 触发重放；清理回调不得删除用户远端会话。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#agent-适配回调
     */
    runTurn(turn: AgentTurn): Promise<string | void>;
    /** Optional live same-user/scope input. True = accepted once; false = definitely not submitted, queue normally. Unknown result must throw, never replay. */
    /** @sdkFailure adapter
     * @remarks 由 SDK 调用并捕获；执行和清理阶段处理不同：runTurn / ensureSession 失败进入回合失败处理；steerTurn 的 false 表示明确未提交，未知结果应拒绝。关闭回调失败可能使 runtime.close 拒绝；取消或会话释放失败的记录与恢复由运行时管理。
     * @remarks runTurn 不混用返回文本与 reply。未知提交结果不得伪装 false 触发重放；清理回调不得删除用户远端会话。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#agent-适配回调
     */
    steerTurn?(turn: AgentSteerTurn): Promise<boolean>;
    /** @sdkFailure adapter
     * @remarks 由 SDK 调用并捕获；执行和清理阶段处理不同：runTurn / ensureSession 失败进入回合失败处理；steerTurn 的 false 表示明确未提交，未知结果应拒绝。关闭回调失败可能使 runtime.close 拒绝；取消或会话释放失败的记录与恢复由运行时管理。
     * @remarks runTurn 不混用返回文本与 reply。未知提交结果不得伪装 false 触发重放；清理回调不得删除用户远端会话。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#agent-适配回调
     */
    cancelTurn(key: string): unknown | Promise<unknown>;
    /** Cancel an interrupted remote session on restart; never replay its prompt. */
    /** @sdkFailure adapter
     * @remarks 由 SDK 调用并捕获；执行和清理阶段处理不同：runTurn / ensureSession 失败进入回合失败处理；steerTurn 的 false 表示明确未提交，未知结果应拒绝。关闭回调失败可能使 runtime.close 拒绝；取消或会话释放失败的记录与恢复由运行时管理。
     * @remarks runTurn 不混用返回文本与 reply。未知提交结果不得伪装 false 触发重放；清理回调不得删除用户远端会话。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#agent-适配回调
     */
    cleanupInterruptedSession(sessionId: string): unknown | Promise<unknown>;
    /** Release local subscriptions; do not delete the remote conversation. */
    /** @sdkFailure adapter
     * @remarks 由 SDK 调用并捕获；执行和清理阶段处理不同：runTurn / ensureSession 失败进入回合失败处理；steerTurn 的 false 表示明确未提交，未知结果应拒绝。关闭回调失败可能使 runtime.close 拒绝；取消或会话释放失败的记录与恢复由运行时管理。
     * @remarks runTurn 不混用返回文本与 reply。未知提交结果不得伪装 false 触发重放；清理回调不得删除用户远端会话。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#agent-适配回调
     */
    releaseSession(key: string): unknown | Promise<unknown>;
    /** @sdkFailure adapter
     * @remarks 由 SDK 调用并捕获；执行和清理阶段处理不同：runTurn / ensureSession 失败进入回合失败处理；steerTurn 的 false 表示明确未提交，未知结果应拒绝。关闭回调失败可能使 runtime.close 拒绝；取消或会话释放失败的记录与恢复由运行时管理。
     * @remarks runTurn 不混用返回文本与 reply。未知提交结果不得伪装 false 触发重放；清理回调不得删除用户远端会话。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#agent-适配回调
     */
    close(): unknown | Promise<unknown>;
}
/** @sdkFailure factory
 * @throws 同步抛出：INVALID_APP_CONFIG 表示配置或已移除选项无效；内联事件注册错误为 HANDLER_REGISTRATION_INVALID。文件状态初始化还可能抛出文件系统或加密错误，不保证都是 CoLinkError。
 * @remarks 修正配置或状态文件问题后重新创建；不要删除已有状态或密钥来绕过错误。创建不表示平台安装已就绪。
 * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#创建运行时
 */
export declare function createCoLinkAgent<Tx extends ProviderTransaction = ProviderTransaction>(options: {
    /** Omit to read COLINK_* environment variables. Explicit config never inherits environment values. */
    config?: AgentConfig;
    manifest: AppManifest;
    /** Omit to enable sessions for app-rendered Manifest views; false disables page sessions. */
    pages?: PageOptions | false;
    provider?: ProviderOptions<Tx>;
    agent: AgentAdapter;
    tools?: AgentToolOptions;
    mcp?: AgentMcpOptions;
    log?: false | ((entry: LifecycleLog) => void);
}): AgentRuntime;
