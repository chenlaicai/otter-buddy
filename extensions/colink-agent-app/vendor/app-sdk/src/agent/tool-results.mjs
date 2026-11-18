import { fail, CoLinkError } from "../shared/errors.mjs";
import { isRecord } from "../shared/data.mjs";
export function agentToolOptions(options) {
    const invalid = (field) => new CoLinkError('INVALID_APP_CONFIG', 400, undefined, {
        message: 'Invalid Agent tool options.', hint: 'Configure tools.transformResult only on createCoLinkAgent.',
        details: [{ field, code: 'INVALID_CONFIG_FIELD', message: 'Use an Agent tools object with an optional transformResult function.' }],
    });
    if ('transformToolResult' in options)
        throw invalid('transformToolResult');
    if (!options.agent && 'tools' in options)
        throw invalid('tools');
    const value = options.tools;
    if (value === undefined)
        return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
        Reflect.ownKeys(value).some(key => key !== 'transformResult'))
        throw invalid('tools');
    const transformResult = value.transformResult;
    if (transformResult !== undefined && typeof transformResult !== 'function')
        throw invalid('tools.transformResult');
    return Object.freeze({ transformResult });
}
// Public tool channels are distinct from trusted server business calls. Some
// platform tools issue NEW deployment credentials in both JSON and text blocks.
// The trusted transformer may persist those securely and return a public receipt.
const credential = /^(?:client[_-]?secret|signing[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|private[_-]?key|authorization|password)$/i;
export async function publicToolResult({ name, result, context, transform, secrets = [] }) {
    const projected = transform ? await transform({ name, result: structuredClone(result), context: Object.freeze({ ...context }) }) : result;
    function sensitive(value, depth = 0) {
        if (depth > 64)
            return true;
        if (typeof value === 'string') {
            if (secrets.some(secret => typeof secret === 'string' && secret.length >= 8 && value.includes(secret)) || /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(value))
                return true;
            try {
                const json = JSON.parse(value);
                if (typeof json === 'object' && json !== null)
                    return sensitive(json, depth + 1);
            }
            catch { }
            return false;
        }
        if (Array.isArray(value))
            return value.some(v => sensitive(v, depth + 1));
        return isRecord(value) && Object.entries(value).some(([k, v]) => credential.test(k) && v != null && v !== '' || sensitive(v, depth + 1));
    }
    if (sensitive(projected))
        throw fail('TOOL_RESULT_REQUIRES_TRUSTED_HANDLING', 409);
    return projected;
}
