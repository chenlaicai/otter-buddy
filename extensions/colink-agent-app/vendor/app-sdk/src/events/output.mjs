import { createHash } from 'node:crypto';
import { splitText } from "../shared/message-chunks.mjs";
import { fail } from "../shared/errors.mjs";
/** Durable, ordered output for one event. Never starts or replays application work. */
export function createOutput({ row, save, send, now }) {
    let tail = Promise.resolve();
    const entries = () => row.outputs || [];
    const replace = (index, patch) => save({ outputs: entries().map((entry, i) => i === index ? { ...entry, ...patch } : entry) });
    async function drain(check = () => { }) {
        for (let i = 0; i < entries().length; i++) {
            const entry = entries()[i];
            if (entry.status !== 'pending')
                continue;
            check();
            if (entry.startedAt !== undefined && now() - entry.startedAt >= 3600000)
                throw fail('REPLY_RECOVERY_EXPIRED', 409);
            const receipt = await send(entry.text, entry.sequence, () => {
                check();
                if (entry.startedAt === undefined)
                    replace(i, { startedAt: now() });
            });
            // Record the actual receipt even if cancellation happened during the HTTP request.
            replace(i, { status: 'sent', messageId: receipt.messageId });
        }
    }
    function schedule(check) {
        const result = tail.catch(() => { }).then(() => drain(check));
        tail = result;
        tail.catch(() => { });
        return result;
    }
    return {
        async progress(input, check) {
            check();
            if (!row.outputPolicy)
                throw fail('PROGRESS_NOT_ENABLED', 400);
            if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['key', 'text'].includes(k)) ||
                typeof input.key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.key) ||
                typeof input.text !== 'string' || !input.text.trim() || input.text.length > 64000)
                throw fail('INVALID_PROGRESS', 400);
            const text = input.text.trim(), key = 'progress:' + input.key;
            const digest = createHash('sha256').update(text).digest('hex');
            let group = entries().filter(e => e.progressKey === key || e.key === key);
            if (group.length && group.some(e => e.digest ? e.digest !== digest : e.text !== text))
                throw fail('OUTPUT_KEY_CONFLICT', 409);
            if (!group.length) {
                const parts = splitText(text), progress = entries().filter(e => e.kind === 'progress');
                if (progress.length + parts.length > 32 || progress.reduce((n, e) => n + e.text.length, 0) + text.length > 64000)
                    throw fail('OUTPUT_LIMIT', 400);
                group = parts.map((part, i) => ({ key: 'chunk:' + key + ':' + i, progressKey: key, digest,
                    kind: 'progress', sequence: entries().length + i, text: part, status: 'pending' }));
                save({ outputs: [...entries(), ...group] });
            }
            await schedule(check);
            const confirmed = entries().filter(e => e.progressKey === key || e.key === key);
            const messages = Object.freeze(confirmed.map(e => {
                if (e.status !== 'sent' || typeof e.messageId !== 'string')
                    throw fail('TURN_INACTIVE', 403);
                return Object.freeze({ sequence: e.sequence, messageId: e.messageId });
            }));
            return Object.freeze({ status: 'sent', ...messages[0], messages });
        },
        async idle() { await tail.catch(() => { }); },
        finish(texts, outcome = 'done', error) {
            const outputs = entries().map(e => outcome !== 'done' && e.status === 'pending' && e.startedAt === undefined
                ? { ...e, status: 'discarded' } : e);
            for (const text of texts)
                outputs.push({ key: 'terminal:' + outputs.length, kind: outcome === 'done' ? 'final' : 'status',
                    sequence: outputs.length, text, status: 'pending' });
            save({ outputs, outcome, error, status: 'reply_pending' });
        },
        flush: () => schedule(),
    };
}
