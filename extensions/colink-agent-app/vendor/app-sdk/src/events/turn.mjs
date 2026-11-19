import { CAPABILITIES } from "../shared/capabilities.mjs";
import { fail } from "../shared/errors.mjs";
import { businessResult } from "../shared/wire-values.mjs";
/** A capability bound to one verified event, never a caller-selected identity. */
export function createTurnActions({ row, platform, requireActive, stageReply, progress }) {
    const dm = row.event.data?.reason === 'dm_message';
    // Fix the authority branch once from the verified event, never from available tokens.
    const visibility = 'channelVisibility' in row.event.data ? row.event.data.channelVisibility : undefined;
    const capability = dm || visibility === 'private' ? CAPABILITIES.privateMessages
        : visibility === 'public' ? CAPABILITIES.publicMessages : undefined;
    const allowed = ['limit', 'cursor'];
    const read = (method) => async (options = {}) => {
        requireActive();
        const input = structuredClone(options);
        if (!input || typeof input !== 'object' || Array.isArray(input) ||
            Object.keys(input).some(key => !allowed.includes(key)))
            throw fail('INVALID_READ_OPTIONS', 400);
        if ((input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) ||
            (input.cursor !== undefined && (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 2048)))
            throw fail('INVALID_READ_OPTIONS', 400);
        if (!capability)
            throw fail('SOURCE_READ_IDENTITY_UNAVAILABLE', 403);
        const result = await platform.readMessages(row, capability, input);
        requireActive();
        return businessResult(method, result);
    };
    const source = dm ? Object.freeze({ kind: 'dm', listMessages: read('directMessages.list') })
        : Object.freeze({ kind: 'topic', listMessages: read('topics.listMessages') });
    return Object.freeze({ source,
        async sendProgress(input) {
            requireActive();
            if (!progress)
                throw fail('PROGRESS_NOT_ENABLED', 400);
            if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['idempotencyKey', 'text'].includes(key)))
                throw fail('INVALID_PROGRESS', 400);
            return progress({ key: input?.idempotencyKey, text: input?.text });
        },
        async reply(input) {
            requireActive();
            if (!input || typeof input !== 'object' || Array.isArray(input) ||
                Object.keys(input).some(key => key !== 'text') ||
                typeof input.text !== 'string' || !input.text.trim() || input.text.length > 64000)
                throw fail('INVALID_REPLY', 400);
            // Copy before waiting: application code cannot change the queued body.
            const text = input.text.trim();
            await platform.validate(row);
            requireActive();
            stageReply(text);
            return Object.freeze({ status: 'staged' });
        },
    });
}
