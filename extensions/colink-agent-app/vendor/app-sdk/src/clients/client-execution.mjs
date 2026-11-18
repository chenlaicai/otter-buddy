import { bindBusinessClient } from "./business-client.mjs";
import { fail } from "../shared/errors.mjs";
import { explainWriteFailure } from "../diagnostics/write-contract.mjs";
const asyncIterable = (value) => value !== null && typeof value === 'object' && Symbol.asyncIterator in value && typeof value[Symbol.asyncIterator] === 'function';
export function createClientExecutions({ installation, request, grant, stopped }) {
    const running = new Set();
    function resolve(binding, identity) {
        if (!binding || typeof binding !== 'object' || Array.isArray(binding) || Object.keys(binding).length !== 1 ||
            !(identity === 'user' ? ['request', 'grantId'] : ['installationId']).includes(Object.keys(binding)[0]) ||
            ('request' in binding ? !binding.request || typeof binding.request !== 'object' :
                typeof (binding.installationId ?? binding.grantId) !== 'string' || !(binding.installationId ?? binding.grantId)))
            throw fail('INVALID_CLIENT_BINDING', 400);
        if (stopped())
            throw fail('CLIENT_EXECUTION_INACTIVE', 403);
        // Capture the original authorization/version once. No general page proof
        // here: exact private-completion recovery has its own authorization path.
        const original = 'installationId' in binding ? installation(binding.installationId) :
            'request' in binding ? request(binding.request) : grant(binding.grantId);
        return { original, identity };
    }
    function checkedOptions(options) {
        if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(k => !['signal', 'timeoutMs'].includes(k)) ||
            options.signal !== undefined && !(options.signal instanceof AbortSignal) ||
            options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 1800000))
            throw fail('INVALID_CLIENT_OPTIONS', 400);
        return { ...options };
    }
    function open({ original, identity }, options) {
        const controller = new AbortController();
        const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
        let finished = false, timer, writeInfo;
        const active = () => { if (finished || stopped() || signal.aborted)
            throw fail('CLIENT_EXECUTION_INACTIVE', 403); };
        active();
        const colink = bindBusinessClient(original, { active, signal, onWriteAttempt: info => { writeInfo = info; } }, identity);
        running.add(controller);
        if (options.timeoutMs)
            timer = setTimeout(() => controller.abort(), options.timeoutMs);
        let reject;
        const cancelled = new Promise((_, no) => { reject = no; });
        // An iterator can be suspended between next() calls when cancellation lands.
        cancelled.catch(() => { });
        const onAbort = () => {
            clearTimeout(timer);
            running.delete(controller);
            const error = fail('CLIENT_EXECUTION_INACTIVE', 403);
            if (writeInfo) {
                error.usage = writeInfo.usage;
                error.write = { outcome: 'unknown', action: 'inspect', ...(writeInfo.operationId ? { operationId: writeInfo.operationId } : {}) };
                explainWriteFailure(error, error.usage);
            }
            reject(error);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        return {
            colink, active,
            race: (promise) => Promise.race([promise, cancelled]),
            close() {
                finished = true;
                clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
                controller.abort();
                running.delete(controller);
            },
        };
    }
    async function execute(source, handler, options) {
        const execution = open(source, options);
        try {
            return await execution.race(Promise.resolve().then(() => { execution.active(); return handler(execution.colink); }));
        }
        finally {
            execution.close();
        }
    }
    function select(identity, binding, options = {}) {
        const source = resolve(binding, identity), settings = checkedOptions(options);
        const call = (colink, path, args) => {
            let value = colink;
            for (const key of path) {
                if (value === null || typeof value !== 'object')
                    throw new TypeError('Invalid internal client path');
                value = Reflect.get(value, key);
            }
            if (typeof value !== 'function')
                throw new TypeError('Invalid internal client method');
            return Reflect.apply(value, undefined, args);
        };
        function wrap(value, path = []) {
            return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, member]) => {
                const parts = [...path, key];
                if (typeof member !== 'function') {
                    if (member === null || typeof member !== 'object')
                        throw new TypeError('Invalid internal method tree');
                    return [key, wrap(member, parts)];
                }
                if (key === 'iterate')
                    return [key, async function* (...args) {
                            const execution = open(source, settings);
                            let iterator;
                            try {
                                const values = call(execution.colink, parts, args);
                                if (!asyncIterable(values))
                                    throw new TypeError('Invalid internal iterator');
                                iterator = values[Symbol.asyncIterator]();
                                while (true) {
                                    execution.active();
                                    const next = await execution.race(iterator.next());
                                    execution.active();
                                    if (next.done)
                                        return;
                                    yield next.value;
                                }
                            }
                            finally {
                                execution.close();
                                Promise.resolve(iterator?.return?.()).catch(() => { });
                            }
                        }];
                return [key, (...args) => execute(source, colink => call(colink, parts, args), settings)];
            })));
        }
        // This transparent wrapper preserves the selected, already checked method tree.
        return wrap(source.original[identity], [identity]);
    }
    return {
        userClient: (binding, options) => select('user', binding, options),
        appClient: (binding, options) => select('app', binding, options),
        close() { for (const controller of running)
            controller.abort(); },
    };
}
