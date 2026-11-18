/** runtime: declarations for the matching SDK reference book. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BackgroundGrant, CapabilityPolicy, InstallationStatus, PageIdentity } from './shared.js';
import type { AppClient, ServerUserClient, UiRequestReceipt } from './business.js';
import type { EventHandler, EventHandlers, EventType } from './events.js';
import type { ProviderOptions, ProviderTransaction } from './integrations.js';
import type { AppManifest } from './manifest.js';
/** Explicit credentials are complete and independent of COLINK_* environment variables. */
export interface AppConfig {
    appId: string;
    appInstanceId: string;
    clientId: string;
    clientSecret: string;
    signingSecret: string;
    issuer: string;
    /** Defaults to ./.colink/state.enc; relative to the process working directory. */
    stateFile?: string;
    /** Optional explicit 64-character hexadecimal key. Otherwise the file store manages a persistent .key sidecar. */
    credentialKey?: string;
    /** Required for automatic page sessions when manifest declares an app-rendered view. */
    appOrigin?: string;
    /** Public CoLink host page origin; defaults to issuer, never inferred from request headers. */
    hostOrigin?: string;
    /** serveCoLinkRuntime default listener address; defaults to 127.0.0.1. */
    bindHost?: string;
    /** serveCoLinkRuntime default port; 0..65535, defaults to 8080. */
    port?: number;
    allowInsecureIssuer?: boolean;
    toolsOrigin?: string;
    /** 1..1800000 ms, default 1800000. Does not extend platform authorization. */
    turnTimeoutMs?: number;
    /** Stable across restarts/upgrades; default colink-agent. */
    idempotencyPrefix?: string;
    /** Opt in to durable live output. Terminal texts must be safe to share with this topic. */
    progressOutput?: {
        failureText: string;
        interruptedText: string;
    };
    /** Default true for app.user_message_received handlers / Agent.runTurn. Advisory status/heartbeat, independent of business readOnly. False disables automatic status and ctx.setDisplayStatus; use events.reportStatus for a custom lifecycle. */
    interactionStatus?: boolean;
    /** Single-process bounded dispatch; same installation/channel/topic remains serial across users and authorization versions. */
    eventQueue?: {
        /** 1..32; default 1. Explicitly opt in only if the App supports independent concurrent turns. */
        concurrency?: number;
        /** 1..32; default 1. Round-robin admission among eligible installations. */
        perInstallation?: number;
        /** Outstanding (running + queued + recovery) receipts, 1..2000; defaults 1000 / 100. Excess inbox requests return 503 before acceptance. */
        maxPending?: number;
        maxPendingPerInstallation?: number;
        /** First-dispatch deadline, 1..7200000 ms; default 1800000. Does not extend authorization. */
        waitTimeoutMs?: number;
        /** Optional safe topic message (<=4000 chars); default false. Uses messages:write, never a false processing status. */
        queuedText?: string | false;
    };
    /** Default user. Topic explicitly shares model history among authorized participants; credentials remain per event. */
    sessionScope?: 'user' | 'topic';
    /** Optional narrowing only. Default is the platform-authorized HTTP/MCP surface. */
    capabilities?: CapabilityPolicy;
}
export interface LifecycleLog {
    code?: string;
    stage?: string;
    field?: string;
    eventId?: string;
    installationId?: string;
    messageId?: string;
    status?: string;
    queueWaitMs?: number;
    activeCount?: number;
}
export type UserBinding = {
    request: IncomingMessage;
    installationId?: never;
    grantId?: never;
} | {
    grantId: string;
    request?: never;
    installationId?: never;
};
export type AppBinding = {
    installationId: string;
    request?: never;
    grantId?: never;
};
export interface ClientExecutionOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
}
export interface AppRuntime {
    /** Each call has its own timeout; the supplied signal can cancel all calls. Authorization remains bound to the original source/version. */
    /** @sdkFailure binding
     * @throws 绑定检查同步抛出；业务执行失败由后续调用拒绝：INVALID_CLIENT_BINDING / INVALID_CLIENT_OPTIONS 表示来源组合或执行设置非法；运行时关闭为 CLIENT_EXECUTION_INACTIVE。来源会话、安装或后台授权也可能在绑定或执行时拒绝。
     * @remarks userClient 只绑定 request 或 grantId；appClient 只绑定 installationId。对象创建成功不等于当前业务权限有效；不把失败的用户操作改用安装身份。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#创建身份客户端
     */
    userClient(binding: UserBinding, options?: ClientExecutionOptions): ServerUserClient;
    /** Uses only the specified installation's authorization and original version; never derives A from a request or user grant. */
    /** @sdkFailure binding
     * @throws 绑定检查同步抛出；业务执行失败由后续调用拒绝：INVALID_CLIENT_BINDING / INVALID_CLIENT_OPTIONS 表示来源组合或执行设置非法；运行时关闭为 CLIENT_EXECUTION_INACTIVE。来源会话、安装或后台授权也可能在绑定或执行时拒绝。
     * @remarks userClient 只绑定 request 或 grantId；appClient 只绑定 installationId。对象创建成功不等于当前业务权限有效；不把失败的用户操作改用安装身份。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#创建身份客户端
     */
    appClient(binding: AppBinding, options?: ClientExecutionOptions): AppClient;
    /** Register one handler per type. app.user_message_received adds reply/source/progress. Handlers support durable at-least-once handoff before output is committed; started progress streams and committed replies recover output without rerunning business work. Return void; replies must be explicit. */
    /** @sdkFailure registration
     * @throws 同步抛出：HANDLER_REGISTRATION_INVALID：未知事件、非函数处理器、重复注册，或在 Agent 注册由适配器负责的用户消息事件。
     * @remarks 每种事件只注册一个处理器；使用 EventType。注册成功并不执行回调，后续回调错误由运行时交接机制处理。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#注册事件处理器
     */
    onEvent<T extends EventType>(type: T, handler: EventHandler<NoInfer<T>>): this;
    readonly pages?: {
        /** @sdkFailure authenticate
         * @throws Promise 拒绝；authenticate 的凭据提取也可能同步抛出：PAGE_ORIGIN_DENIED 表示来源不符；无效或过期会话及在线授权失败会拒绝。completeInteraction 的 beforeComplete 抛错会阻止平台完成请求。
         * @remarks 以 SDK 携带的请求凭据校验；完成前回调必须核验持久业务回执。平台已完成后响应丢失仍需查回执，不能重复业务写入。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#页面服务端会话
         */
        authenticate(req: IncomingMessage): Promise<PageIdentity>;
        /** Callback checks this session's durable business receipt. Platform complete performs online authorization, including completed retries. */
        /** @sdkFailure authenticate
         * @throws Promise 拒绝；authenticate 的凭据提取也可能同步抛出：PAGE_ORIGIN_DENIED 表示来源不符；无效或过期会话及在线授权失败会拒绝。completeInteraction 的 beforeComplete 抛错会阻止平台完成请求。
         * @remarks 以 SDK 携带的请求凭据校验；完成前回调必须核验持久业务回执。平台已完成后响应丢失仍需查回执，不能重复业务写入。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#页面服务端会话
         */
        completeInteraction(req: IncomingMessage, beforeComplete: (identity: PageIdentity) => Promise<void>): Promise<UiRequestReceipt>;
    };
    readonly installations: {
        get(id: string): Readonly<{
            installationId: string;
            status: InstallationStatus;
            authorizationVersion: number;
        }> | null;
    };
    readonly events: {
        getStatus(eventId: string): Readonly<{
            status: string;
            code?: string;
            queuedAt: number;
            startedAt: number | null;
            firstOutputAt: number | null;
            finishedAt: number | null;
            queueWaitMs: number;
        }> | null;
    };
    readonly backgroundGrants: {
        /** @sdkFailure background
         * @throws Promise 拒绝：INVALID_BACKGROUND_QUERY 表示安装、用户或分页查询非法；网络和安装授权失败仍会拒绝。findActive 返回 null 表示没有激活授权，不是异常。
         * @remarks 无授权时停止后台用户任务，等待用户在平台重新授权；查询不自动恢复已撤销委托。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#查询后台授权
         */
        findActive(options: {
            installationId: string;
            userId: string;
        }): Promise<BackgroundGrant | null>;
        /** @sdkFailure background
         * @throws Promise 拒绝：INVALID_BACKGROUND_QUERY 表示安装、用户或分页查询非法；网络和安装授权失败仍会拒绝。findActive 返回 null 表示没有激活授权，不是异常。
         * @remarks 无授权时停止后台用户任务，等待用户在平台重新授权；查询不自动恢复已撤销委托。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#查询后台授权
         */
        list(options: {
            installationId: string;
            limit?: number;
            cursor?: string;
        }): Promise<{
            items: BackgroundGrant[];
            hasMore: boolean;
            nextCursor: string | null;
        }>;
    };
    /** @sdkFailure lifecycle
     * @throws start 可同步返回或异步拒绝；close 返回 Promise：监听器、适配器或存储清理错误可传播为原生 Error；close 不保证未完成的业务已成功，不撤销外部写入。
     * @remarks 自管 HTTP 时负责监听和启动顺序，并 await close。发生清理异常时保留原错误和状态，不重新执行未知结果业务。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#运行时生命周期
     */
    start(): void | Promise<void>;
    /** @sdkFailure lifecycle
     * @throws start 可同步返回或异步拒绝；close 返回 Promise：监听器、适配器或存储清理错误可传播为原生 Error；close 不保证未完成的业务已成功，不撤销外部写入。
     * @remarks 自管 HTTP 时负责监听和启动顺序，并 await close。发生清理异常时保留原错误和状态，不重新执行未知结果业务。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#运行时生命周期
     */
    close(): Promise<void>;
}
/** Handles app.user_message_received; installation notifications are managed by the SDK. */
export interface PageOptions {
    /** Exact public App origin, not the CoLink host origin. */
    origin: string;
    /** Same-origin SDK API prefix; default /colink/page. */
    path?: string;
    capabilities?: CapabilityPolicy;
}
/** @sdkFailure factory
 * @throws 同步抛出：INVALID_APP_CONFIG 表示配置或已移除选项无效；内联事件注册错误为 HANDLER_REGISTRATION_INVALID。文件状态初始化还可能抛出文件系统或加密错误，不保证都是 CoLinkError。
 * @remarks 修正配置或状态文件问题后重新创建；不要删除已有状态或密钥来绕过错误。创建不表示平台安装已就绪。
 * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#创建运行时
 */
