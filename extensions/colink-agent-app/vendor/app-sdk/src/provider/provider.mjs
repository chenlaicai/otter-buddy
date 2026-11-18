import { providerDirectory } from "./provider-directory.mjs";
import { randomUUID } from 'node:crypto';
import { compileCapabilityDocument as compileDocument, LIMITS } from "./protocol/catalog.mjs";
import { createProviderMiddleware as createMiddleware } from "./protocol/provider.mjs";
import { CapabilityProtocolError, sha256 } from "./protocol/common.mjs";
import { overlapsPath } from "../shared/http-paths.mjs";
import { createBusinessClient } from "../clients/business-client.mjs";
import { createWriteJournal } from "../clients/write-journal.mjs";
import { CoLinkError } from "../shared/errors.mjs";
import { isRecord } from "../shared/data.mjs";
const compileCapabilityDocument = compileDocument;
const createProviderMiddleware = createMiddleware;
function fail(code, status = 400, hint = '核对 provider 配置、操作声明和业务存储。') {
    throw new CoLinkError(code, status, undefined, { hint });
}
;
const immutable = (value) => {
    if (value && typeof value === 'object') {
        for (const item of Object.values(value))
            immutable(item);
        Object.freeze(value);
    }
    return value;
};
const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(body === undefined || status === 204 ? undefined : JSON.stringify(body));
};
/** Single-owner runtime integration. Business and receipt transactions belong to options.store. */
export function createProvider({ options, manifest, config, store, installations, users, appClient, fetcher, now, stopped, pagePath, log }) {
    if (!options || typeof options.authorize !== 'function' || !options.handlers || manifest.api?.contextVersion !== 2)
        fail('PROVIDER_INVALID_OPTIONS');
    if ('replayStore' in options)
        fail('PROVIDER_INVALID_OPTIONS', 400, '请求防重放由 SDK 管理；移除 replayStore 配置。');
    const document = structuredClone(options.document);
    const handlers = { ...options.handlers };
    const catalog = compileCapabilityDocument(document, manifest.api);
    const catalogs = [catalog, ...(options.previousDocuments || []).map(doc => compileCapabilityDocument(doc, manifest.api))];
    const byRevision = new Map(catalogs.map(item => [item.specRevision, item]));
    const operationIds = new Set(catalogs.flatMap(item => item.operations.map(op => op.operationId)));
    // Only public schema paths may reach logs. An undeclared property name can
    // itself contain a secret, so report its nearest declared parent instead.
    const declaredFields = new Set(['input', 'response', 'topicReply', 'topicReply.status', 'topicReply.text', 'topicReply.reason']);
    function schemaFields(schema, path, depth = 0) {
        if (!isRecord(schema) || depth > LIMITS.schemaDepth)
            return;
        declaredFields.add(path);
        if (isRecord(schema.properties))
            for (const [name, child] of Object.entries(schema.properties))
                schemaFields(child, path + '.' + name, depth + 1);
        if (isRecord(schema.items))
            schemaFields(schema.items, path + '[]', depth + 1);
    }
    for (const item of catalogs)
        for (const op of item.operations) {
            schemaFields(op.inputSchema, 'input');
            for (const response of Object.values(op.responses))
                schemaFields(response.schema, 'response');
        }
    function diagnosticField(field) {
        if (typeof field !== 'string' || field.length > 2048)
            return;
        let path = field.replace(/\[\d+\]/g, '[]');
        while (path) {
            if (declaredFields.has(path) && /^[A-Za-z0-9_.:\[\]-]{1,200}$/.test(path))
                return path;
            const parent = path.replace(/(?:\.[^.\[\]]+|\[\])$/, '');
            if (parent === path)
                return;
            path = parent;
        }
    }
    // Serialization runs before schema validation. Locate non-JSON values only
    // along declared paths, with a separate small budget; diagnostics must never
    // change the protocol result or traverse arbitrary business property names.
    function nonJsonField(schema, value, path, budget, depth = 0) {
        if (budget.remaining-- <= 0 || depth > LIMITS.schemaDepth || !isRecord(schema))
            return;
        if (['undefined', 'bigint', 'function', 'symbol'].includes(typeof value) ||
            (typeof value === 'number' && !Number.isFinite(value)))
            return path;
        if (Array.isArray(value) && isRecord(schema.items)) {
            for (let i = 0; i < value.length && budget.remaining > 0; i++) {
                const field = nonJsonField(schema.items, value[i], path + '[]', budget, depth + 1);
                if (field)
                    return field;
            }
        }
        else if (isRecord(value) && isRecord(schema.properties)) {
            for (const [name, child] of Object.entries(schema.properties)) {
                if (budget.remaining <= 0)
                    break;
                if (!Object.hasOwn(value, name))
                    continue;
                const field = nonJsonField(child, value[name], path + '.' + name, budget, depth + 1);
                if (field)
                    return field;
            }
        }
    }
    function resultDiagnostic(result, operation) {
        try {
            if (typeof result.status !== 'number')
                return;
            return diagnosticField(nonJsonField(operation.responses[result.status]?.schema, result.data, 'response', { remaining: 1024 }));
        }
        catch {
            return;
        } // A callback's getter/proxy must not break error handling.
    }
    if ([...operationIds].some(id => typeof handlers[id] !== 'function') ||
        Object.keys(handlers).some(id => !operationIds.has(id)))
        fail('PROVIDER_HANDLER_MISMATCH');
    const writes = catalogs.some(item => item.operations.some(op => op.method === 'POST'));
    if (writes && (!options.store || typeof options.store.runInTransaction !== 'function' || typeof options.store.getReceipt !== 'function'))
        fail('PROVIDER_STORE_REQUIRED');
    for (const item of catalogs)
        for (const op of item.operations)
            if ((op.requiredUserScopes || []).some(scope => !(manifest.permissions || []).includes(scope)))
                fail('PROVIDER_SCOPE_UNDECLARED');
    const paths = [manifest.api.openapiPath, manifest.api.basePath];
    if (paths.some(path => ['/events', '/healthz', '/manifest.json', '/.well-known', '/page-config.json', '/colink-browser.mjs', pagePath].filter((p) => typeof p === 'string').some(reserved => overlapsPath(path, reserved))))
        fail('PROVIDER_PATH_CONFLICT');
    const pending = new Set(), controllers = new Set();
    const replays = () => store.data.providerReplays ||= {};
    const replayStore = { claim(key, expiresAt) {
            const before = replays(), next = Object.fromEntries(Object.entries(before).filter(([, expiry]) => expiry > now()));
            if (Object.hasOwn(next, key))
                return false;
            if (Object.keys(next).length >= 4096)
                fail('PROVIDER_REPLAY_CAPACITY', 503, '等待有效请求防重放记录过期后重试；不要清除未过期记录。');
            next[key] = expiresAt;
            store.data.providerReplays = next;
            try {
                store.persist();
            }
            catch (error) {
                store.data.providerReplays = before;
                throw error;
            }
            return true;
        } };
    const binding = (context) => {
        const installation = store.data.oauthInstallations[context.providerInstallationId];
        if (stopped() || installation?.status !== 'ready')
            fail('APP_API_INSTALLATION_UNAVAILABLE', 403);
        return installation;
    };
    const safeContext = (context) => immutable(structuredClone({
        callId: context.callId, installationId: context.providerInstallationId, consumerInstallationId: context.consumerInstallationId,
        projectId: context.context.projectId, operationId: context.operationId, specRevision: context.specRevision,
        expiresAt: context.executionExpiresAt,
        actor: context.execution ? { kind: 'user', userId: context.execution.actor.userId } : { kind: 'app', installationId: context.consumerInstallationId },
        ...(context.execution ? { source: context.execution.source } : {}), ...(context.reply ? { reply: context.reply } : {}),
    }));
    const transactions = new WeakMap();
    const businessStore = options.store;
    const protocolStore = businessStore && {
        readReceipt: identity => businessStore.getReceipt(identity),
        runInTransaction: callback => businessStore.runInTransaction(transaction => {
            const adapter = { claim: (...args) => transaction.claimCall(...args), complete: (...args) => transaction.completeCall(...args), ack: (...args) => transaction.acknowledge(...args) };
            transactions.set(adapter, transaction);
            return callback(adapter);
        }),
    };
    const middleware = createProviderMiddleware({
        catalog: revision => byRevision.get(revision) ?? null, receiptPath: manifest.api.receiptPath,
        recipient: config.appInstanceId, credentialVersion: sha256(config.signingSecret), secret: config.signingSecret,
        replayStore, store: protocolStore, now,
        authorize: async ({ context, operation, input, purpose }) => {
            binding(context);
            if (input !== undefined && !isRecord(input))
                fail('APP_API_INPUT_INVALID');
            await options.authorize({ context: safeContext(context), input: input === undefined ? undefined : immutable(structuredClone(input)),
                purpose: purpose === 'capability_call' ? 'execute' : purpose === 'capability_receipt' ? 'receipt' : 'ack' });
            binding(context);
        },
    });
    function pruneExpiredState() {
        const expiredUsers = Object.entries(store.data.oauthUserExecutions || {}).filter(([, row]) => row.eventId?.startsWith('provider:') && row.deadline !== undefined && row.deadline <= now());
        const expiredClients = Object.entries(store.data.providerClients || {}).filter(([, row]) => row.expiresAt + 30 * 86400000 <= now() && Object.values(row.writes || {}).every(write => write.status === 'sent'));
        if (!expiredUsers.length && !expiredClients.length)
            return;
        for (const [key] of expiredUsers)
            delete store.data.oauthUserExecutions[key];
        for (const [key] of expiredClients)
            delete store.data.providerClients[key];
        try {
            store.persist();
        }
        catch (error) {
            Object.assign(store.data.oauthUserExecutions || {}, Object.fromEntries(expiredUsers));
            Object.assign(store.data.providerClients || {}, Object.fromEntries(expiredClients));
            throw error;
        }
    }
    async function invoke(tx, { input, context, operation }) {
        pruneExpiredState();
        const version = binding(context).authorizationVersion, controller = new AbortController();
        controllers.add(controller);
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(0, Math.min(300000, Date.parse(context.executionExpiresAt) - now())))]);
        let finished = false;
        const active = () => {
            if (finished || signal.aborted || now() >= Date.parse(context.executionExpiresAt))
                fail('APP_API_EXECUTION_EXPIRED', 403);
            if (binding(context).authorizationVersion !== version)
                fail('INSTALLATION_AUTHORIZATION_CHANGED', 403);
        };
        try {
            active();
            let executionId;
            if (context.userAuthorization) {
                if (!context.execution || (operation.requiredUserScopes || []).length === 0)
                    fail('USER_AUTHORIZATION_INVALID', 403);
                const scopes = context.userAuthorization.scope.split(' ');
                if (scopes.some(scope => !(operation.requiredUserScopes || []).includes(scope)) ||
                    (operation.requiredUserScopes || []).some(scope => !scopes.includes(scope)))
                    fail('SCOPE_MISSING', 403);
                executionId = await users.acceptEvent({ eventId: 'provider:' + context.callId, installationId: context.providerInstallationId,
                    actor: { type: 'user', id: context.execution.actor.userId }, userAuthorization: context.userAuthorization });
            }
            else if (operation.requiredUserScopes?.length)
                fail('USER_AUTHORIZATION_REQUIRED', 403);
            const validate = async () => { active(); if (executionId)
                await users.validateProvider(context); active(); };
            await validate();
            store.data.providerClients ||= {};
            const key = context.providerInstallationId + ':' + context.callId;
            const row = store.data.providerClients[key] ||= { expiresAt: Date.parse(context.executionExpiresAt) };
            const save = (patch) => {
                const previous = { ...row };
                Object.assign(row, patch);
                try {
                    store.persist();
                }
                catch (error) {
                    for (const k of Object.keys(row))
                        Reflect.deleteProperty(row, k);
                    Object.assign(row, previous);
                    throw error;
                }
            };
            const colink = context.execution && !executionId ? undefined : createBusinessClient({ config, fetcher, policy: config.capabilities,
                journal: createWriteJournal({ row, save, now }), context: { key, active, validate, signal,
                    identities: () => executionId ? { user: store.data.oauthUserExecutions[executionId].scopes || [] } : { app: (binding(context).scope || '').split(' ') },
                    token: identity => identity === 'user' ? users.getAccessToken(executionId, context.providerInstallationId, context.execution.actor.userId)
                        : installations.getAccessToken(context.providerInstallationId) } });
            if (!isRecord(input))
                fail('APP_API_INPUT_INVALID');
            const result = await handlers[operation.operationId]({ input, context: safeContext(context), transaction: tx ? transactions.get(tx) : null, colink, signal,
                directory: providerDirectory(appClient(context.providerInstallationId).app, context.callId, active), });
            // Once business commits, later authority loss must not erase its receipt. Publication rechecks at the platform.
            return result;
        }
        finally {
            finished = true;
            controllers.delete(controller);
            const key = context.providerInstallationId + ':' + context.callId;
            if (!Object.keys(store.data.providerClients?.[key]?.writes || {}).length)
                delete store.data.providerClients?.[key];
        }
    }
    async function handle(req, res) {
        const path = (req.url || '').split('?')[0];
        if (path !== manifest.api.openapiPath && path !== manifest.api.basePath && !path.startsWith(manifest.api.basePath + '/'))
            return false;
        if (stopped())
            fail('APP_API_UNAVAILABLE', 503);
        if (path === manifest.api.openapiPath) {
            if (req.method !== 'GET' || req.url !== path)
                fail('APP_API_INPUT_INVALID');
            json(res, 200, document);
            return true;
        }
        // Reject duplicate headers before Node's normalized map can obscure signed values.
        const headers = Object.create(null);
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
            const name = req.rawHeaders[i].toLowerCase();
            if (Object.hasOwn(headers, name))
                fail('APP_API_SIGNATURE_INVALID', 401);
            headers[name] = req.rawHeaders[i + 1];
        }
        if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')
            fail('APP_API_INPUT_INVALID');
        if (req.method === 'POST' && !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))
            fail('CONTENT_TYPE_REQUIRED', 415);
        const chunks = [];
        let length = 0;
        for await (const part of req) {
            length += part.length;
            if (length > LIMITS.inputBytes)
                fail('BODY_TOO_LARGE', 413);
            chunks.push(part);
        }
        if ((req.method !== 'GET' && req.method !== 'POST') || !req.url)
            fail('APP_API_INPUT_INVALID');
        const request = { method: req.method, requestTarget: req.url, headers, body: Buffer.concat(chunks) };
        let outcome;
        try {
            if (path === manifest.api.receiptPath)
                json(res, 200, await middleware.receipt(request));
            else if (path === manifest.api.receiptPath + '/ack')
                json(res, 200, await middleware.ack(request));
            else {
                const result = await middleware.execute(request, async (tx, call) => {
                    const result = await invoke(tx, call);
                    outcome = { result, operation: call.operation };
                    return result;
                });
                if (result.receipt)
                    json(res, 200, result.receipt);
                else if (result.response)
                    json(res, result.response.status, result.response.data);
                else
                    fail('APP_API_RESULT_UNVERIFIED', 502);
            }
        }
        catch (error) {
            if (!(error instanceof CapabilityProtocolError))
                throw error;
            // Consumer responses may deliberately hide an unverified result. Keep the
            // producer's protocol code observable without logging requests or values.
            const field = diagnosticField(error.field) ?? (error.code === 'APP_API_RESULT_UNVERIFIED' && outcome
                ? resultDiagnostic(outcome.result, outcome.operation) : undefined);
            log({ code: 'PROVIDER_REQUEST_REJECTED', stage: error.code, field });
            const status = /SIGNATURE|REPLAY/.test(error.code) ? 401 : /UNAVAILABLE/.test(error.code) ? 503
                : /EXPIRED|INSTALLATION|CONTEXT_UNAVAILABLE/.test(error.code) ? 403 : /CONFLICT|SPEC_CHANGED|MISMATCH/.test(error.code) ? 409 : 400;
            json(res, status, { code: error.code, message: error.message, details: error.details, requestId: randomUUID() });
        }
        return true;
    }
    return {
        handle(req, res) {
            const promise = handle(req, res).catch(error => {
                log({ code: 'PROVIDER_REQUEST_REJECTED', stage: error instanceof CoLinkError ? error.code : 'PROVIDER_CALLBACK_FAILED' });
                throw error;
            });
            pending.add(promise);
            return promise.finally(() => pending.delete(promise));
        },
        async close() { for (const controller of controllers)
            controller.abort(); await Promise.allSettled([...pending]); },
    };
}
