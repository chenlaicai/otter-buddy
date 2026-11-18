import { fail, CoLinkError } from "../shared/errors.mjs";
import { parseMessageMentions } from "../shared/message-mention-schema.mjs";
import { withMethodDiagnostics } from "../diagnostics/method-diagnostics.mjs";
import { businessResult } from "../shared/wire-values.mjs";
import { isRecord } from "../shared/data.mjs";
const resource = (value) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
        throw fail('INVALID_RESOURCE', 400);
    return value;
};
const record = isRecord;
function checkedObject(value, id) {
    if (!record(value) || id && (typeof value[id] !== 'string' || !value[id]))
        throw fail('PLATFORM_RESPONSE_INVALID', 502);
    return value;
}
function checkedPage(value, id) {
    checkedObject(value);
    if (!Array.isArray(value.items) || typeof value.hasMore !== 'boolean' ||
        (value.hasMore ? typeof value.nextCursor !== 'string' || !value.nextCursor : value.nextCursor !== null))
        throw fail('PLATFORM_RESPONSE_INVALID', 502);
    for (const row of value.items)
        checkedObject(row, id);
    return value;
}
const string = (value) => typeof value === 'string';
const integer = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const nullable = (check) => value => value === null || check(value);
const array = (check) => value => Array.isArray(value) && value.every(check);
const shape = (fields) => value => record(value) && Object.entries(fields).every(([key, check]) => check(value[key]));
const principal = shape({ type: v => (v === 'user' || v === 'agent' || v === 'app'), id: string, name: string });
const channel = shape({ channelId: string, channelName: string });
const fileSummary = shape({ fileId: string, channelId: string, title: string, fileName: string, mimeType: nullable(string),
    sizeBytes: integer, sha256: nullable(string), sharedBy: principal, sharedAt: string });
