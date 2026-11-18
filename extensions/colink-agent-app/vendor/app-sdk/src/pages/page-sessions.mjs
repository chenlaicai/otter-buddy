import { createHash, randomBytes } from 'node:crypto';
import { validateIssuer } from "../shared/config.mjs";
import { CoLinkError, fail, errorBody } from "../shared/errors.mjs";
import { verifyIdToken } from "../auth/protocol/oauth.mjs";
import { pageTransport } from "../auth/oauth-http.mjs";
import { USER_SCOPES } from "../shared/public-contract.mjs";
import { requestClient, createBusinessClient } from "../clients/business-client.mjs";
import { createWriteJournal } from "../clients/write-journal.mjs";
import { isRecord as object, record } from "../shared/data.mjs";
import { isMessageContent } from "./page-values.mjs";
const random = () => randomBytes(32).toString('base64url');
const hash = (value) => createHash('sha256').update(value).digest('base64url');
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128;
const opaque = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const supported = new Set(USER_SCOPES.filter(s => !['openid', 'profile'].includes(s)));
function pageSourceMismatch(source, execution) {
    const actual = record(execution.source);
    for (const field of ['channelId', 'topicId', 'taskId', 'conversationId'])
        if ((actual[field] ?? null) !== (source[field] ?? null))
            return 'execution.source.' + field;
    if (source.projectId === undefined || source.projectId === null)
        return;
    // The page location and the execution's authorization scope are distinct.
    // The platform can omit a page project from its resourceBounds projection.
    if (actual.projectId !== undefined && actual.projectId !== null && actual.projectId !== source.projectId)
        return 'execution.source.projectId';
    // A concrete authorization project still fences a project installation.
    // Explicit null denotes an unscoped personal/system subject, not a missing
    // page location. Missing authorization metadata is not proof of that scope.
    if (execution.projectId !== null && execution.projectId !== source.projectId)
        return 'execution.projectId';
}
function pageBindingError(field) {
    return new CoLinkError('PAGE_BINDING_INVALID', 401, undefined, {
        message: '当前授权执行与可信页面的绑定不一致或不完整。',
        hint: '从当前 CoLink 页面重新发起授权，并核对平台与 SDK 的页面来源契约；不修改主体/来源字段或切换身份重试。',
        details: [{ field, code: 'PAGE_BINDING_INVALID', message: '该绑定字段与当前页面不匹配，或缺少必需的平台信息。' }],
    });
}
function fields(value, allowed) {
    if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)))
        throw fail('PAGE_INVALID_INPUT', 400);
}
;
/** Single-owner page credentials, entirely separate from event/background U. */
export function createPageSessions({ config, store, options, background, fetcher = fetch, now = Date.now }) {
    validateIssuer(options.origin, config.allowInsecureIssuer);
    const path = options.path ?? '/colink/page';
    if (!/^\/[a-z][a-z0-9/-]*$/.test(path) || path.endsWith('/') || path.includes('//'))
        throw Error('Invalid page API path');
    const transport = pageTransport(config, fetcher), lanes = new Map();
    store.data.pageSessions ||= {};
    store.data.pageTransactions ||= {};
    const clients = new Map();
    let stopped = false, jwks, jwksAt = 0, keyLoading, unknownKeyAt = -Infinity;
    const sessions = () => store.data.pageSessions, transactions = () => store.data.pageTransactions;
    function commit(fn) {
        const before = structuredClone({ sessions: sessions(), transactions: transactions() });
        try {
            const result = fn();
            store.persist();
            return result;
        }
        catch {
            store.data.pageSessions = before.sessions;
            store.data.pageTransactions = before.transactions;
            throw fail('PAGE_STORAGE_UNAVAILABLE');
        }
    }
    const serial = (key, action) => {
        if (stopped)
            return Promise.reject(fail('PAGE_UNAVAILABLE'));
        const work = (lanes.get(key) || Promise.resolve()).catch(() => { }).then(action);
        lanes.set(key, work);
        return work.finally(() => { if (lanes.get(key) === work)
            lanes.delete(key); });
    };
    function install(row) {
        const current = store.data.oauthInstallations?.[row.installationId];
        if (current?.status !== 'ready' || current.authorizationVersion !== row.version)
            throw fail('PAGE_INSTALLATION_CHANGED', 401);
    }
    function load(token) {
        const row = opaque(token) && sessions()[hash(token)];
        if (!row || row.deadline <= now())
            throw fail('PAGE_LOGIN_REQUIRED', 401);
        install(row);
        return row;
    }
    function proof(value, row) {
        if (!object(value) || !id(value.userId) || !id(value.installationId) || !id(value.pageSessionId) ||
            !object(value.source) || !Array.isArray(value.userScopes) || !value.userScopes.every(s => typeof s === 'string') ||
            typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now() ||
            (row && (value.userId !== row.userId || value.installationId !== row.installationId || value.pageSessionId !== row.pageSessionId)))
            throw fail('PAGE_BINDING_INVALID', 401);
        if (value.displayName !== undefined && value.displayName !== null && typeof value.displayName !== 'string' || value.username !== undefined && value.username !== null && typeof value.username !== 'string' || value.content !== undefined && !isMessageContent(value.content) || value.viewData !== undefined && !object(value.viewData))
            throw fail('PAGE_BINDING_INVALID', 401);
        return { ...value, userId: value.userId, installationId: value.installationId, pageSessionId: value.pageSessionId, source: value.source,
            userScopes: value.userScopes, expiresAt: value.expiresAt, ...(isMessageContent(value.content) ? { content: value.content } : {}), ...(object(value.viewData) ? { viewData: value.viewData } : {}),
            ...(value.displayName === null || typeof value.displayName === 'string' ? { displayName: value.displayName } : {}), ...(value.username === null || typeof value.username === 'string' ? { username: value.username } : {}) };
    }
    function credentials(value, allowed, executionId) {
        if (!object(value) || value.token_type !== 'Bearer' || typeof value.access_token !== 'string' || !value.access_token || value.access_token.length > 16384 ||
            typeof value.refresh_token !== 'string' || !value.refresh_token || value.refresh_token.length > 16384 ||
            typeof value.expires_in !== 'number' || !Number.isSafeInteger(value.expires_in) || value.expires_in < 1 || value.expires_in > 3600 ||
            typeof value.scope !== 'string' || value.scope.length > 4096 || value.accessMode === 'background')
            throw fail('PAGE_RESPONSE_INVALID', 502);
        const scopes = value.scope.split(' ');
        if (!['openid', 'profile'].every(s => scopes.includes(s)) || scopes.some(s => !allowed.includes(s)) ||
            new Set(scopes).size !== scopes.length ||
            (!executionId && value.executionId !== undefined) ||
            (executionId && (value.executionId !== executionId || typeof value.executionExpiresAt !== 'string' || !Number.isFinite(Date.parse(String(value.executionExpiresAt))) || Date.parse(String(value.executionExpiresAt)) <= now())))
            throw fail('PAGE_RESPONSE_INVALID', 502);
        return { access: store.seal(value.access_token), refresh: store.seal(value.refresh_token), scopes,
            tokenExpiresAt: now() + value.expires_in * 1000 };
    }
    async function keys(token) {
        let kid;
        try {
            kid = record(JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'))).kid;
        }
        catch {
            throw fail('PAGE_IDENTITY_INVALID', 401);
        }
        const unknown = !jwks?.keys?.some(k => k.kid === kid);
        if (!jwks || now() - jwksAt >= 300000 || unknown && now() - unknownKeyAt >= 1000) {
            if (!keyLoading) {
                if (unknown)
                    unknownKeyAt = now();
                keyLoading = transport.request('/oauth/jwks', { method: 'GET' }).then(value => {
                    if (!object(value) || !Array.isArray(value.keys) || value.keys.length > 20)
                        throw fail('PAGE_IDENTITY_INVALID', 401);
                    if (!value.keys.every(object))
                        throw fail('PAGE_IDENTITY_INVALID', 401);
                    jwks = { keys: value.keys };
                    jwksAt = now();
                }).finally(() => { keyLoading = undefined; });
            }
            await keyLoading;
        }
        return jwks;
    }
    function identity(row, current) {
        if (!row.sessionId)
            throw fail('PAGE_BINDING_INVALID', 401);
        return Object.freeze({ userId: row.userId, installationId: row.installationId,
            sessionId: row.sessionId, authorizationVersion: row.version,
            pageSessionId: row.pageSessionId, ...(current.displayName === undefined ? {} : { displayName: current.displayName }),
            ...(current.username === undefined ? {} : { username: current.username }), source: structuredClone(current.source),
            ...(current.content === undefined ? {} : { content: structuredClone(current.content) }),
            ...(current.viewData === undefined ? {} : { viewData: structuredClone(current.viewData) }),
            scopes: [...row.scopes], expiresAt: new Date(Math.min(row.deadline, Date.parse(current.expiresAt))).toISOString() });
    }
    async function refresh(token) {
        let row = load(token);
        if (!row.pendingRefresh && row.tokenExpiresAt > now() + 30000)
            return row;
        if (!row.pendingRefresh)
            commit(() => { row.pendingRefresh = { key: random(), at: now() }; });
        if (!row.pendingRefresh || now() - row.pendingRefresh.at >= 60000)
            throw fail('PAGE_LOGIN_REQUIRED', 401);
        const pending = row.pendingRefresh;
        const value = record(await transport.token({ grant_type: 'refresh_token', refresh_token: store.unseal(row.refresh) }, pending.key));
        const next = credentials(value, row.scopes, row.executionId);
        // The same family cannot widen scopes, change execution or extend its source.
        if (row.executionId && Date.parse(String(value.executionExpiresAt)) !== row.executionDeadline)
            throw fail('PAGE_BINDING_INVALID', 401);
        load(token);
        commit(() => { Object.assign(row, next, { tokenExpiresAt: Math.min(next.tokenExpiresAt, pending.at + Number(value.expires_in) * 1000), pendingRefresh: undefined }); });
        return row;
    }
    async function current(token) {
        const row = await refresh(token), value = proof(await transport.proof(store.unseal(row.access)), row);
        load(token);
        // Adopt additional metadata on existing SDK sessions only after live proof.
        if (!row.sessionId || !row.lastProof)
            commit(() => {
                row.sessionId ||= random();
                row.lastProof = structuredClone(value);
            });
        return { row, value };
    }
    function begin(kind, input, sessionToken) {
        fields(input, kind === 'login' ? ['state', 'nonce', 'codeChallenge'] : ['state', 'codeChallenge', 'scopes', 'scopeMode', 'accessMode']);
        if (input.accessMode !== undefined && (input.accessMode !== 'session' && input.accessMode !== 'background'))
            throw fail('PAGE_INVALID_INPUT', 400);
        if (!opaque(input.state) || !opaque(input.codeChallenge) || kind === 'login' && !opaque(input.nonce))
            throw fail('PAGE_INVALID_INPUT', 400);
        if (input.scopeMode !== undefined && (input.scopeMode !== 'manifest' || input.accessMode === 'background' || input.scopes !== undefined))
            throw fail('PAGE_INVALID_INPUT', 400);
        if (kind === 'authorize' && (input.scopes === undefined ? input.scopeMode !== 'manifest' :
            !Array.isArray(input.scopes) || !input.scopes.length || input.scopes.some(s => typeof s !== 'string' || !supported.has(s)) || new Set(input.scopes).size !== input.scopes.length))
            throw fail('PAGE_UNSUPPORTED_SCOPE', 400);
        const row = kind === 'authorize' ? load(sessionToken) : null;
        const token = random(), transactionId = hash(token);
        commit(() => {
            for (const [key, value] of Object.entries(transactions()))
                if (value.expiresAt <= now())
                    delete transactions()[key];
            for (const [key, value] of Object.entries(sessions()))
                if (value.deadline <= now())
                    delete sessions()[key];
            if (Object.keys(transactions()).length >= 1000 || Object.keys(sessions()).length >= 1000)
                throw Error('capacity');
            transactions()[transactionId] = { kind, state: String(input.state), codeChallenge: String(input.codeChallenge), ...(typeof input.nonce === 'string' ? { nonce: input.nonce } : {}), ...(Array.isArray(input.scopes) ? { scopes: input.scopes.filter((s) => typeof s === 'string') } : {}), ...(input.scopeMode === 'manifest' ? { scopeMode: input.scopeMode } : {}), ...(input.accessMode === 'background' || input.accessMode === 'session' ? { accessMode: input.accessMode } : {}), session: row ? hash(sessionToken) : null,
                expiresAt: now() + (kind === 'authorize' ? 600000 : 120000), status: 'new' };
        });
        return { transaction: token };
    }
    async function complete(input, sessionToken) {
        fields(input, ['transaction', 'code', 'codeVerifier', 'state', 'issuer', 'executionId']);
        if (!opaque(input.transaction) || !opaque(input.code) || typeof input.codeVerifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier))
            throw fail('PAGE_INVALID_INPUT', 400);
        const code = input.code, codeVerifier = input.codeVerifier, executionId = typeof input.executionId === 'string' ? input.executionId : undefined;
        const txKey = hash(input.transaction), tx = transactions()[txKey];
        if (!tx || tx.expiresAt <= now())
            throw fail('PAGE_TRANSACTION_EXPIRED', 401);
        if (tx.kind === 'login' && input.executionId !== undefined)
            throw fail('PAGE_INVALID_INPUT', 400);
        if (tx.state !== input.state || input.issuer !== config.issuer || tx.codeChallenge !== hash(input.codeVerifier))
            throw fail('PAGE_TRANSACTION_INVALID', 401);
        if (tx.kind === 'authorize' && (tx.session !== hash(sessionToken || '') || !id(input.executionId)))
            throw fail('PAGE_TRANSACTION_INVALID', 401);
        const fingerprint = hash(JSON.stringify([input.code, input.codeVerifier, input.executionId]));
        if (tx.fingerprint && tx.fingerprint !== fingerprint)
            throw fail('PAGE_TRANSACTION_INVALID', 401);
        if (tx.kind === 'authorize' && !opaque(sessionToken))
            throw fail('PAGE_TRANSACTION_INVALID', 401);
        const lane = tx.status === 'done' ? 'session:' + hash(store.unseal(tx.result)) : tx.kind === 'login' ? 'transaction:' + txKey : 'session:' + tx.session;
        return serial(lane, async () => {
            const live = transactions()[txKey];
            if (!live || live.expiresAt <= now())
                throw fail('PAGE_TRANSACTION_EXPIRED', 401);
            if (live.fingerprint && live.fingerprint !== fingerprint)
                throw fail('PAGE_TRANSACTION_INVALID', 401);
            if (live.status === 'done') {
                const token = store.unseal(live.result);
                const recover = async () => { const { row, value } = await current(token); return { sessionToken: token, identity: identity(row, value), ...(live.grantId ? { backgroundGrant: background.info(live.grantId) } : {}) }; };
                return lane === 'session:' + hash(token) ? recover() : serial('session:' + hash(token), recover);
            }
            if (live.status === 'failed' || live.kind === 'login' && live.status === 'sending')
                throw fail('PAGE_LOGIN_RESTART_REQUIRED', 409);
            if (live.kind === 'authorize' && live.status === 'new') {
                const { row, value: sourceProof } = await current(sessionToken);
                {
                    // A background token intentionally has no page identity. Verify the
                    // code's execution binding with the installation before exchanging it.
                    const appToken = await config.installationOAuth.getAccessToken(row.installationId);
                    const execution = record(await transport.request('/extensions/user-executions/' + encodeURIComponent(executionId), { headers: { Authorization: 'Bearer ' + appToken } }));
                    for (const field of ['userId', 'installationId', 'pageSessionId'])
                        if (execution[field] !== row[field])
                            throw pageBindingError('execution.' + field);
                    if (execution.sourceKind !== 'page')
                        throw pageBindingError('execution.sourceKind');
                    if (execution.status !== 'active')
                        throw pageBindingError('execution.status');
                    const mismatch = pageSourceMismatch(sourceProof.source, execution);
                    if (mismatch)
                        throw pageBindingError(mismatch);
                    {
                        const requestedScopes = execution.requestedScopes;
                        if (live.scopeMode === 'manifest' && execution.accessMode !== 'session')
                            throw pageBindingError('execution.accessMode');
                        if (!Array.isArray(requestedScopes) ||
                            requestedScopes.some(s => !supported.has(s)) ||
                            new Set(requestedScopes).size !== requestedScopes.length ||
                            (live.scopes ?? []).some(s => !requestedScopes.includes(s)))
                            throw pageBindingError('execution.requestedScopes');
                        // Persist the platform-authenticated set before exchange, including response-loss recovery.
                        commit(() => { live.resolvedScopes = [...requestedScopes]; });
                    }
                }
            }
            commit(() => { live.status = 'sending'; live.fingerprint = fingerprint; live.pending ||= { key: random(), at: now() }; });
            if (!live.pending || now() - live.pending.at >= 60000)
                throw fail('PAGE_LOGIN_RESTART_REQUIRED', 409);
            let value;
            try {
                value = record(await transport.token({ grant_type: 'authorization_code', code, code_verifier: codeVerifier }, live.kind === 'authorize' ? live.pending.key : undefined));
            }
            catch (error) {
                if (live.kind === 'login' || [400, 401, 403, 409].includes(Number(record(error).status)))
                    commit(() => { live.status = 'failed'; });
                throw error;
            }
            try {
                if (live.scopeMode === 'manifest' && value.accessMode === 'background')
                    throw fail('PAGE_RESPONSE_INVALID', 502);
                if (live.kind === 'authorize' && value.accessMode === 'background') {
                    const old = load(sessionToken), grant = background.adopt(value, old);
                    commit(() => { live.grantId = grant.grantId; live.status = 'done'; live.result = store.seal(sessionToken); });
                    const { row, value: verified } = await current(sessionToken);
                    return { sessionToken, identity: identity(row, verified), backgroundGrant: grant };
                }
                const next = credentials(value, live.kind === 'login' ? ['openid', 'profile'] : ['openid', 'profile', ...(live.resolvedScopes ?? live.scopes ?? [])], live.kind === 'authorize' ? executionId : undefined);
                if (live.resolvedScopes?.some(s => !next.scopes.includes(s)))
                    throw fail('PAGE_RESPONSE_INVALID', 502);
                let claims, old;
                if (live.kind === 'login') {
                    if (typeof value.id_token !== 'string' || typeof value.access_token !== 'string' || typeof live.nonce !== 'string')
                        throw fail('PAGE_IDENTITY_INVALID', 401);
                    try {
                        claims = record(verifyIdToken({ token: value.id_token, jwks: await keys(value.id_token), issuer: config.issuer,
                            clientId: config.clientId, expectedNonce: live.nonce, accessToken: value.access_token, nowMs: now() }));
                    }
                    catch {
                        throw fail('PAGE_IDENTITY_INVALID', 401);
                    }
                }
                else
                    old = load(sessionToken);
                const verified = proof(await transport.proof(String(value.access_token)), old);
                if (next.scopes.some(s => !['openid', 'profile'].includes(s) && !verified.userScopes.includes(s)))
                    throw fail('PAGE_BINDING_INVALID', 401);
                if (claims && (verified.userId !== claims.sub || verified.installationId !== claims.installation_id))
                    throw fail('PAGE_BINDING_INVALID', 401);
                const token = old ? sessionToken : random();
                const row = { ...next, userId: verified.userId, installationId: verified.installationId, pageSessionId: verified.pageSessionId,
                    // Online proof expires at min(access token, source). It is not the source
                    // lifetime: refresh may extend the token, but never the platform source.
                    // This local cap only forces periodic fresh login; every request is fenced online.
                    version: old?.version ?? Number(claims?.authorization_version), deadline: old?.deadline ?? now() + 86400000,
                    sessionId: old?.sessionId || random(), lastProof: structuredClone(verified),
                    ...(old ? { executionId, executionDeadline: Date.parse(String(value.executionExpiresAt)) } : {}) };
                install(row);
                commit(() => {
                    if (!old)
                        for (const [key, existing] of Object.entries(sessions()))
                            if (existing.installationId === row.installationId && existing.pageSessionId === row.pageSessionId)
                                delete sessions()[key];
                    sessions()[hash(token)] = { ...old, ...row };
                    live.status = 'done';
                    live.result = store.seal(token);
                });
                return { sessionToken: token, identity: identity(row, verified) };
            }
            catch (error) {
                // Keep business exchange recovery on transport/storage failure: same form/key.
                if (live.kind === 'login' || Number(record(error).status) < 500)
                    commit(() => { live.status = 'failed'; });
                throw error;
            }
        });
    }
    async function authenticated(token, action) {
        if (!opaque(token))
            throw fail('PAGE_LOGIN_REQUIRED', 401);
        return serial('session:' + hash(token), async () => { const { row, value } = await current(token); return action(row, value); });
    }
    const originlessGet = (req) => req.method === 'GET' && req.headers.origin === undefined;
    function pageClient(token, readOnly = false) {
        if (!opaque(token))
            throw fail('PAGE_LOGIN_REQUIRED', 401);
        load(token);
        const key = 'page:' + hash(token);
        const clientKey = readOnly ? key + ':read-only' : key;
        const policy = readOnly ? { ...options.capabilities, readOnly: true } : options.capabilities;
        if (!clients.has(clientKey))
            clients.set(clientKey, createBusinessClient({ config, fetcher, policy,
                journal: createWriteJournal({ row: () => load(token), now, save: patch => commit(() => Object.assign(load(token), patch)) }),
                context: { key, active: () => load(token), validate: input => {
                        const row = load(token), ref = record(row.lastProof?.source.uiRequest);
                        // Completion itself fences the page, claimant and installation and accepts
                        // completed retries. Ordinary proof rejects completed pages, so never put
                        // it in front of this one exact bound operation. All other calls stay online.
                        if (ref?.id && input?.method === 'POST' && input.path === '/extensions/ui-requests/' + ref.id + '/complete' &&
                            object(input.body) && Object.keys(input.body).length === 0 && input.query === undefined)
                            return;
                        return authenticated(token, () => { });
                    },
                    identities: () => ({ user: load(token).scopes }),
                    token: () => serial('session:' + hash(token), async () => store.unseal((await refresh(token)).access)) } }));
        return clients.get(clientKey);
    }
    async function business(token, kind, input = {}) {
        fields(input, kind === 'topics' ? ['projectId', 'channelId', 'topicIds', 'limit', 'cursor'] : ['topicId', 'limit', 'cursor']);
        const resource = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,36}$/.test(value);
        if (['projectId', 'channelId', 'topicId'].some(k => input[k] !== undefined && !resource(input[k])) || kind === 'messages' && !resource(input.topicId) ||
            input.limit !== undefined && (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) ||
            input.cursor !== undefined && (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 2048) ||
            input.topicIds !== undefined && (!Array.isArray(input.topicIds) || !input.topicIds.length || input.topicIds.length > 100 || !input.topicIds.every(resource) || new Set(input.topicIds).size !== input.topicIds.length))
            throw fail('PAGE_INVALID_INPUT', 400);
        // Preserve shortcut-specific missing-consent errors; successful reads share
        // the ordinary client's online checks, policy and transport.
        const row = load(token);
        if (!row.scopes.includes(kind === 'topics' ? 'topics:list' : 'messages:read-private'))
            throw fail('PAGE_AUTHORIZATION_REQUIRED', 403);
        const client = pageClient(token);
        const result = await (kind === 'topics' ? client.user.topics.list(input) : client.user.topics.listMessages({ ...input, topicId: String(input.topicId) }));
        if (!object(result) || !Array.isArray(result.items) || typeof result.hasMore !== 'boolean' || !(result.nextCursor === null || typeof result.nextCursor === 'string'))
            throw fail('PAGE_RESPONSE_INVALID', 502);
        return result;
    }
    const sessionToken = (req) => /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
    return {
        path,
        async handle(req, res) {
            if (req.url?.split('?')[0] !== path && !req.url?.split('?')[0]?.startsWith(path + '/'))
                return false;
            const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
            try {
                if (stopped)
                    throw fail('PAGE_UNAVAILABLE');
                if (req.headers.origin !== options.origin)
                    throw fail('PAGE_ORIGIN_DENIED', 403);
                if (req.method !== 'POST' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))
                    throw fail('PAGE_INVALID_REQUEST', 400);
                const chunks = [];
                let size = 0;
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > (req.url === path + '/http' ? 28 * 1024 * 1024 : 16384))
                        throw fail('PAGE_INVALID_REQUEST', 413);
                    chunks.push(chunk);
                }
                let input;
                try {
                    input = JSON.parse(Buffer.concat(chunks).toString());
                }
                catch {
                    throw fail('PAGE_INVALID_INPUT', 400);
                }
                const token = sessionToken(req);
                let result;
                switch (req.url.slice(path.length)) {
                    case '/login/start':
                        result = begin('login', input);
                        break;
                    case '/login/complete':
                    case '/authorize/complete':
                        result = await complete(input, token);
                        break;
                    case '/authorize/start':
                        result = await authenticated(token, () => begin('authorize', input, token));
                        break;
                    case '/identity':
                        fields(input, []);
                        result = await authenticated(token, (row, value) => identity(row, value));
                        break;
                    case '/topics':
                        result = await business(token, 'topics', input);
                        break;
                    case '/messages':
                        result = await business(token, 'messages', input);
                        break;
                    case '/http': {
                        fields(input, ['method', 'path', 'query', 'body', 'key', 'bytes', 'contentType']);
                        if (input.bytes !== undefined) {
                            if (typeof input.bytes !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.bytes))
                                throw fail('PAGE_INVALID_INPUT', 400);
                            input.bytes = new Uint8Array(Buffer.from(input.bytes, 'base64'));
                        }
                        result = await requestClient(pageClient(token).user, input);
                        if (object(result) && result.bytes instanceof Uint8Array)
                            result = { ...result, bytes: Buffer.from(result.bytes).toString('base64') };
                        break;
                    }
                    case '/logout':
                        fields(input, []);
                        if (opaque(token))
                            await serial('session:' + hash(token), () => commit(() => { delete sessions()[hash(token)]; }));
                        result = { status: 'closed' };
                        break;
                    default: throw fail('PAGE_NOT_FOUND', 404);
                }
                send(200, result);
            }
            catch (error) {
                send(Number(record(error).status) || 503, errorBody(error, 'PAGE_UNAVAILABLE'));
            }
            return true;
        },
        /** Authenticate each App-owned request; returned identity is not a reusable proof. */
        authenticate(req) {
            // Same-origin browser GETs do not necessarily carry Origin. They still
            // require the non-cookie Bearer and current online page proof.
            if (req.headers.origin !== options.origin && !originlessGet(req))
                return Promise.reject(fail('PAGE_ORIGIN_DENIED', 403));
            return authenticated(sessionToken(req), (row, value) => identity(row, value));
        },
        client(req) {
            const readOnly = originlessGet(req);
            if (req.headers.origin !== options.origin && !readOnly)
                throw fail('PAGE_ORIGIN_DENIED', 403);
            return pageClient(sessionToken(req), readOnly);
        },
        async completeInteraction(req, beforeComplete) {
            if (req.headers.origin !== options.origin)
                throw fail('PAGE_ORIGIN_DENIED', 403);
            if (typeof beforeComplete !== 'function')
                throw fail('PAGE_INVALID_INPUT', 400);
            const token = sessionToken(req), row = load(token), ref = record(row.lastProof?.source.uiRequest);
            if (!row.lastProof || !id(ref.id))
                throw fail('PAGE_BINDING_INVALID', 403);
            // The callback verifies the App's durable prepared receipt; this identity
            // is only for that check, not an online authorization proof for other work.
            await beforeComplete(identity(row, row.lastProof));
            const result = await pageClient(token).user.interactions.complete({ interactionId: ref.id });
            if (result?.id !== ref.id || result.status !== 'completed')
                throw fail('PAGE_RESPONSE_INVALID', 502);
            return result;
        },
        async close() { stopped = true; await Promise.allSettled([...lanes.values()]); },
    };
}
