import { MCP_POLICIES, MANIFEST_SCOPES, EVENT_POLICIES, SCOPE_REQUIRES } from "../shared/public-contract.mjs";
import { methodUsage } from "./method-guidance.mjs";
import { hasScopes } from "../shared/scopes.mjs";
const mcpPolicies = MCP_POLICIES;
const eventPolicies = EVENT_POLICIES;
const scopeRequires = { ...SCOPE_REQUIRES };
const own = (value, key) => Object.hasOwn(value, key);
const unique = (values) => [...new Set(values)].sort();
const issue = (code, source, message, hint, extra = {}) => ({ code, source, message, hint, ...extra });
const branches = (policy) => policy.tokens.filter((value) => value === 'user' || value === 'app').map(identity => ({ identity, requiredScopes: [...policy.permissions] }));
// Metadata only: never obtains credentials, executes code, or changes consent.
export function permissionAlternatives(use) {
    if (!use || typeof use.method !== 'string')
        return [];
    const explicit = /^(user|app)\.(.+)$/.exec(use.method);
    if (explicit)
        return permissionAlternatives({ ...use, method: explicit[2] }).filter(p => p.identity === explicit[1]);
    if (use.method === 'tools.call')
        return use.tool && own(mcpPolicies, use.tool) ? branches(mcpPolicies[use.tool]) : [];
    return methodUsage(use.method)?.authorization.alternatives || [];
}
// Explain conjunction separately from identity-dependent alternatives.
export function explainPermissionScopes(method, source, alternatives, identity) {
    const variants = unique(alternatives.map(p => [...p.requiredScopes].sort().join(',')));
    const selected = alternatives.filter(p => identity === undefined || p.identity === identity);
    if (variants.length > 1)
        return { code: 'PERMISSION_IDENTITY_SCOPES', method, source, mode: 'by_identity',
            selectedIdentity: identity ?? null, alternatives,
            message: '同一方法按调用身份使用不同权限，不是同时需要所有备选权限。',
            hint: identity ? '已按客户端身份选择对应分支；其他分支不能用于替代当前授权。' : '根据业务使用实际身份绑定的客户端；即使声明两个权限，也不能消除调用身份歧义。' };
    if (selected[0]?.requiredScopes.length > 1)
        return { code: 'PERMISSION_MULTIPLE_SCOPES', method, source, mode: 'all',
            requiredScopes: [...selected[0].requiredScopes].sort(),
            message: '此调用需要同时声明这些权限，不能只选择其中一个。', hint: '分别核对全部 requiredScopes；声明仍不代表已取得相应授权。' };
}
function explicitInputs(input) {
    const { uses = [], events = [], permissions = [] } = input;
    if (![uses, events, permissions].every(Array.isArray))
        throw new TypeError('uses、events、permissions 必须为数组');
    if ([...events, ...permissions].some(v => typeof v !== 'string') || uses.some(use => !use || typeof use !== 'object' || Array.isArray(use) ||
        typeof use.method !== 'string' || Object.keys(use).some(k => !['method', 'identity', 'source', 'tool'].includes(k)) ||
        use.source !== undefined && typeof use.source !== 'string' || use.tool !== undefined && typeof use.tool !== 'string'))
        throw new TypeError('能力项须使用 method、identity、source、tool；事件和 scope 须为字符串');
    return { uses, events, permissions };
}
export function planPermissions(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['uses', 'events', 'permissions'].includes(k)))
        throw new TypeError('权限计划只接受 uses、events、permissions');
    const { uses, events, permissions } = explicitInputs(input);
    const requirements = [], diagnostics = [], notices = [];
    const add = (source, alternatives, identity, method) => {
        if (method === 'source.listMessages' && identity === undefined && alternatives.length) {
            requirements.push({ source, method, identity: 'source', mode: 'by_source', requiredScopes: [], alternatives });
            notices.push({ code: 'PERMISSION_SOURCE_SCOPES', method, source, mode: 'by_source', alternatives,
                message: '原来源决定读取身份及权限；公共话题使用应用，私密话题及私聊使用本轮用户。',
                hint: '按应用实际支持的来源声明对应读取权限；SDK 固定选择来源分支，失败不会切换身份。' });
            return;
        }
        if (method === 'source.listMessages')
            alternatives = [];
        const explanation = method && explainPermissionScopes(method, source, alternatives, identity);
        if (explanation)
            notices.push(explanation);
        const selected = alternatives.filter(p => identity === undefined || p.identity === identity);
        const scopeSets = unique(selected.map(p => [...p.requiredScopes].sort().join(',')));
        if (!selected.length || scopeSets.length !== 1) {
            diagnostics.push(issue(!alternatives.length ? 'PERMISSION_USAGE_UNKNOWN' : selected.length ? 'PERMISSION_IDENTITY_REQUIRED' : 'PERMISSION_IDENTITY_INVALID', source, !alternatives.length ? '当前契约无法确定此能力的权限。' : '需要选择此能力实际使用的调用身份。', '按 alternatives 明确 app 或 user；业务使用具名方法；Agent 工具填写具体工具名，不合并备选分支。', { alternatives, ...(method ? { methods: [method] } : {}) }));
        }
        else
            requirements.push({ source, ...(method ? { method } : {}), ...selected[0], requiredScopes: [...selected[0].requiredScopes], identity: unique(selected.map(p => p.identity)).join('|') });
    };
    for (const [index, use] of uses.entries())
        add(use?.source || `uses[${index}] ${use?.method || ''}`, permissionAlternatives(use), use?.identity, use.method);
    for (const event of unique(events))
        add(`events.${event}`, own(eventPolicies, event) ? branches(eventPolicies[event]) : [], 'app');
    for (const event of ['app.message_processing_cancelled', 'app.collaboration_message_received']) {
        if (events.includes(event) && !events.includes('app.user_message_received'))
            diagnostics.push(issue('PERMISSION_EVENT_DEPENDENCY', `events.${event}`, `${event} 必须与 app.user_message_received 一起订阅。`, '将 app.user_message_received 加入 events.types，再重新检查权限。'));
    }
    for (const scope of unique(permissions)) {
        if (!own(MANIFEST_SCOPES, scope))
            diagnostics.push(issue('PERMISSION_SCOPE_UNKNOWN', 'permissions', '权限不属于当前版本可声明的业务 scope。', '使用平台注册的业务权限，不填写 openid、profile、别名或通配符。', { scope }));
        else
            requirements.push({ source: 'permissions', identity: 'explicit', requiredScopes: [scope] });
    }
    // Keep every causing method/source when a scope has dependencies.
    for (const requirement of requirements) {
        for (let i = 0; i < requirement.requiredScopes.length; i++) {
            for (const dependency of scopeRequires[requirement.requiredScopes[i]] || [])
                if (!requirement.requiredScopes.includes(dependency))
                    requirement.requiredScopes.push(dependency);
        }
        requirement.requiredScopes.sort();
    }
    return { complete: diagnostics.length === 0, permissions: unique(requirements.flatMap(p => p.requiredScopes)), requirements, diagnostics, notices };
}
export function checkPermissions(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['manifest', 'uses', 'events', 'permissions'].includes(key)))
        throw new TypeError('权限核对只接受 manifest、uses、events、permissions；不支持源码分析选项');
    const { manifest } = input;
    const { uses, events, permissions } = explicitInputs(input);
    if (!manifest || !Array.isArray(manifest.permissions))
        throw new TypeError('manifest.permissions 必须为数组');
    if (manifest.events !== undefined && (!manifest.events || !Array.isArray(manifest.events.types)))
        throw new TypeError('manifest.events.types 必须为数组');
    const plan = planPermissions({ uses, events: unique([...events, ...(manifest.events?.types || [])]), permissions: unique([...permissions, ...manifest.permissions]) });
    return comparePermissionPlan(manifest, plan);
}
export function comparePermissionPlan(manifest, plan) {
    if (!manifest || !Array.isArray(manifest.permissions))
        throw new TypeError('manifest.permissions 必须为数组');
    const missing = plan.permissions.filter(scope => !hasScopes(manifest.permissions, [scope]));
    const conditional = plan.requirements.filter(requirement => requirement.mode === 'by_source');
    const invalid = manifest.permissions.filter(scope => !own(MANIFEST_SCOPES, scope));
    const diagnostics = [...plan.diagnostics,
        ...conditional.filter(requirement => !requirement.alternatives?.some(branch => hasScopes(manifest.permissions, branch.requiredScopes)))
            .map(requirement => issue('MANIFEST_SOURCE_READ_PERMISSION_MISSING', requirement.source, '原来源读取未声明任何可用的读取权限。', '公共话题声明 messages:read-public；私密话题或私聊声明 messages:read-private，按实际支持范围选择。', { methods: ['source.listMessages'], alternatives: requirement.alternatives })),
        ...invalid.map(scope => issue('PERMISSION_SCOPE_UNKNOWN', 'manifest.permissions', 'Manifest 含未知业务权限。', '删除未知项；不能通过申请全部权限解决调用失败。', { scope })),
        ...missing.map(scope => issue('MANIFEST_PERMISSION_MISSING', 'manifest.permissions', '已确定的能力缺少 Manifest 权限声明。', '检查以下方法与事件，在 Manifest 中声明确实需要的权限，再更新登记和授权。SDK 不会改写清单。', { scope, requiredBy: plan.requirements.filter(r => r.requiredScopes.includes(scope)).map(r => r.source), methods: unique(plan.requirements.filter(r => r.requiredScopes.includes(scope)).flatMap(r => r.method ? [r.method] : [])) }))];
    return { ...plan, complete: plan.complete && !invalid.length,
        passed: diagnostics.length === 0, missing, extra: [], extraCheck: 'not_evaluated', diagnostics, coverage: 'explicit_uses_only',
        note: '仅核对显式方法、事件和清单约束，不读取 App 源码、不判断多余权限、不修改 Manifest；通过不证明未运行分支或实际授权。' };
}
