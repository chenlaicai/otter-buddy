import { messageChunks } from "../shared/message-chunks.mjs";
import { createHash, randomUUID } from 'node:crypto';
import { hasScopes } from "../shared/scopes.mjs";
import { HTTP_ROUTES, MCP_POLICIES, MCP_OPERATIONS, MCP_ERROR_STATUS } from "../shared/public-contract.mjs";
import { createTransport } from "./transport.mjs";
import { identityMethods } from "./identity-methods.mjs";
import { createBusinessMethods } from "./client-methods.mjs";
import { CoLinkError, fail, responseError } from "../shared/errors.mjs";
import { explainMethodError } from "../diagnostics/method-diagnostics.mjs";
import { methodForHttp, methodUsage, toolUsage } from "../diagnostics/method-guidance.mjs";
import { writeUsage, explainWriteFailure } from "../diagnostics/write-contract.mjs";
import { isRecord as object, record } from "../shared/data.mjs";
import { businessResult } from "../shared/wire-values.mjs";
const routes = HTTP_ROUTES;
const toolPolicies = MCP_POLICIES;
const operations = MCP_OPERATIONS;
const errorStatus = MCP_ERROR_STATUS;
// Runtime-only identity-bound reads. They are not part of the public client surface.
const topicReaders = new WeakMap();
const clientOptions = new WeakMap();
const managedTools = new WeakMap();
const toolClients = new WeakMap();
const clientIdentities = new WeakMap();
export const clientTools = (client) => toolClients.get(client);
function httpInput(value) {
    if (!object(value) || Object.keys(value).some(k => !['method', 'path', 'query', 'body', 'key', 'bytes', 'contentType'].includes(k)))
        throw fail('INVALID_HTTP_REQUEST', 400);
    if (typeof value.path !== 'string' || value.method !== undefined && typeof value.method !== 'string')
        throw fail('HTTP_ROUTE_DENIED', 403);
    if (value.query !== undefined && !object(value.query))
        throw fail('INVALID_HTTP_QUERY', 400);
    if (value.key !== undefined && typeof value.key !== 'string')
        throw fail('IDEMPOTENCY_KEY_REQUIRED', 400);
    if (value.bytes !== undefined && !(value.bytes instanceof Uint8Array))
        throw fail('INVALID_HTTP_BODY', 400);
    if (value.contentType !== undefined && typeof value.contentType !== 'string')
        throw fail('INVALID_CONTENT_TYPE', 400);
    return { path: value.path, body: value.body, ...(typeof value.method === 'string' ? { method: value.method } : {}),
        ...(object(value.query) ? { query: value.query } : {}), ...(typeof value.key === 'string' ? { key: value.key } : {}),
        ...(value.bytes instanceof Uint8Array ? { bytes: value.bytes } : {}), ...(typeof value.contentType === 'string' ? { contentType: value.contentType } : {}) };
}
export async function requestClient(client, rawInput) {
    try {
        return await topicReaders.get(client)(httpInput(rawInput));
    }
    catch (error) {
        const input = record(rawInput);
        throw explainMethodError(error, clientIdentities.get(client) + '.' + methodForHttp(typeof input.method === 'string' ? input.method : 'GET', input.path, input.body));
    }
}
export const managedClientTools = (client) => managedTools.get(client);
export function bindBusinessClient(client, execution, identity) {
    const options = clientOptions.get(client);
    if (!options)
        throw fail('INVALID_CLIENT_BINDING', 400);
    const original = options.context;
    const active = async () => { execution.active(); await original.active(); execution.active(); };
    const bound = createBusinessClient({ ...options, identity: undefined, context: { ...original, signal: execution.signal, onWriteAttempt: execution.onWriteAttempt,
            active, validate: async (input) => { await active(); await original.validate(input); await active(); } } });
    return identity === 'user' ? Object.freeze({ user: bound.user }) : Object.freeze({ app: bound.app });
}
// DM 唤醒运行时专用读取：仅用户身份，conversationId 来自可信事件上下文
const dmReaders = new WeakMap();
export async function readClientDm(client, { conversationId, ...query }) {
    try {
        return await dmReaders.get(client)({ path: '/app-direct-messages/' + conversationId + '/messages', query }, 'user');
    }
    catch (error) {
        throw explainMethodError(error, 'directMessages.list');
    }
}
export async function readClientTopic(client, identity, { topicId, ...query }) {
    try {
        return await topicReaders.get(client)({ path: '/topics/' + topicId + '/messages', query }, identity);
    }
    catch (error) {
        throw explainMethodError(error, 'source.listMessages');
    }
}
function checkPolicy(policy) {
    if (!object(policy) || Object.keys(policy).some(k => !['readOnly', 'tools', 'resources'].includes(k)) ||
        policy.readOnly !== undefined && typeof policy.readOnly !== 'boolean' ||
        policy.tools !== undefined && (!Array.isArray(policy.tools) || policy.tools.some(n => typeof n !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(n))) ||
        policy.resources !== undefined && (!object(policy.resources) || Object.entries(policy.resources).some(([k, values]) => !['projectId', 'channelId', 'topicId', 'taskId', 'fileId', 'messageId', 'providerInstallationId', 'appId'].includes(k) || !Array.isArray(values) || values.some(v => typeof v !== 'string' || !v))))
        throw fail('INVALID_CAPABILITY_POLICY', 400);
    return structuredClone(policy);
}
export function validateCapabilityPolicy(policy = {}) { return checkPolicy(policy); }
export function createBusinessClient({ config, fetcher, context, policy = {}, journal, onDelivery = () => { }, identity: fixedIdentity }) {
    policy = checkPolicy(policy);
    if (!fixedIdentity) {
        const options = { config, fetcher, context, policy, journal, onDelivery };
        const client = Object.freeze({ user: createBusinessClient({ ...options, identity: 'user' }), app: createBusinessClient({ ...options, identity: 'app' }) });
        clientOptions.set(client, options);
        topicReaders.set(client, (input, identity) => topicReaders.get(client[identity])(input));
        dmReaders.set(client, input => dmReaders.get(client.user)(input));
        const owners = new Map();
        let documentationBound = false;
        async function discoverManaged() {
            await context.validate();
            const identities = context.identities(), entries = [];
            // Platform documentation is identity-independent. Bind before asynchronous
            // discovery so concurrent lists/calls cannot select different subjects.
            if (!documentationBound) {
                owners.set('colink_read_platform', identities.app ? 'app' : identities.user ? 'user' : undefined);
                documentationBound = true;
            }
            for (const identity of ['user', 'app'].filter(name => identities[name]))
                for (const tool of await clientTools(client[identity]).list())
                    entries.push({ identity, tool });
            const counts = new Map();
            for (const { tool } of entries)
                counts.set(tool.name, (counts.get(tool.name) || 0) + 1);
            // No generic equivalence inference or model-facing identity aliases.
            // A new collision needs an explicitly reviewed semantic binding rule.
            if ([...counts].some(([name, count]) => name !== 'colink_read_platform' && count > 1))
                throw fail('MCP_RESPONSE_INVALID', 502);
            await context.active();
            const found = new Map();
            for (const { identity, tool } of entries) {
                if (owners.has(tool.name) && owners.get(tool.name) !== identity)
                    continue;
                owners.set(tool.name, identity);
                found.set(tool.name, { identity, upstreamName: tool.name, tool });
            }
            return found;
        }
        managedTools.set(client, Object.freeze({
            async list() { return [...(await discoverManaged()).values()].map(item => item.tool); },
            async call(name, args) {
                const selected = (await discoverManaged()).get(name);
                if (!selected)
                    throw fail('TOOL_UNAVAILABLE', 403);
                return clientTools(client[selected.identity]).call(selected.upstreamName, args);
            },
        }));
        return client;
    }
    const selectedIdentity = fixedIdentity;
    const request = createTransport(config, fetcher);
    function narrow(input) {
        for (const [field, allowed] of Object.entries(policy.resources || {})) {
            // A caller opting into resource narrowing must provide the constrained
            // fields; a directory/global tool cannot silently evade the restriction.
            if (!allowed.includes(String(record(input)[field])) || typeof record(input)[field] !== 'string')
                throw fail('RESOURCE_POLICY_DENIED', 403);
        }
    }
    async function authority(input) { await context.validate(input); return context.identities(); }
    async function token(identity, input) { await context.validate(input); const value = await context.token(identity); await context.active(); return value; }
    const wireKey = (key) => createHash('sha256').update(context.key + '\n' + key).digest('hex');
    async function write(key, input, send) {
        if (policy.readOnly)
            throw fail('WRITE_POLICY_DENIED', 403);
        if (!journal)
            throw fail('WRITE_CONTEXT_REQUIRED', 403);
        return journal(key, input, send, typeof key === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(key) ? wireKey(key) : undefined);
    }
    async function http(input, identityHint = selectedIdentity, chunkIndex) {
        if (!object(input) || Object.keys(input).some(k => !['method', 'path', 'query', 'body', 'key', 'bytes', 'contentType'].includes(k)))
            throw fail('INVALID_HTTP_REQUEST', 400);
        const copy = structuredClone(input), { method = 'GET', path, query, key, bytes, contentType } = copy, body = record(copy.body);
        if (typeof path !== 'string' || !/^\/[A-Za-z0-9_/-]+$/.test(path) || path.includes('//') || path.endsWith('/'))
            throw fail('HTTP_ROUTE_DENIED', 403);
        const matched = Object.entries(routes).find(([route]) => {
            const [verb, template] = route.split(' ');
            return verb === method && new RegExp('^' + template.replace(/:[A-Za-z]+/g, '[A-Za-z0-9_-]{1,128}') + '$').test(path);
        });
        if (!matched)
            throw fail('HTTP_ROUTE_DENIED', 403);
        const [route, entry] = matched;
        const readOnly = method === 'GET' || entry.readOnly === true;
        if (context.managedStatus && route === 'POST /agent-sessions/status')
            throw fail('INTERACTION_STATUS_MANAGED', 409);
        if (context.eventId && ['POST /extensions/ui-requests', 'POST /agent-sessions/status', 'POST /extensions/agent-apps/receipts'].includes(route) && body?.eventId !== context.eventId)
            throw fail('RESOURCE_OUTSIDE_EVENT', 403);
        if (context.eventId && route === 'GET /extensions/ui-requests/:id' && record(query).eventId !== context.eventId)
            throw fail('RESOURCE_OUTSIDE_EVENT', 403);
        if (query !== undefined && (!object(query) || Object.values(query).some(v => v !== undefined && !['string', 'number', 'boolean'].includes(typeof v) && !(Array.isArray(v) && v.every(x => typeof x === 'string')))))
            throw fail('INVALID_HTTP_QUERY', 400);
        if (method === 'GET' && (copy.body !== undefined || bytes !== undefined))
            throw fail('INVALID_HTTP_REQUEST', 400);
        const readPolicy = typeof body.operation === 'string' && Object.hasOwn(entry.readPolicies || {}, body.operation) ? entry.readPolicies[body.operation] : undefined;
        const resourceInput = { ...query, ...record(readPolicy ? body.arguments : copy.body) };
        const template = route.split(' ')[1].split('/'), actual = path.split('/');
        const resourceNames = { topics: 'topicId', channels: 'channelId', 'app-channels': 'channelId', tasks: 'taskId', messages: 'messageId', 'app-files': 'fileId', 'app-capabilities': 'providerInstallationId' };
        template.forEach((part, i) => { if (part.startsWith(':'))
            resourceInput[part === ':id' ? resourceNames[template[i - 1]] || 'id' : part.slice(1)] = actual[i]; });
        narrow(resourceInput);
        const identities = await authority(copy);
        if (selectedIdentity && !identities[identityHint])
            throw explainMethodError(fail('CLIENT_IDENTITY_UNAVAILABLE', 403), methodForHttp(method, path, copy.body) ?? 'http.request', identities, identityHint);
        const branches = readPolicy ? [readPolicy] : [entry.policy, ...(entry.alternatives || [])];
        // The path fixes identity; scopes only determine whether this identity may call.
        const identity = branches.some(p => p.tokens.includes(selectedIdentity) && hasScopes(identities[selectedIdentity] || [], p.permissions)) ? selectedIdentity : undefined;
        if (!identity)
            throw explainMethodError(fail('SCOPE_MISSING', 403), methodForHttp(method, path, copy.body) ?? 'http.request', identities, identityHint);
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(query || {}))
            if (v !== undefined)
                params.set(k, Array.isArray(v) ? v.join(',') : String(v));
        const binary = route === 'GET /app-files/:fileId/content' || route === 'GET /app-direct-messages/:conversationId/attachments/:artifactId/download', upload = route === 'PUT /app-files/:fileId/content';
        if (upload ? !(bytes instanceof Uint8Array) || bytes.length > 20 * 1024 * 1024 || copy.body !== undefined : bytes !== undefined || contentType !== undefined)
            throw fail('INVALID_HTTP_BODY', 400);
        if (upload && (typeof contentType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(contentType)))
            throw fail('INVALID_CONTENT_TYPE', 400);
        const requestKey = key ? (chunkIndex === undefined ? wireKey(key) : createHash('sha256').update('message-chunk\n' + wireKey(key) + '\n' + chunkIndex).digest('hex')) : undefined;
        const send = async () => {
            let attempted = false;
            try {
                const bearer = await token(identity, copy);
                attempted = true;
                if (!readOnly)
                    context.onWriteAttempt?.({ usage: methodUsage(identity + '.' + methodForHttp(method, path, body)), ...(key ? { operationId: wireKey(key) } : {}) });
                const result = await request(path + (params.size ? '?' + params : ''), bearer, { method, signal: context.signal,
                    ...(route === 'POST /app-capabilities/:id/calls' ? { timeoutMs: 120000 } : {}),
                    body: upload ? bytes : copy.body === undefined ? undefined : JSON.stringify(route === 'POST /app-files' ? { ...body, uploadKey: wireKey(key) } : copy.body), responseType: binary ? 'bytes' : 'json',
                    maxBytes: binary ? 20 * 1024 * 1024 : 2 * 1024 * 1024,
                    headers: { ...(upload ? { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length), 'X-Content-SHA256': createHash('sha256').update(bytes).digest('hex') } : {}), ...(key ? { [route === 'POST /extensions/ui-requests' ? 'X-CoLink-Operation-Id' : 'Idempotency-Key']: requestKey } : {}) } });
                if (route === 'POST /messages' && object(result) && typeof result.messageId === 'string')
                    onDelivery({
                        topicId: result.topicId ?? body.topicId,
                        ...((result.conversationId ?? body.conversationId) !== undefined
                            ? { conversationId: result.conversationId ?? body.conversationId }
                            : {}),
                        text: body.text,
                        messageId: result.messageId,
                    });
                return result;
            }
            catch (error) {
                if (!readOnly && error instanceof CoLinkError)
                    error.write = {
                        outcome: attempted ? 'unknown' : 'not_sent', action: attempted ? 'inspect' : 'stop',
                        ...(typeof key === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(key) ? { operationId: wireKey(key) } : {}),
                    };
                throw error;
            }
        };
        if (readOnly) {
            const result = await send();
            await context.active();
            return result;
        }
        // Only routes with an actual idempotency contract use the durable replay lane.
        // Other mutations are single attempts; a lost response stays unknown.
        const repeatable = writeUsage(route)?.mode === 'journal';
        if (policy.readOnly)
            throw fail('WRITE_POLICY_DENIED', 403);
        return repeatable && chunkIndex === undefined ? write(key, { route, identity, query, body: copy.body }, send) : send();
    }
    async function sendMessage({ idempotencyKey: key, ...original }) {
        const body = structuredClone(original), parts = messageChunks(body.text, body.mentions);
        if (parts.length === 1) {
            const raw = await http({ method: 'POST', path: '/messages', body, key });
            const receipt = businessResult('messages.send', { ...record(raw), messages: [raw] }).messages[0];
            return { ...receipt, messages: [receipt] };
        }
        const identities = await authority();
        narrow(body);
        if (!identities[selectedIdentity])
            throw fail('CLIENT_IDENTITY_UNAVAILABLE', 403);
        if (selectedIdentity !== 'app' || !hasScopes(identities.app ?? [], ['messages:write']))
            throw fail('SCOPE_MISSING', 403);
        return write(key, { route: 'POST /messages', identity: selectedIdentity, query: undefined, body }, async () => {
            const messages = [];
            for (let i = 0; i < parts.length; i++) {
                const part = { ...body, ...parts[i] };
                if (i) {
                    delete part.fileIds;
                    if (body.channelId && !body.topicId) {
                        if (!messages[0].topicId && !messages[0].messageId)
                            throw fail('PLATFORM_RESPONSE_INVALID', 502);
                        part.topicId = messages[0].topicId || messages[0].messageId;
                    }
                }
                try {
                    const receipt = await http({ method: 'POST', path: '/messages', body: part, key }, selectedIdentity, i);
                    messages.push(businessResult('messages.send', { ...record(receipt), messages: [receipt] }).messages[0]);
                }
                catch (error) {
                    // A later unsent chunk does not mean the complete operation was unsent.
                    if (messages.length && error instanceof CoLinkError)
                        error.write = { action: 'inspect', ...error.write, outcome: 'unknown' };
                    throw error;
                }
            }
            return { ...messages[0], messages };
        });
    }
    async function rpc(identity, method, params, writeInfo) {
        const bearer = await token(identity), secrets = [bearer, config.clientSecret, config.signingSecret];
        if (writeInfo)
            context.onWriteAttempt?.(writeInfo);
        const raw = await request('/mcp', bearer, { method: 'POST', signal: context.signal, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
        if (!object(raw))
            throw fail('MCP_RESPONSE_INVALID', 502);
        const result = raw, failure = record(result.error), data = record(failure.data), output = record(result.result);
        if (result.error) {
            const code = typeof data.code === 'string' ? data.code : '';
            throw responseError({ ...data, message: data.message || failure.message }, errorStatus[code] || (failure.code === -32602 ? 400 : 502), { fallback: 'MCP_REQUEST_REJECTED', secrets });
        }
        if (output.isError) {
            let detail = output.structuredContent;
            try {
                detail ||= JSON.parse(String((Array.isArray(output.content) ? output.content : []).find(p => record(p).type === 'text')?.text));
            }
            catch { /* unknown errors get safe guidance */ }
            if (record(detail).error && !record(detail).code)
                detail = record(detail).error;
            throw responseError(detail, errorStatus[String(record(detail).code)] || 502, { fallback: 'MCP_TOOL_FAILED', secrets });
        }
        return result.result;
    }
    async function discover() {
        const identities = await authority(), found = new Map();
        // Discover only the identity selected by the namespace.
        if (selectedIdentity && !identities[selectedIdentity])
            throw fail('CLIENT_IDENTITY_UNAVAILABLE', 403);
        for (const identity of [selectedIdentity]) {
            let cursor;
            const seen = new Set();
            do {
                const result = record(await rpc(identity, 'tools/list', cursor ? { cursor } : {}));
                if (!Array.isArray(result?.tools))
                    throw fail('MCP_RESPONSE_INVALID', 502);
                for (const tool of result.tools) {
                    if (!object(tool) || typeof tool.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(tool.name) || !object(tool.inputSchema))
                        throw fail('MCP_RESPONSE_INVALID', 502);
                    const toolPolicy = toolPolicies[tool.name];
                    if (selectedIdentity && toolPolicy && (!toolPolicy.tokens.includes(selectedIdentity) || !hasScopes(identities[selectedIdentity] ?? [], toolPolicy.permissions)))
                        continue;
                    if (policy.tools && !policy.tools.includes(tool.name) || policy.readOnly && record(tool.annotations).readOnlyHint !== true)
                        continue;
                    if (policy.resources && Object.keys(policy.resources).some(k => !record(record(tool.inputSchema).properties)[k]))
                        continue;
                    if (found.has(tool.name))
                        throw fail('MCP_RESPONSE_INVALID', 502);
                    if (tool.description !== undefined && typeof tool.description !== 'string' || tool.annotations !== undefined && (!object(tool.annotations) || tool.annotations.readOnlyHint !== undefined && typeof tool.annotations.readOnlyHint !== 'boolean'))
                        throw fail('MCP_RESPONSE_INVALID', 502);
                    const descriptor = { name: tool.name, inputSchema: tool.inputSchema, ...(typeof tool.description === 'string' ? { description: tool.description } : {}), ...(object(tool.annotations) ? { annotations: { ...tool.annotations, ...(typeof tool.annotations.readOnlyHint === 'boolean' ? { readOnlyHint: tool.annotations.readOnlyHint } : {}) } } : {}) };
                    found.set(tool.name, { tool: descriptor, identity, upstreamName: tool.name });
                }
                cursor = result.nextCursor;
                if (cursor && (typeof cursor !== 'string' || seen.has(cursor) || seen.size >= 20))
                    throw fail('MCP_PAGINATION_INVALID', 502);
                seen.add(cursor);
            } while (cursor);
        }
        await context.active();
        return found;
    }
    const mcp = Object.freeze({
        async list() { return [...(await discover()).values()].map(({ tool }) => structuredClone(tool)); },
        async call(name, args = {}) {
            if (typeof name !== 'string' || !object(args))
                throw new CoLinkError('INVALID_TOOL_CALL', 400, undefined, {
                    usage: toolUsage({ name }, [], selectedIdentity), details: [{ field: typeof name !== 'string' ? 'name' : 'args', code: 'INVALID_ARGUMENT',
                            message: 'name 使用当前授权目录中的工具名，args 必须为符合该工具 inputSchema 的对象。' }]
                });
            args = structuredClone(args);
            narrow(args);
            const selected = (await discover()).get(name);
            if (!selected) {
                const error = fail('TOOL_UNAVAILABLE', 403);
                error.usage = toolUsage({ name }, [], selectedIdentity);
                throw error;
            }
            const { tool, identity, upstreamName } = selected;
            try {
                const send = async () => {
                    const result = await rpc(identity, 'tools/call', { name: upstreamName, arguments: args }, tool.annotations?.readOnlyHint === true ? undefined : { usage: toolUsage(tool, [], identity) });
                    const content = record(record(result).structuredContent);
                    if (operations[upstreamName] === 'messages.send' && typeof content.messageId === 'string')
                        onDelivery({
                            topicId: content.topicId,
                            ...((content.conversationId ?? args.conversationId) !== undefined
                                ? { conversationId: content.conversationId ?? args.conversationId }
                                : {}),
                            text: args.text,
                            messageId: content.messageId,
                        });
                    return result;
                };
                if (tool.annotations?.readOnlyHint === true) {
                    const result = await send();
                    await context.active();
                    return result;
                }
                const parameter = ['requestKey', 'operationId'].find(p => record(tool.inputSchema.properties)[p]);
                if (!parameter) {
                    if (policy.readOnly)
                        throw fail('WRITE_POLICY_DENIED', 403);
                    return await send(); // Unrecognized future write contract: one attempt, never automatic replay.
                }
                const key = args[parameter];
                if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
                    throw fail('IDEMPOTENCY_KEY_REQUIRED', 400);
                args[parameter] = wireKey(key);
                return await write(key, { name, identity, args }, send);
            }
            catch (error) {
                if (error instanceof CoLinkError) {
                    error.usage = toolUsage(tool, [config.clientSecret, config.signingSecret], selectedIdentity);
                    explainWriteFailure(error, error.usage);
                }
                throw error;
            }
        },
    });
    const client = identityMethods(createBusinessMethods(http, context.eventId, sendMessage), selectedIdentity, { active: async () => { await context.active(); } });
    clientIdentities.set(client, selectedIdentity);
    topicReaders.set(client, http);
    dmReaders.set(client, http);
    toolClients.set(client, mcp);
    return client;
}
