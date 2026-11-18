import { record } from "./data.mjs";
let projectUsage = () => undefined;
// Private assembly hook. Foundational errors never import the method catalog.
export function installUsageProjection(project) { projectUsage = project; }
export function safeMethodUsage(input, secrets = []) {
    return projectUsage(input, secrets);
}
export const WRITE_RECOVERY_MS = 3600000;
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