function checked(value, check) {
    if (!check(value))
        throw fail('PLATFORM_RESPONSE_INVALID', 502);
    return value;
}
function checkedHistory(value) {
    checkedPage(value, 'messageId');
    return checked(value, shape({ channel, items: array(shape({ messageId: string, revision: integer, channelId: string,
            topicId: nullable(string), author: principal, text: string, createdAt: string, recalled: v => typeof v === 'boolean', sentToChannel: v => typeof v === 'boolean',
            files: array(shape({ fileId: string, title: string, fileName: string, sizeBytes: nullable(integer) })),
            apps: array(shape({ appKey: string, resourceId: string, title: nullable(string) })),
            quote: nullable(shape({ messageId: string, authorName: string, text: string, recalled: v => v === undefined || typeof v === 'boolean' })),
            event: nullable(shape({ kind: string, taskId: nullable(string), summary: nullable(string) })), taskId: nullable(string),
        })) }));
}
function checkedUnread(value) {
    checkedPage(value, 'messageId');
    return checked(value, shape({ channel,
        items: array(shape({ messageId: string, channelId: string, topicId: string, createdAt: string })),
        unreadSnapshot: shape({ scope: v => v === 'channel', readerUserId: string, readStateAvailable: v => typeof v === 'boolean',
            readAt: nullable(string), capturedAt: string, unreadCount: nullable(integer) }),
    }));
}
function checkedFile(value) {
    checked(value, fileSummary);
    return checked(value, shape({ download: v => v === undefined, content: nullable(string), totalCharacters: nullable(integer), nextOffset: nullable(integer),
        image: nullable(shape({ mimeType: string, width: integer, height: integer })),
        unreadableReason: v => v === null || typeof v === 'string' && ['PERMISSION', 'TOO_LARGE', 'UNSUPPORTED_TYPE', 'NOT_TEXT', 'UNREADABLE'].includes(v),
        images: v => v === undefined || array(shape({ data: string, mimeType: v => (v === 'image/png' || v === 'image/jpeg') }))(v),
    }));
}
function pageMethods(list, id) {
    const read = async (query = {}) => checkedPage(await list(query), id);
    return Object.freeze({ list: read, async *iterate(query = {}, { maxPages = 100, signal } = {}) {
            if (!Number.isSafeInteger(maxPages) || maxPages < 1)
                throw fail('INVALID_PAGINATION', 400);
            const input = structuredClone(query), seen = new Set();
            for (let count = 0; count < maxPages; count++) {
                signal?.throwIfAborted();
                const page = await read(input);
                signal?.throwIfAborted();
                if (page.hasMore && (page.nextCursor === input.cursor || seen.has(page.nextCursor)))
                    throw fail('PAGINATION_CURSOR_REPEATED', 502);
                for (const item of page.items) {
                    signal?.throwIfAborted();
                    yield item;
                }
                if (!page.hasMore)
                    return;
                seen.add(page.nextCursor);
                input.cursor = page.nextCursor ?? undefined;
            }
            throw fail('PAGINATION_INCOMPLETE', 409);
        } });
}
export function createBusinessMethods(http, boundEventId, sendMessage) {
    const get = async (method, path, query) => businessResult(method, await http({ path, query }));
    const post = async (method, path, body, key) => businessResult(method, await http({ method: 'POST', path, body, key }));
    const search = ({ query, ...rest } = {}) => ({ ...rest, ...(query === undefined ? {} : { q: query }) });
    const fileKey = (idempotencyKey) => {
        if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey))
            throw fail('IDEMPOTENCY_KEY_REQUIRED', 400);
        return idempotencyKey;
    };
    const prepareFile = (input, mode, extra) => {
        const { idempotencyKey, ...body } = input;
        return http({ method: 'POST', path: '/app-files', body: { ...body, ...extra, mode, uploadKey: fileKey(idempotencyKey) }, key: idempotencyKey })
            .then(value => checkedObject(value, 'fileId'));
    };
    const methods = {
        projects: pageMethods(query => get('projects.list', '/app-projects', query), 'projectId'),
        channels: Object.freeze({ ...pageMethods(query => get('channels.list', '/app-channels', query), 'channelId'),
            listMembers: ({ channelId, ...query }) => get('channels.listMembers', '/app-channels/' + resource(channelId) + '/members', query).then(value => checkedPage(value, 'id')),
            listMessages: ({ channelId, ...query }) => get('channels.listMessages', '/app-channels/' + resource(channelId) + '/messages', query).then(checkedHistory),
            listUnreadMessages: ({ channelId, ...query }) => get('channels.listUnreadMessages', '/channels/' + resource(channelId) + '/unread-messages', query).then(checkedUnread) }),
        messages: Object.freeze({
            send: ({ idempotencyKey, ...body }) => {
                if ('mentions' in body && (!body.mentions || !parseMessageMentions(body.mentions) || typeof body.text !== 'string' || body.mentions.items.some(item => item.end > body.text.trim().length)))
                    throw fail('VALIDATION_FAILED', 400);
                if (!sendMessage)
                    throw new TypeError('Internal send implementation is required');
                return sendMessage({ ...body, idempotencyKey });
            },
            get: ({ messageId }) => get('messages.get', '/messages/' + resource(messageId)).then(value => checked(value, shape({
                source: shape({ messageId: string, channelId: string, topicId: string, projectId: v => v === undefined || string(v) }),
                content: shape({ author: principal, text: string, createdAt: string, recalled: v => typeof v === 'boolean',
                    files: array(shape({ fileId: string, fileName: string })) }),
            }))),
            replace: ({ messageId, ...body }) => http({ method: 'PUT', path: '/messages/' + resource(messageId), body }).then(value => businessResult('messages.replace', value)),
            recall: ({ messageId, idempotencyKey, ...body }) => post('messages.recall', '/messages/' + resource(messageId) + '/recall', body, idempotencyKey)
        }),
        topics: Object.freeze({ list: (options = {}) => get('topics.list', '/topics', options),
            listMessages: ({ topicId, ...query }) => get('topics.listMessages', '/topics/' + resource(topicId) + '/messages', query),
            listParticipants: ({ topicId, ...query }) => get('topics.listParticipants', '/topics/' + resource(topicId) + '/participants', query),
            readImage: ({ topicId, artifactId }) => get('topics.readImage', '/topics/' + resource(topicId) + '/images/' + resource(artifactId)) }),
        directMessages: Object.freeze({
            list: ({ conversationId, ...query }) => get('directMessages.list', '/app-direct-messages/' + resource(conversationId) + '/messages', query),
            downloadAttachment: ({ conversationId, artifactId }) => http({ path: '/app-direct-messages/' + resource(conversationId) + '/attachments/' + resource(artifactId) + '/download' }).then(value => businessResult('directMessages.downloadAttachment', value)),
        }),
        drafts: Object.freeze({ create: ({ idempotencyKey, ...body }) => post('drafts.create', '/message-drafts', body, idempotencyKey) }),
        events: Object.freeze({ reportStatus: ({ idempotencyKey, ...body }) => post('events.reportStatus', '/agent-sessions/status', { ...body, eventId: boundEventId || body.eventId }, idempotencyKey)
                .then(value => checked(value, shape({ deploymentId: string, channelId: string, topicId: string, sequence: integer,
                status: v => typeof v === 'string' && ['processing', 'suspended', 'finished'].includes(v), updatedAt: string, warnings: array(string) }))),
            reportUndelivered: body => post('events.reportUndelivered', '/extensions/agent-apps/receipts', { ...body, eventId: boundEventId || body.eventId }) }),
        actions: Object.freeze({ complete: ({ idempotencyKey, ...body }) => post('actions.complete', '/extensions/ui-requests', { ...body, kind: 'action_result', eventId: boundEventId || body.eventId }, idempotencyKey) }),
        interactions: Object.freeze({
            openDialog: ({ idempotencyKey, ...body }) => post('interactions.openDialog', '/extensions/ui-requests', { ...body, kind: 'dialog', eventId: boundEventId || body.eventId }, idempotencyKey),
            showToast: ({ idempotencyKey, ...body }) => post('interactions.showToast', '/extensions/ui-requests', { ...body, kind: 'toast', eventId: boundEventId || body.eventId }, idempotencyKey),
            get: ({ interactionId, eventId = boundEventId }) => get('interactions.get', '/extensions/ui-requests/' + resource(interactionId), { eventId }),
            complete: ({ interactionId }) => post('interactions.complete', '/extensions/ui-requests/' + resource(interactionId) + '/complete', {})
        }),
        files: Object.freeze({ ...pageMethods(query => {
                if (!query || !Object.hasOwn(query, 'channelId') || typeof query.channelId !== 'string' || !query.channelId.trim())
                    throw new CoLinkError('INVALID_ARGUMENT', 400, undefined, { details: [{ field: 'query.channelId', code: 'FIELD_REQUIRED',
                                message: '文件列表必须显式指定频道；从可信上下文或 channels.list 选择频道，项目主页没有默认来源频道。' }] });
                return get('files.list', '/app-files', query);
            }, 'fileId'),
            readContent: ({ fileId, ...query }) => get('files.readContent', '/app-files/' + resource(fileId), query).then(checkedFile),
            createText: input => prepareFile(input, 'text').then(value => {
                const { upload, ...file } = checked(value, shape({ fileId: string, status: value => value === 'ok' }));
                return businessResult('files.createText', file);
            }),
            download: ({ fileId }) => get('files.download', '/app-files/' + resource(fileId) + '/content'),
            async upload({ bytes, ...input }) {
                if (!(bytes instanceof Uint8Array) || bytes.byteLength > 20 * 1024 * 1024)
                    throw fail('INVALID_ARGUMENT', 400);
                const copy = new Uint8Array(bytes), digest = await globalThis.crypto.subtle.digest('SHA-256', copy);
                const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
                const file = await prepareFile(input, 'upload', { sizeBytes: copy.byteLength, sha256 });
                const receipt = checked(businessResult('files.upload', await http({ method: 'PUT', path: '/app-files/' + resource(file.fileId) + '/content', bytes: copy, contentType: 'application/octet-stream' })), shape({ fileId: string, status: v => v === 'ok', sizeBytes: integer, sha256: v => string(v) && /^[a-fA-F0-9]{64}$/.test(v) }));
                if (receipt.fileId !== file.fileId || receipt.sizeBytes !== copy.byteLength || receipt.sha256 !== sha256)
                    throw fail('PLATFORM_RESPONSE_INVALID', 502);
                return receipt;
            } }),
        tasks: Object.freeze({ ...pageMethods(query => get('tasks.list', '/tasks', search(query)), 'taskId'),
            get: ({ taskId }) => get('tasks.get', '/tasks/' + resource(taskId)),
            listPersonal: (query = {}) => get('tasks.listPersonal', '/personal-tasks', search(query)).then(value => {
                checkedObject(value);
                if (!Array.isArray(value.items) || !Number.isSafeInteger(value.total) || !Number.isSafeInteger(value.page) || !Number.isSafeInteger(value.pageSize))
                    throw fail('PLATFORM_RESPONSE_INVALID', 502);
                for (const row of value.items)
                    checkedObject(row, 'taskId');
                return value;
            }),
            create: ({ idempotencyKey, ...body }) => post('tasks.create', '/tasks', body, idempotencyKey), update: ({ taskId, idempotencyKey, ...body }) => post('tasks.update', '/tasks/' + resource(taskId), body, idempotencyKey),
            reportExecution: ({ taskId, idempotencyKey, ...body }) => post('tasks.reportExecution', '/tasks/' + resource(taskId) + '/execution-reports', body, idempotencyKey) }),
        contacts: Object.freeze({ list: query => get('contacts.list', '/extensions/contacts', search(query)), listChannels: query => get('contacts.listChannels', '/extensions/contact-channels', search(query)),
            listProjects: query => get('contacts.listProjects', '/extensions/contact-projects', search(query)), resolve: body => post('contacts.resolve', '/extensions/participant-selections', body) }),
        apps: Object.freeze({
            list: (query = {}) => get('apps.list', '/app-capabilities', query).then(value => checkedPage(value, 'providerInstallationId')),
            listOperations: ({ providerInstallationId, ...query }) => get('apps.listOperations', '/app-capabilities/' + resource(providerInstallationId) + '/operations', query).then(value => checkedPage(value, 'operationId')),
            callOperation: ({ providerInstallationId, idempotencyKey, ...body }) => post('apps.callOperation', '/app-capabilities/' + resource(providerInstallationId) + '/calls', body, idempotencyKey)
        }),
    };
    return withMethodDiagnostics(methods);
}
