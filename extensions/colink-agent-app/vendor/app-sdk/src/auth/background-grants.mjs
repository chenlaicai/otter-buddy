import { randomUUID } from 'node:crypto';
import { fail } from "../shared/errors.mjs";
import { pageTransport } from "./oauth-http.mjs";
import { createBusinessClient } from "../clients/business-client.mjs";
import { createWriteJournal } from "../clients/write-journal.mjs";
import { isRecord as object, record, errorCode } from "../shared/data.mjs";
const uuid = (value) => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
function transportFailure(error) {
    if (['PAGE_LOGIN_REQUIRED', 'EXTENSION_TOKEN_INVALID'].includes(errorCode(error) ?? ''))
        return fail('BACKGROUND_AUTHORIZATION_REQUIRED', 401);
    if (errorCode(error) === 'PAGE_PLATFORM_UNAVAILABLE')
        return fail('BACKGROUND_PLATFORM_UNAVAILABLE', typeof record(error).status === 'number' ? Number(record(error).status) : 503);
    if (errorCode(error) === 'PAGE_RESPONSE_INVALID')
        return fail('PLATFORM_RESPONSE_INVALID', 502);
    return error;
}
function binding(id) {
    try {
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(id))
            throw Error();
        const v = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'));
        if (!Array.isArray(v) || v.length !== 4 || !uuid(v[0]) || !uuid(v[1]) || v.slice(2).some(n => typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) ||
            Buffer.from(JSON.stringify(v)).toString('base64url') !== id)
            throw Error();
        const [installationId, , version, authorizationVersion] = v;
        if (!uuid(installationId) || typeof version !== 'number' || typeof authorizationVersion !== 'number')
            throw Error();
        return { installationId, version, authorizationVersion };
    }
    catch {
        throw fail('BACKGROUND_AUTHORIZATION_REQUIRED', 401);
    }
}
/** Background user authority does not depend on pages or browser sessions. */
export function createBackgroundGrants({ config, store, installations, fetcher, now = Date.now }) {
    store.data.backgroundGrants ||= {};
    const transport = pageTransport(config, fetcher), lanes = new Map(), clients = new Map();
    let stopped = false;
    const save = (fn) => {
        const before = structuredClone(store.data.backgroundGrants);
        try {
            const value = fn();
            store.persist();
            return value;
        }
        catch (error) {
            store.data.backgroundGrants = before;
            throw error;
        }
    };
    const serial = (id, fn) => {
        const p = (lanes.get(id) || Promise.resolve()).catch(() => { }).then(fn);
        lanes.set(id, p);
        return p.finally(() => { if (lanes.get(id) === p)
            lanes.delete(id); });
    };
    function active(id) {
        const ref = binding(id), row = store.data.backgroundGrants[id];
        const installation = store.data.oauthInstallations?.[ref.installationId];
        if (stopped || row?.revoked || row?.revoking)
            throw fail('BACKGROUND_AUTHORIZATION_REQUIRED', 401);
        if (installation?.status !== 'ready' || installation.authorizationVersion !== ref.authorizationVersion)
            throw fail('INSTALLATION_AUTHORIZATION_CHANGED', 403);
        return row;
    }
    function metadata(value, expectedId) {
        if (!object(value) || typeof value.grantId !== 'string')
            throw fail('PLATFORM_RESPONSE_INVALID', 502);
        let ref;
        try {
            ref = binding(value.grantId);
        }
        catch {
            throw fail('PLATFORM_RESPONSE_INVALID', 502);
        }
        if (expectedId && expectedId !== value.grantId || value.installationId !== ref.installationId || value.version !== ref.version ||
            value.authorizationVersion !== ref.authorizationVersion || !(typeof value.userId === 'string' && value.userId.length > 0 && value.userId.length <= 128) || !(value.projectId === null || typeof value.projectId === 'string' && value.projectId.length > 0 && value.projectId.length <= 128) ||
            (value.status !== 'active' && value.status !== 'inactive') || !Array.isArray(value.scopes) || !value.scopes.length ||
            value.scopes.some(s => typeof s !== 'string') || new Set(value.scopes).size !== value.scopes.length)
            throw fail('PLATFORM_RESPONSE_INVALID', 502);
        return { grantId: value.grantId, installationId: value.installationId, userId: value.userId, projectId: value.projectId, scopes: [...value.scopes], version: value.version, authorizationVersion: value.authorizationVersion, status: value.status };
    }
    function retain(info) {
        save(() => {
            if (!store.data.backgroundGrants[info.grantId] && Object.keys(store.data.backgroundGrants).length >= 1000)
                throw fail('STORAGE_LIMIT', 503);
            const row = store.data.backgroundGrants[info.grantId] ||= {};
            row.info = info;
        });
        return store.data.backgroundGrants[info.grantId];
    }
    async function request(installationId, suffix = '', options = {}) {
        if (stopped)
            throw fail('CLIENT_EXECUTION_INACTIVE', 403);
        const token = await installations.getAccessToken(installationId);
        try {
            return await transport.request('/extensions/background-grants' + suffix, { ...options,
                headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...options.headers } });
        }
        catch (error) {
            throw transportFailure(error);
        }
    }
    function credentials(value, info) {
        if (!object(value) || value.accessMode !== 'background' || value.token_type !== 'Bearer' ||
            typeof value.access_token !== 'string' || !value.access_token || value.access_token.length > 16384 || typeof value.refresh_token !== 'string' || !value.refresh_token || value.refresh_token.length > 16384 ||
            typeof value.expires_in !== 'number' || !Number.isSafeInteger(value.expires_in) || value.expires_in < 1 || value.expires_in > 3600 || typeof value.scope !== 'string' ||
            value.scope.split(' ').some(s => !info.scopes.includes(s)) || !value.scope || value.executionId !== undefined)
            throw fail('PLATFORM_RESPONSE_INVALID', 502);
        const confirmed = metadata(value.backgroundGrant, info.grantId);
        if (confirmed.userId !== info.userId || confirmed.projectId !== info.projectId || confirmed.status !== 'active')
            throw fail('PLATFORM_RESPONSE_INVALID', 502);
        return { access: store.seal(value.access_token), refresh: store.seal(value.refresh_token), scopes: value.scope.split(' '),
            tokenExpiresAt: now() + value.expires_in * 1000, idleExpiresAt: now() + 90 * 86400000 };
    }
    async function ensure(id) {
        let row = active(id);
        if (!row?.info) {
            const info = metadata(await request(binding(id).installationId, '/' + id), id);
            active(id);
            row = retain(info);
        }
        if (!row.info || row.info.status !== 'active')
            throw fail('BACKGROUND_AUTHORIZATION_REQUIRED', 401);
        return Object.assign(row, { info: row.info });
    }
    async function access(id) {
        return serial(id, async () => {
            let row = await ensure(id);
            if (row.access && !row.pendingRefresh && (row.tokenExpiresAt ?? 0) > now() + 30000)
                return store.unseal(row.access);
            if (!row.access) {
                if (!row.pendingAcquire || now() - row.pendingAcquire.at >= 60000)
                    save(() => { row.pendingAcquire = { key: randomUUID(), at: now() }; });
                if (!row.pendingAcquire)
                    throw fail('BACKGROUND_AUTHORIZATION_REQUIRED', 401);
                const response = await request(row.info.installationId, '/' + id + '/credentials', { method: 'POST', body: '{}', headers: { 'Idempotency-Key': row.pendingAcquire.key } });
                active(id);
                const next = credentials(response, row.info);
                save(() => Object.assign(row, next, { pendingAcquire: undefined }));
            }
            else {
                if (row.idleExpiresAt === undefined || row.idleExpiresAt <= now() || !row.refresh)
                    throw fail('BACKGROUND_AUTHORIZATION_REQUIRED', 401);
                if (!row.pendingRefresh)
                    save(() => { row.pendingRefresh = { key: randomUUID(), at: now() }; });
                if (!row.pendingRefresh || now() - row.pendingRefresh.at >= 60000)
                    throw fail('BACKGROUND_AUTHORIZATION_REQUIRED', 401);
                let response;
                try {
                    response = await transport.token({ grant_type: 'refresh_token', refresh_token: store.unseal(row.refresh) }, row.pendingRefresh.key);
                }
                catch (error) {
                    throw transportFailure(error);
                }
                active(id);
                const next = credentials(response, row.info);
                save(() => Object.assign(row, next, { pendingRefresh: undefined }));
            }
            const latest = active(id);
            if (!latest.access)
                throw fail('BACKGROUND_AUTHORIZATION_REQUIRED', 401);
            return store.unseal(latest.access);
        });
    }
    return {
        async findActive(options) {
            if (!object(options) || Object.keys(options).some(k => !['installationId', 'userId'].includes(k)) ||
                !uuid(options.installationId) || !uuid(options.userId))
                throw fail('INVALID_BACKGROUND_QUERY', 400);
            const result = await request(options.installationId, '/active?' + new URLSearchParams(options));
            if (result === null)
                return null;
            const info = metadata(result);
            if (info.installationId !== options.installationId || info.userId !== options.userId || info.status !== 'active')
                throw fail('PLATFORM_RESPONSE_INVALID', 502);
            retain(info);
            return info;
        },
        async list(options) {
            if (!object(options) || Object.keys(options).some(k => !['installationId', 'limit', 'cursor'].includes(k)) || !uuid(options.installationId) ||
                options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) ||
                options.cursor !== undefined && (typeof options.cursor !== 'string' || !options.cursor || options.cursor.length > 1024))
                throw fail('INVALID_BACKGROUND_QUERY', 400);
            const query = new URLSearchParams(Object.entries(options).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
            const result = await request(options.installationId, '?' + query);
            if (!object(result) || !Array.isArray(result.items) || result.items.length > (options.limit ?? 30) || typeof result.hasMore !== 'boolean' ||
                (result.hasMore ? typeof result.nextCursor !== 'string' || !result.nextCursor : result.nextCursor !== null))
                throw fail('PLATFORM_RESPONSE_INVALID', 502);
            const items = result.items.map(value => metadata(value));
            if (new Set(items.map(v => v.grantId)).size !== items.length || items.some(v => v.installationId !== options.installationId))
                throw fail('PLATFORM_RESPONSE_INVALID', 502);
            for (const item of items)
                retain(item);
            const nextCursor = result.nextCursor;
            if (nextCursor !== null && typeof nextCursor !== 'string')
                throw fail('PLATFORM_RESPONSE_INVALID', 502);
            return { items, hasMore: result.hasMore, nextCursor };
        },
        info(id) { const row = active(id); if (!row?.info)
            throw fail('BACKGROUND_AUTHORIZATION_REQUIRED', 401); return structuredClone(row.info); },
        adopt(value, expected) {
            const info = metadata(record(value).backgroundGrant);
            if (info.installationId !== expected.installationId || info.userId !== expected.userId || info.authorizationVersion !== expected.version)
                throw fail('PAGE_BINDING_INVALID', 401);
            active(info.grantId);
            const next = credentials(value, info), row = retain(info);
            // A replayed page callback must not overwrite credentials already refreshed by a background job.
            if (!row.access)
                save(() => Object.assign(row, next));
            return structuredClone(info);
        },
        client(id) {
            active(id);
            if (!clients.has(id))
                clients.set(id, createBusinessClient({ config, fetcher, policy: config.capabilities || {},
                    journal: createWriteJournal({ row: () => active(id), now, save: patch => save(() => Object.assign(active(id), patch)) }),
                    context: { key: 'background:' + id, active: () => { active(id); }, validate: () => ensure(id),
                        identities: () => ({ user: active(id)?.scopes || active(id)?.info?.scopes || [] }), token: () => access(id) } }));
            return clients.get(id);
        },
        async close() { stopped = true; await Promise.allSettled([...lanes.values()]); },
    };
}
