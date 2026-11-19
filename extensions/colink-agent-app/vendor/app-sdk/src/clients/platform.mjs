import { createTransport } from "./transport.mjs";
import { createBusinessClient, managedClientTools, readClientDm, readClientTopic } from "./business-client.mjs";
import { createWriteJournal } from "./write-journal.mjs";
import { fail } from "../shared/errors.mjs";
import { record, isRecord } from "../shared/data.mjs";
export { fail } from "../shared/errors.mjs";
export function createPlatform({ config, store, installations, users, fetcher = fetch, now = Date.now, saveRow, assertNotCancelled = () => { } }) {
    const prefix = config.idempotencyPrefix ?? 'colink-agent';
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(prefix))
        throw Error('Invalid idempotencyPrefix');
    const request = createTransport(config, fetcher);
    const appToken = async (row) => {
        const token = await installations.getAccessToken(row.event.installationId);
        if (store.data.oauthInstallations[row.event.installationId]?.authorizationVersion !== row.version)
            throw fail('INSTALLATION_AUTHORIZATION_CHANGED', 403);
        return token;
    };
    const userToken = (row) => users.getAccessToken(row.executionId, row.event.installationId, row.event.actor.id);
    async function validateOne(row) {
        assertNotCancelled(row);
        const current = store.data.oauthInstallations[row.event.installationId];
        if (current?.status !== 'ready' || current.authorizationVersion !== row.version)
            throw fail('INSTALLATION_AUTHORIZATION_CHANGED', 403);
        if (!row.executionId)
            return;
        await users.validateEvent({ ...row.event, userExecutionId: row.executionId,
            capabilityInstallationId: row.event.installationId });
        assertNotCancelled(row);
    }
    async function validate(row) {
        await validateOne(row);
        for (const eventId of row.steerEventIds || []) {
            const child = store.data.events[eventId];
            if (!child || child.steerParentId !== row.event.eventId)
                throw fail('TURN_INACTIVE', 403);
            await validateOne(child);
        }
    }
    const clients = new WeakMap();
    function client(row, active = () => { }) {
        let cached = clients.get(row);
        if (cached && !active.bound)
            return cached;
        const save = (patch) => saveRow(row, patch);
        const activeCall = () => { assertNotCancelled(row); active(); };
        const value = createBusinessClient({ config, fetcher, policy: config.capabilities || {},
            journal: createWriteJournal({ row, save, now }),
            context: { key: row.event.eventId, signal: active.signal, eventId: row.event.eventId,
                conversationId: row.event.data.conversationId ?? null,
                managedStatus: config.interactionStatus !== false && row.dispatch !== 'handler',
                validate: async () => { activeCall(); await validate(row); activeCall(); }, active: activeCall,
                identities: () => ({ app: (store.data.oauthInstallations[row.event.installationId]?.scope || '').split(' '),
                    ...(row.executionId ? { user: store.data.oauthUserExecutions[row.executionId]?.scopes || [] } : {}) }),
                token: identity => identity === 'user' ? userToken(row) : appToken(row) },
            onDelivery: receipt => {
                // DM 允许显式回主时间线（receipt.topicId=新根消息）或本会话话题；两者都属于本轮交付。
                // 频道仍只认来源话题，避免把同客户端写到别处的消息误算为当前 @ 的答复。
                const deliveredHere = row.event.data.conversationId
                    ? receipt.conversationId === row.event.data.conversationId
                    : receipt.topicId === row.event.data.topicId;
                if (deliveredHere && typeof receipt.text === 'string')
                    save({ firstOutputAt: row.firstOutputAt ?? now(), delivered: [...(row.delivered || []), { text: receipt.text.trim(), messageId: receipt.messageId }] });
            } });
        clients.set(row, value);
        return value;
    }
    const list = (row) => managedClientTools(client(row)).list();
    return {
        validate, list, client,
        managedList: (row) => managedClientTools(client(row)).list(),
        managedCall: (row, params) => managedClientTools(client(row)).call(params?.name, params?.arguments),
        async reportInteraction(row, report) {
            assertNotCancelled(row);
            const installation = store.data.oauthInstallations[row.event.installationId];
            if (installation?.status !== 'ready' || installation.authorizationVersion !== row.version)
                throw fail('INSTALLATION_AUTHORIZATION_CHANGED', 403);
            if (!(installation.scope || '').split(' ').includes('messages:write'))
                throw fail('SCOPE_MISSING', 403);
            // Runtime control-plane output, like final replies: never exposed as a
            // model tool and not a relaxation of the business client's readOnly policy.
            const token = await appToken(row);
            assertNotCancelled(row);
            // DM 状态属于会话轮次：线上 topicId 恒 null。唤醒话题根只用于回话目标，不进入状态契约。
            const statusTopicId = row.event.data.conversationId ? null : row.event.data.topicId;
            const result = record(await request('/agent-sessions/status', token, { method: 'POST',
                headers: { 'Idempotency-Key': `${prefix}-status-${row.event.eventId}-${report.sequence}` },
                body: JSON.stringify({ eventId: row.event.eventId, channelId: row.event.data.channelId,
                    topicId: statusTopicId, conversationId: row.event.data.conversationId,
                    status: report.status, sequence: report.sequence }) }));
            if (result?.status !== report.status || result.sequence !== report.sequence ||
                result.channelId !== row.event.data.channelId || result.topicId !== statusTopicId ||
                (result.conversationId ?? null) !== (row.event.data.conversationId ?? null) ||
                result.deploymentId !== config.appInstanceId)
                throw fail('INTERACTION_STATUS_RESPONSE_INVALID', 502);
            return result;
        },
        async readMessages(row, capability, options) {
            await validate(row);
            if (capability.identity === 'user' && !row.executionId)
                throw fail('USER_AUTHORIZATION_REQUIRED', 403);
            if (capability.identity === 'user' && !row.scopes.includes(capability.scope))
                throw fail('SCOPE_MISSING', 403);
            // DM 唤醒（F20261102dmagent）：conversationId 仅用户身份可读；channelId/topicId 与 conversationId 互斥
            if (row.event.data.conversationId && capability.identity !== 'user')
                throw fail('DM_MESSAGES_UNREADABLE', 403);
            if (!row.event.data.conversationId && row.event.data.channelId === null)
                throw fail('DM_MESSAGES_UNREADABLE', 403);
            const result = row.event.data.conversationId
                ? await readClientDm(client(row), { conversationId: row.event.data.conversationId,
                    ...(options.limit === undefined ? {} : { limit: options.limit }), ...(options.cursor === undefined ? {} : { cursor: options.cursor }) })
                : await readClientTopic(client(row), capability.identity, {
                    topicId: row.event.data.topicId, ...(options.limit === undefined ? {} : { limit: options.limit }), ...(options.cursor === undefined ? {} : { cursor: options.cursor })
                });
            if (!isRecord(result) || !Array.isArray(result.items) ||
                result.items.some(item => typeof item.id !== 'string' || typeof item.text !== 'string') ||
                typeof result.hasMore !== 'boolean' || !(result.nextCursor === null || typeof result.nextCursor === 'string'))
                throw fail('MESSAGES_RESPONSE_INVALID', 502);
            return result;
        },
        call: (row, params) => managedClientTools(client(row)).call(params?.name, params?.arguments),
        async send(row, text, index, beforeSend = () => { }) {
            await validate(row);
            const token = await appToken(row);
            assertNotCancelled(row);
            beforeSend();
            // 私聊回话携带来源消息，平台用它核对本安装的真实唤醒投递；频道保持原契约。
            const dm = row.event.data.channelId === null && row.event.data.conversationId;
            const result = record(await request('/messages', token, { method: 'POST',
                headers: { 'Idempotency-Key': `${prefix}-${row.event.eventId}-${index}` },
                body: JSON.stringify(dm
                    ? { conversationId: row.event.data.conversationId, sourceMessageId: row.event.data.messageId, text }
                    : { channelId: row.event.data.channelId, topicId: row.event.data.topicId, text }) }));
            if (typeof result.messageId !== 'string' || !result.messageId)
                throw fail('MESSAGE_RESPONSE_INVALID', 502);
            if (row.firstOutputAt === undefined)
                saveRow(row, { firstOutputAt: now() });
            return { ...result, messageId: result.messageId };
        },
        async complete(row) {
            if (!row.executionId)
                return;
            assertNotCancelled(row);
            const path = '/extensions/user-executions/' + encodeURIComponent(row.executionId);
            const token = await appToken(row), current = record(await request(path, token));
            assertNotCancelled(row);
            if (current.status === 'completed')
                return;
            if (current.status !== 'active')
                throw fail('USER_EXECUTION_INACTIVE', 403);
            if (typeof current.version !== 'number' || !Number.isSafeInteger(current.version) || current.version < 0)
                throw fail('EXECUTION_RESPONSE_INVALID', 502);
            if (row.completionVersion === undefined) {
                row.completionVersion = current.version;
                try {
                    store.persist();
                }
                catch (error) {
                    delete row.completionVersion;
                    throw error;
                }
            }
            return request(path + '/completion', token, { method: 'POST',
                headers: { 'Idempotency-Key': `${prefix}-complete-${row.event.eventId}` },
                body: JSON.stringify({ expectedVersion: row.completionVersion }) });
        },
    };
}
