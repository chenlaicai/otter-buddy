import { record } from "../shared/data.mjs";
import { WRITE_RECOVERY_MS } from "../shared/error-details.mjs";
export { WRITE_RECOVERY_MS };
const journal = Object.freeze(['required', 'journal']);
const optional = Object.freeze(['required', 'single_attempt']);
const single = Object.freeze(['none', 'single_attempt']);
export const WRITE_CONTRACTS = Object.freeze({
    'POST /messages': journal,
    'PUT /messages/:id': single,
    'POST /message-drafts': journal,
    'POST /agent-sessions/status': journal,
    'POST /extensions/ui-requests': journal,
    'POST /tasks': journal,
    'POST /tasks/:id': journal,
    'POST /tasks/:id/execution-reports': journal,
    'POST /messages/:id/recall': optional,
    'POST /app-files': journal,
    'POST /app-capabilities/:id/calls': optional,
    'PUT /app-files/:fileId/content': single,
    'POST /extensions/ui-requests/:id/complete': single,
    'POST /extensions/agent-apps/receipts': single,
});
export function writeUsage(route) {
    const entry = route !== undefined && Object.hasOwn(WRITE_CONTRACTS, route) && WRITE_CONTRACTS[route];
    if (!entry)
        return undefined;
    return describeWrite(route ?? '', entry);
}
export function mcpWriteUsage(tool, isMessageSend = false) {
    if (tool.annotations?.readOnlyHint === true)
        return undefined;
    const keyParameter = ['requestKey', 'operationId'].find(p => tool.inputSchema?.properties?.[p]);
    return { ...describeWrite(isMessageSend ? 'POST /messages' : '', keyParameter ? journal : single), ...(keyParameter ? { keyParameter } : {}) };
}
function describeWrite(route, entry) {
    const [key, mode] = entry;
    const inspect = route === 'POST /tasks/:id' || route === 'POST /tasks/:id/execution-reports'
        ? '可用 tasks.get 核对已知任务，但当前状态不能单独证明某次写入成功。'
        : route === 'POST /extensions/ui-requests' || route === 'POST /extensions/ui-requests/:id/complete'
            ? '已知请求 ID 时用 interactions.get 核对状态。'
            : route.includes('/app-files') ? '已知 fileId 时用 files.readContent 核对文件状态。'
                : '没有按任意 key 查询结果的通用接口；保留操作标识和 requestId，由业务回执或操作者核对。不能只按相同内容判断成功。';
    return { mode, key, ...(mode === 'journal' ? { recoveryWindowMs: WRITE_RECOVERY_MS } : {}),
        scope: 'idempotencyKey 不是 API Key。相同可信上下文内，一次业务操作使用一个稳定 idempotencyKey；业务重新调用、事件重投和重启恢复保持原值。不同操作即使内容相同也使用不同 key。',
        onUnknown: (mode === 'journal'
            ? 'SDK 不自动重跑业务。仅在原上下文仍有效且恢复窗口内，用原参数和原 idempotencyKey 显式恢复；不要换 idempotencyKey 或改走 HTTP/MCP 重做。'
            : 'SDK 只尝试一次；传 key 不代表已进入持久恢复队列。结果未知时先核对状态，不自动重做或改走 HTTP/MCP。') + inspect,
        ...(route === 'POST /messages' ? { managedAlternative: '回复当前 @ 的最终文本，在 runtime.onEvent(EventType.UserMessageReceived, handler) 的 handler 中暂存 ctx.reply({text}) 后成功返回；Agent.runTurn 也可返回最终文本；SDK 管理持久发送标识，无须 key。主动发送仍用 messages.send。' } : {}),
    };
}
// Rebuild bounded machine-readable fields at every proxy boundary. Never include
// request bodies, original business keys, credential values or arbitrary hints.
export function safeWriteRecovery(input, secrets = []) {
    const value = record(input), { outcome, action, remainingMs } = value;
    if ((outcome !== 'not_sent' && outcome !== 'unknown' && outcome !== 'confirmed') ||
        (action !== 'fix_request' && action !== 'same_key' && action !== 'inspect' && action !== 'stop'))
        return undefined;
    const operationId = value.operationId;
    return { outcome, action,
        ...(typeof operationId === 'string' && /^[a-f0-9]{64}$/.test(operationId) && !secrets.some(s => s && operationId.includes(s)) ? { operationId } : {}),
        ...(typeof remainingMs === 'number' && Number.isSafeInteger(remainingMs) && remainingMs >= 0 && remainingMs <= WRITE_RECOVERY_MS ? { remainingMs } : {}),
    };
}
export function explainWriteFailure(error, usage) {
    if (!usage?.write)
        return error;
    if (!error.write) {
        const beforeSend = ['INVALID_ARGUMENT', 'INVALID_RESOURCE', 'IDEMPOTENCY_KEY_REQUIRED', 'SCOPE_MISSING',
            'CLIENT_IDENTITY_UNAVAILABLE', 'WRITE_POLICY_DENIED', 'WRITE_CONTEXT_REQUIRED', 'RESOURCE_POLICY_DENIED', 'INTERACTION_STATUS_MANAGED',
            'INVALID_HTTP_REQUEST', 'INVALID_HTTP_BODY', 'INVALID_CONTENT_TYPE', 'INVALID_HTTP_QUERY',
            'SIMULATOR_NOT_IMPLEMENTED'].includes(error.code);
        error.write = { outcome: beforeSend ? 'not_sent' : 'unknown', action: ['WRITE_RECOVERY_EXPIRED', 'IDEMPOTENCY_EXPIRED'].includes(error.code) ? 'stop' : beforeSend ? 'fix_request' : 'inspect' };
    }
    if (error.write.outcome === 'unknown' && error.write.action !== 'stop' && !['WRITE_KEY_CONFLICT', 'IDEMPOTENCY_KEY_CONFLICT', 'IDEMPOTENCY_CONFLICT'].includes(error.code))
        error.hint = usage.write.onUnknown;
    return error;
}
