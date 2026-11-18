/** integrations: declarations for the matching SDK reference book. */
import type { ChannelSummary, CoLinkClient, CursorQuery, MemberSummary, PageResult } from './business.js';
export interface ProviderContext {
    readonly callId: string;
    readonly installationId: string;
    readonly consumerInstallationId: string;
    readonly projectId: string;
    readonly operationId: string;
    readonly specRevision: string;
    readonly expiresAt: string;
    readonly actor: Readonly<{
        kind: 'user';
        userId: string;
    } | {
        kind: 'app';
        installationId: string;
    }>;
    readonly source?: Readonly<{
        kind: 'mention' | 'task' | 'ui' | 'background';
        channelId?: string;
        topicId?: string;
        messageId?: string;
        taskId?: string;
        executionEpoch?: number;
        authorityReference?: string;
    }>;
    readonly reply?: Readonly<{
        channelId: string;
        topicId: string;
        initiator?: Readonly<{
            userId: string;
            displayName: string;
        }>;
    }>;
}
export type ProviderTopicReply = {
    status: 'ready';
    text: string;
} | {
    status: 'skipped';
    reason: string;
};
export type ProviderResult = {
    status: number;
    data?: unknown;
    topicReply?: ProviderTopicReply | null;
} | {
    status: 'failed';
    error: {
        providerErrorCode: string;
        message: string;
    };
    sideEffect: 'not_executed' | 'rolled_back';
};
/** Private storage metadata, distinct from the credential-free handler context. */
export interface ProviderIdentity {
    providerInstallationId: string;
    consumerInstallationId: string;
    callId: string;
    operationId: string;
    specRevision: string;
    projectId: string;
    executionExpiresAt: string;
    idempotencyKey?: string;
    inputHash?: string;
    contextVersion?: 2;
    authorizationDomainId?: string;
    actorUserId?: string;
    sourceHash?: string;
    userExecutionId?: string;
}
export interface ProviderReceipt {
    callId: string;
    inputHash: string | null;
    specRevision: string;
    status: 'running' | 'completed' | 'failed' | 'not_found';
    resultAvailable: boolean;
    response: {
        status: number;
        data?: unknown;
    } | null;
    error: {
        providerErrorCode: string;
        message: string;
    } | null;
    sideEffect?: 'not_executed' | 'rolled_back';
    topicReply: ProviderTopicReply | null;
}
/** Canonical receipt digest for atomic ACK in a custom ProviderStore. */
export interface ProviderTransaction {
    /** Atomically claim both call and installation-scoped business keys; return the immutable existing record on duplicates. */
    /** @sdkFailure provider
     * @remarks 由 SDK 等待回调；拒绝进入业务提供方协议处理：authorize 抛错阻止访问；业务处理可正常返回 failed + sideEffect，不等于异常。runInTransaction 的回调拒绝必须由应用存储回滚；原生存储错误不保证是 CoLinkError。
     * @remarks 业务写入和回执在同一事务提交。响应丢失后按 callId 查询原回执；acknowledge 返回 false 是未满足原身份/摘要匹配，不当作确认成功。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务提供方回调与事务
     */
    claimCall(identity: ProviderIdentity, running: ProviderReceipt): Promise<{
        claimed: true;
    } | {
        claimed: false;
        identity: ProviderIdentity;
        receipt: ProviderReceipt;
    }>;
    /** @sdkFailure provider
     * @remarks 由 SDK 等待回调；拒绝进入业务提供方协议处理：authorize 抛错阻止访问；业务处理可正常返回 failed + sideEffect，不等于异常。runInTransaction 的回调拒绝必须由应用存储回滚；原生存储错误不保证是 CoLinkError。
     * @remarks 业务写入和回执在同一事务提交。响应丢失后按 callId 查询原回执；acknowledge 返回 false 是未满足原身份/摘要匹配，不当作确认成功。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务提供方回调与事务
     */
    completeCall(identity: ProviderIdentity, receipt: ProviderReceipt): Promise<void>;
    /** Check original identity and current receipt hash atomically before persisting acknowledgment. */
    /** @sdkFailure provider
     * @remarks 由 SDK 等待回调；拒绝进入业务提供方协议处理：authorize 抛错阻止访问；业务处理可正常返回 failed + sideEffect，不等于异常。runInTransaction 的回调拒绝必须由应用存储回滚；原生存储错误不保证是 CoLinkError。
     * @remarks 业务写入和回执在同一事务提交。响应丢失后按 callId 查询原回执；acknowledge 返回 false 是未满足原身份/摘要匹配，不当作确认成功。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务提供方回调与事务
     */
    acknowledge(identity: ProviderIdentity, receiptHash: string): Promise<boolean>;
}
export interface ProviderStore<Tx extends ProviderTransaction = ProviderTransaction> {
    /** Business writes, claim and completion share this transaction. Rejecting the callback rolls it back. */
    /** @sdkFailure provider
     * @remarks 由 SDK 等待回调；拒绝进入业务提供方协议处理：authorize 抛错阻止访问；业务处理可正常返回 failed + sideEffect，不等于异常。runInTransaction 的回调拒绝必须由应用存储回滚；原生存储错误不保证是 CoLinkError。
     * @remarks 业务写入和回执在同一事务提交。响应丢失后按 callId 查询原回执；acknowledge 返回 false 是未满足原身份/摘要匹配，不当作确认成功。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务提供方回调与事务
     */
    runInTransaction<T>(callback: (transaction: Tx) => Promise<T>): Promise<T>;
    /** @sdkFailure provider
     * @remarks 由 SDK 等待回调；拒绝进入业务提供方协议处理：authorize 抛错阻止访问；业务处理可正常返回 failed + sideEffect，不等于异常。runInTransaction 的回调拒绝必须由应用存储回滚；原生存储错误不保证是 CoLinkError。
     * @remarks 业务写入和回执在同一事务提交。响应丢失后按 callId 查询原回执；acknowledge 返回 false 是未满足原身份/摘要匹配，不当作确认成功。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务提供方回调与事务
     */
    getReceipt(identity: ProviderIdentity): Promise<{
        identity: ProviderIdentity;
        receipt: ProviderReceipt;
    } | null>;
}
export interface ProviderDirectory {
    /** @sdkFailure read
     * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
     * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
     */
    listChannels(input?: CursorQuery): Promise<PageResult<ChannelSummary>>;
    /** @sdkFailure read
     * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
     * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
     */
    listChannelMembers(input: CursorQuery & {
        channelId: string;
    }): Promise<PageResult<MemberSummary>>;
}
export interface ProviderCall<Tx extends ProviderTransaction = ProviderTransaction> {
    input: Record<string, unknown>;
    context: ProviderContext;
    transaction: Tx | null;
    signal: AbortSignal;
    /** User calls without delegated platform permissions have no client; no fallback to App authority. */
    colink?: CoLinkClient;
    directory: ProviderDirectory;
}
export interface ProviderOptions<Tx extends ProviderTransaction = ProviderTransaction> {
    document: Record<string, unknown>;
    /** Retain executable prior schemas; handlers dispatch by context.specRevision when semantics differ. */
    previousDocuments?: Record<string, unknown>[];
    handlers: Record<string, (call: ProviderCall<Tx>) => Promise<ProviderResult>>;
    /** Application data authorization is mandatory for execution and result recovery. Throw to deny. */
    /** @sdkFailure provider
     * @remarks 由 SDK 等待回调；拒绝进入业务提供方协议处理：authorize 抛错阻止访问；业务处理可正常返回 failed + sideEffect，不等于异常。runInTransaction 的回调拒绝必须由应用存储回滚；原生存储错误不保证是 CoLinkError。
     * @remarks 业务写入和回执在同一事务提交。响应丢失后按 callId 查询原回执；acknowledge 返回 false 是未满足原身份/摘要匹配，不当作确认成功。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务提供方回调与事务
     */
    authorize(input: {
        context: ProviderContext;
        input?: Readonly<Record<string, unknown>>;
        purpose: 'execute' | 'receipt' | 'ack';
    }): void | Promise<void>;
    /** Required for POST; optional for GET-only applications. SDK state is not a business database transaction. */
    store?: ProviderStore<Tx>;
}
/** @sdkFailure hash
 * @throws 同步计算；非法序列化输入可同步抛出：对 SDK 定义的回执求摘要；该函数不访问网络，也不创建或确认回执。
 * @remarks 保留原始不可变回执，在原子确认事务内核验摘要；不能以摘要代替授权。
 * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#提供方回执摘要
 */
export declare function hashProviderReceipt(receipt: ProviderReceipt): string;
