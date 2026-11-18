import { CoLinkError } from "../shared/errors.mjs";
import { methodUsage } from "./method-guidance.mjs";
import { explainWriteFailure } from "./write-contract.mjs";
import { record, isIterable } from "../shared/data.mjs";
export function explainMethodError(error, name, identities, identityHint, args) {
    const usage = methodUsage(name, identities, identityHint);
    if (!usage)
        return error;
    // A foreign exception is not permission to expose its message or guessed code.
    if (!(error instanceof CoLinkError))
        return error;
    const safe = error;
    const previous = safe.usage;
    safe.usage = usage;
    if (!identities && previous && previous.route === usage.route)
        safe.usage.authorization = previous.authorization;
    if (safe.code === 'INVALID_RESOURCE' && !safe.details && args) {
        const field = usage.arguments[0]?.parameters.find(p => (p.name === 'id' || p.name.endsWith('Id')) && p.required &&
            (() => { const value = record(args[0])[p.name]; return typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value); })());
        if (field)
            safe.details = [{ field: usage.arguments[0].name + '.' + field.name, code: 'INVALID_RESOURCE',
                    message: field.description + ' SDK 路径 ID 要求 1–128 位字母、数字、下划线或连字符；接口可能有更严格约束。' }];
    }
    return explainWriteFailure(safe, usage);
}
function validateArguments(guide, args) {
    for (const [index, argument] of guide.arguments.entries()) {
        const input = args[index];
        if (input === undefined && argument.optional)
            continue;
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            throw new CoLinkError('INVALID_ARGUMENT', 400, undefined, { details: [{ field: argument.name, code: 'OBJECT_REQUIRED', message: '此参数必须为对象；按 usage.arguments 和 usage.example 填写。' }] });
        }
        if (!argument.open) {
            const allowed = new Set(argument.parameters.map(parameter => parameter.name));
            const field = Object.keys(input).find(name => !allowed.has(name));
            if (field)
                throw new CoLinkError('INVALID_ARGUMENT', 400, undefined, { details: [{ field: argument.name + '.' + field,
                            code: 'UNKNOWN_FIELD', message: '此方法不接受该字段；按当前方法签名填写，不使用旧版参数或传输协议字段。' }] });
        }
    }
}
export function withMethodDiagnostics(methods, prefix = '') {
    return Object.freeze(Object.fromEntries(Object.entries(methods).map(([key, entry]) => {
        const value = entry;
        const name = prefix + key;
        if (typeof value !== 'function') {
            if (value === null || typeof value !== 'object')
                throw new TypeError('Invalid internal method tree');
            return [key, withMethodDiagnostics(value, name + '.')];
        }
        const guide = methodUsage(name);
        if (!guide)
            return [key, value];
        if (name.endsWith('.iterate'))
            return [key, async function* (...args) {
                    try {
                        validateArguments(guide, args);
                        const values = Reflect.apply(value, undefined, args);
                        if (!isIterable(values))
                            throw new TypeError('Invalid internal iterator');
                        yield* values;
                    }
                    catch (error) {
                        throw explainMethodError(error, name, undefined, undefined, args);
                    }
                }];
        return [key, async (...args) => {
                try {
                    validateArguments(guide, args);
                    return await Reflect.apply(value, undefined, args);
                }
                catch (error) {
                    throw explainMethodError(error, name, undefined, undefined, args);
                }
            }];
    })));
}
