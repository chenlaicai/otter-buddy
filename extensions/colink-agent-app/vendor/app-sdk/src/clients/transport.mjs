import { CoLinkError, fail, responseError } from "../shared/errors.mjs";
/** Fixed-origin transport. Internal credentials/headers never cross the public API. */
export function createTransport({ apiBase, clientSecret, signingSecret }, fetcher = fetch) {
    return async function request(path, token, { method = 'GET', body, headers = {}, responseType = 'json', maxBytes = 2 * 1024 * 1024, timeoutMs = 15000, signal } = {}) {
        let response;
        try {
            response = await fetcher(apiBase + path, { method, body: body instanceof Uint8Array ? new Uint8Array(body) : body, redirect: 'error', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
                headers: { Accept: responseType === 'bytes' ? 'application/octet-stream' : 'application/json',
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers, Authorization: 'Bearer ' + token } });
        }
        catch {
            throw fail('PLATFORM_NETWORK_UNAVAILABLE');
        }
        const chunks = [];
        let size = 0;
        try {
            for await (const chunk of response.body || []) {
                size += chunk.length;
                if (size > maxBytes)
                    throw fail('PLATFORM_RESPONSE_TOO_LARGE', 502);
                chunks.push(chunk);
            }
        }
        catch (error) {
            if (error instanceof CoLinkError)
                throw error;
            throw fail('PLATFORM_NETWORK_UNAVAILABLE');
        }
        const bytes = Buffer.concat(chunks);
        let value;
        if (responseType !== 'bytes' || !response.ok) {
            try {
                value = bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
            }
            catch {
                if (response.ok)
                    throw fail('PLATFORM_RESPONSE_INVALID', 502);
            }
        }
        if (!response.ok)
            throw responseError(value, response.status, { fallback: `PLATFORM_HTTP_${response.status}`, secrets: [token, clientSecret, signingSecret] });
        return responseType === 'bytes' ? { bytes: new Uint8Array(bytes), contentType: response.headers.get('content-type') || 'application/octet-stream' } : value;
    };
}
