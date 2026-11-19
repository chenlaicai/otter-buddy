/** events: declarations for the matching SDK reference book. */
import type { CoLinkClient, DirectMessagePage, MessageMentions, MessagePage } from './business.js';
type DeepReadonly<T> = T extends object ? {
    readonly [K in keyof T]: DeepReadonly<T[K]>;
} : T;
interface UserMessageDataBase {
    messageId: string;
    text: string;
    fileIds: string[];
}
export type TopicUserMessageData = DeepReadonly<UserMessageDataBase & {
    mentions?: MessageMentions;
    reason: 'mention' | 'reply';
    channelId: string;
    /** Source channel visibility when the event was created. Older events omit it. */
    channelVisibility?: 'public' | 'private';
    topicId: string;
    conversationId: null;
    replyToMessageId: string | null;
}>;
/** A new human message in an existing personal App conversation or one of its topics. */
export type DirectUserMessageData = DeepReadonly<UserMessageDataBase & {
    reason: 'dm_message';
    channelId: null;
    channelVisibility?: never;
    /** Main-timeline wake: null; topic wake: the root message ID. */
    topicId: string | null;
    conversationId: string;
    replyToMessageId: null;
}>;
/** Verified, normalized event data. Channel events always expose conversationId: null. */
export type UserMessageEventData = DeepReadonly<TopicUserMessageData | DirectUserMessageData>;
export interface UserMessageContext extends TurnActions {
    /** Online validation of the current event; never grants access after this turn ends. */
    /** @sdkFailure active
     * @throws Promise 拒绝：事件过期、取消、授权失效或回合结束时拒绝；不能延长事件有效期。
     * @remarks 停止当前回合工作。已经发送的外部副作用不回滚，不在另一个身份下继续本轮。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#检查事件有效期
     */
    assertActive(): Promise<void>;
    /** Current callback only; does not pause the model, extend authority, or survive callback return. */
    /** @sdkFailure status
     * @throws 输入或有效期失败时 Promise 拒绝；发送结果也可正常返回状态：INVALID_INTERACTION_STATUS 表示非 processing / suspended；disabled、unavailable、pending 是正常状态回执，不表示抛出异常。
     * @remarks 读取 status、code、hint。pending 由 SDK 维护恢复；不要绕开自动状态管理并发发送手工状态。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#更新展示状态
     */
    setDisplayStatus(status: 'processing' | 'suspended'): Promise<Readonly<{
        status: 'sent' | 'pending' | 'unavailable' | 'disabled';
        code?: string;
        message: string;
        hint: string;
    }>>;
    /** Complete verified event envelope without authorization credentials, shared by App and Agent. */
    readonly event: Extract<AppEvent, {
        type: 'app.user_message_received';
    }>;
    colink: CoLinkClient;
    /** Topic wake: channelId/topicId set, conversationId null. DM wake (F20261102dmagent): the reverse. */
    context: Readonly<{
        installationId: string;
        userId: string;
        channelId: string | null;
        topicId: string | null;
        conversationId?: string | null;
        authorizationVersion: number;
    }>;
    signal: AbortSignal;
}
export interface TopicReadOptions {
    limit?: number;
    cursor?: string;
}
export interface TurnActions {
    /** Reads only the original topic or DM conversation; never accepts caller-selected resources or identities. */
    readonly source: {
        readonly kind: 'topic'; /** @sdkFailure source
       * @throws Promise 拒绝：INVALID_READ_OPTIONS 表示分页参数非法；SOURCE_READ_IDENTITY_UNAVAILABLE 表示可信话题缺少可见性。缺授权、失效回合及当前来源访问校验仍会拒绝。
       * @remarks 仅传对应分页参数；SDK 按可信来源固定身份，公共话题用 A，私密话题及私聊用本轮 U。缺少可见性时等待具有完整来源的新事件；不切换身份重试，不以通用读取绕过来源限制。
       * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#原来源读取
       */
        listMessages(options?: TopicReadOptions): Promise<MessagePage>;
    } | {
        readonly kind: 'dm'; /** @sdkFailure source
       * @throws Promise 拒绝：INVALID_READ_OPTIONS 表示分页参数非法；SOURCE_READ_IDENTITY_UNAVAILABLE 表示可信话题缺少可见性。缺授权、失效回合及当前来源访问校验仍会拒绝。
       * @remarks 仅传对应分页参数；SDK 按可信来源固定身份，公共话题用 A，私密话题及私聊用本轮 U。缺少可见性时等待具有完整来源的新事件；不切换身份重试，不以通用读取绕过来源限制。
       * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#原来源读取
       */
        listMessages(options?: TopicReadOptions): Promise<DirectMessagePage>;
    };
    /** Persist and send a complete stage message now. Await for backpressure; key is stable within the event. */
    /** @sdkFailure progress
     * @throws Promise 拒绝：PROGRESS_NOT_ENABLED / INVALID_PROGRESS 分别表示未启用或输入无效；失效回合、幂等冲突及发送故障也会拒绝。
     * @remarks 阶段消息可能已经发送；保留稳定 idempotencyKey，按输出回执恢复，失败不撤回此前阶段。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#阶段输出
     */
    sendProgress(input: {
        idempotencyKey: string;
        text: string;
    }): Promise<Readonly<{
        status: 'sent';
        sequence: number;
        messageId: string;
        messages: readonly {
            sequence: number;
            messageId: string;
        }[];
    }>>;
    /** Stage a reply. After the handler succeeds the SDK persists and delivers it with a stable idempotency key. */
    /** @sdkFailure reply
     * @throws Promise 拒绝：INVALID_REPLY 表示回复字段或文本非法；失效回合及在线授权检查会拒绝。成功只返回 staged，还未确认消息发送。
     * @remarks await reply；回调成功后由 SDK 提交，staged 不是最终发送回执。本方法发布到原来源，公共话题的其他成员也可见。读取 App 私人记录时只发布允许公开的回执，详情留在鉴权页面；群里查询不等于同意分享正文。
     * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#暂存消息回复
     */
    reply(input: {
        text: string;
    }): Promise<Readonly<{
        status: 'staged';
    }>>;
}
export interface EventEnvelope {
    eventId: string;
    appId: string;
    deploymentId: string;
    installationId: string;
    timestamp: string;
    actor: {
        type: 'user';
        id: string;
        username?: string;
        displayName?: string;
    };
}
export interface CollaborationMessageSource {
    mentions?: MessageMentions;
    collaborationId: string;
    channelId: string;
    topicId: string;
    messageId: string;
    replyToMessageId: string | null;
    expiresAt: string;
}
export interface CoLinkUiActionSource {
    projectId: string;
    channelId: string;
    topicId: string;
    messageId: string;
    componentId: string;
    /** Present for completion:result actions; the numeric revision at the click. */
    messageRevision?: number;
}
export type AppEvent = DeepReadonly<(Omit<EventEnvelope, 'actor'> & {
    schemaVersion: '1.0.0';
    type: 'app.collaboration_message_received';
    actor: {
        type: 'app';
        id: string;
    };
    data: CollaborationMessageSource & {
        reason: 'mention';
        text: string;
    };
}) | (EventEnvelope & {
    schemaVersion: '2.0.0';
    type: 'app.user_message_received';
    data: UserMessageEventData;
}) | (EventEnvelope & {
    schemaVersion: '1.0.0';
    type: 'app.colink_ui_action_invoked';
    data: {
        name: string;
        payload: Record<string, unknown>;
        source: CoLinkUiActionSource;
    };
}) | (EventEnvelope & {
    schemaVersion: '2.0.0';
    type: 'app.message_processing_cancelled';
    data: {
        messageEventId: string;
        channelId: string;
        topicId: string;
        reason: 'stopped' | 'recalled';
    };
}) | (Omit<EventEnvelope, 'actor'> & {
    schemaVersion: '2.0.0';
    type: 'task.execution_requested';
    actor: {
        type: 'user' | 'app';
        id: string;
    };
    data: {
        taskId: string;
        executionEpoch: number;
        channelId: string;
        topicId: string | null;
        title: string;
        reason: 'assigned' | 'reopened';
        rejection?: {
            executionEpoch: number;
            reason: string;
        };
    };
}) | (Omit<EventEnvelope, 'actor'> & {
    schemaVersion: '2.0.0';
    type: 'task.execution_cancelled';
    actor: {
        type: 'user' | 'app';
        id: string;
    };
    data: {
        taskId: string;
        channelId: string;
        executionEpoch: number;
        reason: 'cancelled' | 'reassigned';
    };
})>;
/** Named registration keys; event.type retains the corresponding wire string. */
export declare enum EventType {
    UserMessageReceived = "app.user_message_received",
    CollaborationMessageReceived = "app.collaboration_message_received",
    CoLinkUiActionInvoked = "app.colink_ui_action_invoked",
    MessageProcessingCancelled = "app.message_processing_cancelled",
    TaskExecutionRequested = "task.execution_requested",
    TaskExecutionCancelled = "task.execution_cancelled"
}
/** Non-mention events have data and identity clients, but no reply/progress capabilities. */
export type NonUserMessageEvent = Exclude<AppEvent, {
    type: 'app.user_message_received';
}>;
export interface EventContext<E extends NonUserMessageEvent = NonUserMessageEvent> {
    readonly event: E;
    context: Readonly<{
        installationId: string;
        authorizationVersion: number;
    }>;
    colink: CoLinkClient;
    signal: AbortSignal;
}
/** Exact callback context selected by the registration key. */
export type EventContextByType = {
    [EventType.UserMessageReceived]: UserMessageContext;
    [EventType.CollaborationMessageReceived]: EventContext<Extract<NonUserMessageEvent, {
        type: 'app.collaboration_message_received';
    }>>;
    [EventType.CoLinkUiActionInvoked]: EventContext<Extract<NonUserMessageEvent, {
        type: 'app.colink_ui_action_invoked';
    }>>;
    [EventType.MessageProcessingCancelled]: EventContext<Extract<NonUserMessageEvent, {
        type: 'app.message_processing_cancelled';
    }>>;
    [EventType.TaskExecutionRequested]: EventContext<Extract<NonUserMessageEvent, {
        type: 'task.execution_requested';
    }>>;
    [EventType.TaskExecutionCancelled]: EventContext<Extract<NonUserMessageEvent, {
        type: 'task.execution_cancelled';
    }>>;
};
/** @sdkFailure eventCallback
 * @remarks SDK 捕获回调抛出或 Promise 拒绝：App 回调必须返回 void；其他结果为 INVALID_EVENT_RESULT。SDK 按现有交接规则记录失败或恢复；回调异常不会从先前已成功的 onEvent 注册调用抛出。
 * @remarks 提交输出前可能重入；业务副作用须幂等。已提交输出的恢复不等于重新执行业务，4xx、超时、撤权和取消不自动当作可重试错误。
 * @see https://colink.link/docs/app-extensions/colink-for-ai.zip 文档包：for-ai-sdk-errors.md#事件处理回调
 */
export type EventHandler<T extends EventType = EventType> = (ctx: EventContextByType[T]) => Promise<void>;
/** Inline handlers are narrowed by their event type, just like runtime.onEvent. */
export type EventHandlers = {
    [T in EventType]?: EventHandler<T>;
};
export {};
