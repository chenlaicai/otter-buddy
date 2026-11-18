import { readFile } from 'node:fs/promises';
import { CoLinkError } from "../shared/errors.mjs";
import { runtimeHttp, runtimeServerDefaults } from "../shared/http-paths.mjs";
export const reserved = (path) => ['/events', '/manifest.json', '/healthz', '/colink-browser.mjs', '/page-config.json'].includes(path) ||
    path === '/colink' || path.startsWith('/colink/') || path === '/.well-known' || path.startsWith('/.well-known/');
const invalid = () => new CoLinkError('APP_HTTP_INVALID_OPTIONS', 400, undefined, {
    message: 'Invalid SDK HTTP binding.', hint: 'Pass only a live SDK runtime to createCoLinkHttpHandler. Mount App pages and routes in your HTTP framework.',
});
/** Protocol and SDK-owned browser resources only; no listener or lifecycle ownership. */
export async function createCoLinkHttpHandler(runtime) {
    const context = runtimeHttp.get(runtime);
    if (arguments.length !== 1 || !context || context.closed())
        throw invalid();
    const config = runtimeServerDefaults.get(runtime)?.pageConfig;
    const assets = new Map();
    if (config) {
        const { hostOrigin, issuer, allowInsecureLocal } = config;
        assets.set('/page-config.json', { contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ hostOrigin, issuer, allowInsecureLocal })) });
        assets.set('/colink-browser.mjs', { contentType: 'text/javascript; charset=utf-8', body: await readFile(new URL('../../browser.mjs', import.meta.url)) });
    }
    if (context.closed())
        throw invalid();
    return async (req, res) => {
        const path = req.url?.split('?')[0] ?? '';
        if (!reserved(path || '') && !context.paths.some(route => path === route || path?.startsWith(route + '/')))
            return false;
        try {
            if (context.closed()) {
                res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
                res.end(JSON.stringify({ code: 'RUNTIME_CLOSED' }));
                return true;
            }
            const asset = assets.get(path);
            if (asset) {
                if (!['GET', 'HEAD'].includes(req.method ?? '')) {
                    res.writeHead(405, { allow: 'GET, HEAD' });
                    res.end();
                    return true;
                }
                res.writeHead(200, { 'content-type': asset.contentType, 'content-length': asset.body.length, 'cache-control': 'no-store' });
                res.end(req.method === 'HEAD' ? undefined : asset.body);
            }
            else
                await context.handleRequest(req, res);
        }
        catch {
            failHttpResponse(res);
        }
        return true;
    };
}
export function failHttpResponse(res) {
    if (res.destroyed || res.writableEnded)
        return;
    if (res.headersSent) {
        res.destroy();
        return;
    }
    res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ code: 'APP_HTTP_HANDLER_FAILED' }));
}
