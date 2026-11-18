import { createHash } from 'node:crypto';
import { CoLinkError, fail } from "../shared/errors.mjs";
import { WRITE_RECOVERY_MS } from "../diagnostics/write-contract.mjs";
import { isRecord } from "../shared/data.mjs";
const stable = (value) => Array.isArray(value) ? value.map(stable) : isRecord(value)
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
/** Single-owner write ledger. Explicit retries only, same request/key.
 * Completed receipts are kept for conflict detection, but every replay still
 * reaches the platform so current authorization and resource ACL are rechecked.
 */
export function createWriteJournal({ row, save, now = Date.now }) {
    const current = typeof row === 'function' ? row : () => row;
    let lane = Promise.resolve();
    return (key, input, send, operationId) => {
        const action = async () => {
            const reject = (code, status, write) => { const error = fail(code, status); error.write = { ...write, ...(operationId ? { operationId } : {}) }; throw error; };
            if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
                reject('IDEMPOTENCY_KEY_REQUIRED', 400, { outcome: 'not_sent', action: 'fix_request' });
            const digest = createHash('sha256').update(JSON.stringify(stable(input))).digest('hex');
            const records = current().writes || {};
            let record = Object.hasOwn(records, key) ? records[key] : undefined;
            const existing = !!record;
            const priorOutcome = () => record?.status === 'sent' ? 'confirmed' : 'unknown';
            if (record && record.digest !== digest)
                reject('WRITE_KEY_CONFLICT', 409, { outcome: priorOutcome(), action: 'inspect' });
            if (record && now() - record.startedAt >= WRITE_RECOVERY_MS)
                reject('WRITE_RECOVERY_EXPIRED', 409, { outcome: priorOutcome(), action: 'stop', remainingMs: 0 });
            if (!record) {
                record = { digest, startedAt: now(), status: 'pending' };
                try {
                    save({ writes: { ...records, [key]: record } });
                }
                catch {
                    reject('WRITE_PERSISTENCE_FAILED', 503, { outcome: 'not_sent', action: 'stop' });
                }
            }
            let result;
            try {
                result = await send();
            }
            catch (error) {
                if (error instanceof CoLinkError) {
                    const remainingMs = Math.max(0, Math.min(WRITE_RECOVERY_MS, WRITE_RECOVERY_MS - (now() - record.startedAt)));
                    error.write = { outcome: existing ? priorOutcome() : error.write?.outcome || 'unknown',
                        action: remainingMs > 0 && (error.status >= 500 || error.status === 429) ? 'same_key' : 'stop', remainingMs,
                        ...(operationId ? { operationId } : {}) };
                }
                throw error;
            }
            try {
                save({ writes: { ...current().writes, [key]: { ...record, status: 'sent' } } });
            }
            catch {
                reject('WRITE_PERSISTENCE_FAILED', 503, { outcome: 'confirmed', action: 'inspect' });
            }
            return result;
        };
        const result = lane.catch(() => { }).then(action);
        lane = result;
        return result;
    };
}
