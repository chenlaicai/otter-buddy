import { requestClient } from "../clients/business-client.mjs";
import { withMethodDiagnostics } from "../diagnostics/method-diagnostics.mjs";
import { fail } from "../shared/errors.mjs";
import { businessResult } from "../shared/wire-values.mjs";
import { isRecord } from "../shared/data.mjs";
export function providerDirectory(client, callId, active) {
    const read = (operation, method) => async (query = {}) => {
        active();
        const result = await requestClient(client, { method: 'POST', path: '/extensions/capability-calls/' + callId + '/reads',
            body: { operation, arguments: query } });
        active();
        const id = operation === 'channels.list' ? 'channelId' : 'id';
        if (!isRecord(result) || !Array.isArray(result.items) || typeof result.hasMore !== 'boolean' ||
            (result.hasMore ? typeof result.nextCursor !== 'string' || !result.nextCursor : result.nextCursor !== null) ||
            result.items.some(item => !item || typeof item[id] !== 'string' || !item[id]))
            throw fail('PLATFORM_RESPONSE_INVALID', 502);
        return businessResult(method, result);
    };
    return withMethodDiagnostics({ listChannels: read('channels.list', 'channels.list'), listChannelMembers: read('channels.members.list', 'channels.listMembers') }, 'directory.');
}
