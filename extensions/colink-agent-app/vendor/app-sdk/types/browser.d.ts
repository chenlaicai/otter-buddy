/** browser: declarations for the matching SDK reference book. */
import type { BinaryResult, MessageContent, UserClient } from './business.js';
import type { PageIdentity, PageScope, BackgroundScope } from './shared.js';
export interface PageContext {
    readonly source: Readonly<Record<string, unknown>>;
    readonly content?: Readonly<MessageContent>;
    readonly container: string;
    readonly theme: 'light' | 'dark';
    readonly themeId: string;
    readonly language: string;
    readonly availableMethods: readonly string[];
    readonly readingForeground: boolean;
    readonly viewData?: Readonly<Record<string, unknown>>;
}
/** Display initialization only; does not identify a user or authorize data access. */
/** @sdkFailure bridgeFactory
 * @throws 配置失败同步抛出；握手失败由 connection.ready 拒绝：INVALID_HOST_ORIGIN / INVALID_TIMEOUT / NOT_EMBEDDED / PAGE_ALREADY_CONNECTED 表示来源、时限或容器非法。桥接错误使用带 code 的 Error，不保证 CoLinkError。
 * @remarks 在宿主嵌入页面中连接一次并等待 ready；握手成功不表示登录或业务授权。
 * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#连接页面宿主
 */
