export const runtimeHttp = new WeakMap();
// Public host defaults captured per SDK runtime, never inferred from an HTTP request.
export const runtimeServerDefaults = new WeakMap();
export const overlapsPath = (a, b) => a === b || a === '/' || b === '/' || a.startsWith(b + '/') || b.startsWith(a + '/');
