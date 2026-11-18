import { METHOD_GUIDES } from "./method-guides.mjs";
import { HTTP_ROUTES, MCP_POLICIES, MCP_OPERATIONS } from "../shared/public-contract.mjs";
import { writeUsage, mcpWriteUsage } from "./write-contract.mjs";
import { record } from "../shared/data.mjs";
const guides = METHOD_GUIDES;
const routes = HTTP_ROUTES;
const policies = MCP_POLICIES;
const operations = MCP_OPERATIONS;
const isIdentity = (value) => value === 'user' || value === 'app';
const publicText = (value, secrets = []) => {
    if (typeof value !== 'string')
        return '';
    let text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]');
    for (const secret of secrets)
        if (typeof secret === 'string' && secret.length >= 4)
            text = text.split(secret).join('[redacted]');
    return text.slice(0, 400);
};
export function toolUsage(rawTool, secrets = [], identity) {
    const tool = record(rawTool);
    if (typeof tool.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(tool.name))
        return undefined;
    const schema = record(tool.inputSchema), annotations = record(tool.annotations), policy = Object.hasOwn(policies, tool.name) ? policies[tool.name] : undefined;
    const properties = record(schema.properties);
    const parameters = Object.entries(properties).filter(([name]) => /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(name)).slice(0, 40).map(([name, value]) => {
        const field = record(value);
        return { name, type: typeof field.type === 'string' && ['string', 'integer', 'number', 'boolean', 'object', 'array'].includes(field.type) ? field.type : '见 tools/list inputSchema',
            required: Array.isArray(schema.required) && schema.required.includes(name),
            description: publicText(field.description, secrets) || '按当前授权 tools/list 中此字段的定义填写。' };
    });
    const input = Object.fromEntries(parameters.filter(p => p.required).map(p => [p.name, p.type === 'integer' || p.type === 'number' ? 1 : p.type === 'boolean' ? true : p.type === 'array' ? [] : p.type === 'object' ? {} : '<' + p.name + '>']));
    const write = mcpWriteUsage({ annotations: { readOnlyHint: annotations.readOnlyHint === true }, inputSchema: { properties } }, operations[tool.name] === 'messages.send');
    return { method: 'tools.call', ...(identity ? { toolIdentity: identity } : {}), tool: tool.name, toolReadOnly: annotations.readOnlyHint === true, ...(write ? { write } : {}), arguments: [{ name: 'args', type: 'object', optional: false, open: schema.additionalProperties !== false, parameters }],
        example: `await turn.tools.call(${JSON.stringify(tool.name)}, ${JSON.stringify(input)});`,
        docs: 'https://colink.link/docs/app-extensions/colink-for-ai.zip', reference: 'for-ai-sdk-agent.md#动态-mcp',
        note: '以本次授权目录中的 inputSchema 为准；示例是待替换的结构，不保证满足 oneOf 等组合限制。普通 App 优先使用具名 HTTP 方法。',
        authorization: { alternatives: policy ? policy.tokens.filter(isIdentity).filter(name => !identity || name === identity).map(identity => ({ identity, requiredScopes: [...policy.permissions] })) : [],
            note: policy ? 'scope 不等于资源可见性；不得切换身份绕过拒绝。' : '此动态工具的 scope 未登记在当前 SDK 中；读取当前授权目录，不推断无须授权。',
            recovery: '重新读取当前授权 tools/list；核对 Manifest、安装批准、用户同意及有效上下文。工具不在目录时停止，不绕过目录直接调用。' } };
}
export function methodForHttp(method, path, input) {
    if (typeof path !== 'string')
        return undefined;
    const body = record(input);
    const interaction = body.kind === 'toast' ? 'interactions.showToast' : body.kind === 'action_result' ? 'actions.complete' : 'interactions.openDialog';
    return Object.values(guides).find(g => g.route && (!g.operation || g.operation === body.operation) && (g.route !== 'POST /extensions/ui-requests' || g.method === interaction) && !g.method.endsWith('.iterate') && (() => {
        const [verb, template] = g.route.split(' ');
        return verb === method && new RegExp('^' + template.replace(/:[A-Za-z]+/g, '[^/]+') + '$').test(path);
    })())?.method;
}
// Only public, versioned metadata is returned. Never copy the caller's input,
// upstream usage text, arbitrary schemas, credential values or resource IDs.
export function methodUsage(inputName, identities, identityHint) {
    if (typeof inputName !== 'string')
        return undefined;
    let name = inputName;
    const explicit = /^(user|app)\.(.+)$/.exec(name || '');
    if (explicit && isIdentity(explicit[1]))
        identityHint = explicit[1];
    const publicName = name;
    if (explicit)
        name = explicit[2];
    const turnRead = name === 'source.listMessages';
    if (turnRead && (explicit || identityHint))
        return undefined;
    const lookup = turnRead ? 'topics.listMessages' : name;
    const guide = Object.hasOwn(guides, lookup || '') && guides[lookup];
    if (!guide)
        return undefined;
    const entry = routes[guide.route];
    const branch = guide.operation && entry?.readPolicies?.[guide.operation];
    const alternatives = entry ? (branch ? [branch] : [entry.policy, ...(entry.alternatives || [])]).flatMap(p => p.tokens.filter(isIdentity)
        .filter(identity => !identityHint || identityHint === identity).map(identity => ({ identity, requiredScopes: [...p.permissions],
        ...(identities ? { identityAvailable: Array.isArray(identities[identity]), missingScopes: p.permissions.filter(s => !identities[identity]?.includes(s)) } : {}) }))) : [];
    const write = writeUsage(guide.route === 'PUT /app-files/:fileId/content' ? 'POST /app-files' : guide.route);
    const metadata = structuredClone(guide);
    if (turnRead) {
        const dm = guides['directMessages.list'];
        metadata.arguments = [{ name: 'options', type: 'TopicReadOptions | DirectMessageReadOptions', optional: true, open: false,
                parameters: [...metadata.arguments[0].parameters.filter(p => ['limit', 'cursor'].includes(p.name)),
                    ...dm.arguments[0].parameters.filter(p => ['beforeId', 'afterId'].includes(p.name))] }];
        metadata.reference = 'for-ai-sdk-events.md#读取当前来源';
    }
    return { ...metadata, ...(write ? { write } : {}), method: publicName,
        example: turnRead ? `await turn.${name}({ limit: 20 });` : (identityHint && guide.identityExamples?.[identityHint]) || guide.example, authorization: { alternatives,
            note: turnRead ? 'SDK 根据已验签的原来源固定身份：公共话题用 A，私密话题及私聊用本轮 U；权限按来源分别要求，不是同时申请两种权限。旧话题事件缺少可见性时明确拒绝，不推测身份。' : '调用路径固定身份，所需 scope 必须全部具备。公开要求不证明当前已获授权或资源可见；失败不切换身份。',
            recovery: '应用权限需 Manifest 声明并由安装批准；用户权限还需当前用户同意及有效用户执行/页面/后台上下文。补权后重新建立有效上下文，不重放旧凭据。' } };
}
export function safeMethodUsage(input, secrets = []) {
    const value = record(input), mcp = value.method === 'tools.call';
    if (mcp) {
        const arg = record(Array.isArray(value.arguments) ? value.arguments[0] : undefined);
        const fields = (Array.isArray(arg.parameters) ? arg.parameters.slice(0, 40) : []).map(record);
        return toolUsage({ name: value.tool, annotations: { readOnlyHint: value.toolReadOnly === true }, inputSchema: { additionalProperties: arg?.open !== false,
                properties: Object.fromEntries(fields.filter(p => p && typeof p.name === 'string').map(p => [p.name, { type: p.type, description: p.description }])),
                required: fields.filter(p => p.required === true).map(p => p.name) } }, secrets, isIdentity(value.toolIdentity) ? value.toolIdentity : undefined);
    }
    const safe = methodUsage(value?.method);
    if (!safe)
        return undefined;
    // Preserve only bounded, known-scope diagnostics through SDK/page proxies.
    for (const branch of safe.authorization.alternatives) {
        const authorization = record(value.authorization);
        const supplied = (Array.isArray(authorization.alternatives) ? authorization.alternatives : []).map(record).find(p => p.identity === branch.identity &&
            Array.isArray(p.requiredScopes) && p.requiredScopes.length === branch.requiredScopes.length && p.requiredScopes.every((s) => typeof s === 'string' && branch.requiredScopes.includes(s)));
        if (supplied && typeof supplied.identityAvailable === 'boolean')
            branch.identityAvailable = supplied.identityAvailable;
        const missing = supplied?.missingScopes;
        if (Array.isArray(missing))
            branch.missingScopes = branch.requiredScopes.filter(s => missing.includes(s));
    }
    return safe;
}
