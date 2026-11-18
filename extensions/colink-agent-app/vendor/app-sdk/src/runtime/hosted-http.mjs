import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCoLinkHttpHandler, reserved, failHttpResponse } from "./http-handler.mjs";
import { CoLinkError } from "../shared/errors.mjs";
import { runtimeHttp, runtimeServerDefaults } from "../shared/http-paths.mjs";
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (field) => new CoLinkError('APP_HTTP_INVALID_OPTIONS', 400, undefined, {
    message: 'Invalid HTTP handler options.', hint: 'Check views, assets and routes in serveCoLinkRuntime.',
    ...(field ? { details: [{ field, code: 'INVALID_CONFIG_FIELD', message: field.startsWith('routes') ? 'Use an exact, non-reserved App path with a function handler; do not shadow SDK paths or assets.' : 'Bind an app-rendered Manifest viewId to a local file URL with a unique, non-reserved entryPath.' }] } : {}),
});
const pathAllowed = (path) => /^\/(?:[A-Za-z0-9][A-Za-z0-9._/-]*)?$/.test(path) &&
    !path.includes('//') && !path.split('/').some(part => part === '.' || part === '..');
const fileTypes = new Map(Object.entries({
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.pdf': 'application/pdf', '.wasm': 'application/wasm',
}));
/** Does not own listening, signals or runtime lifetime. Unmatched requests remain untouched. */
export async function createHostedHttpHandler(runtime, options = {}) {
    const context = runtimeHttp.get(runtime);
    if (!context || context.closed() || !object(options) || Object.keys(options).some(key => !['views', 'assets', 'routes'].includes(key)))
        throw invalid();
    const protocolHandler = await createCoLinkHttpHandler(runtime);
    const defaults = runtimeServerDefaults.get(runtime);
    const assets = new Map();
    const routes = new Map();
    const declared = options.assets ?? {};
    if (!object(declared))
        throw invalid();
    const bindings = options.views === undefined ? {} : options.views;
    if (!object(bindings))
        throw invalid('views');
    const resources = new Map(Object.entries(declared));
    for (const [viewId, file] of Object.entries(bindings)) {
        const matches = defaults?.views?.filter(view => view.viewId === viewId) ?? [];
        const view = matches[0];
        const entryPath = view?.entryPath;
        if (matches.length !== 1 || view.renderer !== 'app' || typeof view.entryPath !== 'string' ||
            !pathAllowed(view.entryPath) || reserved(view.entryPath) ||
            context.paths.some(route => entryPath === route || entryPath?.startsWith(route + '/')) ||
            defaults?.views.filter(other => other.entryPath === view.entryPath).length !== 1 || resources.has(view.entryPath) ||
            !(file instanceof URL) || file.protocol !== 'file:')
            throw invalid('views.' + viewId);
        resources.set(view.entryPath, file);
    }
    for (const [path, value] of resources) {
        const asset = value instanceof URL ? { file: value } : value;
        if (!pathAllowed(path) || reserved(path) || context.paths.some(route => path === route || path.startsWith(route + '/')) || !object(asset) ||
            Object.keys(asset).some(key => !['file', 'body', 'contentType'].includes(key)) ||
            (Object.hasOwn(asset, 'file') === Object.hasOwn(asset, 'body')))
            throw invalid();
        let body, contentType = asset.contentType;
        if (Object.hasOwn(asset, 'file')) {
            if (!(asset.file instanceof URL) || asset.file.protocol !== 'file:')
                throw invalid();
            if (contentType === undefined)
                contentType = fileTypes.get(extname(fileURLToPath(asset.file)).toLowerCase()) ?? 'application/octet-stream';
            if (typeof contentType !== 'string' || !/^[\x20-\x7e]+$/.test(contentType))
                throw invalid();
            body = await readFile(asset.file);
        }
        else {
            if (typeof contentType !== 'string' || !/^[\x20-\x7e]+$/.test(contentType))
                throw invalid();
            if (typeof asset.body !== 'string' && !(asset.body instanceof Uint8Array))
                throw invalid();
            body = typeof asset.body === 'string' ? Buffer.from(asset.body, 'utf8') : Buffer.from(asset.body);
        }
        assets.set(path, { contentType, body });
    }
    if (options.routes !== undefined && !object(options.routes))
        throw invalid('routes');
    for (const [path, handler] of Object.entries(options.routes ?? {})) {
        if (!pathAllowed(path) || reserved(path) || assets.has(path) || typeof handler !== 'function' ||
            context.paths.some(route => path === route || path.startsWith(route + '/')))
            throw invalid('routes.' + path);
        routes.set(path, handler);
    }
    if (context.closed())
        throw invalid();
    return async (req, res) => {
        const path = req.url?.split('?')[0] ?? '';
        if (await protocolHandler(req, res))
            return true;
        if (!assets.has(path) && !routes.has(path))
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
                await routes.get(path)(req, res);
        }
        catch {
            failHttpResponse(res);
        }
        return true;
    };
}
