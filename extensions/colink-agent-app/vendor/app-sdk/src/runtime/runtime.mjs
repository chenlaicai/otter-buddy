import { createBackgroundGrants } from "../auth/background-grants.mjs";
import { resolveAppConfig, resolvePageOptions, invalidRuntimeConfig } from "../shared/config.mjs";
import { openEncryptedStore } from "../shared/store.mjs";
import { resolveLogger } from "../shared/logging.mjs";
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createInstallationOAuth } from "../auth/installation-oauth.mjs";
import { createUserOAuth } from "../auth/user-oauth.mjs";
import { createPlatform, fail } from "../clients/platform.mjs";
import { CoLinkError, errorBody } from "../shared/errors.mjs";
import { createTurnActions } from "../events/turn.mjs";
import { createPageSessions } from "../pages/page-sessions.mjs";
import { createOutput } from "../events/output.mjs";
import { validateCapabilityPolicy } from "../clients/business-client.mjs";
import { createClientExecutions } from "../clients/client-execution.mjs";
import { createBusinessClient } from "../clients/business-client.mjs";
import { createWriteJournal } from "../clients/write-journal.mjs";
import { publicToolResult, agentToolOptions } from "../agent/tool-results.mjs";
import { assertEventHandler, STOP_EVENTS, userMessageEvent, validateCoLinkUiAction, validateCollaborationMessage, validateTaskEvent, stopKey, sameStopSource, validateUserMessage } from "../events/event-handler.mjs";
import { createInteractionStatus } from "../events/interaction-status.mjs";
import { createSteering } from "../events/steering.mjs";
import { eventQueueOptions, eventTerminal, selectEvent } from "../events/event-queue.mjs";
import { localMcpOptions, createLocalMcpServer } from "../agent/local-mcp.mjs";
import { createProvider } from "../provider/provider.mjs";
import { runtimeHttp, runtimeServerDefaults } from "../shared/http-paths.mjs";
import { completeManifest } from "../shared/complete-manifest.mjs";
import { MANIFEST_PROTOCOL_DEFAULTS } from "../shared/manifest-protocol.mjs";
import { isRecord, record, errorCode } from "../shared/data.mjs";
import { runtimeState, runtimeEvent, publicEvent } from "../shared/state.mjs";
import { validateApiDeclaration } from "../provider/protocol/api-declaration.mjs";
const runtimeInternals = new WeakMap();
export const inspectRuntime = (runtime) => runtimeInternals.get(runtime);
function manifestValue(value) {
    if (!isRecord(value))
        throw new Error('Agent manifest is required');
    const result = { ...value };
    if (value.ui !== undefined) {
        if (!isRecord(value.ui) || value.ui.views !== undefined && !Array.isArray(value.ui.views))
            throw new Error('Invalid Manifest views');
        const views = { ...value.ui };
        if (Array.isArray(value.ui.views))
            views.views = value.ui.views.map(v => {
                if (!isRecord(v) || ['viewId', 'renderer', 'entryPath'].some(key => v[key] !== undefined && typeof v[key] !== 'string'))
                    throw new Error('Invalid Manifest view');
                return { ...v, ...(typeof v.viewId === 'string' ? { viewId: v.viewId } : {}), ...(typeof v.renderer === 'string' ? { renderer: v.renderer } : {}), ...(typeof v.entryPath === 'string' ? { entryPath: v.entryPath } : {}) };
            });
        result.ui = views;
    }
    if (value.permissions !== undefined) {
        if (!Array.isArray(value.permissions) || !value.permissions.every((v) => typeof v === 'string'))
            throw new Error('Invalid Manifest permissions');
        result.permissions = value.permissions;
    }
    if (value.api !== undefined)
        result.api = validateApiDeclaration(value.api);
    return result;
}
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal = new Set(['done', 'failed', 'interrupted', 'cancelled']);
const loopback = (address) => address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1';
import { splitText } from "../shared/message-chunks.mjs";
function executionConfig(config) {
    const invalid = invalidRuntimeConfig;
    const eventQueue = eventQueueOptions(config.eventQueue);
    if (config.interactionStatus !== undefined && typeof config.interactionStatus !== 'boolean')
        throw invalid('interactionStatus', '使用 boolean，省略时默认 true。');
    if (config.sessionScope !== undefined && !['user', 'topic'].includes(config.sessionScope))
        throw invalid('sessionScope', '使用 user 或 topic。');
    const turnTimeoutMs = config.turnTimeoutMs === undefined ? 1800000 : config.turnTimeoutMs;
    if (!Number.isInteger(turnTimeoutMs) || turnTimeoutMs < 1 || turnTimeoutMs > 1800000)
        throw invalid('turnTimeoutMs', 'turnTimeoutMs 使用 1–1800000 范围内的整数毫秒。');
    const idempotencyPrefix = config.idempotencyPrefix === undefined ? 'colink-agent' : config.idempotencyPrefix;
    if (typeof idempotencyPrefix !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(idempotencyPrefix))
        throw invalid('idempotencyPrefix', '使用 1–40 位字母、数字、下划线或连字符，跨升级保持稳定。');
    const output = config.progressOutput;
    if (output !== undefined) {
        if (!output || typeof output !== 'object' || Array.isArray(output) || Object.keys(output).some(k => !['failureText', 'interruptedText'].includes(k)))
            throw invalid('progressOutput', '使用包含 failureText 和 interruptedText 的对象。');
        for (const key of ['failureText', 'interruptedText'])
            if (typeof output[key] !== 'string' || !output[key].trim() || output[key].length > 4000)
                throw invalid('progressOutput.' + key, '使用不超过 4000 字符的非空安全提示文本。');
    }
    let capabilities;
    try {
        capabilities = validateCapabilityPolicy(config.capabilities);
    }
    catch (error) {
        if (errorCode(error) !== 'INVALID_CAPABILITY_POLICY')
            throw error;
        throw invalid('capabilities', '按 CapabilityPolicy 配置读写、工具和资源范围。');
    }
    return { ...config, eventQueue, turnTimeoutMs, idempotencyPrefix, capabilities,
        ...(output === undefined ? {} : { progressOutput: { ...output } }) };
}
/** Resolve deployment defaults before allocating a store; release owned resources on failed construction. */
export function createRuntime(options) {
    const tools = agentToolOptions(options);
    const log = resolveLogger(options.log, options.now);
    const config = executionConfig(resolveAppConfig(options.config));
    const manifest = manifestValue(completeManifest(options.manifest, MANIFEST_PROTOCOL_DEFAULTS));
    const pages = resolvePageOptions(options.pages, manifest, config);
    let store = options.store;
    const ownsStore = store === undefined;
    if (ownsStore) {
        if (typeof config.stateFile !== 'string' || !config.stateFile.trim())
            throw invalidRuntimeConfig('stateFile', '状态文件路径必须为非空字符串；省略时默认 ./.colink/state.enc，环境变量 COLINK_STATE_FILE 可覆盖。');
        if (config.credentialKey !== undefined && (typeof config.credentialKey !== 'string' || !/^[a-f0-9]{64}$/i.test(config.credentialKey)))
            throw invalidRuntimeConfig('credentialKey', '显式存储密钥须为 64 位十六进制；省略时 SDK 生成并复用状态文件旁的 .key 文件。');
        store = openEncryptedStore(config.stateFile, config.credentialKey, { decode: runtimeState });
    }
    try {
        return createResolvedRuntime({ ...options, manifest, config, store: store, pages, log, tools });
    }
    catch (error) {
        if (ownsStore)
            store.close();
        throw error;
    }
}
/** Event-only Agent; public ingress and loopback MCP use separate HTTP listeners. */
function createResolvedRuntime({ config: initialConfig, store, agent, manifest, mcp: inputMcp, tools: toolOptions, pages: pageOptions, provider: providerOptions, fetcher = fetch, now = Date.now, log }) {
    if (!manifest || typeof manifest !== 'object')
        throw Error('Agent manifest is required');
    const outputPolicy = initialConfig.progressOutput;
    const queue = initialConfig.eventQueue;
    for (const method of agent ? ['ensureSession', 'runTurn', 'cancelTurn', 'cleanupInterruptedSession', 'releaseSession', 'close'] : [])
        if (typeof agent?.[method] !== 'function')
            throw Error('Missing agent adapter method: ' + method);
    if (agent?.steerTurn !== undefined && typeof agent.steerTurn !== 'function')
        throw Error('Invalid agent steer adapter');
    const publicManifest = structuredClone(manifest);
    const turnTimeoutMs = initialConfig.turnTimeoutMs;
    const mcp = localMcpOptions(inputMcp, initialConfig.toolsOrigin);
    const installations = createInstallationOAuth({ config: initialConfig, store, fetch: fetcher, now });
    const config = { ...initialConfig, installationOAuth: installations };
    const users = createUserOAuth({ config, store, fetch: fetcher, now });
    store.data.eventStops ||= {};
    function cancellation(row) {
        const key = stopKey(row.event);
        const stop = key ? store.data.eventStops[key] : undefined;
        if (stop && sameStopSource(stop.event, row.event))
            return true;
        return (row.steerEventIds || []).map(id => store.data.events[id]).some(child => !!child && cancellation(child));
    }
    function assertNotCancelled(row) { if (!STOP_EVENTS.has(row.event.type) && cancellation(row))
        throw fail('EVENT_CANCELLED', 409); }
    const platform = createPlatform({ config, store, installations, users, fetcher, now, saveRow, assertNotCancelled });
    const interactions = createInteractionStatus({ rows: () => store.data.events, save: saveRow,
        send: platform.reportInteraction, now, log });
    const background = createBackgroundGrants({ config, store, installations, fetcher, now });
    const pages = pageOptions ? createPageSessions({ config, store, options: pageOptions, background, fetcher, now }) : undefined;
    store.data.controls ||= {};
    const active = new Map(), grants = new Map(), controllers = new Map();
    const handoffControllers = new WeakSet();
    const eventHandlers = new Map();
    const steering = createSteering({ agent, rows: () => store.data.events, active, controllers, keyFor: sessionKey,
        contextFor: row => turnContext(row), platform, save: saveRow, kick });
    // Identity, not an error code/status, distinguishes shutdown from business
    // rejection and execution timeout. Only durable handoffs may be replayed.
    const handoffStopped = fail('TURN_INTERRUPTED', 409);
    let stopped = false, localReady = !mcp?.managed, controlWorker, timer, lastInstallation, accepting = Promise.resolve();
    if (providerOptions && !publicManifest.api)
        throw new Error('Provider Manifest API is required');
    const provider = providerOptions ? createProvider({ options: providerOptions, manifest: { ...publicManifest, api: publicManifest.api }, config, store, installations, users,
        appClient, fetcher, now, log, stopped: () => stopped, pagePath: pageOptions ? pageOptions.path ?? '/colink/page' : undefined }) : null;
    const jobs = new Map(), notices = new Map();
    const persist = () => store.persist();
    const executions = createClientExecutions({ installation: appClient, stopped: () => stopped,
        request: req => { if (!pages)
            throw fail('PAGE_LOGIN_REQUIRED', 403); return pages.client(req); },
        grant: id => background.client(id) });
    const appClients = new Map();
    const projectResult = (row, name, result) => publicToolResult({ name, result, transform: toolOptions?.transformResult, secrets: [config.clientSecret, config.signingSecret],
        context: { kind: 'event', installationId: row.event.installationId, userId: row.event.actor.id, eventId: row.event.eventId } });
    function appClient(installationId) {
        const installation = store.data.oauthInstallations[installationId];
        if (stopped || installation?.status !== 'ready')
            throw fail('INSTALLATION_NOT_READY', 403);
        const version = installation.authorizationVersion, key = installationId + ':' + version;
        if (!appClients.has(key)) {
            store.data.appClients ||= {};
            const row = store.data.appClients[key] ||= {};
            const active = () => {
                const current = store.data.oauthInstallations[installationId];
                if (stopped || current?.status !== 'ready' || current.authorizationVersion !== version)
                    throw fail('INSTALLATION_AUTHORIZATION_CHANGED', 403);
            };
            appClients.set(key, createBusinessClient({ config, fetcher, policy: config.capabilities,
                journal: createWriteJournal({ row, now, save: patch => saveRow(row, patch) }),
                context: { key, active, validate: async () => active(), identities: () => ({ app: (store.data.oauthInstallations[installationId].scope || '').split(' ') }),
                    token: async () => { const token = await installations.getAccessToken(installationId); active(); return token; } } }));
        }
        return appClients.get(key);
    }
    function prune() {
        const cutoff = now() - 7 * 86400000;
        for (const [eventId, row] of Object.entries(store.data.events)) {
            if (terminal.has(row.status) && (row.updatedAt ?? 0) < cutoff) {
                delete store.data.events[eventId];
                if (row.executionId)
                    delete store.data.oauthUserExecutions[row.executionId];
            }
        }
        for (const [eventId, row] of Object.entries(store.data.controls))
            if (row.done && row.updatedAt !== undefined && row.updatedAt < cutoff)
                delete store.data.controls[eventId];
        for (const [key, row] of Object.entries(store.data.eventStops))
            if (row.createdAt < cutoff)
                delete store.data.eventStops[key];
        for (const [key, row] of Object.entries(store.data.sessions))
            if (row.updatedAt < cutoff)
                delete store.data.sessions[key];
    }
    function saveRow(row, patch) {
        const previous = { ...row }, changes = { ...patch }, current = record(row);
        if (typeof changes.status === 'string' && eventTerminal({ status: changes.status }) && current.finishedAt === undefined)
            changes.finishedAt ??= now();
        Object.assign(row, changes, { updatedAt: now() });
        try {
            persist();
        }
        catch (error) {
            for (const key of Object.keys(row))
                Reflect.deleteProperty(row, key);
            Object.assign(row, previous);
            throw error;
        }
        if (changes.status || changes.done !== undefined || changes.firstOutputAt !== undefined) {
            const event = record(current.event), data = record(event.data);
            log({ code: 'EVENT_STAGE', stage: changes.firstOutputAt !== undefined ? 'output_confirmed' : current.done !== undefined ? 'installation_control' : typeof current.status === 'string' ? current.status : undefined,
                status: typeof current.status === 'string' ? current.status : undefined, installationId: typeof event.installationId === 'string' ? event.installationId : undefined,
                eventId: typeof event.eventId === 'string' ? event.eventId : undefined, messageId: typeof data.messageId === 'string' ? data.messageId : typeof record(data.source).messageId === 'string' ? String(record(data.source).messageId) : undefined });
        }
    }
    async function controls() {
        for (const row of Object.values(store.data.controls)) {
            if (stopped || row.done || row.nextAttempt !== undefined && row.nextAttempt > now())
                continue;
            try {
                await installations.handleAuthorization(row.event);
                saveRow(row, { done: true });
            }
            catch (error) {
                saveRow(row, { nextAttempt: now() + 3000, error: errorCode(error) || 'INSTALLATION_FAILED',
                    done: store.data.oauthInstallations[row.event.installationId]?.status === 'reconnect_required' });
            }
        }
    }
    function sessionKey(row) {
        if (config.sessionScope === 'topic')
            return hash(['topic', row.event.deploymentId, row.event.installationId, row.version,
                row.event.data.channelId, row.event.data.topicId]);
        return hash([row.event.deploymentId, row.event.installationId, row.version, row.event.actor.id,
            row.event.data.channelId, row.event.data.topicId, row.event.data.conversationId, row.scopes]);
    }
    const turnContext = (row) => Object.freeze({ installationId: row.event.installationId, userId: row.event.actor.id,
        channelId: row.event.data.channelId ?? null, topicId: row.event.data.topicId ?? null,
        conversationId: row.event.data.conversationId ?? null, authorizationVersion: row.version });
    const outputFor = (row) => createOutput({ row, save: patch => saveRow(row, patch), now,
        send: (text, sequence, check) => platform.send(row, text, sequence, check) });
    // App handlers retain durable at-least-once handoff until staged output exists.
    // Agent/model turns and started progress streams must not replay unknown work.
    const replayableHandler = (row) => !agent && row.event.type === 'app.user_message_received' && !row.outputs?.length;
    async function run(row) {
        assertNotCancelled(row);
        const eventDeadline = row.event.type === 'app.collaboration_message_received' ? Date.parse(row.event.data.expiresAt) : Infinity;
        if (eventDeadline <= now())
            throw fail('EVENT_EXPIRED', 409);
        if (row.startedAt === undefined && now() - row.createdAt >= queue.waitTimeoutMs)
            throw fail('EVENT_QUEUE_EXPIRED', 409);
        if (stopped)
            throw handoffStopped;
        if (row.startedAt === undefined) {
            const startedAt = now();
            saveRow(row, { startedAt });
            log({ eventId: row.event.eventId, code: 'EVENT_DISPATCHED', queueWaitMs: startedAt - row.createdAt, activeCount: jobs.size });
        }
        if (now() - row.createdAt > 7200000)
            throw fail('EVENT_EXPIRED', 409);
        if (store.data.oauthInstallations[row.event.installationId]?.authorizationVersion !== row.version)
            throw fail('INSTALLATION_AUTHORIZATION_CHANGED', 403);
        if (row.status !== 'completion_pending')
            await platform.validate(row);
        if (row.dispatch === 'stop') {
            const handler = eventHandlers.get(row.event.type);
            if (!handler) {
                saveRow(row, { status: 'done' });
                return;
            }
        }
        if ((row.dispatch === 'handler' || row.dispatch === 'stop') && row.status !== 'completion_pending') {
            const handler = eventHandlers.get(row.event.type);
            if (!handler)
                throw fail('HANDLER_NOT_REGISTERED', 503);
            saveRow(row, { status: 'queued' });
            const version = row.version;
            const controller = new AbortController();
            controllers.set(row.event.eventId, controller);
            handoffControllers.add(controller);
            let accepting = true;
            const interruptionError = () => controller.signal.reason === handoffStopped ? handoffStopped : fail('TURN_INTERRUPTED', 409);
            const guard = () => {
                assertNotCancelled(row);
                if (!accepting)
                    throw fail('TURN_INTERRUPTED', 409);
                if (controller.signal.aborted)
                    throw interruptionError();
                if (stopped)
                    throw handoffStopped;
            };
            guard.bound = true;
            guard.signal = controller.signal;
            const interrupted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(interruptionError()), { once: true }));
            const timeout = setTimeout(() => controller.abort(), Math.min(turnTimeoutMs, Math.max(1, eventDeadline - now())));
            try {
                const result = await Promise.race([interrupted, Promise.resolve().then(() => {
                        guard();
                        const event = publicEvent(row.event);
                        if (event.type === 'app.user_message_received')
                            throw fail('INVALID_EVENT', 400);
                        const ctx = { event, context: Object.freeze({ installationId: row.event.installationId, authorizationVersion: version }), colink: platform.client(row, guard), signal: controller.signal };
                        return Reflect.apply(handler, undefined, [ctx]);
                    })]);
                guard();
                if (result !== undefined)
                    throw fail('INVALID_EVENT_RESULT', 400);
            }
            finally {
                accepting = false;
                clearTimeout(timeout);
                controllers.delete(row.event.eventId);
            }
            // Returning means a durable handoff or idempotent operation, not a public
            // reply. At-least-once replay after crashes is explicit for these handlers.
            await platform.validate(row);
            saveRow(row, { status: 'completion_pending', error: undefined });
        }
        if (row.status === 'queued') {
            if (row.event.type !== 'app.user_message_received')
                throw fail('INVALID_EVENT', 400);
            if (!agent && !eventHandlers.has('app.user_message_received'))
                throw fail('HANDLER_NOT_REGISTERED', 503);
            const key = agent ? sessionKey(row) : row.event.eventId;
            const binding = agent && store.data.sessions[key];
            const session = agent ? await agent.ensureSession({ key, sessionId: binding?.sessionId || '', context: turnContext(row), eventId: row.event.eventId })
                : { sessionId: key };
            if (!id(session?.sessionId))
                throw fail('INVALID_AGENT_SESSION');
            if (active.has(session.sessionId))
                throw fail('AGENT_SESSION_BUSY', 503);
            if (stopped)
                throw handoffStopped;
            if (agent)
                store.data.sessions[key] = { sessionId: session.sessionId, updatedAt: now() };
            saveRow(row, { sessionKey: key, sessionId: session.sessionId, status: 'running',
                ...(outputPolicy ? { outputPolicy: structuredClone(outputPolicy), outputs: [] } : {}) });
            if (config.interactionStatus !== false)
                interactions.begin(row);
            const policy = row.outputPolicy;
            const output = policy && outputFor(row);
            active.set(session.sessionId, row);
            const controller = new AbortController();
            controllers.set(key, controller);
            if (!agent)
                handoffControllers.add(controller);
            let timeout;
            const interruption = new Promise((_, reject) => {
                controller.signal.addEventListener('abort', () => {
                    void Promise.resolve().then(() => agent?.cancelTurn(key)).catch(() => { });
                    reject(controller.signal.reason === handoffStopped ? handoffStopped : fail('TURN_INTERRUPTED', agent ? 503 : 409));
                }, { once: true });
                timeout = setTimeout(() => controller.abort(), turnTimeoutMs);
            });
            let acceptingOutput = true;
            const requireActive = () => {
                assertNotCancelled(row);
                if (!acceptingOutput || controller.signal.aborted || active.get(session.sessionId) !== row)
                    throw fail('TURN_INACTIVE', 403);
            };
            requireActive.bound = true;
            requireActive.signal = controller.signal;
            const business = platform.client(row, requireActive);
            const tools = agent ? Object.freeze({
                async list() { requireActive(); const result = await platform.list(row); requireActive(); return result; },
                async call(name, args) {
                    requireActive();
                    // Caller-owned arguments may be mutated while authorization is awaited.
                    const result = await platform.call(row, { name, arguments: structuredClone(args) });
                    const projected = await projectResult(row, name, result);
                    requireActive();
                    return projected;
                },
            }) : undefined;
            const replies = [];
            let replyLength = 0;
            const turnActions = createTurnActions({ row, platform, requireActive,
                progress: output ? input => output.progress(input, requireActive) : undefined, stageReply(text) {
                    if (replyLength + text.length > 64000)
                        throw fail('REPLY_TOO_LARGE', 400);
                    replyLength += text.length;
                    replies.push(text);
                } });
            const event = userMessageEvent(row.event);
            try {
                // Explicit projection: authorization envelopes and control-store records never reach adapters.
                const result = await Promise.race([interruption, Promise.resolve().then(async () => {
                        const connection = mcp?.managed ? await grantConnection(session.sessionId, row) : undefined;
                        requireActive();
                        const ctx = { event, colink: business, ...turnActions, setDisplayStatus: interactions.api(row, requireActive, config.interactionStatus !== false).setDisplayStatus,
                            context: turnContext(row), async assertActive() { requireActive(); await platform.validate(row); requireActive(); }, signal: controller.signal };
                        if (agent) {
                            if (!tools)
                                throw new Error('Agent tools unavailable');
                            return agent.runTurn({ ...ctx, key, sessionId: session.sessionId, tools, ...(connection ? { mcpConnection: connection.connection } : {}) });
                        }
                        const handler = eventHandlers.get('app.user_message_received');
                        if (!handler)
                            throw fail('HANDLER_NOT_REGISTERED', 503);
                        return Reflect.apply(handler, undefined, [ctx]);
                    })]);
                // A late steer must settle before persisting/publishing the final reply.
                // An uncertain receipt aborts the turn even if run() just returned.
                await steering.drain(row);
                if (controller.signal.aborted)
                    throw controller.signal.reason === handoffStopped ? handoffStopped : fail('TURN_INTERRUPTED', agent ? 503 : 409);
                if (!agent && result !== undefined)
                    throw fail('INVALID_EVENT_RESULT', 400);
                if (agent && replies.length && result !== undefined)
                    throw fail('MIXED_REPLY_MODES', 400);
                if (agent && !replies.length && !(result === undefined && row.delivered?.length)) {
                    if (typeof result !== 'string' || !result.trim() || result.length > 64000)
                        throw fail('INVALID_AGENT_RESULT');
                    replies.push(result.trim());
                }
                // Explicit HTTP/MCP sends and handler-returned final text share one
                // delivery record. Do not publish an identical confirmed final twice.
                const final = replies.filter(text => !row.delivered?.some(sent => sent.text === text.trim()));
                if (output) {
                    acceptingOutput = false;
                    await output.idle();
                    output.finish(final.flatMap(splitText));
                }
                else
                    saveRow(row, { status: 'reply_pending', reply: final.flatMap(splitText), sent: 0, replyStartedAt: now() });
            }
            catch (error) {
                assertNotCancelled(row);
                acceptingOutput = false;
                if (output)
                    await output.idle();
                if (replayableHandler(row) && (error === handoffStopped ||
                    ((!record(error).status || Number(record(error).status) >= 500 || record(error).status === 429) && now() - row.createdAt < 3600000))) {
                    saveRow(row, { status: 'queued' });
                    throw error;
                }
                if (!output || !policy)
                    throw error;
                const interrupted = controller.signal.aborted || errorCode(error) === 'TURN_INTERRUPTED';
                output.finish([interrupted ? policy.interruptedText : policy.failureText], interrupted ? 'interrupted' : 'failed', /^[A-Z0-9_]+$/.test(errorCode(error) || '') ? errorCode(error) : 'AGENT_FAILED');
            }
            finally {
                await steering.drain(row);
                acceptingOutput = false;
                clearTimeout(timeout);
                controllers.delete(key);
                active.delete(session.sessionId);
                steering.release(row);
                // A mounted proxy token is valid only during its matching running event.
                for (const [token, grant] of grants)
                    if (grant.eventId === row.event.eventId)
                        grants.delete(token);
                await agent?.releaseSession(key);
            }
        }
        if (row.status === 'reply_pending') {
            interactions.monitor(row);
            if (row.outputPolicy)
                await outputFor(row).flush();
            else {
                // Do not replay an unknown external write indefinitely after a long outage.
                if (!row.reply || row.sent === undefined || row.replyStartedAt === undefined)
                    throw fail('INVALID_AGENT_RESULT', 502);
                if (now() - row.replyStartedAt > 3600000)
                    throw fail('REPLY_RECOVERY_EXPIRED', 409);
                while (row.sent < row.reply.length) {
                    await platform.send(row, row.reply[row.sent], row.sent);
                    saveRow(row, { sent: row.sent + 1 });
                }
            }
            saveRow(row, { status: 'completion_pending' });
        }
        if (row.status === 'completion_pending') {
            await interactions.finish(row);
            await platform.complete(row);
            if (row.outcome && row.outcome !== 'done' && row.sessionKey)
                delete store.data.sessions[row.sessionKey];
            saveRow(row, { status: row.outcome || 'done', finishedAt: now() });
        }
    }
    async function work(row) {
        try {
            assertNotCancelled(row);
            if (await steering.settle(row))
                return;
            if (row.status === 'running' && replayableHandler(row))
                saveRow(row, { status: 'queued' });
            if (row.status === 'running') {
                if (!row.sessionId || !row.sessionKey)
                    throw fail('INVALID_AGENT_SESSION', 502);
                await interactions.finish(row);
                await agent?.cleanupInterruptedSession(row.sessionId);
                delete store.data.sessions[row.sessionKey];
                if (row.outputPolicy) {
                    outputFor(row).finish([row.outputPolicy.interruptedText], 'interrupted', 'PROCESS_INTERRUPTED');
                    await run(row);
                    return;
                }
                saveRow(row, { status: 'interrupted', error: 'PROCESS_INTERRUPTED', finishedAt: now() });
                log({ eventId: row.event.eventId, code: 'PROCESS_INTERRUPTED' });
                return;
            }
            await run(row);
        }
        catch (error) {
            if (cancellation(row) && !STOP_EVENTS.has(row.event.type)) {
                interactions.cancel(row);
                if (row.sessionKey)
                    delete store.data.sessions[row.sessionKey];
                saveRow(row, { status: 'cancelled', error: 'EVENT_CANCELLED' });
                return;
            }
            if (((row.dispatch === 'handler' || row.dispatch === 'stop') || replayableHandler(row)) && row.status === 'queued' && error === handoffStopped) {
                // The inbox was ACKed, but the App may not have committed yet. Keep
                // the durable receipt pending; restart revalidates authorization and
                // the App's idempotency receipt resolves an uncertain business commit.
                saveRow(row, { nextAttempt: now(), error: undefined });
                return;
            }
            const retry = ['reply_pending', 'completion_pending', 'queued'].includes(row.status) &&
                (!record(error).status || Number(record(error).status) >= 500 || record(error).status === 429) && now() - row.createdAt < 3600000;
            if (!retry && row.sessionKey)
                delete store.data.sessions[row.sessionKey];
            if (!retry)
                await interactions.finish(row);
            saveRow(row, { status: retry ? row.status : 'failed', nextAttempt: now() + 3000,
                error: /^[A-Z0-9_]+$/.test(errorCode(error) || '') ? errorCode(error) : 'AGENT_FAILED', ...(!retry ? { finishedAt: now() } : {}) });
            log({ eventId: row.event.eventId, code: row.error });
        }
    }
    function notifyQueued(row) {
        if (notices.size >= queue.concurrency || !queue.queuedText || row.dispatch || row.status !== 'queued' || row.startedAt !== undefined || row.queueNotice?.sent ||
            (row.queueNotice?.nextAttempt !== undefined && row.queueNotice.nextAttempt > now()) || notices.has(row))
            return;
        const queuedText = queue.queuedText;
        if (typeof queuedText !== 'string')
            return;
        const task = (async () => {
            try {
                if (!row.queueNotice)
                    saveRow(row, { queueNotice: { text: queuedText, createdAt: now(), sent: false } });
                const notice = row.queueNotice;
                if (!notice)
                    throw new Error('Queue notice was not persisted');
                if (now() - notice.createdAt >= 3600000)
                    return;
                await platform.send(row, notice.text, 'queued', () => {
                    if (row.startedAt !== undefined || row.status !== 'queued' || stopped)
                        throw fail('QUEUE_NOTICE_OBSOLETE', 409);
                });
                saveRow(row, { queueNotice: { ...notice, sent: true }, firstOutputAt: row.firstOutputAt ?? now() });
            }
            catch (error) {
                if (row.queueNotice)
                    saveRow(row, { queueNotice: { ...row.queueNotice,
                            nextAttempt: !record(error).status || Number(record(error).status) >= 500 || record(error).status === 429 ? now() + 3000 : Number.MAX_SAFE_INTEGER } });
                log({ eventId: row.event.eventId, code: errorCode(error) || 'QUEUE_NOTICE_UNAVAILABLE' });
            }
        })().catch(() => log({ code: 'QUEUE_NOTICE_UNAVAILABLE' })).finally(() => notices.delete(row));
        notices.set(row, task);
    }
    function kick() {
        if (stopped)
            return;
        // Restored App handoffs are still executing; do not publish a premature
        // finished status before their durable callback can resume.
        if (config.interactionStatus !== false)
            for (const row of Object.values(store.data.events))
                if (replayableHandler(row) && ['queued', 'running'].includes(row.status))
                    interactions.monitor(row);
        void interactions.pulse();
        if (!controlWorker)
            controlWorker = controls().catch(() => log({ code: 'CONTROL_STORE_UNAVAILABLE' })).finally(() => { controlWorker = null; });
        if (!localReady)
            return; // Durable acceptance may race public listen; do not run before private listen succeeds.
        for (;;) {
            const row = selectEvent(Object.values(store.data.events), jobs, queue, lastInstallation, now());
            if (!row)
                break;
            lastInstallation = row.event.installationId;
            const job = { row };
            jobs.set(row.event.eventId, job);
            job.promise = Promise.resolve().then(() => work(row)).catch(() => {
                stopped = true;
                for (const controller of controllers.values())
                    controller.abort();
                log({ code: 'EVENT_STORE_UNAVAILABLE' });
            })
                .finally(() => { jobs.delete(row.event.eventId); if (!stopped)
                kick(); });
        }
        for (const row of Object.values(store.data.events))
            if (!jobs.has(row.event.eventId))
                notifyQueued(row);
    }
    async function acceptOne(raw, headers) {
        if (stopped)
            throw fail('AGENT_STOPPING', 503);
        if (raw.length > 60 * 1024)
            throw fail('BODY_TOO_LARGE', 413);
        const envelope = installations.verifyEvent(headers, raw);
        prune();
        if (envelope.type === 'installation.authorized') {
            if (typeof envelope.installationId !== 'string' || !UUID.test(envelope.installationId) || typeof envelope.eventId !== 'string' || typeof envelope.authorizationVersion !== 'number' || !Number.isSafeInteger(envelope.authorizationVersion) || envelope.authorizationVersion < 1)
                throw fail('INVALID_EVENT', 400);
            const existing = store.data.controls[envelope.eventId];
            if (existing && hash(existing.event) !== hash(envelope))
                throw fail('EVENT_CONFLICT', 409);
            if (!existing) {
                if (Object.keys(store.data.controls).length >= 2000)
                    throw fail('CONTROL_CAPACITY', 503);
                store.data.controls[envelope.eventId] = { event: { ...envelope, type: 'installation.authorized', eventId: envelope.eventId, installationId: envelope.installationId, authorizationVersion: envelope.authorizationVersion }, done: false, createdAt: now() };
                try {
                    persist();
                }
                catch (error) {
                    delete store.data.controls[envelope.eventId];
                    throw error;
                }
            }
            kick();
            return;
        }
        const event = runtimeEvent(envelope);
        const handler = eventHandlers.has(event.type);
        if (event.type === 'app.colink_ui_action_invoked')
            validateCoLinkUiAction(event, config, store);
        else if (event.type === 'app.collaboration_message_received')
            validateCollaborationMessage(event, config, store);
        else if (event.type === 'app.user_message_received')
            validateUserMessage(event, config, store);
        else
            validateTaskEvent(event, config, store);
        const isStop = STOP_EVENTS.has(event.type), cancellationKey = stopKey(event);
        if (!handler && !isStop && (event.type !== 'app.user_message_received' || !agent))
            throw fail('HANDLER_NOT_REGISTERED', 503);
        if (Date.parse(event.timestamp) < now() - 7 * 86400000)
            throw fail('EVENT_EXPIRED', 400);
        const safe = structuredClone(event);
        delete safe.userAuthorization;
        const fingerprint = hash(safe), existing = store.data.events[event.eventId];
        if (existing) {
            if (existing.fingerprint !== fingerprint)
                throw fail('EVENT_CONFLICT', 409);
            return; // A redelivery must never overwrite rotated user credentials.
        }
        if (Object.keys(store.data.events).length >= 2000)
            throw fail('EVENT_CAPACITY', 503);
        if (isStop && Object.values(store.data.events).some(row => !STOP_EVENTS.has(row.event.type) &&
            stopKey(row.event) === cancellationKey && !sameStopSource(event, row.event)))
            throw fail('INVALID_EVENT', 400);
        if (isStop && !cancellationKey)
            throw fail('INVALID_EVENT', 400);
        const previousStop = cancellationKey ? store.data.eventStops[cancellationKey] : undefined;
        if (!isStop && previousStop && !sameStopSource(previousStop.event, event))
            throw fail('INVALID_EVENT', 400);
        if (isStop && !previousStop && Object.keys(store.data.eventStops).length >= 2000)
            throw fail('EVENT_CAPACITY', 503);
        const cancelled = !isStop && previousStop;
        if (!isStop && !cancelled) {
            const pending = Object.values(store.data.events).filter(row => !eventTerminal(row));
            if (pending.length >= queue.maxPending || pending.filter(row => row.event.installationId === event.installationId).length >= queue.maxPendingPerInstallation)
                throw fail('EVENT_QUEUE_CAPACITY', 503);
        }
        const executionId = isStop || cancelled ? null : await users.acceptEvent(event);
        const scopes = executionId ? [...(store.data.oauthUserExecutions[executionId].scopes || [])].sort() : [];
        store.data.events[event.eventId] = { event: safe, fingerprint, executionId, scopes,
            version: store.data.oauthInstallations[event.installationId].authorizationVersion,
            status: cancelled ? 'cancelled' : 'queued', ...(isStop ? { dispatch: 'stop' } : handler && event.type !== 'app.user_message_received' ? { dispatch: 'handler' } : {}), createdAt: now(), updatedAt: now() };
        if (isStop)
            store.data.eventStops[cancellationKey] = { event: safe, createdAt: previousStop?.createdAt ?? now() };
        try {
            persist();
        }
        catch (error) {
            delete store.data.events[event.eventId];
            if (isStop) {
                if (previousStop)
                    store.data.eventStops[cancellationKey] = previousStop;
                else
                    delete store.data.eventStops[cancellationKey];
            }
            throw error;
        }
        if (isStop)
            for (const row of Object.values(store.data.events)) {
                if (STOP_EVENTS.has(row.event.type) || !cancellation(row))
                    continue;
                controllers.get(row.sessionKey || row.event.eventId)?.abort(fail('EVENT_CANCELLED', 409));
                if (row.steerParentId) {
                    const parent = store.data.events[row.steerParentId];
                    (parent?.sessionKey ? controllers.get(parent.sessionKey) : undefined)?.abort(fail('EVENT_CANCELLED', 409));
                }
                try {
                    interactions.cancel(row);
                }
                catch {
                    log({ eventId: row.event.eventId, code: 'EVENT_STORE_UNAVAILABLE' });
                }
            }
        log({ code: 'EVENT_ACCEPTED', stage: 'queued', installationId: event.installationId, eventId: event.eventId, messageId: event.data?.messageId ?? event.data?.source?.messageId });
        steering.offer(store.data.events[event.eventId]);
        kick();
    }
    function accept(raw, headers) {
        const result = accepting.catch(() => { }).then(() => acceptOne(raw, headers));
        accepting = result;
        return result;
    }
    async function read(req) {
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))
            throw fail('CONTENT_TYPE_REQUIRED', 415);
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > 60 * 1024)
                throw fail('BODY_TOO_LARGE', 413);
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }
    const json = (res, status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const guarded = (fn) => async (req, res) => {
        try {
            await fn(req, res);
        }
        catch (error) {
            json(res, Number(record(error).status) || 503, errorBody(error));
        }
    };
    const handleRequest = guarded(async (req, res) => {
        if (provider && await provider.handle(req, res))
            return;
        if (pages && await pages.handle(req, res))
            return;
        const url = new URL(req.url || '/', 'http://localhost');
        if (req.method === 'GET' && url.pathname === '/healthz')
            return json(res, stopped ? 503 : 200, { status: stopped ? 'stopped' : 'ok' });
        if (req.method === 'GET' && url.pathname === '/manifest.json')
            return json(res, 200, publicManifest);
        if (req.method === 'GET' && url.pathname === '/.well-known/colink-app') {
            const challenge = url.searchParams.get('challenge');
            if ([...url.searchParams].length !== 1 || !/^[a-f0-9]{64}$/.test(challenge || ''))
                throw fail('INVALID_CHALLENGE', 400);
            const { appId, appInstanceId, signingSecret } = config;
            return json(res, 200, { appId, appInstanceId, signature: createHmac('sha256', signingSecret)
                    .update(['colink-app-verification-v1', appId, appInstanceId, challenge].join('\n')).digest('hex') });
        }
        if (req.method === 'POST' && req.url === '/events') {
            await accept(await read(req), req.headers);
            return json(res, 204);
        }
        throw fail('NOT_FOUND', 404);
    });
    function requireProxyActive(sessionId, row) {
        if (stopped || !row || active.get(sessionId) !== row || (row.sessionKey ? controllers.get(row.sessionKey) : undefined)?.signal.aborted)
            throw fail('NO_ACTIVE_EVENT', 403);
    }
    async function grantConnection(sessionId, row) {
        requireProxyActive(sessionId, row);
        const origin = localServer ? localServer.origin : config.toolsOrigin;
        const tools = await platform.managedList(row);
        requireProxyActive(sessionId, row);
        const token = randomBytes(32).toString('base64url');
        for (const [old, grant] of grants)
            if (grant.sessionId === sessionId)
                grants.delete(old);
        grants.set(token, { sessionId, eventId: row.event.eventId });
        return { connection: Object.freeze({ url: origin + '/mcp', headers: Object.freeze({ authorization: 'Bearer ' + token }) }),
            tools: tools.map(tool => tool.name) };
    }
    const localHandler = guarded(async (req, res) => {
        if (!mcp)
            throw fail('NOT_FOUND', 404);
        // Separate listener prevents public ingress from accidentally exposing local grants.
        if (!loopback(req.socket.remoteAddress) || req.headers.origin || req.headers['sec-fetch-site'])
            throw fail('LOCAL_ONLY', 403);
        if (req.method === 'GET' && req.url === '/healthz')
            return json(res, stopped ? 503 : 200, { status: stopped ? 'stopped' : 'ok' });
        if (req.method !== 'POST' || !['/handshake', '/mcp'].includes(req.url || ''))
            throw fail('NOT_FOUND', 404);
        let body;
        try {
            body = record(JSON.parse((await read(req)).toString('utf8')));
        }
        catch (error) {
            throw record(error).status ? error : fail('INVALID_JSON', 400);
        }
        if (req.url === '/handshake') {
            if (mcp.managed)
                throw fail('NOT_FOUND', 404);
            if (typeof body.sessionId !== 'string')
                throw fail('NO_ACTIVE_EVENT', 403);
            const row = active.get(body.sessionId);
            if (body.client !== mcp.clientName || !row || body.topicId !== row.event.data.topicId)
                throw fail('NO_ACTIVE_EVENT', 403);
            const { connection, tools } = await grantConnection(body.sessionId, row);
            return json(res, 200, { ...connection, tools });
        }
        const grant = grants.get((req.headers.authorization || '').replace(/^Bearer /, ''));
        const row = grant && active.get(grant.sessionId);
        if (!row || row.event.eventId !== grant.eventId || stopped || (row.sessionKey ? controllers.get(row.sessionKey) : undefined)?.signal.aborted)
            throw fail('PROXY_TOKEN_EXPIRED', 401);
        if (body.jsonrpc !== '2.0' || typeof body.method !== 'string')
            throw fail('INVALID_RPC', 400);
        if (body.method === 'notifications/initialized')
            return json(res, 202);
        let result;
        if (body.method === 'initialize')
            result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: mcp.serverName || 'colink-agent', version: '0.1.0' } };
        else if (body.method === 'ping')
            result = {};
        else if (body.method === 'tools/list')
            result = { tools: await platform.managedList(row) };
        else if (body.method === 'tools/call') {
            try {
                const params = record(body.params);
                if (typeof params.name !== 'string' || params.arguments !== undefined && !isRecord(params.arguments))
                    throw fail('INVALID_TOOL_CALL', 400);
                const input = { name: params.name, ...(isRecord(params.arguments) ? { arguments: params.arguments } : {}) };
                result = await projectResult(row, input.name, await platform.managedCall(row, input));
            }
            catch (error) {
                if (error instanceof CoLinkError && error.status === 401)
                    throw error;
                const diagnostic = errorBody(error, 'MCP_TOOL_FAILED');
                result = { isError: true, structuredContent: diagnostic, content: [{ type: 'text', text: JSON.stringify(diagnostic) }] };
            }
        }
        else
            return json(res, 200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
        if (active.get(grant.sessionId) !== row || stopped || (row.sessionKey ? controllers.get(row.sessionKey) : undefined)?.signal.aborted || ![...grants.values()].includes(grant))
            throw fail('PROXY_TOKEN_EXPIRED', 401);
        json(res, 200, { jsonrpc: '2.0', id: body.id, result });
    });
    const localServer = mcp?.managed ? createLocalMcpServer(localHandler, mcp.port) : null;
    let closing;
    const startPolling = () => { if (timer || stopped)
        return; kick(); timer = setInterval(kick, 1000); timer.unref(); };
    const runtime = {
        ...(mcp ? { mcp: Object.freeze({ handleRequest: localHandler }) } : {}),
        pages: pages && Object.freeze({ authenticate: pages.authenticate, completeInteraction: pages.completeInteraction }),
        userClient: executions.userClient, appClient: executions.appClient, backgroundGrants: Object.freeze({ findActive: background.findActive, list: background.list }),
        installations: Object.freeze({ get(installationId) {
                const row = store.data.oauthInstallations[installationId];
                return row ? Object.freeze({ installationId, status: row.status, authorizationVersion: row.authorizationVersion }) : null;
            } }),
        events: Object.freeze({ getStatus(eventId) {
                const row = store.data.events[eventId];
                return row ? Object.freeze({ status: row.status, ...(row.error ? { code: row.error } : {}),
                    queuedAt: row.createdAt, startedAt: row.startedAt ?? null, firstOutputAt: row.firstOutputAt ?? null, finishedAt: row.finishedAt ?? null,
                    queueWaitMs: Math.max(0, (row.startedAt ?? row.finishedAt ?? now()) - row.createdAt) }) : null;
            } }),
        onEvent(type, handler) {
            assertEventHandler(type, handler);
            if (stopped || eventHandlers.has(type) ||
                type === 'app.user_message_received' && agent)
                throw fail('HANDLER_REGISTRATION_INVALID', 409);
            eventHandlers.set(type, handler);
            return this;
        },
        start() { return localServer ? localServer.start().then(() => { localReady = true; startPolling(); }) : startPolling(); },
        close() {
            if (closing)
                return closing;
            const completion = Promise.withResolvers();
            closing = completion.promise; // Publish before abort callbacks can re-enter close().
            stopped = true;
            executions.close();
            clearInterval(timer);
            grants.clear();
            const listenerClosed = localServer?.close();
            const providerClosed = provider?.close();
            for (const controller of controllers.values())
                controller.abort(handoffControllers.has(controller) ? handoffStopped : undefined);
            void (async () => {
                try {
                    await Promise.allSettled([...active.values()].map(row => row.sessionKey ? agent?.cancelTurn(row.sessionKey) : undefined));
                    await agent?.close();
                    await Promise.allSettled([controlWorker, accepting, ...[...jobs.values()].map(job => job.promise), ...notices.values()]);
                    await interactions.idle();
                    await pages?.close();
                    await background.close();
                }
                finally {
                    try {
                        await Promise.all([listenerClosed, providerClosed]);
                    }
                    finally {
                        store.close();
                    }
                }
            })().then(completion.resolve, completion.reject);
            return closing;
        },
    };
    runtimeHttp.set(runtime, { handleRequest, closed: () => stopped, paths: Object.freeze([
            ...(pages ? [pages.path] : []), ...(provider && publicManifest.api ? [publicManifest.api.openapiPath, publicManifest.api.basePath] : []),
        ]) });
    runtimeInternals.set(runtime, { accept, store, platform, installations, users, dispatchPending: kick,
        async waitForIdle() { do {
            await Promise.all([controlWorker, ...[...jobs.values()].map(job => job.promise), ...notices.values()]);
        } while (jobs.size); await interactions.idle(); },
    });
    runtimeServerDefaults.set(runtime, Object.freeze({
        views: Object.freeze((publicManifest.ui?.views ?? []).map(({ viewId, renderer, entryPath }) => Object.freeze({ viewId, renderer, entryPath }))),
        host: config.bindHost === undefined ? '127.0.0.1' : config.bindHost,
        port: config.port === undefined ? 8080 : config.port,
        pageConfig: publicManifest.ui?.views?.some(view => view.renderer === 'app') ? Object.freeze({
            hostOrigin: config.hostOrigin === undefined ? config.issuer : config.hostOrigin, issuer: config.issuer,
            allowInsecureLocal: config.allowInsecureIssuer === true,
        }) : undefined,
    }));
    return runtime;
}