export declare function createCoLinkRuntime<Tx extends ProviderTransaction = ProviderTransaction>(options: {
    config?: AppConfig;
    manifest: AppManifest;
    onEvent?: EventHandlers;
    pages?: PageOptions | false;
    provider?: ProviderOptions<Tx>;
    log?: false | ((entry: LifecycleLog) => void);
}): AppRuntime;
/** Explicit public resources, loaded once before listening. Never a directory mount. */
export type AppHttpAsset = URL | {
    file: URL;
    contentType?: string;
    body?: never;
} | {
    body: string | Uint8Array;
    contentType: string;
    file?: never;
};
export interface AppServerOptions {
    /** Maps Manifest app-rendered viewIds to local file URLs; routes come from entryPath. Unbound views may be hosted elsewhere. */
    views?: Record<string, URL>;
    assets?: Record<string, AppHttpAsset>;
    /** Exact App-owned paths; handlers validate method, authenticate and write the response. Cannot shadow SDK paths or assets. */
    routes?: Record<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>;
    /** Overrides bindHost / COLINK_BIND_HOST; defaults to loopback. */
    host?: string;
    /** Overrides port / COLINK_PORT. Default 8080; zero selects an available port. */
    port?: number;
    /** Owns unmatched requests; must write a response. Runs before any App body parser. */
    /** @sdkFailure route
     * @remarks 托管入口捕获同步异常或 Promise 拒绝：routes / fallback 失败由托管服务写安全失败响应或销毁已开始响应；应用自己的数据库和业务错误由应用处理。
     * @remarks 处理方法、身份及业务错误并写一次响应；异常不回滚回调已完成的业务写入。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#应用-http-回调
     */
    fallback?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    /** Default true. SIGINT/SIGTERM close only this service; no process.exit call. */
    handleSignals?: boolean;
    /** 1..60000 ms, default 5000. Timeout destroys connections and rejects closed. */
    closeTimeoutMs?: number;
}
export interface AppServer {
    readonly host: string;
    readonly port: number;
    /** Stops accepting HTTP, closes the SDK, drains connections; repeated calls share the same promise. */
    /** @sdkFailure server
     * @throws Promise 拒绝；server.closed 也承载关闭失败：APP_SERVER_INVALID_OPTIONS 表示非法或重复托管；资源读取、端口占用可能为原生错误；关闭多个失败可为 AggregateError。
     * @remarks 启动失败会尝试清理运行时；关闭销毁超时连接。不要把关闭当作业务完成，保留状态后修复配置/资源。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#托管服务启动与关闭
     */
    close(): Promise<void>;
    /** Resolves on clean shutdown, rejects on close/fatal server failure. */
    readonly closed: Promise<void>;
}
/** A matched SDK request is owned even on failure; false leaves the request and response untouched. */
/** @sdkFailure http
 * @remarks 协议失败写入 HTTP 响应；不作为业务 JSON 返回：未匹配返回 false，匹配返回 true；捕获的处理故障写 APP_HTTP_HANDLER_FAILED 或销毁已开始的响应。响应对象自身异常仍可能传播。
 * @remarks true 后不能再写响应；false 才继续框架路由。请求处理不转移运行时生命周期所有权。
 * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#处理-sdk-http-请求
 */
