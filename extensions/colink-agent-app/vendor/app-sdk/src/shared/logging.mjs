import { CoLinkError } from "./errors.mjs";
/** Allowlisted lifecycle metadata only; logging must not change execution semantics. */
export function safeLogEntry(value) {
    const result = {};
    if (!value || typeof value !== 'object')
        return result;
    for (const key of ['code', 'stage', 'eventId', 'installationId', 'messageId', 'status']) {
        const field = Reflect.get(value, key);
        if (typeof field === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(field))
            result[key] = field;
    }
    for (const key of ['queueWaitMs', 'activeCount']) {
        const field = Reflect.get(value, key);
        if (typeof field === 'number' && Number.isSafeInteger(field) && field >= 0)
            result[key] = field;
    }
    const field = Reflect.get(value, 'field');
    if (typeof field === 'string' && /^[A-Za-z0-9_.:\[\]-]{1,200}$/.test(field))
        result.field = field;
    return result;
}
export function guardedLogger(log) {
    return entry => { try {
        const pending = log(safeLogEntry(entry));
        pending?.catch?.(() => { });
    }
    catch { } };
}
export function resolveLogger(log, now = Date.now) {
    if (log === false)
        return () => { };
    if (log !== undefined && typeof log !== 'function')
        throw new CoLinkError('INVALID_APP_CONFIG', 400, undefined, {
            message: 'Invalid log option.', hint: 'Omit log for JSON output, set false to disable, or supply a callback.',
            details: [{ field: 'log', code: 'INVALID_CONFIG_FIELD', message: 'Expected a function or false.' }],
        });
    return guardedLogger(log ?? (entry => console.error(JSON.stringify({ at: new Date(now()).toISOString(), ...entry }))));
}