export declare function connectPage(options: {
    hostOrigin: string;
    allowInsecureLocal?: boolean;
    timeoutMs?: number;
    window?: Window;
    signal?: AbortSignal;
    deferPresentation?: boolean;
}): PageConnection;
export interface PageConnection {
    readonly ready: Promise<PageContext>; /** @sdkFailure dispose
     * @remarks 同步释放：重复关闭可调用；未完成请求会因 PAGE_CLOSED 失败。注销远端会话的清理请求是尽力发送，网络失败被隔离。
     * @remarks close 释放本地资源；不能以此证明远端注销已确认，也不会撤销已发送业务。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#释放页面资源
     */
    close(): void;
    /** @sdkFailure bridge
     * @throws Promise 拒绝；非法 JavaScript 实参解构还可能同步抛出：PAGE_CLOSED / PAGE_METHOD_UNAVAILABLE / PAGE_BRIDGE_TIMEOUT 表示连接关闭、宿主能力不可用或等待超时；各操作还校验导航、尺寸、视图数据或输入内容。
     * @remarks 超时不表示宿主未执行。openView 返回打开 ACK，关闭结果由 onViewClosed 接收；composer.send 等副作用按原 operationId 核查，不能盲目重发。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#页面宿主操作
     */
    markPresentationReady(): Promise<unknown>; /** @sdkFailure bridge
     * @throws Promise 拒绝；非法 JavaScript 实参解构还可能同步抛出：PAGE_CLOSED / PAGE_METHOD_UNAVAILABLE / PAGE_BRIDGE_TIMEOUT 表示连接关闭、宿主能力不可用或等待超时；各操作还校验导航、尺寸、视图数据或输入内容。
     * @remarks 超时不表示宿主未执行。openView 返回打开 ACK，关闭结果由 onViewClosed 接收；composer.send 等副作用按原 operationId 核查，不能盲目重发。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#页面宿主操作
     */
    closeView(options?: {
        result?: Record<string, unknown>;
    }): Promise<{
        readonly accepted: true;
    }>;
    /** @sdkFailure bridge
     * @throws Promise 拒绝；非法 JavaScript 实参解构还可能同步抛出：PAGE_CLOSED / PAGE_METHOD_UNAVAILABLE / PAGE_BRIDGE_TIMEOUT 表示连接关闭、宿主能力不可用或等待超时；各操作还校验导航、尺寸、视图数据或输入内容。
     * @remarks 超时不表示宿主未执行。openView 返回打开 ACK，关闭结果由 onViewClosed 接收；composer.send 等副作用按原 operationId 核查，不能盲目重发。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#页面宿主操作
     */
    openTopic(input: {
        channelId: string;
        topicId: string;
    }): Promise<{
        readonly accepted: true;
    }>;
    /** Returns the open ACK; register onViewClosed first to receive the separate, correlated result. */
    /** @sdkFailure bridge
     * @throws Promise 拒绝；非法 JavaScript 实参解构还可能同步抛出：PAGE_CLOSED / PAGE_METHOD_UNAVAILABLE / PAGE_BRIDGE_TIMEOUT 表示连接关闭、宿主能力不可用或等待超时；各操作还校验导航、尺寸、视图数据或输入内容。
     * @remarks 超时不表示宿主未执行。openView 返回打开 ACK，关闭结果由 onViewClosed 接收；composer.send 等副作用按原 operationId 核查，不能盲目重发。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#页面宿主操作
     */
    openView(input: {
        viewId: string;
        data?: Record<string, unknown>;
    }): Promise<{
        readonly accepted: true;
        readonly requestId: string;
    }>;
    /** @sdkFailure observer
     * @throws 注册检查同步抛出；通知中的同步异常被隔离：PAGE_CLOSED 表示连接关闭或 listener 非函数。SDK 捕获同步监听回调异常，不等待回调自行启动的异步工作。
     * @remarks 保存返回的取消订阅函数；自行处理异步回调拒绝，避免遗留未处理 Promise。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#页面观察回调
     */
    onViewClosed(listener: (result: ViewClosed) => void): () => void;
    readonly composer: {
        /** @sdkFailure bridge
         * @throws Promise 拒绝；非法 JavaScript 实参解构还可能同步抛出：PAGE_CLOSED / PAGE_METHOD_UNAVAILABLE / PAGE_BRIDGE_TIMEOUT 表示连接关闭、宿主能力不可用或等待超时；各操作还校验导航、尺寸、视图数据或输入内容。
         * @remarks 超时不表示宿主未执行。openView 返回打开 ACK，关闭结果由 onViewClosed 接收；composer.send 等副作用按原 operationId 核查，不能盲目重发。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#页面宿主操作
         */
        insert(input: ComposerInput): Promise<{
            status: 'inserted';
            operationId: string;
        }>;
        /** @sdkFailure bridge
         * @throws Promise 拒绝；非法 JavaScript 实参解构还可能同步抛出：PAGE_CLOSED / PAGE_METHOD_UNAVAILABLE / PAGE_BRIDGE_TIMEOUT 表示连接关闭、宿主能力不可用或等待超时；各操作还校验导航、尺寸、视图数据或输入内容。
         * @remarks 超时不表示宿主未执行。openView 返回打开 ACK，关闭结果由 onViewClosed 接收；composer.send 等副作用按原 operationId 核查，不能盲目重发。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#页面宿主操作
         */
        send(input: ComposerInput): Promise<{
            status: 'sent';
            operationId: string;
            messageId: string;
        }>;
    };
    /** @sdkFailure bridge
     * @throws Promise 拒绝；非法 JavaScript 实参解构还可能同步抛出：PAGE_CLOSED / PAGE_METHOD_UNAVAILABLE / PAGE_BRIDGE_TIMEOUT 表示连接关闭、宿主能力不可用或等待超时；各操作还校验导航、尺寸、视图数据或输入内容。
     * @remarks 超时不表示宿主未执行。openView 返回打开 ACK，关闭结果由 onViewClosed 接收；composer.send 等副作用按原 operationId 核查，不能盲目重发。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#页面宿主操作
     */
    resize(input: {
        height: number;
    }): Promise<unknown>;
    /** Request host confirmation for HTTPS, or same-App HTTP with a loopback development host. */
    /** @sdkFailure bridge
     * @throws Promise 拒绝；非法 JavaScript 实参解构还可能同步抛出：PAGE_CLOSED / PAGE_METHOD_UNAVAILABLE / PAGE_BRIDGE_TIMEOUT 表示连接关闭、宿主能力不可用或等待超时；各操作还校验导航、尺寸、视图数据或输入内容。
     * @remarks 超时不表示宿主未执行。openView 返回打开 ACK，关闭结果由 onViewClosed 接收；composer.send 等副作用按原 operationId 核查，不能盲目重发。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#页面宿主操作
     */
    openExternal(input: {
        url: string;
    }): Promise<unknown>;
    /** Ask the trusted host to save already-authorized bytes, at most 16 MiB, after explicit confirmation. */
    /** @sdkFailure fileSave
     * @throws Promise 拒绝；用户取消正常返回 cancelled：INVALID_FILE_SAVE 表示文件名、Blob 或实际大小不合法；PAGE_METHOD_UNAVAILABLE 表示旧宿主没有提供方法，PAGE_CLOSED 表示通道关闭，PAGE_BRIDGE_TIMEOUT 表示等待结果超时；非法返回为 PAGE_RESPONSE_INVALID。宿主拒绝沿用其安全错误码。
     * @remarks 先取得已授权字节，用户在宿主确认后才发起下载；download_started 不证明设备保存成功。取消后由用户重新操作；超时先核对浏览器结果，不自动重试。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#宿主文件保存
     */
    saveFile(input: {
        fileName: string;
        blob: Blob;
    }): Promise<{
        readonly status: 'download_started' | 'cancelled';
    }>;
    /** @sdkFailure observer
     * @throws 注册检查同步抛出；通知中的同步异常被隔离：PAGE_CLOSED 表示连接关闭或 listener 非函数。SDK 捕获同步监听回调异常，不等待回调自行启动的异步工作。
     * @remarks 保存返回的取消订阅函数；自行处理异步回调拒绝，避免遗留未处理 Promise。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#页面观察回调
     */
    onThemeChange(listener: (theme: Readonly<{
        theme: 'light' | 'dark';
        themeId?: string;
    }>) => void): () => void;
}
export type ViewClosed = {
    readonly requestId: string;
} & ({
    readonly status: 'submitted';
    readonly result: Readonly<Record<string, unknown>>;
} | {
    readonly status: 'cancelled';
    readonly result?: never;
});
/** Stable operationId is required. Blob bytes travel over the current port; the host binds sender and destination. */
export interface ComposerInput {
    operationId: string;
    text?: string;
    images?: Array<{
        name: string;
        blob: Blob;
    }>;
}
export interface PageClient {
    /** Initialization snapshot; not proof of login or business authorization. */
    readonly context: PageContext;
    readonly connection: PageConnection;
    readonly user: UserClient;
    /** Establish identity only; does not request business permissions. */
    /** @sdkFailure page
     * @throws Promise 拒绝；非法 JavaScript 实参解构可能同步抛出：PAGE_LOGIN_REQUIRED / PAGE_CLOSED / PAGE_OPERATION_BUSY / PAGE_UNSUPPORTED_SCOPE 分别表示缺少会话、连接关闭、授权操作冲突或 scope 无效；传输失败为 PAGE_NETWORK_UNAVAILABLE，非法响应为 PAGE_RESPONSE_INVALID。
     * @remarks authorize 会先完成必要登录；用户拒绝或会话失效时由界面引导。requestBackend 的业务副作用由应用负责，失败不代表未执行；logout 即使请求失败也清除本地令牌。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#页面登录授权与后端调用
     */
    login(): Promise<PageIdentity>;
    /** Log in if needed, then request all Manifest-declared permissions applicable to this page. Background requires explicit scopes. */
    /** @sdkFailure page
     * @throws Promise 拒绝；非法 JavaScript 实参解构可能同步抛出：PAGE_LOGIN_REQUIRED / PAGE_CLOSED / PAGE_OPERATION_BUSY / PAGE_UNSUPPORTED_SCOPE 分别表示缺少会话、连接关闭、授权操作冲突或 scope 无效；传输失败为 PAGE_NETWORK_UNAVAILABLE，非法响应为 PAGE_RESPONSE_INVALID。
     * @remarks authorize 会先完成必要登录；用户拒绝或会话失效时由界面引导。requestBackend 的业务副作用由应用负责，失败不代表未执行；logout 即使请求失败也清除本地令牌。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#页面登录授权与后端调用
     */
    authorize(): Promise<PageIdentity>;
    /** Log in if needed, then request permissions, retaining current applicable consent. Background retains background consent only. */
    /** @sdkFailure page
     * @throws Promise 拒绝；非法 JavaScript 实参解构可能同步抛出：PAGE_LOGIN_REQUIRED / PAGE_CLOSED / PAGE_OPERATION_BUSY / PAGE_UNSUPPORTED_SCOPE 分别表示缺少会话、连接关闭、授权操作冲突或 scope 无效；传输失败为 PAGE_NETWORK_UNAVAILABLE，非法响应为 PAGE_RESPONSE_INVALID。
     * @remarks authorize 会先完成必要登录；用户拒绝或会话失效时由界面引导。requestBackend 的业务副作用由应用负责，失败不代表未执行；logout 即使请求失败也清除本地令牌。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#页面登录授权与后端调用
     */
    authorize(scopes: readonly PageScope[], options?: {
        accessMode?: 'session';
    }): Promise<PageIdentity>;
    /** @sdkFailure page
     * @throws Promise 拒绝；非法 JavaScript 实参解构可能同步抛出：PAGE_LOGIN_REQUIRED / PAGE_CLOSED / PAGE_OPERATION_BUSY / PAGE_UNSUPPORTED_SCOPE 分别表示缺少会话、连接关闭、授权操作冲突或 scope 无效；传输失败为 PAGE_NETWORK_UNAVAILABLE，非法响应为 PAGE_RESPONSE_INVALID。
     * @remarks authorize 会先完成必要登录；用户拒绝或会话失效时由界面引导。requestBackend 的业务副作用由应用负责，失败不代表未执行；logout 即使请求失败也清除本地令牌。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#页面登录授权与后端调用
     */
    authorize(scopes: readonly BackgroundScope[], options: {
        accessMode?: 'session' | 'background';
    }): Promise<PageIdentity>;
    /** @sdkFailure page
     * @throws Promise 拒绝；非法 JavaScript 实参解构可能同步抛出：PAGE_LOGIN_REQUIRED / PAGE_CLOSED / PAGE_OPERATION_BUSY / PAGE_UNSUPPORTED_SCOPE 分别表示缺少会话、连接关闭、授权操作冲突或 scope 无效；传输失败为 PAGE_NETWORK_UNAVAILABLE，非法响应为 PAGE_RESPONSE_INVALID。
     * @remarks authorize 会先完成必要登录；用户拒绝或会话失效时由界面引导。requestBackend 的业务副作用由应用负责，失败不代表未执行；logout 即使请求失败也清除本地令牌。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#页面登录授权与后端调用
     */
    getIdentity(): Promise<PageIdentity>;
    /** App-owned JSON API only; never accepts custom Authorization or another origin. */
    /** @sdkFailure page
     * @throws Promise 拒绝；非法 JavaScript 实参解构可能同步抛出：PAGE_LOGIN_REQUIRED / PAGE_CLOSED / PAGE_OPERATION_BUSY / PAGE_UNSUPPORTED_SCOPE 分别表示缺少会话、连接关闭、授权操作冲突或 scope 无效；传输失败为 PAGE_NETWORK_UNAVAILABLE，非法响应为 PAGE_RESPONSE_INVALID。
     * @remarks authorize 会先完成必要登录；用户拒绝或会话失效时由界面引导。requestBackend 的业务副作用由应用负责，失败不代表未执行；logout 即使请求失败也清除本地令牌。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#页面登录授权与后端调用
     */
    requestBackend(input: {
        path: string;
        method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
        query?: Record<string, string | number | boolean>;
        body?: unknown;
        idempotencyKey?: string;
    }): Promise<unknown>;
    /** Authenticated same-origin GET for App-owned files, at most 16 MiB. Does not save the file or grant business access. */
    /** @sdkFailure pageDownload
     * @throws Promise 拒绝；非法 JavaScript 属性访问可能同步抛出：PAGE_LOGIN_REQUIRED / PAGE_CLOSED 表示缺少身份或页面关闭；参数非法为 PAGE_INVALID_REQUEST，传输失败为 PAGE_NETWORK_UNAVAILABLE，非法响应为 PAGE_RESPONSE_INVALID；文件超过 16 MiB 为 PAGE_FILE_TOO_LARGE。后端业务拒绝保留安全错误码。
     * @remarks 由 SDK 携带页面身份，不传 URL、凭据头、method 或 body。后端逐请求校验业务归属；失败不返回部分字节，退出或关闭后不返回旧会话结果。按需重新登录后由用户重试读取，较大文件须另行设计受控传输。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#页面文件下载
     */
    downloadBackend(input: {
        path: string;
        query?: Record<string, string | number | boolean>;
    }): Promise<BinaryResult>;
    /** @sdkFailure page
     * @throws Promise 拒绝；非法 JavaScript 实参解构可能同步抛出：PAGE_LOGIN_REQUIRED / PAGE_CLOSED / PAGE_OPERATION_BUSY / PAGE_UNSUPPORTED_SCOPE 分别表示缺少会话、连接关闭、授权操作冲突或 scope 无效；传输失败为 PAGE_NETWORK_UNAVAILABLE，非法响应为 PAGE_RESPONSE_INVALID。
     * @remarks authorize 会先完成必要登录；用户拒绝或会话失效时由界面引导。requestBackend 的业务副作用由应用负责，失败不代表未执行；logout 即使请求失败也清除本地令牌。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#页面登录授权与后端调用
     */
    logout(): Promise<void>;
    /** @sdkFailure dispose
     * @remarks 同步释放：重复关闭可调用；未完成请求会因 PAGE_CLOSED 失败。注销远端会话的清理请求是尽力发送，网络失败被隔离。
     * @remarks close 释放本地资源；不能以此证明远端注销已确认，也不会撤销已发送业务。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#释放页面资源
     */
    close(): void;
}
export interface PageClientRequestOptions {
    path?: string;
}
export interface PageClientConnectionOptions {
    window?: Window;
    signal?: AbortSignal;
    timeoutMs?: number;
    deferPresentation?: boolean;
}
export type PageClientOptions = PageClientRequestOptions & ((PageClientConnectionOptions & {
    configUrl?: string;
    hostOrigin?: never;
    issuer?: never;
    connection?: never;
    allowInsecureLocal?: never;
}) | (PageClientConnectionOptions & {
    hostOrigin: string;
    issuer: string;
    allowInsecureLocal?: boolean;
    connection?: never;
    configUrl?: never;
}) | {
    connection: PageConnection;
    issuer: string;
    hostOrigin?: never;
    configUrl?: never;
    allowInsecureLocal?: never;
    window?: never;
    signal?: never;
    timeoutMs?: never;
    deferPresentation?: never;
});
/** Fetch public config and initialize, or use explicit config / an existing connection. Does not log in or authorize. */
/** @sdkFailure pageFactory
 * @throws Promise 拒绝：PAGE_INVALID_OPTIONS / PAGE_CLIENT_ALREADY_CREATED 表示配置冲突或重复复用连接；配置下载、握手、网络及 JSON 解析错误可能传播。
 * @remarks 自动初始化失败会关闭自身创建的连接；复用外部连接由调用方管理。初始化不自动申请业务权限。
 * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#初始化页面客户端
 */
export declare function createPageClient(options?: PageClientOptions): Promise<PageClient>;
