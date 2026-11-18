/** Narrow untrusted JSON before reading fields. No caller-defined shape is assumed. */
export function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export const record = (value) => isRecord(value) ? value : {};
export function errorCode(value) {
    const code = record(value).code;
    return typeof code === 'string' ? code : undefined;
}
export function isIterable(value) {
    return typeof value === 'string' || value !== null && typeof value === 'object' &&
        (typeof Reflect.get(value, Symbol.asyncIterator) === 'function' || typeof Reflect.get(value, Symbol.iterator) === 'function');
}
