import { EventType } from "./event-types.mjs";
import { fail } from "../shared/errors.mjs";
import { parseMessageMentions } from "../shared/message-mention-schema.mjs";
import { isRecord as object, record } from "../shared/data.mjs";
import { publicEvent } from "../shared/state.mjs";
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
export const STOP_EVENTS = new Set(['app.message_processing_cancelled', 'task.execution_cancelled']);
export const HANDLED_EVENTS = new Set(Object.values(EventType));
export function assertEventHandler(type, handler) {
    if (typeof type !== 'string' || !HANDLED_EVENTS.has(type) || typeof handler !== 'function')
        throw fail('HANDLER_REGISTRATION_INVALID', 409);
}
const resource = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;
export function validateTaskEvent(event, config, store) {
    const d = record(event.data), messageStop = event.type === 'app.message_processing_cancelled';
    if (event.schemaVersion !== '2.0.0' || !['task.execution_requested', 'task.execution_cancelled', 'app.message_processing_cancelled'].includes(event.type) ||
        event.appId !== config.appId || event.deploymentId !== config.appInstanceId ||
        !uuid(event.eventId) || !uuid(event.installationId) || !['user', 'app'].includes(event.actor?.type) ||
        !resource(event.actor.id) || !Number.isFinite(Date.parse(event.timestamp)) || !object(d) || !resource(d.channelId))
        throw fail('INVALID_EVENT', 400);
    if (messageStop ? event.actor.type !== 'user' || !uuid(d.messageEventId) || !resource(d.topicId) || !['stopped', 'recalled'].includes(typeof d.reason === 'string' ? d.reason : '')
        : !resource(d.taskId) || typeof d.executionEpoch !== 'number' || !Number.isSafeInteger(d.executionEpoch) || d.executionEpoch < 0 ||
            (event.type === 'task.execution_requested' ? !(d.topicId === null || resource(d.topicId)) || typeof d.title !== 'string' ||
                !d.title.trim() || d.title.length > 255 || !['assigned', 'reopened'].includes(typeof d.reason === 'string' ? d.reason : '') ||
                d.rejection !== undefined && (!object(d.rejection) || typeof d.rejection.executionEpoch !== 'number' || !Number.isSafeInteger(d.rejection.executionEpoch) ||
                    d.rejection.executionEpoch < 0 || typeof d.rejection.reason !== 'string' || d.rejection.reason.length > 1000)
                : !['cancelled', 'reassigned'].includes(typeof d.reason === 'string' ? d.reason : '')))
        throw fail('INVALID_EVENT', 400);
    if (STOP_EVENTS.has(event.type) && event.userAuthorization !== undefined)
        throw fail('INVALID_EVENT', 400);
    if (store.data.oauthInstallations[event.installationId]?.status !== 'ready')
        throw fail('INSTALLATION_NOT_READY', 503);
}
/** Stop tombstones bind the installation and exact round, never a global task/user. */
export function stopKey(event) {
    if (event.type === 'app.user_message_received' || event.type === 'app.message_processing_cancelled')
        return `${event.installationId}:mention:${event.data.messageEventId || event.eventId}`;
    if (event.type === 'task.execution_requested' || event.type === 'task.execution_cancelled')
        return `${event.installationId}:task:${event.data.taskId}:${event.data.executionEpoch}`;
}
export function sameStopSource(stop, event) {
    return stop.data.channelId === event.data.channelId &&
        (stop.type !== 'app.message_processing_cancelled' || stop.data.topicId === event.data.topicId);
}
function userMessageData(event) {
    if (event.type !== 'app.user_message_received')
        throw fail('INVALID_EVENT', 400);
    const d = event.data;
    const common = { messageId: d.messageId, text: d.text, fileIds: d.fileIds };
    if (d.reason === 'dm_message')
        return { ...common, reason: d.reason, channelId: null, topicId: d.topicId, conversationId: d.conversationId, replyToMessageId: null };
    const mentions = parseMessageMentions(d.mentions);
    return { ...common, reason: d.reason, channelId: d.channelId, topicId: d.topicId, conversationId: null, replyToMessageId: d.replyToMessageId,
        ...(d.channelVisibility === undefined ? {} : { channelVisibility: d.channelVisibility }), ...(mentions ? { mentions } : {}) };
}
export function userMessageEvent(event) {
    const safe = Object.fromEntries(['schemaVersion', 'type', 'eventId', 'appId', 'deploymentId', 'installationId', 'timestamp']
        .map(key => [key, event[key]]));
    const actor = { type: event.actor.type, id: event.actor.id };
    safe.actor = actor;
    for (const [key, max] of [['username', 100], ['displayName', 255]]) {
        const value = event.actor[key];
        if (typeof value === 'string' && value.length > 0 && value.length <= max)
            actor[key] = value;
    }
    safe.data = userMessageData(event);
    const result = publicEvent(safe);
    if (result.type !== 'app.user_message_received')
        throw fail('INVALID_EVENT', 400);
    return result;
}
export function validateCollaborationMessage(event, config, store) {
    const data = record(event.data);
    if (event.type !== 'app.collaboration_message_received' || event.schemaVersion !== '1.0.0' ||
        event.appId !== config.appId || event.deploymentId !== config.appInstanceId ||
        !uuid(event.eventId) || !uuid(event.installationId) || !Number.isFinite(Date.parse(event.timestamp)) ||
        !object(data) || !uuid(data.collaborationId) || !['channelId', 'topicId', 'messageId'].every(key => id(data[key])) ||
        !(data.replyToMessageId === null || id(data.replyToMessageId)) || !Number.isFinite(Date.parse(String(data.expiresAt))) ||
        Object.hasOwn(event, 'userAuthorization'))
        throw fail('INVALID_EVENT', 400);
    if (data.reason !== 'mention' || event.actor?.type !== 'app' || !uuid(event.actor.id) ||
        typeof data.text !== 'string' || !data.text.trim() || data.text.length > 4000)
        throw fail('INVALID_EVENT', 400);
    if (store.data.oauthInstallations[event.installationId]?.status !== 'ready')
        throw fail('INSTALLATION_NOT_READY', 503);
}
// A trusted envelope is not permission to act on arbitrary data supplied in a
// button payload. The App still checks its own record ownership and source.
export function validateCoLinkUiAction(event, config, store) {
    const d = record(event.data), source = record(d.source);
    if (event.schemaVersion !== '1.0.0' || event.type !== 'app.colink_ui_action_invoked' ||
        event.appId !== config.appId || event.deploymentId !== config.appInstanceId ||
        !uuid(event.eventId) || !uuid(event.installationId) || event.actor?.type !== 'user' || !id(event.actor.id) ||
        !Number.isFinite(Date.parse(event.timestamp)) || !object(d) || typeof d.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(d.name) ||
        !object(d.payload) || !object(source) || !['projectId', 'channelId', 'topicId', 'messageId', 'componentId'].every(k => typeof source[k] === 'string' && source[k].length > 0))
        throw fail('INVALID_EVENT', 400);
    if (store.data.oauthInstallations[event.installationId]?.status !== 'ready')
        throw fail('INSTALLATION_NOT_READY', 503);
}
export function validateUserMessage(event, config, store) {
    const d = record(event.data);
    if (event.schemaVersion !== '2.0.0' || event.type !== 'app.user_message_received' ||
        event.appId !== config.appId || event.deploymentId !== config.appInstanceId ||
        !uuid(event.installationId) || !uuid(event.eventId) ||
        event.actor?.type !== 'user' || !resource(event.actor.id) || !Number.isFinite(Date.parse(event.timestamp)) ||
        !d || !['mention', 'reply', 'dm_message'].includes(typeof d.reason === 'string' ? d.reason : '') ||
        !resource(d.messageId) ||
        !(d.replyToMessageId === null || resource(d.replyToMessageId)) ||
        // DM 唤醒（F20261102dmagent）：channelId 为 null 且 conversationId 有值；主时间线唤醒
        // topicId=null，话题唤醒 topicId=话题根（F20261110dmagent）。频道唤醒：channelId 必填
        //（topicId 可空），无 conversationId。两者互斥，必居其一。
        !((resource(d.channelId) && resource(d.topicId) && (d.conversationId ?? null) === null) ||
            (d.channelId === null && (d.topicId === null || resource(d.topicId)) && resource(d.conversationId) && d.replyToMessageId === null)) ||
        (d.channelVisibility !== undefined && (!resource(d.channelId) ||
            (d.channelVisibility !== 'public' && d.channelVisibility !== 'private'))) ||
        typeof d.text !== 'string' || d.text.length > 4000 || !Array.isArray(d.fileIds) ||
        d.fileIds.length > 20 || !d.fileIds.every(resource) || new Set(d.fileIds).size !== d.fileIds.length ||
        (!d.text.trim() && !d.fileIds.length))
        throw fail('INVALID_EVENT', 400);
    if (store.data.oauthInstallations[event.installationId]?.status !== 'ready')
        throw fail('INSTALLATION_NOT_READY', 503);
}
