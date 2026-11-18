import { CoLinkError, fail, responseError } from "../shared/errors.mjs";
import { record } from "../shared/data.mjs";
export function pageTransport(config, fetcher) {
    const form = (value) => new URLSearchParams([['v', value]]).toString().slice(2);
    const basic = 'Basic ' + Buffer.from(form(config.clientId) + ':' + form(config.clientSecret)).toString('base64');
    async function request(path, options = {}) {
        try {
            const response = await fetcher(config.apiBase + path, { ...options, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
            const chunks = [];
            let size = 0;
            for await (const chunk of response.body || []) {
                size += chunk.length;
                if (size > 2 * 1024 * 1024)
                    throw fail('PAGE_RESPONSE_INVALID', 502);
                chunks.push(chunk);
            }
            let value;
            try {
                value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            }
            catch {
                throw fail('PAGE_RESPONSE_INVALID', 502);
            }
            if (!response.ok) {
                const data = record(value);
                const code = data.error === 'invalid_grant' ? 'PAGE_LOGIN_REQUIRED'
                    : typeof data.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(data.code) ? data.code : 'PAGE_PLATFORM_UNAVAILABLE';
                const secrets = [config.clientSecret, basic, options.headers?.Authorization?.replace(/^Bearer /, '')];
                if (typeof options.body === 'string')
                    for (const key of ['code', 'code_verifier', 'refresh_token', 'token'])
                        secrets.push(new URLSearchParams(options.body).get(key));
                throw responseError({ ...data, code }, data.error === 'invalid_grant' ? 401 : response.status, { secrets });
            }
            return value;
        }
        catch (error) {
            if (error instanceof CoLinkError)
                throw error;
            throw fail('PAGE_PLATFORM_UNAVAILABLE', 503);
        }
    }
    return {
        request,
        revoke(token) { return request('/oauth/revoke', { method: 'POST', headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() }); },
        token(fields, key) {
            return request('/oauth/token', { method: 'POST', headers: {
                    Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded', ...(key ? { 'Idempotency-Key': key } : {}),
                }, body: new URLSearchParams(fields).toString() });
        },
        proof(token) { return request('/extensions/session-validations', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }); },
    };
}
