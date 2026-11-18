import { createServer } from 'node:http';
import { CoLinkError } from "../shared/errors.mjs";
import { runtimeHttp, runtimeServerDefaults } from "../shared/http-paths.mjs";
import { failHttpResponse } from "./http-handler.mjs";
import { createHostedHttpHandler } from "./hosted-http.mjs";
import { errorCode } from "../shared/data.mjs";
const owned = new WeakSet();
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (field) => new CoLinkError('APP_SERVER_INVALID_OPTIONS', 400, undefined, {
    message: 'Invalid Node server options.', hint: 'Check host, port, views, assets, routes and fallback in serveCoLinkRuntime.',
    ...(field ? { details: [{ field, code: 'INVALID_CONFIG_FIELD', message: field.startsWith('routes') ? 'Use an exact, non-reserved App path with a function handler; do not shadow SDK paths or assets.' : 'Bind an app-rendered Manifest viewId to a local file URL with a unique, non-reserved entryPath.' }] } : {}),
});
/** Optional Node host. Explicit resources only; never exposes a filesystem directory. */
export async function serveCoLinkRuntime(runtime, options = {}) {
    if (!runtimeHttp.has(runtime) || typeof runtime.start !== 'function' || typeof runtime.close !== 'function' || owned.has(runtime))
        throw invalid();
    owned.add(runtime);
    const sockets = new Set();
    let handler, fallback;
    const { promise: closed, resolve: finished, reject: failed } = Promise.withResolvers();
    // Programmatic callers can close explicitly; an unobserved closed promise must not
    // become an unhandled rejection. Awaiting it still exposes every shutdown failure.
    closed.catch(() => { });
    let stopping = false, started = false, closeTimeoutMs = 5000;
    const server = createServer((req, res) => {
        if (stopping) {
            res.writeHead(503, { connection: 'close' });
            res.end();
            return;
        }
        res.once('finish', () => { if (stopping)
            setImmediate(() => server.closeIdleConnections()); });
        Promise.resolve().then(async () => {
            if (await handler(req, res))
                return;
            if (fallback)
                await fallback(req, res);
            else {
                res.writeHead(404, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ code: 'NOT_FOUND' }));
            }
        }).catch(() => failHttpResponse(res));
    });
    server.requestTimeout = 20000;
    server.headersTimeout = 10000;
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.on('upgrade', (_req, socket) => socket.destroy());
    const destroyConnections = () => { for (const socket of sockets)
        socket.destroy(); };
    const onSignal = () => { void stop().catch(() => { process.exitCode = 1; }); };
    const onError = (error) => { if (started)
        void stop(error); };
    server.on('error', onError);
    function stop(cause) {
        if (stopping)
            return closed;
        stopping = true;
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        // Stop accepting connections before cancelling SDK work. Existing responses
        // can drain, but neither slow clients nor a stuck adapter can hide a failure.
        const httpClosed = new Promise((resolve, reject) => server.close(error => {
            if (error && errorCode(error) !== 'ERR_SERVER_NOT_RUNNING')
                reject(error);
            else
                resolve();
        }));
        const runtimeClosed = Promise.resolve().then(() => runtime.close()).catch(error => { destroyConnections(); throw error; });
        let timer;
        const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new CoLinkError('APP_SERVER_CLOSE_TIMEOUT', 503, undefined, { message: 'Node server shutdown exceeded its deadline.', hint: 'Inspect pending App work; connections have been closed, but external work may still be running.' })), closeTimeoutMs);
        });
        void (async () => {
            try {
                const results = await Promise.race([Promise.allSettled([runtimeClosed, httpClosed]), deadline]);
                const errors = [...(cause === undefined ? [] : [cause]), ...results.filter(result => result.status === 'rejected').map(result => result.reason)];
                if (errors.length)
                    throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'App server shutdown failed');
                finished();
            }
            catch (error) {
                failed(error);
            }
            finally {
                clearTimeout(timer);
                destroyConnections();
                server.off('error', onError);
            }
        })();
        return closed;
    }
    try {
        if (!object(options) || Object.keys(options).some(key => !['host', 'port', 'views', 'assets', 'routes', 'handleSignals', 'closeTimeoutMs', 'fallback'].includes(key)))
            throw invalid();
        const defaults = runtimeServerDefaults.get(runtime);
        const { host = defaults ? defaults.host : '127.0.0.1', port = defaults ? defaults.port : 8080, handleSignals = true } = options;
        if (typeof host !== 'string' || !host.trim() || typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535 || typeof handleSignals !== 'boolean')
            throw invalid();
        if (options.closeTimeoutMs !== undefined) {
            if (!Number.isInteger(options.closeTimeoutMs) || options.closeTimeoutMs < 1 || options.closeTimeoutMs > 60000)
                throw invalid();
            closeTimeoutMs = options.closeTimeoutMs;
        }
        if (options.fallback !== undefined && typeof options.fallback !== 'function')
            throw invalid('fallback');
        fallback = options.fallback;
        const { views, assets, routes } = options;
        try {
            handler = await createHostedHttpHandler(runtime, { views, assets, routes });
        }
        catch (error) {
            if (error instanceof CoLinkError && error.code === 'APP_HTTP_INVALID_OPTIONS')
                throw invalid(error.details?.[0]?.field);
            throw error;
        }
        await new Promise((resolve, reject) => {
            const fail = (error) => { server.off('listening', ready); reject(error); };
            const ready = () => { server.off('error', fail); resolve(); };
            server.once('error', fail);
            server.once('listening', ready);
            try {
                server.listen(port, host);
            }
            catch (error) {
                server.off('error', fail);
                fail(error);
            }
        });
        await runtime.start();
        started = true;
        if (handleSignals) {
            process.once('SIGINT', onSignal);
            process.once('SIGTERM', onSignal);
        }
        const address = server.address();
        if (!address || typeof address === 'string')
            throw invalid();
        return Object.freeze({ host, port: address.port, close: () => stop(), closed });
    }
    catch (error) {
        await stop(error);
        throw error;
    }
}