export type AppHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
/** SDK protocol and generated browser resources only; does not manage listener or runtime lifetime. */
/** @sdkFailure httpFactory
 * @throws Promise 拒绝：APP_HTTP_INVALID_OPTIONS 表示非 SDK 运行时、额外参数或已关闭；读取浏览器资源可能传播文件系统错误。
 * @remarks 传入存活运行时；自管页面与路由由框架提供，接入函数不负责监听和关闭。
 * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#创建-http-接入函数
 */
export declare function createCoLinkHttpHandler(runtime: Omit<AppRuntime, 'onEvent'>): Promise<AppHttpHandler>;
/** Owns the runtime lifecycle, including cleanup after validation/load/listen/start failure. */
/** @sdkFailure server
 * @throws Promise 拒绝；server.closed 也承载关闭失败：APP_SERVER_INVALID_OPTIONS 表示非法或重复托管；资源读取、端口占用可能为原生错误；关闭多个失败可为 AggregateError。
 * @remarks 启动失败会尝试清理运行时；关闭销毁超时连接。不要把关闭当作业务完成，保留状态后修复配置/资源。
 * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#托管服务启动与关闭
 */
export declare function serveCoLinkRuntime(runtime: Omit<AppRuntime, 'onEvent'>, options?: AppServerOptions): Promise<AppServer>;
