import { isWireValue } from "./wire-values.mjs";
import { stateSchemas, stateSchema, runtimeEventSchema, publicEventSchema } from "./state-schemas.mjs";
import { fail } from "./errors.mjs";
export function runtimeEvent(value) {
    if (!isWireValue(value, runtimeEventSchema, stateSchemas))
        throw fail('INVALID_EVENT', 400);
    return value;
}
export function publicEvent(value) {
    if (!isWireValue(value, publicEventSchema, stateSchemas))
        throw fail('INVALID_EVENT', 400);
    const freeze = (copy) => {
        if (copy && typeof copy === 'object') {
            for (const child of Object.values(copy))
                freeze(child);
            Object.freeze(copy);
        }
        return copy;
    };
    // Never freeze the mutable journal or pass its references into application code.
    return freeze(structuredClone(value));
}
export function runtimeState(value) {
    const maps = ['oauthInstallations', 'oauthUserExecutions', 'backgroundGrants', 'pageSessions', 'pageTransactions',
        'eventStops', 'controls', 'appClients', 'providerClients', 'providerReplays'];
    const next = { ...value };
    for (const name of maps)
        next[name] ??= {};
    next.oauthControlReceipts ??= [];
    if (!isWireValue(next, stateSchema, stateSchemas))
        throw new Error('Unsupported runtime state shape');
    return next;
}
