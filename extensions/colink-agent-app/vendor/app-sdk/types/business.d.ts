/** business: declarations for the matching SDK reference book. */
export interface DirectMessagePage {
    items: Array<{
        id: string;
        conversationId: string;
        senderId: string;
        senderKind: 'human' | 'agent';
        text: string;
        attachments: Array<{
            artifactId: string;
            fileName: string;
            sizeBytes?: number;
        }>;
        createdAt: string;
        recalledAt: string | null;
    }>;
}
export interface MessagePage {
    items: Array<{
        id: string;
        revision: number;
        senderName: string;
        senderKind: string;
        text: string;
        mentions?: MessageMentions;
        truncated: boolean;
        attachments: Array<{
            artifactId: string;
            fileName: string;
        }>;
        createdAt: string;
    }>;
    hasMore: boolean;
    nextCursor: string | null;
}
export interface ChannelReference {
    channelId: string;
    channelName: string;
}
/** Positions count UTF-16 code units in the original stored text, before Markdown parsing. */
export interface MessageMentions {
    version: 1;
    items: Array<{
        start: number;
        end: number;
        label: string;
        target: {
            type: 'user';
            userId: string;
        } | {
            type: 'app';
            installationId: string;
        };
    }>;
}
export interface MemberPage extends PageResult<MemberSummary> {
    mentionProtocol?: 1;
}
export interface MessageContent {
    mentions?: MessageMentions;
    author: PrincipalSummary;
    text: string;
    createdAt: string;
    recalled: boolean;
    files: Array<{
        fileId: string;
        fileName: string;
    }>;
}
export interface MessageDetail {
    source: {
        projectId?: string;
        channelId: string;
        topicId: string;
        messageId: string;
    };
    content: MessageContent;
}
export interface ChannelMessage {
    mentions?: MessageMentions;
    messageId: string;
    revision: number;
    channelId: string;
    topicId: string | null;
    author: PrincipalSummary;
    text: string;
    createdAt: string;
    recalled: boolean;
    sentToChannel: boolean;
    files: Array<{
        fileId: string;
        title: string;
        fileName: string;
        sizeBytes: number | null;
    }>;
    apps: Array<{
        appKey: string;
        resourceId: string;
        title: string | null;
    }>;
    quote: {
        messageId: string;
        authorName: string;
        text: string;
        recalled?: boolean;
    } | null;
    event: {
        kind: string;
        taskId: string | null;
        summary: string | null;
    } | null;
    taskId: string | null;
}
export interface ChannelMessagePage extends PageResult<ChannelMessage> {
    channel: ChannelReference;
}
export interface UnreadPage extends PageResult<{
    messageId: string;
    channelId: string;
    topicId: string;
    createdAt: string;
}> {
    channel: ChannelReference;
    unreadSnapshot: {
        scope: 'channel';
        readerUserId: string;
        readStateAvailable: boolean;
        readAt: string | null;
        capturedAt: string;
        unreadCount: number | null;
    };
}
export interface StatusReceipt {
    deploymentId: string;
    channelId: string;
    topicId: string;
    status: 'processing' | 'suspended' | 'finished';
    sequence: number;
    updatedAt: string;
    warnings: string[];
}
export interface PageResult<T> {
    items: T[];
    hasMore: boolean;
    nextCursor: string | null;
}
export interface Participant {
    userId: string;
    displayName: string;
    username: string;
}
export interface BinaryResult {
    bytes: Uint8Array;
    contentType: string;
}
export interface ContactPerson {
    userId: string;
    username: string;
    displayName: string;
}
export interface ContactQuery {
    query?: string;
    cursor?: string;
    view?: 'picker';
}
export interface ContactResult {
    items: ContactPerson[];
    nextCursor?: string | null;
    hasMore?: boolean;
    recentItems?: ContactPerson[];
}
export interface DiscussionImage {
    artifactId: string;
    mimeType: string;
    data: string;
    [key: string]: unknown;
}
export interface SendReceipt {
    /** Present for channel posts and attachment sends; legacy topic-only receipts may omit these. */
    topicId?: string;
    channelId?: string;
    fileIds?: string[];
    messageId: string;
    [key: string]: unknown;
}
export interface DraftReceipt {
    topicId: string;
    draftId: string;
    status: 'pending';
    requiresConfirmation: true;
}
export interface ActionResultReceipt {
    id: string;
    status: 'completed';
    expiresAt: string;
    result: {
        operationId: string;
        status: 'succeeded' | 'failed';
        message: string | null;
        replacement: {
            messageId: string;
            revision: number;
        } | null;
        completedAt: string;
    };
}
export interface UiRequestReceipt {
    id: string;
    status: string;
    expiresAt?: string;
}
export interface CursorQuery {
    limit?: number;
    cursor?: string;
}
/** The iterator throws on a repeated cursor, page limit or failed page. Previously yielded items are partial. Signal is checked between requests/items; it does not abort an in-flight HTTP request. */
export interface IterationOptions {
    maxPages?: number;
    signal?: AbortSignal;
}
export interface PagedMethods<T, Q extends CursorQuery> {
    /** @sdkFailure read
     * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
     * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
     */
    list(query?: Q): Promise<PageResult<T>>;
    /** @sdkFailure iterate
     * @throws 迭代时 next() 拒绝；创建迭代器不开始请求：除业务读取失败外，INVALID_PAGINATION 表示 maxPages 非法，PAGINATION_CURSOR_REPEATED 表示重复游标，PAGINATION_INCOMPLETE 表示达到页数上限但仍有下一页。取消可能为原生 AbortSignal.reason 或绑定执行的 CLIENT_EXECUTION_INACTIVE。
     * @remarks 已经产出的条目仍有效，失败不是正常末页。可用 for await 捕获；提前 return() 结束消费。服务端绑定包装会释放执行并吞掉内部迭代器异步清理失败，不据此推断所有条目已读取。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#异步分页
     */
    iterate(query?: Q, options?: IterationOptions): AsyncIterableIterator<T>;
}
export interface ProjectSummary {
    projectId: string;
    name: string;
}
export interface ChannelSummary {
    channelId: string;
    projectId: string;
    name: string;
    visibility: 'public' | 'private';
}
export interface MemberSummary {
    type: 'user' | 'agent' | 'app';
    id: string;
    name: string;
    publicName?: string;
    mention: string;
    isYou: boolean;
    participant?: boolean;
    description?: string | null;
    canReceiveAgentMention?: boolean;
}
export interface PrincipalSummary {
    type: 'user' | 'agent' | 'app';
    id: string;
    name: string;
}
/** 执行状态。`paused` 已退役（迁移 1800001000095 把存量并入 `failed`）：传它会被平台按非法值 400 拒。 */
export type TaskExecutionStatus = 'todo' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface TaskListQuery extends CursorQuery {
    topicId?: string;
    channelId?: string;
    executionStatus?: TaskExecutionStatus[];
    relatedTo?: 'me';
    assignee?: 'self';
    query?: string;
}
export interface TaskSummary {
    taskId: string;
    title: string;
    channelId: string;
    source: {
        topicId: string | null;
        messageId: string | null;
    };
    creator: PrincipalSummary;
    assignee: {
        type: 'human' | 'agent' | 'app';
        id: string;
        name: string;
    } | null;
    executionStatus: TaskExecutionStatus;
    acceptanceStatus: string;
    executionEpoch: number;
    version: number;
    dueAt: string | null;
    updatedAt: string;
    permalink: string;
}
export interface TaskDetail extends TaskSummary {
    taskKey: string | null;
    goal: string;
    requester: PrincipalSummary | null;
    attachments: Array<{
        fileId: string;
        name: string;
    }>;
    progress: string | null;
    conclusion: string | null;
    resultArtifacts: Array<{
        type: 'text';
        content: string;
        title?: string;
        format?: string;
    } | {
        type: 'file';
        name: string;
        url: string;
        fileId?: string;
    }>;
    rejection: {
        executionEpoch: number;
        reason: string;
        by: PrincipalSummary;
        at: string;
    } | null;
    pendingAction: string | null;
    controlHistory: ReadonlyArray<Record<string, unknown>>;
    delivery: Readonly<Record<string, unknown>>;
    startedAt: string | null;
    createdAt: string;
}
export type TaskAssigneeInput = 'self' | {
    type: 'user' | 'agent' | 'app';
    id: string;
};
export type TaskResultArtifactInput = {
    type: 'file';
    fileId: string;
} | {
    type: 'file';
    name: string;
    url: string;
};
export interface TaskCreateInput {
    idempotencyKey: string;
    title: string;
    goal: string;
    taskKey?: string;
    channelId?: string;
    topicId?: string;
    assignee?: TaskAssigneeInput;
    dueAt?: string | null;
    attachments?: string[];
}
export type TaskUpdateInput = {
    taskId: string;
    idempotencyKey: string;
    expectedVersion: number;
} & ({
    action?: never;
    title?: string;
    goal?: string;
    dueAt?: string | null;
    attachments?: string[];
    assignee?: never;
    reason?: never;
} | {
    action: 'reassign';
    reason: string;
    assignee: TaskAssigneeInput;
    title?: never;
    goal?: never;
    dueAt?: never;
    attachments?: never;
} | {
    action: 'cancel' | 'restart';
    reason: string;
    assignee?: never;
    title?: never;
    goal?: never;
    dueAt?: never;
    attachments?: never;
});
export interface TaskReportInput {
    taskId: string;
    idempotencyKey: string;
    expectedVersion: number;
    executionEpoch: number;
    executionStatus?: 'running' | 'completed' | 'failed';
    progress?: string;
    conclusion?: string;
    resultArtifacts?: TaskResultArtifactInput[];
}
export interface TaskWriteReceipt {
    taskId: string;
    version: number;
}
export interface TaskReportReceipt extends TaskWriteReceipt {
    executionEpoch: number;
    executionStatus: TaskExecutionStatus;
    acceptanceStatus: string;
}
export interface PersonalTaskQuery {
    status?: 'todo' | 'running' | 'failed' | 'complete' | 'cancelled';
    view?: 'created' | 'requested' | 'assigned' | 'review' | 'actionable';
    query?: string;
    page?: number;
}
export interface PersonalTaskPage {
    items: Array<{
        taskId: string;
        title: string;
        requesterId: string | null;
        acceptanceStatus: string;
        status: string;
        channelId: string;
        channelName: string;
        projectId: string;
        projectName: string;
        assignee: {
            type: 'human' | 'agent' | 'app' | null;
            id: string | null;
            name: string | null;
        };
        createdAt: string;
        updatedAt: string;
    }>;
    counts: Record<'todo' | 'running' | 'failed' | 'complete' | 'cancelled', number>;
    total: number;
    page: number;
    pageSize: number;
    revision: string;
}
export interface FileSummary {
    fileId: string;
    channelId: string;
    title: string;
    fileName: string;
    mimeType: string | null;
    sizeBytes: number;
    sha256: string | null;
    sharedBy: PrincipalSummary;
    sharedAt: string;
}
export interface FileContentResult extends FileSummary {
    content: string | null;
    totalCharacters: number | null;
    nextOffset: number | null;
    unreadableReason: 'PERMISSION' | 'TOO_LARGE' | 'UNSUPPORTED_TYPE' | 'NOT_TEXT' | 'UNREADABLE' | null;
    image: {
        mimeType: string;
        width: number;
        height: number;
    } | null;
    images?: Array<{
        data: string;
        mimeType: 'image/png' | 'image/jpeg';
    }>;
    download?: never;
}
export interface FileUploadReceipt {
    fileId: string;
    status: 'ok';
    sizeBytes: number;
    sha256: string;
}
export interface FileCreateInput {
    idempotencyKey: string;
    channelId: string;
    fileName: string;
    title?: string;
    asArtifact?: boolean;
}
export interface FileCreateTextInput extends FileCreateInput {
    content: string;
}
export interface FileUploadInput extends FileCreateInput {
    bytes: Uint8Array;
}
export interface FileCreated {
    fileId: string;
    channelId: string;
    title: string;
    fileName: string;
    sizeBytes: number;
    sha256: string;
    mimeType: string | null;
    status: 'ok';
}
export interface AppDiscoveryQuery extends CursorQuery {
    query?: string;
    providerInstallationId?: string;
}
export interface AppSummary {
    providerInstallationId: string;
    appId: string;
    name: string;
    description: string;
    status: string;
    available: boolean;
    specRevision: string | null;
    operations: Array<{
        operationId: string;
        summary: string;
        description: string;
        topicReply?: unknown;
    }>;
    errorCode?: string;
}
export interface AppOperationGuide {
    operationId: string;
    summary: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
    errorCodes: string[];
    [field: string]: unknown;
}
export interface AppGuide extends PageResult<AppOperationGuide> {
    providerInstallationId: string;
    appId: string;
    name: string;
    description: string;
    specRevision: string;
    available: boolean;
}
export interface AppCallResult {
    callId: string;
    status: 'accepted' | 'running' | 'completed' | 'failed' | 'unknown';
    specRevision: string;
    resultAvailable: boolean;
    topicReply: {
        state: 'not_required' | 'pending' | 'published' | 'skipped' | 'stopped';
        sender: 'provider' | 'consumer' | null;
        format: 'text' | 'card' | null;
        messageId: string | null;
        reason: string | null;
    };
    response: {
        status: 200 | 201 | 202 | 204;
        data: unknown;
    } | null;
    error: {
        code: string;
        message: string;
        requestId: string;
        providerErrorCode?: string;
    } | null;
}
export interface BusinessMethods {
    readonly projects: {
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        list(query?: CursorQuery | undefined): Promise<PageResult<ProjectSummary>>;
        /** @sdkFailure iterate
         * @throws 迭代时 next() 拒绝；创建迭代器不开始请求：除业务读取失败外，INVALID_PAGINATION 表示 maxPages 非法，PAGINATION_CURSOR_REPEATED 表示重复游标，PAGINATION_INCOMPLETE 表示达到页数上限但仍有下一页。取消可能为原生 AbortSignal.reason 或绑定执行的 CLIENT_EXECUTION_INACTIVE。
         * @remarks 已经产出的条目仍有效，失败不是正常末页。可用 for await 捕获；提前 return() 结束消费。服务端绑定包装会释放执行并吞掉内部迭代器异步清理失败，不据此推断所有条目已读取。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#异步分页
         */
        iterate(query?: CursorQuery | undefined, options?: IterationOptions): AsyncIterableIterator<ProjectSummary>;
    };
    readonly channels: {
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        list(query?: (CursorQuery & {
            projectId?: string;
        }) | undefined): Promise<PageResult<ChannelSummary>>;
        /** @sdkFailure iterate
         * @throws 迭代时 next() 拒绝；创建迭代器不开始请求：除业务读取失败外，INVALID_PAGINATION 表示 maxPages 非法，PAGINATION_CURSOR_REPEATED 表示重复游标，PAGINATION_INCOMPLETE 表示达到页数上限但仍有下一页。取消可能为原生 AbortSignal.reason 或绑定执行的 CLIENT_EXECUTION_INACTIVE。
         * @remarks 已经产出的条目仍有效，失败不是正常末页。可用 for await 捕获；提前 return() 结束消费。服务端绑定包装会释放执行并吞掉内部迭代器异步清理失败，不据此推断所有条目已读取。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#异步分页
         */
        iterate(query?: (CursorQuery & {
            projectId?: string;
        }) | undefined, options?: IterationOptions): AsyncIterableIterator<ChannelSummary>;
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        listMembers(input: CursorQuery & {
            channelId: string;
            topicId?: string;
        }): Promise<MemberPage>;
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        listMessages(input: CursorQuery & {
            channelId: string;
            beforeMessageId?: string;
            afterMessageId?: string;
        }): Promise<ChannelMessagePage>;
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        listUnreadMessages(options: {
            channelId: string;
            limit?: number;
            cursor?: string;
        }): Promise<UnreadPage>;
    };
    readonly messages: {
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        get(input: {
            messageId: string;
        }): Promise<MessageDetail>;
        /** @sdkFailure write
         * @throws Promise 拒绝：沿用业务读取的参数、身份及传输失败边界；写入另受幂等键、版本和资源范围约束。失败不等于未写入，部分操作返回业务失败或部分成功回执而不抛异常。
         * @remarks 先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务写入
         */
        replace(input: {
            messageId: string;
            expectedRevision: number;
            text: string;
            fileIds?: string[];
        }): Promise<{
            messageId: string;
            revision: number;
            channelId: string;
            topicId: string | null;
        }>;
        /** @sdkFailure write
         * @throws Promise 拒绝：沿用业务读取的参数、身份及传输失败边界；写入另受幂等键、版本和资源范围约束。失败不等于未写入，部分操作返回业务失败或部分成功回执而不抛异常。
         * @remarks 先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务写入
         */
        recall(input: {
            messageId: string;
            channelId?: string;
            idempotencyKey: string;
        }): Promise<{
            messageId: string;
            channelId: string;
            recalledAt: string;
        }>;
        /** @sdkFailure write
         * @throws Promise 拒绝：沿用业务读取的参数、身份及传输失败边界；写入另受幂等键、版本和资源范围约束。失败不等于未写入，部分操作返回业务失败或部分成功回执而不抛异常。
         * @remarks 先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务写入
         */
        send(input: {
            idempotencyKey: string;
            text: string;
            fileIds?: string[];
        } & ({
            channelId: string;
            topicId?: string;
            conversationId?: never;
            sourceMessageId?: never;
            sourceEventId?: string;
            mentions?: MessageMentions;
        } | {
            conversationId: string;
            sourceMessageId: string;
            channelId?: never;
            topicId?: string | null;
            sourceEventId?: never;
            mentions?: never;
        })): Promise<SendReceipt & {
            messages: SendReceipt[];
        }>;
    };
    readonly topics: {
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        list(options?: TopicListOptions): Promise<TopicPage>;
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        listMessages(options: {
            topicId: string;
            limit?: number;
            cursor?: string;
        }): Promise<MessagePage>;
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        listParticipants(options: {
            topicId: string;
            limit?: number;
            cursor?: string;
        }): Promise<PageResult<Participant>>;
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        readImage(input: {
            topicId: string;
            artifactId: string;
        }): Promise<DiscussionImage>;
    };
    readonly directMessages: {
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        list(options: {
            conversationId: string;
            limit?: number;
            beforeId?: string;
            afterId?: string;
        }): Promise<DirectMessagePage>;
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        downloadAttachment(options: {
            conversationId: string;
            artifactId: string;
        }): Promise<BinaryResult>;
    };
    readonly drafts: {
        /** @sdkFailure write
         * @throws Promise 拒绝：沿用业务读取的参数、身份及传输失败边界；写入另受幂等键、版本和资源范围约束。失败不等于未写入，部分操作返回业务失败或部分成功回执而不抛异常。
         * @remarks 先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务写入
         */
        create(input: {
            idempotencyKey: string;
            topicId: string;
            text: string;
        }): Promise<DraftReceipt>;
    };
    readonly events: {
        /** @sdkFailure write
         * @throws Promise 拒绝：沿用业务读取的参数、身份及传输失败边界；写入另受幂等键、版本和资源范围约束。失败不等于未写入，部分操作返回业务失败或部分成功回执而不抛异常。
         * @remarks 先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务写入
         */
        reportStatus(input: {
            idempotencyKey: string;
            eventId?: string;
            channelId: string;
            topicId: string;
            sequence: number;
            status: "processing" | "suspended" | "finished";
        }): Promise<StatusReceipt>;
        /** @sdkFailure write
         * @throws Promise 拒绝：沿用业务读取的参数、身份及传输失败边界；写入另受幂等键、版本和资源范围约束。失败不等于未写入，部分操作返回业务失败或部分成功回执而不抛异常。
         * @remarks 先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务写入
         */
        reportUndelivered(input: {
            eventId?: string;
            reason: "agent_backend_unavailable" | "channel_denied" | "app_failed";
            requestId: string;
            threadId: string;
            channelId: string;
            errorCode?: string;
            errorMessage?: string;
        }): Promise<{
            accepted: true;
            duplicate: boolean;
        }>;
    };
    readonly actions: {
        /** @sdkFailure write
         * @throws Promise 拒绝：沿用业务读取的参数、身份及传输失败边界；写入另受幂等键、版本和资源范围约束。失败不等于未写入，部分操作返回业务失败或部分成功回执而不抛异常。
         * @remarks 先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务写入
         */
        complete(input: {
            idempotencyKey: string;
            eventId?: string;
            status: "succeeded" | "failed";
            message?: string;
            replacement?: {
                messageId: string;
                revision: number;
            };
        }): Promise<ActionResultReceipt>;
    };
    readonly interactions: {
        /** @sdkFailure write
         * @throws Promise 拒绝：沿用业务读取的参数、身份及传输失败边界；写入另受幂等键、版本和资源范围约束。失败不等于未写入，部分操作返回业务失败或部分成功回执而不抛异常。
         * @remarks 先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务写入
         */
        openDialog(input: {
            idempotencyKey: string;
            eventId?: string;
            viewId: string;
            title?: string;
            message?: string;
        }): Promise<UiRequestReceipt>;
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        get(input: {
            interactionId: string;
            eventId?: string;
        }): Promise<UiRequestReceipt>;
        /** @sdkFailure write
         * @throws Promise 拒绝：沿用业务读取的参数、身份及传输失败边界；写入另受幂等键、版本和资源范围约束。失败不等于未写入，部分操作返回业务失败或部分成功回执而不抛异常。
         * @remarks 先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务写入
         */
        complete(input: {
            interactionId: string;
        }): Promise<UiRequestReceipt>;
        /** @sdkFailure write
         * @throws Promise 拒绝：沿用业务读取的参数、身份及传输失败边界；写入另受幂等键、版本和资源范围约束。失败不等于未写入，部分操作返回业务失败或部分成功回执而不抛异常。
         * @remarks 先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务写入
         */
        showToast(input: {
            idempotencyKey: string;
            eventId?: string;
            message: string;
            severity?: "success" | "error" | "info";
            durationMs?: number;
        }): Promise<UiRequestReceipt>;
    };
    readonly files: {
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        list(query: CursorQuery & {
            channelId: string;
            query?: string;
        }): Promise<PageResult<FileSummary>>;
        /** @sdkFailure iterate
         * @throws 迭代时 next() 拒绝；创建迭代器不开始请求：除业务读取失败外，INVALID_PAGINATION 表示 maxPages 非法，PAGINATION_CURSOR_REPEATED 表示重复游标，PAGINATION_INCOMPLETE 表示达到页数上限但仍有下一页。取消可能为原生 AbortSignal.reason 或绑定执行的 CLIENT_EXECUTION_INACTIVE。
         * @remarks 已经产出的条目仍有效，失败不是正常末页。可用 for await 捕获；提前 return() 结束消费。服务端绑定包装会释放执行并吞掉内部迭代器异步清理失败，不据此推断所有条目已读取。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#异步分页
         */
        iterate(query: CursorQuery & {
            channelId: string;
            query?: string;
        }, options?: IterationOptions): AsyncIterableIterator<FileSummary>;
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        readContent(input: {
            fileId: string;
            offset?: number;
            limit?: number;
        }): Promise<FileContentResult>;
        /** @sdkFailure write
         * @throws Promise 拒绝：沿用业务读取的参数、身份及传输失败边界；写入另受幂等键、版本和资源范围约束。失败不等于未写入，部分操作返回业务失败或部分成功回执而不抛异常。
         * @remarks 先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务写入
         */
        createText(input: FileCreateTextInput): Promise<FileCreated>;
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        download(input: {
            fileId: string;
        }): Promise<BinaryResult>;
        /** @sdkFailure write
         * @throws Promise 拒绝：沿用业务读取的参数、身份及传输失败边界；写入另受幂等键、版本和资源范围约束。失败不等于未写入，部分操作返回业务失败或部分成功回执而不抛异常。
         * @remarks 先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务写入
         */
        upload(input: FileUploadInput): Promise<FileUploadReceipt>;
    };
    readonly tasks: {
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        list(query?: TaskListQuery | undefined): Promise<PageResult<TaskSummary>>;
        /** @sdkFailure iterate
         * @throws 迭代时 next() 拒绝；创建迭代器不开始请求：除业务读取失败外，INVALID_PAGINATION 表示 maxPages 非法，PAGINATION_CURSOR_REPEATED 表示重复游标，PAGINATION_INCOMPLETE 表示达到页数上限但仍有下一页。取消可能为原生 AbortSignal.reason 或绑定执行的 CLIENT_EXECUTION_INACTIVE。
         * @remarks 已经产出的条目仍有效，失败不是正常末页。可用 for await 捕获；提前 return() 结束消费。服务端绑定包装会释放执行并吞掉内部迭代器异步清理失败，不据此推断所有条目已读取。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#异步分页
         */
        iterate(query?: TaskListQuery | undefined, options?: IterationOptions): AsyncIterableIterator<TaskSummary>;
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        get(input: {
            taskId: string;
        }): Promise<TaskDetail>;
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        listPersonal(query?: PersonalTaskQuery): Promise<PersonalTaskPage>;
        /** @sdkFailure write
         * @throws Promise 拒绝：沿用业务读取的参数、身份及传输失败边界；写入另受幂等键、版本和资源范围约束。失败不等于未写入，部分操作返回业务失败或部分成功回执而不抛异常。
         * @remarks 先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务写入
         */
        create(input: TaskCreateInput): Promise<TaskWriteReceipt>;
        /** @sdkFailure write
         * @throws Promise 拒绝：沿用业务读取的参数、身份及传输失败边界；写入另受幂等键、版本和资源范围约束。失败不等于未写入，部分操作返回业务失败或部分成功回执而不抛异常。
         * @remarks 先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务写入
         */
        update(input: TaskUpdateInput): Promise<TaskWriteReceipt>;
        /** @sdkFailure write
         * @throws Promise 拒绝：沿用业务读取的参数、身份及传输失败边界；写入另受幂等键、版本和资源范围约束。失败不等于未写入，部分操作返回业务失败或部分成功回执而不抛异常。
         * @remarks 先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务写入
         */
        reportExecution(input: TaskReportInput): Promise<TaskReportReceipt>;
    };
    readonly contacts: {
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        list(query?: ContactQuery): Promise<ContactResult>;
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        listChannels(query?: {
            query?: string;
            cursor?: string;
        }): Promise<PageResult<{
            id: string;
            name: string;
        }>>;
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        listProjects(query?: {
            query?: string;
            cursor?: string;
        }): Promise<PageResult<{
            id: string;
            name: string;
        }>>;
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        resolve(body: {
            participantIds?: string[];
            channelIds?: string[];
            projectIds?: string[];
        }): Promise<{
            items: ContactPerson[];
        }>;
    };
    readonly apps: {
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        list(query?: AppDiscoveryQuery): Promise<PageResult<AppSummary>>;
        /** @sdkFailure read
         * @throws Promise 拒绝：参数形状错误为 INVALID_ARGUMENT；路径 ID 不合法为 INVALID_RESOURCE；所选身份不可用或缺少权限为 CLIENT_IDENTITY_UNAVAILABLE / SCOPE_MISSING。平台传输失败为 PLATFORM_NETWORK_UNAVAILABLE，受校验的响应结构不合法为 PLATFORM_RESPONSE_INVALID。浏览器还可能返回 PAGE_LOGIN_REQUIRED / PAGE_CLOSED。
         * @remarks 检查 error.usage、details 和授权来源；修正后重新读取。不切换身份。原生异常及未识别的上游错误仍可能传播，错误码列表不是穷举。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务读取
         */
        listOperations(input: CursorQuery & {
            providerInstallationId: string;
            operationId?: string;
        }): Promise<AppGuide>;
        /** @sdkFailure write
         * @throws Promise 拒绝：沿用业务读取的参数、身份及传输失败边界；写入另受幂等键、版本和资源范围约束。失败不等于未写入，部分操作返回业务失败或部分成功回执而不抛异常。
         * @remarks 先检查回执及 error.write.outcome/action；只有指示 same_key 时才按原键原参数恢复。unknown 先查询结果，不换键重放；取消不撤销已发出的写入。
         * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#业务写入
         */
        callOperation(input: {
            providerInstallationId: string;
            operationId: string;
            input: Record<string, unknown>;
            expectedSpecRevision?: string;
            idempotencyKey: string;
        }): Promise<AppCallResult>;
    };
}
/** User business methods retain their fixed identity and page-safe surface. */
export interface UserClient extends Pick<BusinessMethods, 'projects' | 'topics' | 'directMessages' | 'drafts' | 'contacts' | 'apps'> {
    readonly channels: Pick<BusinessMethods['channels'], 'list' | 'iterate' | 'listMessages' | 'listUnreadMessages'>;
    readonly messages: Pick<BusinessMethods['messages'], 'get'>;
    readonly interactions: Pick<BusinessMethods['interactions'], 'complete'>;
    readonly files: Pick<BusinessMethods['files'], 'list' | 'iterate' | 'readContent' | 'download'>;
    readonly tasks: Omit<BusinessMethods['tasks'], 'reportExecution'>;
}
export type ServerUserClient = UserClient;
export interface AppClient extends Pick<BusinessMethods, 'projects' | 'messages' | 'events' | 'actions' | 'apps'> {
    readonly channels: Pick<BusinessMethods['channels'], 'list' | 'iterate' | 'listMembers' | 'listMessages'>;
    readonly topics: Pick<BusinessMethods['topics'], 'listMessages' | 'listParticipants'>;
    readonly interactions: Omit<BusinessMethods['interactions'], 'complete'>;
    readonly files: Pick<BusinessMethods['files'], 'createText' | 'upload'>;
    readonly tasks: Pick<BusinessMethods['tasks'], 'reportExecution'>;
}
export interface CoLinkClient {
    readonly user: ServerUserClient;
    readonly app: AppClient;
}
export interface TopicListOptions {
    projectId?: string;
    channelId?: string;
    topicIds?: string[];
    limit?: number;
    cursor?: string;
}
export interface TopicPage {
    items: Array<{
        id: string;
        channelId: string;
        projectId: string;
        title: string | null;
    }>;
    hasMore: boolean;
    nextCursor: string | null;
}
