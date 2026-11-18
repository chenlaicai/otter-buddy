import { randomUUID, createHash } from 'node:crypto';
import { CoLinkError } from "../shared/errors.mjs";
import { isRecord, record as dataRecord } from "../shared/data.mjs";
const fail = (code, status = 401) => Object.assign(new CoLinkError(code, status), { beforeDispatch: true });
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const token = (value) => typeof value === 'string' && value.length > 0 && value.length <= 16384;
/** This App's durable user credentials. No credential is returned to a page or model. */
export function createUserOAuth({ config, store, fetch: fetcher = fetch, now = Date.now }) {
    const issuer = new URL(config.issuer);
    if (issuer.origin !== config.issuer || issuer.username || issuer.password ||
        !(issuer.protocol === 'https:' || issuer.protocol === 'http:' && config.allowInsecureIssuer === true &&
            ['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname)))
        throw Error('Invalid user OAuth issuer');
    const form = (value) => new URLSearchParams([['v', value]]).toString().slice(2);
    const basic = 'Basic ' + Buffer.from(form(config.clientId) + ':' + form(config.clientSecret)).toString('base64');
    const lanes = new Map();
    const records = () => store.data.oauthUserExecutions ||= {};
    const activeRecord = (key) => {
        const row = records()[key];
        if (!row || typeof row.access !== 'string' || typeof row.refresh !== 'string' || typeof row.expiresAt !== 'number' || typeof row.deadline !== 'number' || !Array.isArray(row.scopes) || (row.mode !== 'session' && row.mode !== 'background'))
            throw fail('USER_AUTHORIZATION_EXPIRED');
        return Object.assign(row, { access: row.access, refresh: row.refresh, expiresAt: row.expiresAt, deadline: row.deadline, scopes: row.scopes, mode: row.mode });
    };
    const serial = (key, action) => {
        const pending = (lanes.get(key) || Promise.resolve()).catch(() => { }).then(action);
        lanes.set(key, pending);
        return pending.finally(() => { if (lanes.get(key) === pending)
            lanes.delete(key); });
    };
    async function read(response) {
        if (!response.body)
            throw fail('OAUTH_RESPONSE_INVALID', 502);
        const reader = response.body.getReader(), chunks = [];
        let size = 0;
        try {
            for (;;) {
                const item = await reader.read();
                if (item.done)
                    break;
                size += item.value.length;
                if (size > 65536)
                    throw fail('OAUTH_RESPONSE_INVALID', 502);
                chunks.push(item.value);
            }
        }
        finally {
            await reader.cancel().catch(() => { });
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!response.ok)
            throw fail(dataRecord(body).error === 'invalid_grant' ? 'USER_AUTHORIZATION_EXPIRED' : 'USER_AUTHORIZATION_UNAVAILABLE', response.status);
        return body;
    }
    async function request(path, options) {
        return read(await fetcher(issuer.origin + '/api/v1' + path, {
            ...options, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
        }));
    }
    function credentials(value, executionId) {
        if (!isRecord(value) || value.token_type !== 'Bearer' || !token(value.access_token) || !token(value.refresh_token) ||
            typeof value.expires_in !== 'number' || !Number.isSafeInteger(value.expires_in) || value.expires_in < 1 || value.expires_in > 3600 ||
            typeof value.scope !== 'string' || value.scope.length > 4096 ||
            (value.accessMode !== 'background' && (value.executionId !== executionId ||
                typeof value.executionExpiresAt !== 'string' || !Number.isFinite(Date.parse(value.executionExpiresAt)) || Date.parse(value.executionExpiresAt) <= now())))
            throw fail('OAUTH_RESPONSE_INVALID', 502);
        return { access: store.seal(value.access_token), refresh: store.seal(value.refresh_token),
            expiresAt: now() + value.expires_in * 1000, mode: value.accessMode === 'background' ? 'background' : 'session',
            deadline: value.accessMode === 'background' ? now() + 30 * 86400000 : Date.parse(String(value.executionExpiresAt)), scopes: value.scope.split(' ') };
    }
    async function save(key, next) {
        const previous = records()[key];
        records()[key] = next;
        try {
            await store.persist();
        }
        catch (error) {
            if (previous)
                records()[key] = previous;
            else
                delete records()[key];
            throw error;
        }
    }
    async function exchange(key, body, retryKey) {
        return credentials(await request('/oauth/token', { method: 'POST', headers: {
                Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': retryKey,
            }, body: new URLSearchParams(body).toString() }), key);
    }
    return {
        async acceptEvent(event) {
            const raw = event.userAuthorization;
            const value = dataRecord(raw);
            if (raw === undefined)
                return null;
            if (!id(value?.executionId) || value.accessMode === 'background' || event.actor?.type !== 'user')
                throw fail('USER_AUTHORIZATION_INVALID');
            const key = value.executionId, actor = event.actor;
            if (!actor)
                throw fail('USER_AUTHORIZATION_INVALID');
            return serial(key, async () => {
                const existing = records()[key];
                if (existing) {
                    if (existing.installationId !== event.installationId || existing.userId !== actor.id || existing.eventId !== event.eventId)
                        throw fail('USER_AUTHORIZATION_INVALID');
                    // Delivery retries may carry a rotated response. Never overwrite locally rotated credentials.
                    return key;
                }
                await save(key, { ...credentials(value, key), installationId: event.installationId,
                    userId: actor.id, eventId: event.eventId });
                return key;
            });
        },
        async acceptPage(input, login) {
            if (!input || !id(input.executionId) || !/^[A-Za-z0-9_-]{43}$/.test(input.code || '') ||
                !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier || ''))
                throw fail('USER_AUTHORIZATION_INVALID');
            const key = input.executionId, binding = createHash('sha256').update(JSON.stringify([input.code, input.codeVerifier])).digest('hex');
            return serial(key, async () => {
                const appToken = await config.installationOAuth.getAccessToken(login.installationId);
                const current = dataRecord(await request('/extensions/user-executions/' + encodeURIComponent(key), {
                    headers: { Authorization: 'Bearer ' + appToken },
                }));
                if (current.status !== 'active' || current.sourceKind !== 'page' ||
                    current.userId !== login.userId || current.installationId !== login.installationId || current.projectId !== login.projectId ||
                    ['channelId', 'topicId', 'taskId'].some(field => (dataRecord(current.source)[field] || null) !== (login.source?.[field] || null)))
                    throw fail('USER_AUTHORIZATION_INVALID');
                let record = records()[key];
                if (record && (record.userId !== login.userId || record.installationId !== login.installationId || record.binding !== binding))
                    throw fail('USER_AUTHORIZATION_INVALID');
                if (record?.access)
                    return key;
                if (!record) {
                    record = { installationId: login.installationId, userId: login.userId, binding,
                        pending: { key: randomUUID(), at: now() } };
                    await save(key, record);
                }
                if (!record.pending || now() - record.pending.at >= 60000)
                    throw fail('USER_AUTHORIZATION_EXPIRED');
                const next = await exchange(key, { grant_type: 'authorization_code', code: input.code, code_verifier: input.codeVerifier }, record.pending.key);
                await save(key, { ...record, ...next, pending: undefined });
                return key;
            });
        },
        async getAccessToken(key, installationId, userId) {
            return serial(key, async () => {
                let record = activeRecord(key);
                if (!record?.refresh || record.installationId !== installationId || record.userId !== userId || (record.deadline === undefined || record.deadline <= now()))
                    throw fail('USER_AUTHORIZATION_EXPIRED');
                if (!record.pending && record.expiresAt > now() + 30000)
                    return store.unseal(record.access);
                if (!record.pending) {
                    await save(key, { ...record, pending: { key: randomUUID(), at: now() } });
                    record = activeRecord(key);
                }
                if (!record.pending || now() - record.pending.at >= 60000)
                    throw fail('USER_AUTHORIZATION_EXPIRED');
                const next = await exchange(key, { grant_type: 'refresh_token', refresh_token: store.unseal(record.refresh) }, record.pending.key);
                if (next.mode !== record.mode || (record.mode === 'session' && next.deadline !== record.deadline))
                    throw fail('OAUTH_RESPONSE_INVALID', 502);
                await save(key, { ...record, ...next, pending: undefined });
                return store.unseal(next.access);
            });
        },
        async validateEvent(event) {
            const key = event.userExecutionId;
            const record = activeRecord(key);
            if (!record || record.eventId !== event.eventId || record.userId !== event.actor?.id ||
                record.installationId !== event.capabilityInstallationId || (record.deadline === undefined || record.deadline <= now()))
                throw fail('USER_AUTHORIZATION_EXPIRED');
            const appToken = await config.installationOAuth.getAccessToken(record.installationId);
            const current = dataRecord(await request('/extensions/user-executions/' + encodeURIComponent(key), {
                headers: { Authorization: 'Bearer ' + appToken },
            }));
            if (current.status !== 'active' || current.userId !== record.userId || current.installationId !== record.installationId ||
                current.sourceKind !== (event.type === 'task.execution_requested' ? 'task' : 'message') ||
                ['channelId', 'topicId', 'taskId', 'conversationId'].some(field => (dataRecord(current.source)[field] || null) !== (dataRecord(event.data)[field] || null)))
                throw fail('USER_AUTHORIZATION_INVALID');
        },
        async validateProvider(context) {
            const key = context.userAuthorization?.executionId;
            if (!key)
                throw fail('USER_AUTHORIZATION_EXPIRED');
            const record = activeRecord(key);
            if (!record || record.eventId !== 'provider:' + context.callId ||
                record.installationId !== context.providerInstallationId || record.userId !== context.execution?.actor.userId || (record.deadline === undefined || record.deadline <= now()))
                throw fail('USER_AUTHORIZATION_EXPIRED');
            const appToken = await config.installationOAuth.getAccessToken(record.installationId);
            const current = dataRecord(await request('/extensions/user-executions/' + encodeURIComponent(key), { headers: { Authorization: 'Bearer ' + appToken } }));
            if (current.status !== 'active' || current.sourceKind !== 'delegation' || current.userId !== record.userId ||
                current.installationId !== record.installationId || current.projectId !== context.context.projectId)
                throw fail('USER_AUTHORIZATION_INVALID');
        },
    };
}
